import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gateway, GatewayType } from '../../../entities/gateway.entity';
import { AgentRun } from '../../../entities/agent-run.entity';
import { ChannelEvent } from '../../../entities/channel-event.entity';
import { AgentRuntimeService } from '../../agents/agent-runtime.service';
import { BaseAdapter, NormalizedMessage } from './adapters/base.adapter';
import { ChatWidgetAdapter } from './adapters/chat-widget.adapter';
import { SlackAdapter } from './adapters/slack.adapter';
import { DiscordAdapter } from './adapters/discord.adapter';
import { TelegramAdapter } from './adapters/telegram.adapter';
import { WhatsAppAdapter } from './adapters/whatsapp.adapter';
import { EmailAdapter } from './adapters/email.adapter';
import { WebhookAdapter } from './adapters/webhook.adapter';
import { GoogleChatAdapter } from './adapters/google-chat.adapter';
import { MicrosoftTeamsAdapter } from './adapters/microsoft-teams.adapter';
import { SignalAdapter } from './adapters/signal.adapter';
import { MatrixAdapter } from './adapters/matrix.adapter';
import { IrcAdapter } from './adapters/irc.adapter';

@Injectable()
export class ChannelGatewayService {
  private readonly logger = new Logger(ChannelGatewayService.name);
  private readonly adapters: Map<string, BaseAdapter>;

  constructor(
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @InjectRepository(ChannelEvent)
    private readonly eventRepository: Repository<ChannelEvent>,
    @Inject(forwardRef(() => AgentRuntimeService))
    private readonly agentRuntimeService: AgentRuntimeService,
    private readonly chatWidgetAdapter: ChatWidgetAdapter,
    private readonly slackAdapter: SlackAdapter,
    private readonly discordAdapter: DiscordAdapter,
    private readonly telegramAdapter: TelegramAdapter,
    private readonly whatsAppAdapter: WhatsAppAdapter,
    private readonly emailAdapter: EmailAdapter,
    private readonly webhookAdapter: WebhookAdapter,
    private readonly googleChatAdapter: GoogleChatAdapter,
    private readonly microsoftTeamsAdapter: MicrosoftTeamsAdapter,
    private readonly signalAdapter: SignalAdapter,
    private readonly matrixAdapter: MatrixAdapter,
    private readonly ircAdapter: IrcAdapter,
  ) {
    this.adapters = new Map<string, BaseAdapter>([
      [GatewayType.CHAT_WIDGET, this.chatWidgetAdapter],
      [GatewayType.SLACK, this.slackAdapter],
      [GatewayType.DISCORD, this.discordAdapter],
      [GatewayType.TELEGRAM, this.telegramAdapter],
      [GatewayType.WHATSAPP, this.whatsAppAdapter],
      [GatewayType.EMAIL, this.emailAdapter],
      [GatewayType.WEBHOOK, this.webhookAdapter],
      [GatewayType.GOOGLE_CHAT, this.googleChatAdapter],
      [GatewayType.MICROSOFT_TEAMS, this.microsoftTeamsAdapter],
      [GatewayType.SIGNAL, this.signalAdapter],
      [GatewayType.MATRIX, this.matrixAdapter],
      [GatewayType.IRC, this.ircAdapter],
    ]);
  }

  // ---------------------------------------------------------------------------
  // Adapter lookup
  // ---------------------------------------------------------------------------

  getAdapter(type: string): BaseAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new BadRequestException(`No adapter found for channel type: ${type}`);
    }
    return adapter;
  }

  // ---------------------------------------------------------------------------
  // Inbound message handling (Slack, Discord, Telegram, etc.)
  // ---------------------------------------------------------------------------

  /**
   * Process an inbound message from an external platform.
   * The caller (controller) returns 200 immediately; this runs async.
   */
  async handleInboundMessage(
    gateway: Gateway,
    body: any,
    headers: Record<string, string>,
  ): Promise<void> {
    if (!gateway.isActive()) {
      this.logger.warn(`Webhook received for inactive gateway: ${gateway.id}`);
      return;
    }

    const adapter = this.getAdapter(gateway.type);

    // Verify webhook signature
    const isValid = await adapter.verifyWebhook(body, headers, gateway.configuration);
    if (!isValid) {
      this.logger.warn(`Webhook signature verification failed for gateway: ${gateway.id}`);
      await this.logEvent(gateway, 'inbound', 'failed', body, 'signature verification failed');
      return;
    }

    // Normalize inbound message
    const normalized: NormalizedMessage = adapter.normalizeInbound(body);
    await this.logEvent(gateway, 'inbound', 'received', this.truncatePayload(body));
    // Find existing run for this thread, or start a new one
    let run: AgentRun | null = null;

    if (normalized.threadId) {
      const existingRuns = await this.runRepository
        .createQueryBuilder('run')
        .where('run.agentId = :agentId', { agentId: gateway.agentId })
        .andWhere('run.status IN (:...activeStatuses)', {
          activeStatuses: ['running', 'waiting_input', 'sleeping'],
        })
        .andWhere("run.metadata->>'threadId' = :threadId", { threadId: normalized.threadId })
        .orderBy('run.createdAt', 'DESC')
        .limit(1)
        .getMany();

      run = existingRuns[0] || null;
    }

    if (run) {
      await this.agentRuntimeService.sendInput(run.id, gateway.organizationId, normalized.text);
      this.listenForCompletionAndRespond(run.id, gateway, adapter, normalized);
    } else {
      const newRun = await this.agentRuntimeService.startRun(
        gateway.agentId,
        gateway.organizationId,
        normalized.userId,
        normalized.text,
        { maxSteps: 25 },
      );

      newRun.metadata = {
        ...(newRun.metadata || {}),
        threadId: normalized.threadId,
        gatewayId: gateway.id,
        gatewayType: gateway.type,
        source: normalized.metadata?.source || gateway.type,
      };
      await this.runRepository.save(newRun);

      this.listenForCompletionAndRespond(newRun.id, gateway, adapter, normalized);
    }

    // Increment request count
    gateway.incrementRequest(true);
    await this.gatewayRepository.save(gateway);
  }

  /**
   * Listen for a run to complete and send the response back via the adapter.
   */
  private listenForCompletionAndRespond(
    runId: string,
    gateway: Gateway,
    adapter: BaseAdapter,
    normalized: NormalizedMessage,
  ): void {
    const emitter = this.agentRuntimeService.getRunEmitter(runId);
    if (!emitter) {
      this.logger.warn(`No emitter found for run ${runId}, cannot send response`);
      return;
    }

    const onEvent = async (event: any) => {
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
        cleanup();

        try {
          const finalRun = await this.runRepository.findOne({ where: { id: runId } });
          if (!finalRun) return;

          const rawText =
            (typeof finalRun.output === 'string'
              ? finalRun.output
              : finalRun.output?.text) || 'No response';
          // EU AI Act Art. 50: prepend the disclosure line on the first
          // outbound message of a conversation when the gateway opts in.
          const responseText = await this.applyAiDisclosure(gateway, finalRun, rawText);

          const formatted = adapter.formatOutbound({ text: responseText });
          try {
            await adapter.sendResponse(gateway.configuration, formatted, {
              threadId: normalized.threadId,
              channel: normalized.metadata?.channel,
              userId: normalized.userId,
              // Reply-routing hints some platforms need (Teams serviceUrl,
              // email from/subject, Signal groupId, ...).
              from: normalized.metadata?.from,
              subject: normalized.metadata?.subject,
              metadata: normalized.metadata,
              // Identity for adapters that persist rather than push
              // (chat widget files the reply as a channel event).
              gatewayId: gateway.id,
              organizationId: gateway.organizationId,
              runId,
            });
            await this.logEvent(gateway, 'outbound', 'processed', this.truncatePayload(formatted), null, runId);
          } catch (sendErr: any) {
            await this.logEvent(gateway, 'outbound', 'failed', this.truncatePayload(formatted), sendErr?.message ?? String(sendErr), runId);
            throw sendErr;
          }
        } catch (err: any) {
          this.logger.error(`Failed to send response for run ${runId}: ${err.message}`);
        }
      }
    };

    const onDone = () => cleanup();

    const cleanup = () => {
      emitter.removeListener('event', onEvent);
      emitter.removeListener('done', onDone);
    };

    emitter.on('event', onEvent);
    emitter.on('done', onDone);

    // Safety timeout — .unref() so pending handle doesn't keep Node alive
    const safety = setTimeout(() => cleanup(), 5 * 60 * 1000);
    safety.unref?.();
  }

  /** Default EU AI Act Art. 50 disclosure line. */
  static readonly DEFAULT_AI_DISCLOSURE = 'You are chatting with an AI assistant.';

  /**
   * EU AI Act Art. 50 transparency: when a channel gateway opts in via
   * `configuration.aiDisclosure` (true = default line, non-empty string
   * = custom override), the FIRST outbound message of each conversation
   * is prefixed with the disclosure. First-ness is tracked on the run
   * (`run.metadata.aiDisclosureSent`) — a conversation maps 1:1 to a
   * run (thread lookups reattach to the active run), so follow-up
   * replies in the same conversation are not re-prefixed. Implemented
   * centrally in the dispatch path so all 12 adapters inherit it
   * without per-adapter changes.
   */
  async applyAiDisclosure(gateway: Gateway, run: AgentRun, text: string): Promise<string> {
    const setting = gateway.configuration?.aiDisclosure;
    if (!setting) return text;
    if ((run.metadata as any)?.aiDisclosureSent) return text;

    const line =
      typeof setting === 'string' && setting.trim()
        ? setting.trim()
        : ChannelGatewayService.DEFAULT_AI_DISCLOSURE;

    run.metadata = { ...(run.metadata || {}), aiDisclosureSent: true };
    await this.runRepository.save(run);

    return `${line}\n\n${text}`;
  }

  // ---------------------------------------------------------------------------
  // Widget message handling
  // ---------------------------------------------------------------------------

  /**
   * Handle a message from the chat widget.
   * Starts or continues a run, returns the run ID for SSE streaming.
   */
  async handleWidgetMessage(
    gateway: Gateway,
    body: { message: string; sessionId?: string; threadId?: string },
  ): Promise<{ runId: string; threadId: string }> {
    if (!gateway.isActive()) {
      throw new BadRequestException('Gateway is not active');
    }

    const adapter = this.getAdapter(gateway.type);
    const normalized = adapter.normalizeInbound({
      message: body.message,
      text: body.message,
      sessionId: body.sessionId,
      threadId: body.threadId,
    });

    // Check for existing run with this threadId
    let run: AgentRun | null = null;

    if (normalized.threadId) {
      const existingRuns = await this.runRepository
        .createQueryBuilder('run')
        .where('run.agentId = :agentId', { agentId: gateway.agentId })
        .andWhere('run.status IN (:...activeStatuses)', {
          activeStatuses: ['running', 'waiting_input', 'sleeping'],
        })
        .andWhere("run.metadata->>'threadId' = :threadId", { threadId: normalized.threadId })
        .orderBy('run.createdAt', 'DESC')
        .limit(1)
        .getMany();

      run = existingRuns[0] || null;
    }

    if (run) {
      run = await this.agentRuntimeService.sendInput(run.id, gateway.organizationId, normalized.text);
    } else {
      run = await this.agentRuntimeService.startRun(
        gateway.agentId,
        gateway.organizationId,
        normalized.userId,
        normalized.text,
        { maxSteps: 25 },
      );

      run.metadata = {
        ...(run.metadata || {}),
        threadId: normalized.threadId || run.id,
        gatewayId: gateway.id,
        gatewayType: gateway.type,
        source: 'chat_widget',
      };
      await this.runRepository.save(run);
    }

    // Persist the agent's reply for the widget poll endpoint once the
    // run completes (the widget can also stream live via the run SSE).
    this.listenForCompletionAndRespond(run.id, gateway, adapter, {
      ...normalized,
      threadId: (run.metadata as any)?.threadId || normalized.threadId || run.id,
    });

    // Increment request count
    gateway.incrementRequest(true);
    await this.gatewayRepository.save(gateway);

    return {
      runId: run.id,
      threadId: (run.metadata as any)?.threadId || run.id,
    };
  }

  /**
   * Resolve a gateway for the public widget surface: must exist, be an
   * active chat_widget gateway. 404s otherwise (no auth on this path —
   * don't leak whether an id exists as a different type).
   */
  async findWidgetGateway(gatewayId: string): Promise<Gateway> {
    const gateway = await this.gatewayRepository.findOne({ where: { id: gatewayId } });
    if (!gateway || gateway.type !== GatewayType.CHAT_WIDGET || !gateway.isActive()) {
      throw new NotFoundException('Widget gateway not found or inactive');
    }
    return gateway;
  }

  /**
   * Poll surface for the widget: outbound widget messages persisted by
   * ChatWidgetAdapter.sendResponse for a given thread, oldest first.
   * `after` restricts to messages newer than the given timestamp so the
   * widget can poll incrementally.
   */
  async listWidgetMessages(
    gatewayId: string,
    threadId: string,
    after?: Date,
  ): Promise<Array<{ id: string; runId: string | null; message: string; attachments: any; createdAt: Date }>> {
    const qb = this.eventRepository
      .createQueryBuilder('event')
      .where('event.gatewayId = :gatewayId', { gatewayId })
      .andWhere('event.channelType = :channelType', { channelType: GatewayType.CHAT_WIDGET })
      .andWhere("event.direction = 'outbound'")
      .andWhere("event.payload->>'kind' = 'widget_message'")
      .andWhere("event.payload->>'threadId' = :threadId", { threadId })
      .orderBy('event.createdAt', 'ASC')
      .limit(100);
    if (after) {
      qb.andWhere('event.createdAt > :after', { after });
    }
    const events = await qb.getMany();
    return events.map((e) => ({
      id: e.id,
      runId: e.runId,
      message: e.payload?.message ?? '',
      attachments: e.payload?.attachments ?? null,
      createdAt: e.createdAt,
    }));
  }

  // ---------------------------------------------------------------------------
  // Run ownership check (for widget stream security)
  // ---------------------------------------------------------------------------

  /**
   * Verify that a given run belongs to the given gateway (same agent,
   * same org, and tagged with the gateway id in metadata).
   */
  async assertRunBelongsToGateway(gatewayId: string, runId: string): Promise<void> {
    const gateway = await this.gatewayRepository.findOne({ where: { id: gatewayId } });
    if (!gateway || !gateway.isActive()) {
      throw new NotFoundException('Gateway not found or inactive');
    }

    const run = await this.runRepository.findOne({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException('Run not found');
    }

    const metaGatewayId = (run.metadata as any)?.gatewayId;
    if (
      run.agentId !== gateway.agentId ||
      run.organizationId !== gateway.organizationId ||
      metaGatewayId !== gatewayId
    ) {
      throw new NotFoundException('Run not found');
    }
  }

  // ---------------------------------------------------------------------------
  // Event log helpers
  // ---------------------------------------------------------------------------

  private static readonly MAX_PAYLOAD_BYTES = 16 * 1024;

  /**
   * Persist a single channel event. Always returns; never throws — a
   * failure to log must not break the actual channel flow.
   */
  private async logEvent(
    gateway: Gateway,
    direction: 'inbound' | 'outbound',
    status: 'received' | 'processed' | 'failed',
    payload: Record<string, any> | null,
    errorMessage?: string | null,
    runId?: string,
  ): Promise<void> {
    try {
      await this.eventRepository.save(this.eventRepository.create({
        organizationId: gateway.organizationId,
        gatewayId: gateway.id,
        channelType: gateway.type,
        direction,
        status,
        payload,
        errorMessage: errorMessage ?? null,
        runId: runId ?? null,
      }));
    } catch (err: any) {
      this.logger.warn(`Failed to log channel event: ${err.message ?? err}`);
    }
  }

  /**
   * Defensive truncation: a webhook payload can be arbitrarily large
   * (image attachments, full message history, etc.). We keep the JSON
   * shape but drop the deep contents past MAX_PAYLOAD_BYTES so the
   * audit table doesn't bloat. Truncated rows note the original size.
   */
  private truncatePayload(payload: any): Record<string, any> | null {
    if (!payload) return null;
    try {
      const json = JSON.stringify(payload);
      if (json.length <= ChannelGatewayService.MAX_PAYLOAD_BYTES) {
        return JSON.parse(json);
      }
      return {
        _truncated: true,
        _originalBytes: json.length,
        preview: json.slice(0, ChannelGatewayService.MAX_PAYLOAD_BYTES),
      };
    } catch {
      return { _unserializable: true };
    }
  }

  // ---------------------------------------------------------------------------
  // Event log API for the controller
  // ---------------------------------------------------------------------------

  /**
   * List events for a gateway (most recent first). Bounded by `limit`
   * (default 100, max 500). Caller is responsible for verifying the
   * caller has access to the gateway before calling this.
   */
  async listEventsForGateway(
    gatewayId: string,
    limit = 100,
  ): Promise<ChannelEvent[]> {
    return this.eventRepository.find({
      where: { gatewayId },
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 500),
    });
  }

  // ---------------------------------------------------------------------------
  // Test connection — exercises the adapter against the saved config
  // ---------------------------------------------------------------------------

  /**
   * Best-effort connectivity check. Each adapter type has different
   * "is the config plausibly correct" signals; we run a cheap call
   * (e.g. Slack's auth.test, Telegram's getMe) and return the result
   * without persisting anything. Caller must verify gateway access
   * (RBAC) before invoking.
   */
  async testConnection(gateway: Gateway): Promise<{ ok: boolean; detail: string }> {
    const adapter = this.getAdapter(gateway.type);
    const cfg = gateway.configuration || {};
    try {
      switch (gateway.type) {
        case GatewayType.SLACK: {
          if (!cfg.bot_token) return { ok: false, detail: 'bot_token not configured' };
          const res = await fetch('https://slack.com/api/auth.test', {
            headers: { Authorization: `Bearer ${cfg.bot_token}` },
          });
          const json: any = await res.json().catch(() => ({}));
          return json?.ok ? { ok: true, detail: `connected as ${json.user || '?'}` }
                          : { ok: false, detail: json?.error || 'auth.test failed' };
        }
        case GatewayType.TELEGRAM: {
          if (!cfg.bot_token) return { ok: false, detail: 'bot_token not configured' };
          const res = await fetch(`https://api.telegram.org/bot${cfg.bot_token}/getMe`);
          const json: any = await res.json().catch(() => ({}));
          return json?.ok ? { ok: true, detail: `bot @${json?.result?.username || '?'}` }
                          : { ok: false, detail: json?.description || 'getMe failed' };
        }
        case GatewayType.DISCORD: {
          if (!cfg.bot_token) return { ok: false, detail: 'bot_token not configured' };
          const res = await fetch('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `Bot ${cfg.bot_token}` },
          });
          if (!res.ok) return { ok: false, detail: `users/@me ${res.status}` };
          const json: any = await res.json().catch(() => ({}));
          return { ok: true, detail: `bot ${json?.username || '?'}` };
        }
        case GatewayType.WHATSAPP: {
          if (!cfg.twilio_account_sid || !cfg.twilio_auth_token) {
            return { ok: false, detail: 'twilio_account_sid + twilio_auth_token required' };
          }
          const auth = Buffer.from(`${cfg.twilio_account_sid}:${cfg.twilio_auth_token}`).toString('base64');
          const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.twilio_account_sid}.json`, {
            headers: { Authorization: `Basic ${auth}` },
          });
          return res.ok ? { ok: true, detail: 'twilio creds ok' }
                        : { ok: false, detail: `twilio ${res.status}` };
        }
        case GatewayType.MICROSOFT_TEAMS: {
          if (!cfg.bot_id || !cfg.bot_password) return { ok: false, detail: 'bot_id + bot_password required' };
          const tokenRes = await fetch('https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: cfg.bot_id,
              client_secret: cfg.bot_password,
              scope: 'https://api.botframework.com/.default',
            }).toString(),
          });
          const json: any = await tokenRes.json().catch(() => ({}));
          return json.access_token ? { ok: true, detail: 'access token issued' }
                                   : { ok: false, detail: json.error_description || 'token request failed' };
        }
        case GatewayType.GOOGLE_CHAT:
        case GatewayType.IRC:
        case GatewayType.WEBHOOK: {
          if (!cfg.webhook_url && !cfg.callback_url) {
            return { ok: false, detail: 'webhook_url not configured' };
          }
          // For these, the only check we can perform without sending
          // is a HEAD probe to the configured endpoint (best-effort).
          const url = cfg.webhook_url || cfg.callback_url;
          try {
            const res = await fetch(url, { method: 'HEAD' });
            return { ok: res.status < 500, detail: `HEAD ${res.status}` };
          } catch (e: any) {
            return { ok: false, detail: `unreachable: ${e?.message ?? e}` };
          }
        }
        case GatewayType.SIGNAL: {
          if (!cfg.api_url || !cfg.phone_number) return { ok: false, detail: 'api_url + phone_number required' };
          try {
            const res = await fetch(`${cfg.api_url}/v1/about`);
            return res.ok ? { ok: true, detail: 'signal-cli reachable' }
                          : { ok: false, detail: `about ${res.status}` };
          } catch (e: any) {
            return { ok: false, detail: `unreachable: ${e?.message ?? e}` };
          }
        }
        case GatewayType.MATRIX: {
          if (!cfg.homeserver_url || !cfg.access_token) return { ok: false, detail: 'homeserver_url + access_token required' };
          const res = await fetch(`${cfg.homeserver_url}/_matrix/client/r0/account/whoami`, {
            headers: { Authorization: `Bearer ${cfg.access_token}` },
          });
          const json: any = await res.json().catch(() => ({}));
          return res.ok ? { ok: true, detail: `matrix user ${json?.user_id || '?'}` }
                        : { ok: false, detail: json?.errcode || `whoami ${res.status}` };
        }
        case GatewayType.EMAIL: {
          if (!cfg.resend_api_key) return { ok: false, detail: 'resend_api_key not configured' };
          const res = await fetch('https://api.resend.com/domains', {
            headers: { Authorization: `Bearer ${cfg.resend_api_key}` },
          });
          return res.ok ? { ok: true, detail: 'resend api key valid' }
                        : { ok: false, detail: `resend ${res.status}` };
        }
        case GatewayType.CHAT_WIDGET:
          // No outbound — widget polls. Always reachable.
          return { ok: true, detail: 'widget mode (no outbound to test)' };
        default:
          return { ok: false, detail: `no test-connection check for type ${gateway.type}` };
      }
    } catch (err: any) {
      return { ok: false, detail: err?.message ?? String(err) };
    }
  }
}
