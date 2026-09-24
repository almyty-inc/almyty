import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import { isUniqueViolation } from '../../../common/utils/unique-violation';
import { Gateway, GatewayType } from '../../../entities/gateway.entity';
import { GatewayRateLimitService } from '../gateway-rate-limit.service';
import { AgentRun } from '../../../entities/agent-run.entity';
import { ChannelEvent, ChannelEventStatus } from '../../../entities/channel-event.entity';
import { AgentRuntimeService } from '../../agents/agent-runtime.service';
import { BaseAdapter, NormalizedMessage } from './adapters/base.adapter';
import { ChatWidgetAdapter } from './adapters/chat-widget.adapter';
import { SlackAdapter } from './adapters/slack.adapter';
import { DiscordAdapter } from './adapters/discord.adapter';
import { TelegramAdapter } from './adapters/telegram.adapter';
import { WhatsAppAdapter } from './adapters/whatsapp.adapter';
import { WhatsAppCloudAdapter } from './adapters/whatsapp-cloud.adapter';
import { SmsAdapter } from './adapters/sms.adapter';
import { EmailAdapter } from './adapters/email.adapter';
import { WebhookAdapter } from './adapters/webhook.adapter';
import { GoogleChatAdapter } from './adapters/google-chat.adapter';
import { MicrosoftTeamsAdapter } from './adapters/microsoft-teams.adapter';
import { SignalAdapter } from './adapters/signal.adapter';
import { MatrixAdapter } from './adapters/matrix.adapter';
import { IrcAdapter } from './adapters/irc.adapter';
import { ChannelInstallationService } from './channel-installation.service';
import { ChannelCredentialService, ChannelUsePurpose } from './channel-credential.service';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';
import { outboundFailureDetail, safeFetch } from '../../../common/security/safe-fetch';
import { isPrivateGateway } from '../private-gateway';
import { gatewayPrincipal } from '../../../common/authorization/execution-access.service';

/**
 * A handle on a `channel_events` row, so a later step can finish it.
 *
 * `eventId` is what our own insert came back with. A claim taken over
 * from a replica that died mid-run was not inserted by us and has no
 * id here, so the (gatewayId, deliveryId) pair — which the partial
 * unique index guarantees names at most one row — addresses it instead.
 */
interface ChannelEventRef {
  eventId: string | null;
  gatewayId: string;
  deliveryId: string | null;
}

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
    private readonly whatsAppCloudAdapter: WhatsAppCloudAdapter,
    private readonly smsAdapter: SmsAdapter,
    private readonly emailAdapter: EmailAdapter,
    private readonly webhookAdapter: WebhookAdapter,
    private readonly googleChatAdapter: GoogleChatAdapter,
    private readonly microsoftTeamsAdapter: MicrosoftTeamsAdapter,
    private readonly signalAdapter: SignalAdapter,
    private readonly matrixAdapter: MatrixAdapter,
    private readonly ircAdapter: IrcAdapter,
    // Optional so existing unit tests and minimal contexts can
    // construct the service without the installation subsystem.
    @Optional() private readonly installationService?: ChannelInstallationService,
    // Optional so positional unit tests can construct the service; when
    // present, warms a BYO-KMS org's DEK before the sync getChannelConfig
    // reads so `encrypted:kms:` secrets can be unwrapped.
    @Optional() private readonly envelopeCrypto?: EnvelopeCryptoService,
    // Per-sender share of a public channel surface. Optional for the same
    // positional-construction reason as the two above.
    @Optional() private readonly gatewayRateLimit?: GatewayRateLimitService,
    // Optional for the same reason. When present, channel secrets are
    // read from the credential store the gateway's connection lives in.
    @Optional() private readonly channelCredentials?: ChannelCredentialService,
    // Optional for the same reason, and advisory even when present: the
    // fast path for the inbound delivery dedupe. Correctness lives in
    // the unique index, so an absent or unreachable Redis costs a DB
    // round trip and nothing else.
    @Optional() @InjectRedis() private readonly redis?: Redis.Redis,
  ) {

    this.adapters = new Map<string, BaseAdapter>([
      [GatewayType.CHAT_WIDGET, this.chatWidgetAdapter],
      // A hosted chat app persists replies exactly like the widget does;
      // only the front end and the URL differ.
      [GatewayType.HOSTED_CHAT, this.chatWidgetAdapter],
      [GatewayType.SLACK, this.slackAdapter],
      [GatewayType.DISCORD, this.discordAdapter],
      [GatewayType.TELEGRAM, this.telegramAdapter],
      [GatewayType.WHATSAPP, this.whatsAppAdapter],
      [GatewayType.WHATSAPP_CLOUD, this.whatsAppCloudAdapter],
      [GatewayType.SMS, this.smsAdapter],
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

  /**
   * The channel's effective configuration: connection secrets merged
   * over the normalized, decrypted row. Public so the unified endpoint
   * and the transports read through the same seam.
   */
  async channelConfig(gateway: Gateway, purpose: ChannelUsePurpose): Promise<Record<string, any>> {
    return ChannelCredentialService.resolveWith(this.channelCredentials, this.envelopeCrypto, gateway, purpose);
  }

  getAdapter(type: string): BaseAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new BadRequestException(`No handler found for channel type: ${type}`);
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
    rawBody?: string,
  ): Promise<void> {
    if (!gateway.isActive()) {
      this.logger.warn(`Webhook received for inactive gateway: ${gateway.id}`);
      return;
    }
    // A channel is reached by people who do not sign in to almyty, so a
    // private one has nobody it may answer; the write path refuses them,
    // and one that exists anyway stays silent.
    if (isPrivateGateway(gateway)) {
      this.logger.warn(`Inbound message refused for private gateway: ${gateway.id}`);
      return;
    }

    const adapter = this.getAdapter(gateway.type);

    // Multi-workspace resolution: when the payload carries a platform
    // tenant id (e.g. Slack team_id) and an active installation exists
    // for it, that installation's credentials (its own bot token)
    // override the gateway's single-workspace configuration for both
    // verification context and the reply. Gateways without
    // installations keep the existing single-credential behavior.
    //
    // channelConfig resolves the gateway's connection through the
    // credential store (inline values are the shim), decrypts and
    // normalizes legacy camelCase keys onto the snake_case names the
    // adapters read.
    let effectiveConfig: Record<string, any> = await this.channelConfig(gateway, 'channel_inbound');
    const tenantId = adapter.extractTenantId(body);
    if (tenantId && this.installationService) {
      try {
        const creds = await this.installationService.resolveCredentials(gateway.id, String(tenantId));
        if (creds) {
          effectiveConfig = { ...effectiveConfig, ...creds };
        }
      } catch (err: any) {
        this.logger.warn(
          `installation resolution failed (gateway ${gateway.id}, tenant ${tenantId}): ${err?.message ?? err}`,
        );
      }
    }

    // Verify webhook signature
    const isValid = await adapter.verifyWebhook(body, headers, effectiveConfig, rawBody);
    if (!isValid) {
      this.logger.warn(`Webhook signature verification failed for gateway: ${gateway.id}`);
      // truncatePayload, like every other logEvent call in this file.
      // This one took the raw body, so an unauthenticated caller whose
      // signature fails still got their full payload persisted to
      // channel_events — a write amplifier on the one path that exists
      // precisely to record requests we did not trust.
      await this.logEvent(
        gateway,
        'inbound',
        'failed',
        this.truncatePayload(body),
        'signature verification failed',
      );
      return;
    }

    // Normalize inbound message
    const normalized: NormalizedMessage = adapter.normalizeInbound(body);

    // One delivery, one run.
    //
    // Every hosted channel here redelivers: Slack retries any event it
    // did not get a response to within three seconds, Telegram repeats
    // an update until it is acknowledged, Twilio and the Bot Framework
    // retry a dropped connection. The controller answered 200 before
    // this ran, so the retry arrives while the first delivery is still
    // in flight — and on another replica, whose thread lookup below
    // finds nothing because the run is still being created. One user
    // message then produced two runs, two LLM bills and two replies.
    // Signature verification authenticates a redelivery; it cannot
    // recognize one.
    //
    // The claim is the insert of the inbound event: `deliveryId` is
    // unique per gateway, so the replica that inserts first owns the
    // delivery and every other one is turned away by the database.
    //
    // A claim is a lease, not a tombstone. A replica that claims a
    // delivery and dies mid-run would otherwise have the platform's
    // retry rejected and the user's message dropped with nothing said —
    // trading two replies for no reply. `logEvent` takes over a claim
    // left in `received` past the lease; see
    // `reclaimAbandonedDelivery`.
    //
    // Redis is a fast path so the common duplicate does not wait on a DB
    // round trip. Its TTL matches the lease so a cache hit can only ever
    // mean "claimed, and still good", and it fails open to the index.
    const deliveryId = adapter.deliveryId(body, headers) ?? null;
    if (deliveryId && (await this.deliveryAlreadyClaimedInCache(gateway.id, deliveryId))) {
      this.logger.log(
        `Duplicate delivery ${deliveryId} for gateway ${gateway.id} — claimed within the lease, dropped`,
      );
      return;
    }
    const claim = await this.logEvent(
      gateway,
      'inbound',
      'received',
      this.truncatePayload(body),
      null,
      undefined,
      deliveryId,
    );
    if (!claim) {
      this.logger.log(
        `Duplicate delivery ${deliveryId} for gateway ${gateway.id} — already handled, dropped`,
      );
      return;
    }

    // Each platform sender gets their own share of the surface, so one
    // person in a Slack workspace cannot use up the whole product's
    // allowance. The webhook's source address is the platform's, not the
    // sender's, so no per-IP scope here.
    const senderId = normalized.userId && normalized.userId !== 'unknown' ? normalized.userId : null;
    if (senderId && this.gatewayRateLimit) {
      const own = await this.gatewayRateLimit.checkVisitor(gateway, { endUserId: senderId, clientHash: null });
      if (own.limited) {
        // On the claim row rather than beside it: this delivery is
        // finished, and a claim left in `received` is one the lease
        // hands to the platform's next retry.
        await this.markInboundOutcome(claim, {
          status: 'failed',
          errorMessage: own.message ?? 'sender rate limited',
        });
        return;
      }
    }

    // Find existing run for this thread on this gateway, or start a new
    // one. Scoped to the gateway, not just the agent: one agent sits
    // behind several surfaces, and the public widget lets its caller
    // pick any threadId, so an agent-wide match would let a thread
    // opened on one surface capture messages sent on another.
    let run: AgentRun | null = null;

    if (normalized.threadId) {
      const existingRuns = await this.runRepository
        .createQueryBuilder('run')
        .where('run.agentId = :agentId', { agentId: gateway.agentId })
        .andWhere("run.metadata->>'gatewayId' = :gatewayId", { gatewayId: gateway.id })
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
      // The cross-link the claim row was always meant to carry: without
      // it an operator holding "the bot never answered me at 14:05" has
      // an inbound row and no way to reach the run that answered it.
      await this.markInboundOutcome(claim, { runId: run.id });
      this.listenForCompletionAndRespond(run.id, gateway, adapter, normalized, effectiveConfig, claim);
    } else {
      // The channel's facts travel WITH the run row rather than in a
      // follow-up save. The thread lookup above keys on
      // metadata->>'threadId', and a second write left a window in
      // which the run existed with no threadId on it — so a concurrent
      // message in the same thread could not see it and started a
      // second run. startRun writes `options.metadata` as part of the
      // insert, which closes the window.
      const newRun = await this.agentRuntimeService.startRun(
        gateway.agentId,
        gateway.organizationId,
        // Nobody with an account here started this. `normalized.userId`
        // is the platform's own id for the sender ("U012ABC" on Slack),
        // and putting it in a column that references `users` made every
        // conversation write fail, so a channel could not answer at all.
        // The sender is recorded in metadata, where the rest of the
        // channel's facts already live.
        null,
        normalized.text,
        {
          maxSteps: 25,
          metadata: {
            channelUserId: normalized.userId,
            threadId: normalized.threadId,
            gatewayId: gateway.id,
            gatewayType: gateway.type,
            source: normalized.metadata?.source || gateway.type,
          },
          // Runs in the gateway's scope: a channel serves its agent only
          // while the gateway's own visibility covers it, checked on every
          // message.
          principal: gatewayPrincipal(gateway),
        },
      );

      await this.markInboundOutcome(claim, { runId: newRun.id });
      this.listenForCompletionAndRespond(newRun.id, gateway, adapter, normalized, effectiveConfig, claim);
    }

    // Inbound traffic count, as an atomic column bump rather than a
    // save() of the whole row: the entity was loaded before config
    // resolution, signature verification, the rate-limit check and
    // startRun, so by now its `status` and `configuration` can be
    // hundreds of milliseconds stale. save() diffs the stale copy
    // against the row and writes it back, which turned a gateway an
    // admin had just deactivated back to active, and reverted channel
    // credentials rotated a moment earlier. Traffic could keep a
    // gateway alive against its owner's wishes.
    await this.incrementRequestCount(gateway.id);
  }

  /**
   * Atomic request-count bump. Touches only the three counter columns,
   * so nothing a concurrent writer put in `status` or `configuration`
   * is clobbered, and concurrent requests cannot lose increments to a
   * read-modify-write. Same shape as GatewaysService.incrementRequestCount
   * and the protocol path's bump.
   */
  private async incrementRequestCount(gatewayId: string): Promise<void> {
    try {
      await this.gatewayRepository
        .createQueryBuilder()
        .update(Gateway)
        .set({
          totalRequests: () => '"totalRequests" + 1',
          successfulRequests: () => '"successfulRequests" + 1',
          lastRequestAt: new Date(),
        })
        .where('id = :id', { id: gatewayId })
        .execute();
    } catch (err: any) {
      this.logger.warn(`Failed to update gateway request metrics: ${err?.message ?? err}`);
    }
  }

  /**
   * Fast duplicate check in Redis: SET NX on the delivery key claims it
   * for whoever gets there first. Returns true when someone already
   * holds the claim.
   *
   * Advisory only. Without Redis, or when Redis is unreachable, this
   * returns false and the unique index on channel_events does the
   * actual rejecting — never the other way round, because a cache is
   * not allowed to be the thing standing between a real message and an
   * answer.
   */
  private async deliveryAlreadyClaimedInCache(gatewayId: string, deliveryId: string): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const key = `channel_delivery:${gatewayId}:${deliveryId}`;
      const claimed = await this.redis.set(key, '1', 'EX', ChannelGatewayService.DELIVERY_CLAIM_TTL_SECONDS, 'NX');
      return claimed === null;
    } catch (err: any) {
      this.logger.warn(`Delivery dedupe cache check failed, falling through to the index: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * How long a delivery claim stays in the cache.
   *
   * Deliberately the same as `DELIVERY_CLAIM_LEASE_MS`, not longer. A
   * cache hit short-circuits before the database is consulted, so a
   * cache entry that outlived the lease would drop a redelivery the
   * lease says is now takeable — reintroducing the lost message for as
   * long as the entry survived. Matching the two means a hit always
   * means "claimed, and the claim is still good", and anything past the
   * lease falls through to the row, where the takeover is decided.
   */
  private static readonly DELIVERY_CLAIM_TTL_SECONDS = 10 * 60;

  /**
   * Listen for a run to complete and send the response back via the adapter.
   * `sendConfig` (optional) carries installation-resolved credentials for
   * multi-workspace gateways; omitted, the gateway's own configuration
   * is used. `inbound` (optional) is the claim row for the delivery this
   * run answers, so its outcome can be written back onto it.
   */
  private listenForCompletionAndRespond(
    runId: string,
    gateway: Gateway,
    adapter: BaseAdapter,
    normalized: NormalizedMessage,
    sendConfig?: Record<string, any>,
    inbound?: ChannelEventRef | null,
  ): void {
    const emitter = this.agentRuntimeService.getRunEmitter(runId);
    if (!emitter) {
      // The emitter is process-local and the run travels through
      // BullMQ, so it can finish on a replica that never saw this
      // registration — or after this pod was recycled. The run then
      // completes, costs its tokens, and the reply is never sent. That
      // used to leave one warning line carrying a run id and no trace
      // anywhere an operator looks, so a customer's "it never answered"
      // was unanswerable. It gets a row.
      const reason =
        `the reply was dropped: no run listener in this process for run ${runId}, ` +
        'so the completed run never reached the channel';
      this.logger.error(`No emitter found for run ${runId}, cannot send response`);
      void this.logEvent(gateway, 'outbound', 'failed', null, reason, runId);
      // The inbound claim keeps its runId but stays `received` on
      // purpose: nothing answered this delivery, so the platform's
      // retry should be allowed to take the lease and try again.
      void this.markInboundOutcome(inbound, { runId });
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
            await adapter.sendResponse(
              sendConfig ?? (await this.channelConfig(gateway, 'channel_outbound')),
              formatted,
              {
              // Every key normalizeInbound recorded is forwarded, because
              // adapters read reply-routing hints straight off this object
              // under the platform's own name: Telegram wants chatId,
              // Discord wants channelId, email wants messageId/references
              // for In-Reply-To. Listing them one by one is how those three
              // ended up undefined at send time, which sent Telegram and
              // Discord replies to a literal "undefined" id and silently
              // dropped mail threading.
              ...(normalized.metadata ?? {}),
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
            // sendResponse resolves only when the platform accepted the
            // message, so this row means delivered rather than
            // attempted.
            await this.logEvent(gateway, 'outbound', 'processed', this.truncatePayload(formatted), null, runId);
            await this.markInboundOutcome(inbound, { status: 'processed', runId });
          } catch (sendErr: any) {
            // The platform's own wording — "not_in_channel",
            // "chat not found", "Missing Access" — is what makes this
            // row worth reading.
            const reason = sendErr?.message ?? String(sendErr);
            await this.logEvent(gateway, 'outbound', 'failed', this.truncatePayload(formatted), reason, runId);
            await this.markInboundOutcome(inbound, { status: 'failed', runId, errorMessage: reason });
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

    // Check for existing run with this threadId ON THIS GATEWAY. The
    // threadId comes from the request body of a public endpoint, and
    // other surfaces behind the same agent key their threads on values
    // an outsider can know (an SMS sender's phone number, a Telegram
    // chat id). Matching on the agent alone let a widget caller feed
    // text into someone else's live conversation and read the reply.
    let run: AgentRun | null = null;

    if (normalized.threadId) {
      const existingRuns = await this.runRepository
        .createQueryBuilder('run')
        .where('run.agentId = :agentId', { agentId: gateway.agentId })
        .andWhere("run.metadata->>'gatewayId' = :gatewayId", { gatewayId: gateway.id })
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
      const channelMetadata = {
        channelUserId: normalized.userId,
        gatewayId: gateway.id,
        gatewayType: gateway.type,
        source: 'chat_widget',
        ...(normalized.threadId ? { threadId: normalized.threadId } : {}),
      };
      run = await this.agentRuntimeService.startRun(
        gateway.agentId,
        gateway.organizationId,
        // Nobody with an account here started this. `normalized.userId`
        // is the platform's own id for the sender ("U012ABC" on Slack),
        // and putting it in a column that references `users` made every
        // conversation write fail, so a channel could not answer at all.
        // The sender is recorded in metadata, where the rest of the
        // channel's facts already live. Written with the insert so the
        // gateway-scoped thread lookup above can see the run at once.
        null,
        normalized.text,
        // Runs in the gateway's scope: a channel serves its agent only while
        // the gateway's own visibility covers it, checked on every message.
        { maxSteps: 25, metadata: channelMetadata, principal: gatewayPrincipal(gateway) },
      );

      run.metadata = {
        ...(run.metadata || {}),
        ...channelMetadata,
        threadId: normalized.threadId || run.id,
      };
      await this.runRepository.save(run);
    }

    // Persist the agent's reply for the widget poll endpoint once the
    // run completes (the widget can also stream live via the run SSE).
    this.listenForCompletionAndRespond(run.id, gateway, adapter, {
      ...normalized,
      threadId: (run.metadata as any)?.threadId || normalized.threadId || run.id,
    });

    await this.incrementRequestCount(gateway.id);

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
    if (!gateway || gateway.type !== GatewayType.CHAT_WIDGET || !gateway.isActive() || isPrivateGateway(gateway)) {
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
   * How long a delivery claim is honoured before a redelivery may take
   * it over. Long enough that a slow run is not reprocessed; short
   * enough that a message lost to a dying pod is answered on the
   * platform's next retry rather than never.
   */
  private static readonly DELIVERY_CLAIM_LEASE_MS = ChannelGatewayService.DELIVERY_CLAIM_TTL_SECONDS * 1000;

  /**
   * Persist a single channel event.
   *
   * Returns null ONLY when the insert lost the race on
   * `UQ_channel_events_gateway_delivery` and the claim it lost to is
   * still good — this gateway has already accepted a delivery carrying
   * this `deliveryId`, so the caller is holding a redelivery and must
   * stop. Every other outcome returns a handle on the row, because a
   * logging problem must neither break the channel flow nor silently
   * drop real traffic: it is warned and swallowed exactly as before,
   * and the handle then simply addresses nothing.
   */
  private async logEvent(
    gateway: Gateway,
    direction: 'inbound' | 'outbound',
    status: 'received' | 'processed' | 'failed',
    payload: Record<string, any> | null,
    errorMessage?: string | null,
    runId?: string,
    deliveryId?: string | null,
  ): Promise<ChannelEventRef | null> {
    try {
      const saved = await this.eventRepository.save(this.eventRepository.create({
        organizationId: gateway.organizationId,
        gatewayId: gateway.id,
        channelType: gateway.type,
        direction,
        status,
        payload,
        errorMessage: errorMessage ?? null,
        runId: runId ?? null,
        deliveryId: deliveryId ?? null,
      }));
      return {
        eventId: (saved as any)?.id ?? null,
        gatewayId: gateway.id,
        deliveryId: deliveryId ?? null,
      };
    } catch (err: any) {
      // With a deliveryId in play the only unique constraint this
      // insert can hit is the dedupe index, and hitting it is an answer
      // rather than a failure.
      if (deliveryId && isUniqueViolation(err)) {
        return this.reclaimAbandonedDelivery(gateway.id, deliveryId);
      }
      this.logger.warn(`Failed to log channel event: ${err.message ?? err}`);
      return { eventId: null, gatewayId: gateway.id, deliveryId: deliveryId ?? null };
    }
  }

  /**
   * Record how a claimed inbound delivery turned out.
   *
   * The claim row is inserted as `received` and nothing used to move it
   * again, which cost more than a gap in the audit trail: the lease
   * below reads "still `received` past the lease" as abandoned, so a
   * delivery that was handled perfectly well stayed takeable forever
   * and the platform's next retry — Slack's is thirty minutes out —
   * started a second run, paid for a second LLM call and sent the user
   * a second reply. Reaching `processed` (or `failed`) is what makes
   * the lease mean what its doc comment says it means.
   *
   * Addressed by row id where we have one, and otherwise by the
   * (gatewayId, deliveryId) pair the unique index already guarantees is
   * a single row — which is how a claim taken over from a dead replica,
   * where no insert of ours produced an id, is still finished properly.
   */
  private async markInboundOutcome(
    ref: ChannelEventRef | null,
    patch: { status?: ChannelEventStatus; runId?: string; errorMessage?: string | null },
  ): Promise<void> {
    if (!ref) return;
    const where = ref.eventId
      ? { id: ref.eventId }
      : ref.deliveryId
        ? { gatewayId: ref.gatewayId, deliveryId: ref.deliveryId }
        : null;
    // A channel whose platform offers no stable delivery id, logged by
    // a repository that handed back no row id, leaves nothing to
    // address. Nothing to do, and nothing worth failing a reply over.
    if (!where) return;
    try {
      await this.eventRepository.update(where, patch);
    } catch (err: any) {
      this.logger.warn(`Failed to update channel event outcome: ${err?.message ?? err}`);
    }
  }

  /**
   * Whether a delivery whose claim already exists may be taken over.
   *
   * Keying the claim on the delivery id alone makes it at-most-once: a
   * replica that claims a delivery and then dies — OOM, eviction, a
   * rolling deploy — leaves a claim nobody is working on, and the
   * platform's retry is turned away by the index. The user's message is
   * then silently dropped, with an event row that says `received` and a
   * thread that never gets an answer. Trading two replies for no reply
   * is not an improvement.
   *
   * So a claim is a lease. A claim still in `received` after
   * `DELIVERY_CLAIM_LEASE_MS` is assumed abandoned and the retry takes
   * it, with the takeover itself conditional on the row still looking
   * abandoned — so several simultaneous retries produce exactly one
   * winner. A claim that reached `processed` or `failed` was finished by
   * somebody and the retry is a genuine duplicate; `markInboundOutcome`
   * is what puts it in one of those two states.
   *
   * This is effectively-once rather than exactly-once, which is the most
   * any at-least-once transport can be given. The remaining window is
   * one lease long, and the alternative is losing messages.
   *
   * Returns a handle on the reclaimed row, or null when the claim stands.
   */
  private async reclaimAbandonedDelivery(
    gatewayId: string,
    deliveryId: string,
  ): Promise<ChannelEventRef | null> {
    const cutoff = new Date(Date.now() - ChannelGatewayService.DELIVERY_CLAIM_LEASE_MS);
    try {
      const takeover = await this.eventRepository
        .createQueryBuilder()
        .update()
        .set({ createdAt: () => 'NOW()' } as any)
        .where('"gatewayId" = :gatewayId', { gatewayId })
        .andWhere('"deliveryId" = :deliveryId', { deliveryId })
        .andWhere('status = :received', { received: 'received' })
        .andWhere('"createdAt" < :cutoff', { cutoff })
        .execute();

      if ((takeover.affected ?? 0) > 0) {
        this.logger.warn(
          `Delivery ${deliveryId} on gateway ${gatewayId} was claimed and abandoned; ` +
            'taking it over on this redelivery.',
        );
        // No insert of ours produced this row, so it is addressed by
        // the pair the unique index keys on.
        return { eventId: null, gatewayId, deliveryId };
      }
    } catch (err: any) {
      // A failed takeover attempt must not look like a successful claim,
      // or a duplicate gets processed. Fall through to dropping it.
      this.logger.warn(`Could not evaluate the claim on delivery ${deliveryId}: ${err.message ?? err}`);
    }
    return null;
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
    this.getAdapter(gateway.type); // throws for an unsupported channel type
    // Decrypted + key-normalized view — testConnection exercises the
    // same credentials the adapters would use, resolved through the
    // credential store when the channel points at a connection.
    const cfg = await this.channelConfig(gateway, 'channel_outbound');
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
        case GatewayType.WHATSAPP:
        case GatewayType.SMS: {
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
        case GatewayType.WHATSAPP_CLOUD: {
          if (!cfg.access_token || !cfg.phone_number_id) {
            return { ok: false, detail: 'access_token + phone_number_id required' };
          }
          const res = await fetch(
            `https://graph.facebook.com/v20.0/${cfg.phone_number_id}?fields=id`,
            { headers: { Authorization: `Bearer ${cfg.access_token}` } },
          );
          return res.ok ? { ok: true, detail: 'whatsapp cloud phone number reachable' }
                        : { ok: false, detail: `graph api ${res.status}` };
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
        case GatewayType.GOOGLE_CHAT:
        case GatewayType.IRC:
        case GatewayType.WEBHOOK: {
          if (!cfg.webhook_url && !cfg.callback_url) {
            return { ok: false, detail: 'webhook_url not configured' };
          }
          // For these, the only check we can perform without sending
          // is a HEAD probe to the configured endpoint (best-effort).
          //
          // Gated, and the failure detail is uniform. Ungated this was an
          // internal port scanner an admin could drive from the dashboard:
          // `HEAD 200/401/404` versus `unreachable: connect ECONNREFUSED`
          // separates "port open, speaks HTTP" from "closed" for any
          // address in the cluster.
          const url = cfg.webhook_url || cfg.callback_url;
          try {
            const res = await safeFetch(url, { method: 'HEAD' });
            return { ok: res.status < 500, detail: `HEAD ${res.status}` };
          } catch (e: any) {
            return { ok: false, detail: outboundFailureDetail(e) };
          }
        }
        case GatewayType.SIGNAL: {
          if (!cfg.api_url || !cfg.phone_number) return { ok: false, detail: 'api_url + phone_number required' };
          try {
            const res = await safeFetch(`${cfg.api_url}/v1/about`);
            return res.ok ? { ok: true, detail: 'signal-cli reachable' }
                          : { ok: false, detail: 'signal-cli did not accept the probe' };
          } catch (e: any) {
            return { ok: false, detail: outboundFailureDetail(e) };
          }
        }
        case GatewayType.MATRIX: {
          if (!cfg.homeserver_url || !cfg.access_token) return { ok: false, detail: 'homeserver_url + access_token required' };
          try {
            const res = await safeFetch(`${cfg.homeserver_url}/_matrix/client/r0/account/whoami`, {
              headers: { Authorization: `Bearer ${cfg.access_token}` },
            });
            const json: any = await res.json().catch(() => ({}));
            return res.ok ? { ok: true, detail: `matrix user ${json?.user_id || '?'}` }
                          : { ok: false, detail: 'the homeserver did not accept the access token' };
          } catch (e: any) {
            return { ok: false, detail: outboundFailureDetail(e) };
          }
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
