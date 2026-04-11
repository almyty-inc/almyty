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
      return;
    }

    // Normalize inbound message
    const normalized: NormalizedMessage = adapter.normalizeInbound(body);

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

          const responseText =
            (typeof finalRun.output === 'string'
              ? finalRun.output
              : finalRun.output?.text) || 'No response';

          const formatted = adapter.formatOutbound({ text: responseText });
          await adapter.sendResponse(gateway.configuration, formatted, {
            threadId: normalized.threadId,
            channel: normalized.metadata?.channel,
            userId: normalized.userId,
          });
        } catch (err) {
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

    // Increment request count
    gateway.incrementRequest(true);
    await this.gatewayRepository.save(gateway);

    return {
      runId: run.id,
      threadId: (run.metadata as any)?.threadId || run.id,
    };
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
}
