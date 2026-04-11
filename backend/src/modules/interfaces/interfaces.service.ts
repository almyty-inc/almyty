import { Injectable, Logger, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentInterface, InterfaceType, InterfaceStatus } from '../../entities/interface.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AgentRuntimeService } from '../agents/agent-runtime.service';
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
export class InterfacesService {
  private readonly logger = new Logger(InterfacesService.name);
  private readonly adapters: Map<string, BaseAdapter>;

  constructor(
    @InjectRepository(AgentInterface)
    private readonly interfaceRepository: Repository<AgentInterface>,
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    private readonly auditLogService: AuditLogService,
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
      [InterfaceType.CHAT_WIDGET, this.chatWidgetAdapter],
      [InterfaceType.SLACK, this.slackAdapter],
      [InterfaceType.DISCORD, this.discordAdapter],
      [InterfaceType.TELEGRAM, this.telegramAdapter],
      [InterfaceType.WHATSAPP, this.whatsAppAdapter],
      [InterfaceType.EMAIL, this.emailAdapter],
      [InterfaceType.WEBHOOK, this.webhookAdapter],
      [InterfaceType.GOOGLE_CHAT, this.googleChatAdapter],
      [InterfaceType.MICROSOFT_TEAMS, this.microsoftTeamsAdapter],
      [InterfaceType.SIGNAL, this.signalAdapter],
      [InterfaceType.MATRIX, this.matrixAdapter],
      [InterfaceType.IRC, this.ircAdapter],
    ]);
  }

  // ---------------------------------------------------------------------------
  // Adapter lookup
  // ---------------------------------------------------------------------------

  getAdapter(type: string): BaseAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new BadRequestException(`No adapter found for interface type: ${type}`);
    }
    return adapter;
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  async create(
    organizationId: string,
    data: {
      agentId: string;
      type: InterfaceType;
      name: string;
      configuration?: Record<string, any>;
      metadata?: Record<string, any>;
    },
  ): Promise<AgentInterface> {
    const iface = this.interfaceRepository.create({
      organizationId,
      agentId: data.agentId,
      type: data.type,
      name: data.name,
      status: InterfaceStatus.INACTIVE,
      configuration: data.configuration || {},
      metadata: data.metadata || null,
    });
    const saved = await this.interfaceRepository.save(iface);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, action: AuditAction.INTERFACE_DEPLOY, resourceType: AuditResource.INTERFACE, resourceId: saved.id, resourceName: saved.name, details: { type: saved.type, agentId: data.agentId } });

    return saved;
  }

  async findAll(organizationId: string, agentId?: string) {
    const where: any = { organizationId };
    if (agentId) where.agentId = agentId;
    return this.interfaceRepository.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  async findById(id: string, organizationId: string): Promise<AgentInterface> {
    const iface = await this.interfaceRepository.findOne({ where: { id, organizationId } });
    if (!iface) throw new NotFoundException('Interface not found');
    return iface;
  }

  /**
   * Find an interface by ID without org scoping (for public endpoints like webhooks/widgets).
   */
  async findByIdPublic(id: string): Promise<AgentInterface | null> {
    return this.interfaceRepository.findOne({ where: { id } });
  }

  /**
   * Verify that a given run id actually belongs to the given interface
   * (same agent, same org, and — for runs started via this service —
   * tagged with the interface id in run metadata). Throws
   * NotFoundException on any mismatch so the caller can't use the
   * endpoint as a cross-interface stream oracle. The NotFound (not
   * Forbidden) response keeps the error shape indistinguishable
   * whether the interface, the run, or the linkage is wrong.
   */
  async assertRunBelongsToInterface(interfaceId: string, runId: string): Promise<void> {
    const iface = await this.findByIdPublic(interfaceId);
    if (!iface || !iface.isActive()) {
      throw new NotFoundException('Interface not found or inactive');
    }

    const run = await this.runRepository.findOne({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException('Run not found');
    }

    // Defence in depth: agentId must match and metadata must carry the
    // same interface id. A run from a different interface on the same
    // agent also fails here, which is the point — the widget stream
    // endpoint is per-interface.
    const metaInterfaceId = (run.metadata as any)?.interfaceId;
    if (
      run.agentId !== iface.agentId ||
      run.organizationId !== iface.organizationId ||
      metaInterfaceId !== interfaceId
    ) {
      throw new NotFoundException('Run not found');
    }
  }

  async update(id: string, organizationId: string, data: Partial<{
    name: string;
    status: InterfaceStatus;
    configuration: Record<string, any>;
    metadata: Record<string, any>;
  }>): Promise<AgentInterface> {
    const iface = await this.findById(id, organizationId);

    // Whitelist updatable fields. The controller types the body with
    // an inline Partial<{...}> — TypeScript only. Nest's global
    // ValidationPipe(whitelist) strips unknown keys for *decorated
    // DTO classes*, not inline types, so otherwise a PATCH with
    // {organizationId, agentId, createdBy, totalMessages, ...} would
    // flow straight through Object.assign and save() would persist
    // the change (including re-homing the interface to a different
    // tenant).
    const patch: Partial<AgentInterface> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.status !== undefined) patch.status = data.status;
    if (data.configuration !== undefined) patch.configuration = data.configuration;
    if (data.metadata !== undefined) patch.metadata = data.metadata;

    Object.assign(iface, patch);
    return this.interfaceRepository.save(iface);
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const iface = await this.findById(id, organizationId);
    await this.interfaceRepository.remove(iface);

    // Audit log (fire-and-forget)
    this.auditLogService.logDelete(organizationId, undefined, AuditResource.INTERFACE, id, iface.name);
  }

  async activate(id: string, organizationId: string): Promise<AgentInterface> {
    return this.update(id, organizationId, { status: InterfaceStatus.ACTIVE });
  }

  async deactivate(id: string, organizationId: string): Promise<AgentInterface> {
    return this.update(id, organizationId, { status: InterfaceStatus.INACTIVE });
  }

  async incrementMessages(id: string, organizationId: string): Promise<void> {
    // The org-scoped WHERE prevents a cross-tenant counter bump
    // in the rare case that a caller passes the wrong interfaceId
    // (e.g. a rehydrated webhook payload pointing at another org's
    // interface by mistake). The atomic `"totalMessages" + 1` is
    // already race-safe; this fix closes the tenancy boundary.
    await this.interfaceRepository
      .createQueryBuilder()
      .update(AgentInterface)
      .set({
        totalMessages: () => '"totalMessages" + 1',
        lastMessageAt: new Date(),
      })
      .where('id = :id AND organizationId = :organizationId', { id, organizationId })
      .execute();
  }

  async findByAgentId(
    agentId: string,
    organizationId: string,
  ): Promise<AgentInterface[]> {
    // organizationId is mandatory to prevent cross-tenant
    // enumeration — an agentId is just a UUID and can't be
    // trusted to imply the tenant on its own.
    return this.interfaceRepository.find({
      where: { agentId, organizationId },
      order: { createdAt: 'DESC' },
    });
  }

  // ---------------------------------------------------------------------------
  // Inbound webhook handling
  // ---------------------------------------------------------------------------

  /**
   * Process an inbound message from an external platform (Slack, Discord, etc.).
   * This runs asynchronously — the controller returns 200 immediately.
   */
  async handleInboundMessage(
    interfaceId: string,
    rawPayload: any,
    headers: Record<string, string>,
  ): Promise<void> {
    // 1. Look up interface
    const iface = await this.interfaceRepository.findOne({ where: { id: interfaceId } });
    if (!iface) {
      this.logger.warn(`Webhook received for unknown interface: ${interfaceId}`);
      return;
    }

    // 2. Check if active
    if (!iface.isActive()) {
      this.logger.warn(`Webhook received for inactive interface: ${interfaceId}`);
      return;
    }

    // 3. Get adapter
    const adapter = this.getAdapter(iface.type);

    // 4. Verify webhook signature
    const isValid = await adapter.verifyWebhook(rawPayload, headers, iface.configuration);
    if (!isValid) {
      this.logger.warn(`Webhook signature verification failed for interface: ${interfaceId}`);
      return;
    }

    // 5. Normalize inbound message
    const normalized: NormalizedMessage = adapter.normalizeInbound(rawPayload);

    // 6. Find existing run for this thread, or start a new one
    let run: AgentRun | null = null;

    if (normalized.threadId) {
      // Search for an active run with matching threadId in metadata
      const existingRuns = await this.runRepository
        .createQueryBuilder('run')
        .where('run.agentId = :agentId', { agentId: iface.agentId })
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
      // Existing run — add user message and resume via sendInput
      await this.agentRuntimeService.sendInput(run.id, iface.organizationId, normalized.text);

      // Resume by listening for completion
      this.listenForCompletionAndRespond(run.id, iface, adapter, normalized);
    } else {
      // New run
      const newRun = await this.agentRuntimeService.startRun(
        iface.agentId,
        iface.organizationId,
        normalized.userId,
        normalized.text,
        { maxSteps: 25 },
      );

      // Save threadId in metadata for future lookups
      newRun.metadata = {
        ...(newRun.metadata || {}),
        threadId: normalized.threadId,
        interfaceId: iface.id,
        interfaceType: iface.type,
        source: normalized.metadata?.source || iface.type,
      };
      await this.runRepository.save(newRun);

      // Listen for completion and send response
      this.listenForCompletionAndRespond(newRun.id, iface, adapter, normalized);
    }

    // 7. Increment message count (scoped to the interface's own org)
    await this.incrementMessages(interfaceId, iface.organizationId);
  }

  /**
   * Listen for a run to complete and send the response back via the adapter.
   */
  private listenForCompletionAndRespond(
    runId: string,
    iface: AgentInterface,
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
          // Get the final run state
          const finalRun = await this.runRepository.findOne({ where: { id: runId } });
          if (!finalRun) return;

          // Use run output as the response text
          const responseText = (typeof finalRun.output === 'string' ? finalRun.output : finalRun.output?.text) || 'No response';

          // Format and send via adapter
          const formatted = adapter.formatOutbound({ text: responseText });
          await adapter.sendResponse(iface.configuration, formatted, {
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

    // Safety timeout: clean up listener after 5 minutes if no completion.
    // .unref() so the pending handle doesn't keep the Node process
    // alive in tests or during graceful shutdown — the handler
    // doesn't need to fire if we're already exiting.
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
    interfaceId: string,
    body: { message: string; sessionId?: string; threadId?: string },
  ): Promise<{ runId: string; threadId: string }> {
    const iface = await this.interfaceRepository.findOne({ where: { id: interfaceId } });
    if (!iface) throw new NotFoundException('Interface not found');
    if (!iface.isActive()) throw new BadRequestException('Interface is not active');

    const adapter = this.getAdapter(iface.type);
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
        .where('run.agentId = :agentId', { agentId: iface.agentId })
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
      // Continue existing run via sendInput
      run = await this.agentRuntimeService.sendInput(run.id, iface.organizationId, normalized.text);
    } else {
      // Start new run
      run = await this.agentRuntimeService.startRun(
        iface.agentId,
        iface.organizationId,
        normalized.userId,
        normalized.text,
        { maxSteps: 25 },
      );

      run.metadata = {
        ...(run.metadata || {}),
        threadId: normalized.threadId || run.id,
        interfaceId: iface.id,
        interfaceType: iface.type,
        source: 'chat_widget',
      };
      await this.runRepository.save(run);
    }

    await this.incrementMessages(interfaceId, iface.organizationId);

    return {
      runId: run.id,
      threadId: (run.metadata as any)?.threadId || run.id,
    };
  }
}
