import { Injectable, Logger, NotFoundException, BadRequestException, Inject, forwardRef, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { AgentRun, AgentRunStatus, AgentMode } from '../../entities/agent-run.entity';
import { Agent } from '../../entities/agent.entity';
import { Organization } from '../../entities/organization.entity';
import { Tool } from '../../entities/tool.entity';
import { EventEmitter } from 'events';
import { LlmProvidersService, ChatRequest, ChatResponse } from '../llm-providers/llm-providers.service';
import { ToolExecutorService, ToolExecutionOptions, ToolExecutionResult } from '../tools/tool-executor.service';
import { CanonicalMemoryService } from '../memory/canonical/canonical-memory.service';
import { MemoryError, Provenance, Tier } from '../memory/canonical/canonical.types';
import { MessageRole } from '../../entities/message.entity';
import { Conversation, ConversationStatus } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { batchAsync } from '../../common/utils/batch-async';
import { AgentRuntimeBuilders } from './agent-runtime-builders';
import { AgentCollaborationHelper } from './agent-collaboration.helper';
import { AgentHeartbeatHelper } from './agent-heartbeat.helper';
import { AgentBuiltInToolsHelper } from './agent-builtin-tools.helper';
import { AgentRuntimeEventsHelper } from './agent-runtime-events.helper';
import { AgentRuntimeMiscHelper } from './agent-runtime-misc.helper';
import { AgentStepProcessor } from './agent-step-processor';

/**
 * Built-in tool definitions that the agent runtime injects for autonomous agents.
 */
export const BUILT_IN_TOOLS = {
  wait: {
    name: 'wait',
    description: 'Pause execution for a specified duration (in seconds). Use this when you need to wait before continuing, e.g. waiting for an external process.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Number of seconds to wait (1-3600)' },
        reason: { type: 'string', description: 'Why the agent is waiting' },
      },
      required: ['seconds'],
    },
  },
  ask_user: {
    name: 'ask_user',
    description: 'Ask the user a question and wait for their response. Use this when you need clarification or approval.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
      },
      required: ['question'],
    },
  },
  store_memory: {
    name: 'store_memory',
    description: 'Save an important fact, preference, or piece of context to long-term memory for future use.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory content to store' },
        type: { type: 'string', enum: ['fact', 'preference', 'context', 'episode', 'instruction'], description: 'Type of memory' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['content'],
    },
  },
  recall_memory: {
    name: 'recall_memory',
    description: 'Search long-term memory for relevant information about a topic.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in memory' },
        limit: { type: 'number', description: 'Max number of results (default 5)' },
      },
      required: ['query'],
    },
  },
};

/** Interval between orphaned-emitter sweeps. */
const RUNTIME_EMITTER_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

@Injectable()
export class AgentRuntimeService implements OnModuleInit {
  readonly logger = new Logger(AgentRuntimeService.name);

  onModuleInit(): void {
    // Wire the emitter cleanup hook so terminal events flush
    // collaboration-temp agents tied to the run.
    this.events.setCleanupHook((runId) => this.misc.cleanupTemporaryAgents(runId));
  }

  constructor(
    @InjectRepository(AgentRun)
    readonly runRepository: Repository<AgentRun>,
    @InjectRepository(Agent)
    readonly agentRepository: Repository<Agent>,
    @InjectRepository(Tool)
    readonly toolRepository: Repository<Tool>,
    @InjectRepository(Organization)
    readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Conversation)
    readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Message)
    readonly messageRepository: Repository<Message>,
    @InjectQueue('agent-runtime')
    readonly runtimeQueue: Queue,
    @Inject(forwardRef(() => LlmProvidersService))
    readonly llmProvidersService: LlmProvidersService,
    @Inject(forwardRef(() => ToolExecutorService))
    readonly toolExecutorService: ToolExecutorService,
    @Inject(forwardRef(() => CanonicalMemoryService))
    readonly memoryService: CanonicalMemoryService,
    @InjectRedis() readonly redis: Redis,
    readonly builders: AgentRuntimeBuilders,
    readonly heartbeat: AgentHeartbeatHelper,
    @Inject(forwardRef(() => AgentCollaborationHelper))
    readonly collaboration: AgentCollaborationHelper,
    @Inject(forwardRef(() => AgentBuiltInToolsHelper))
    readonly builtInTools: AgentBuiltInToolsHelper,
    readonly events: AgentRuntimeEventsHelper,
    readonly misc: AgentRuntimeMiscHelper,
    @Inject(forwardRef(() => AgentStepProcessor))
    readonly processor: AgentStepProcessor,
  ) {}

  /**
   * Start a new autonomous agent run
   */
  async startRun(
    agentId: string,
    organizationId: string,
    userId: string,
    input: any,
    options?: {
      maxSteps?: number;
      maxCostCents?: number;
      maxDurationMs?: number;
      parentRunId?: string;
      conversationId?: string;
    },
  ): Promise<AgentRun> {
    const agent = await this.agentRepository.findOne({ where: { id: agentId, organizationId } });
    if (!agent) throw new NotFoundException('Agent not found');

    if (agent.mode !== 'autonomous') {
      throw new BadRequestException('Agent is not in autonomous mode. Use /invoke for workflow agents.');
    }

    // Enforce maxChainDepth: count how many ancestors the new run will have
    // by walking the parentRunId chain. The new run's nesting level equals
    // (ancestor count) + 1, so we reject when ancestor count >= maxChainDepth.
    //
    // The previous version only checked AFTER finding another grandparent,
    // so a maxChainDepth of 1 ("only roots") never fired even when creating
    // a child of a root run. Now the check fires from the start (depth=1
    // means "the new run already has 1 ancestor — its parent"), and again
    // after each step up the chain.
    //
    // Also added a hard iteration cap (MAX_PARENT_WALK) so a corrupted
    // parent chain with a cycle can't loop forever.
    if (options?.parentRunId && agent.collaboration?.rules?.maxChainDepth) {
      const maxChainDepth = agent.collaboration.rules.maxChainDepth;
      const MAX_PARENT_WALK = 1000;
      let depth = 1;
      let currentParentId: string | null = options.parentRunId;
      let walks = 0;
      while (currentParentId) {
        if (depth >= maxChainDepth) {
          throw new BadRequestException(`Chain depth limit exceeded (max: ${maxChainDepth})`);
        }
        if (++walks > MAX_PARENT_WALK) {
          this.logger.warn(`Parent chain walk exceeded ${MAX_PARENT_WALK} hops for run ${currentParentId} — possible cycle, aborting walk`);
          break;
        }
        // Scope the parent-chain walk to the caller's org. Without
        // this, a caller in org A could pass a parent run id from
        // org B and the walker would traverse org B's chain to
        // calculate depth — a cross-org probe vector (the walker's
        // depth outcome observably affects whether the new run is
        // accepted or rejected).
        const parentRun = await this.runRepository.findOne({
          where: { id: currentParentId, organizationId },
          select: ['id', 'parentRunId'],
        });
        if (!parentRun || !parentRun.parentRunId) break;
        depth++;
        currentParentId = parentRun.parentRunId;
      }
    }

    // Reuse an existing conversation or create a new one
    let savedConversation: Conversation;
    if (options?.conversationId) {
      const existing = await this.conversationRepository.findOne({
        where: { id: options.conversationId, organizationId },
      } as any);
      if (!existing) {
        throw new BadRequestException('Conversation not found');
      }
      savedConversation = existing;
    } else {
      const conversation = Conversation.createConversation({
        agentId,
        organizationId,
        userId,
      });
      savedConversation = await this.conversationRepository.save(conversation);
    }

    // Persist initial user message
    const userMessage = Message.createUserMessage(
      savedConversation.id,
      typeof input === 'string' ? input : JSON.stringify(input),
    );
    await this.messageRepository.save(userMessage);

    const run = this.runRepository.create({
      agentId,
      organizationId,
      userId,
      conversationId: savedConversation.id,
      mode: AgentMode.AUTONOMOUS,
      status: AgentRunStatus.RUNNING,
      input,
      steps: [],
      currentStep: 0,
      maxSteps: options?.maxSteps || 50,
      limits: {
        maxSteps: options?.maxSteps || 50,
        maxDurationMs: options?.maxDurationMs || 3600000, // 1 hour
        maxCostCents: options?.maxCostCents || 100,       // $1
        maxToolCalls: 100,
      },
      parentRunId: options?.parentRunId || null,
    });

    const savedRun = await this.runRepository.save(run);

    // Create event emitter for this run (for SSE streaming)
    this.events.ensureRunEmitter(savedRun.id);

    // Enqueue first step
    await this.runtimeQueue.add('next-step', { runId: savedRun.id }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    });

    this.logger.log(`Started run ${savedRun.id} for agent ${agent.name}`);
    return savedRun;
  }

  /**
   * Process one step of a run (called by BullMQ processor).
   * Makes a single LLM call. If the LLM returns tool_calls, executes them and returns 'continue'.
   * If the LLM returns content without tool_calls, the run is done.
   */
  /**
   * Process one step of a run (called by BullMQ processor). Delegates
   * to AgentStepProcessor — see that file for the full inner loop.
   */
  async processStep(runId: string): Promise<'continue' | 'done' | 'waiting'> {
    return this.processor.processStep(runId);
  }

  // ---------------------------------------------------------------------------
  // Built-in tool execution
  // ---------------------------------------------------------------------------

  /**
   * Execute a built-in tool. Returns null if the tool name is not a built-in.
   */

  // ---------------------------------------------------------------------------
  // Public API (unchanged)
  // ---------------------------------------------------------------------------

  /**
   * Get a run by ID. Optionally also asserts that the run belongs to
   * a specific agent — the run-scoped controller endpoints
   * `/agents/:id/runs/:runId/...` use this to enforce routing
   * correctness. Previously the `:id` path segment was decorative:
   * any runId in the caller's org would resolve through the endpoint
   * regardless of which agent it was attached to, which meant the
   * URL path wasn't actually a hierarchical constraint.
   */
  async getRun(runId: string, organizationId: string, agentId?: string): Promise<AgentRun> {
    const run = await this.runRepository.findOne({
      where: agentId
        ? { id: runId, organizationId, agentId }
        : { id: runId, organizationId },
      relations: ['agent'],
    });
    if (!run) throw new NotFoundException('Run not found');
    return run;
  }

  /**
   * List runs for an agent
   */
  async listRuns(agentId: string, organizationId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await this.runRepository.findAndCount({
      where: { agentId, organizationId },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Cancel a run. Optional agentId argument asserts the run belongs
   * to that agent (for the /agents/:id/runs/:runId/cancel route).
   */
  async cancelRun(runId: string, organizationId: string, agentId?: string): Promise<AgentRun> {
    const run = await this.getRun(runId, organizationId, agentId);
    if (run.isDone()) {
      throw new BadRequestException('Run is already completed');
    }
    run.status = AgentRunStatus.CANCELLED;
    await this.runRepository.save(run);
    this.emitEvent(runId, 'run.cancelled', {});
    return run;
  }

  /**
   * Send input to a waiting run (human-in-the-loop). Same optional
   * agentId assertion as cancelRun.
   */
  async sendInput(runId: string, organizationId: string, input: string, agentId?: string): Promise<AgentRun> {
    const run = await this.getRun(runId, organizationId, agentId);
    if (run.status !== AgentRunStatus.WAITING_INPUT) {
      throw new BadRequestException('Run is not waiting for input');
    }

    // Persist user message
    if (run.conversationId) {
      const userMsg = Message.createUserMessage(run.conversationId, input);
      userMsg.runId = run.id;
      await this.messageRepository.save(userMsg);
    }
    run.status = AgentRunStatus.RUNNING;
    await this.runRepository.save(run);

    // Resume execution
    await this.runtimeQueue.add('next-step', { runId }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });

    return run;
  }

  /** Get SSE event emitter for a run. */
  getRunEmitter(runId: string): EventEmitter | null {
    return this.events.getRunEmitter(runId);
  }

  /** Emit an event for SSE subscribers. */
  emitEvent(runId: string, type: string, data: any) {
    this.events.emitEvent(runId, type, data);
  }

  /** Subscribe to run events via Redis Streams (cross-pod). */
  async subscribeRunEvents(
    runId: string,
    handler: (event: { type: string; data: any; timestamp: string }) => void,
    signal?: AbortSignal,
    timeoutMs = 300_000,
  ): Promise<void> {
    return this.events.subscribeRunEvents(runId, handler, signal, timeoutMs);
  }

  /** Best-effort periodic sweep of orphaned run emitters. */
  async sweepOrphanedRunEmitters(): Promise<void> {
    return this.events.sweepOrphanedRunEmitters();
  }

  // ── Delegations to AgentRuntimeMiscHelper ──
  waitForRun(...args: Parameters<AgentRuntimeMiscHelper['waitForRun']>) { return this.misc.waitForRun(...args); }

  // ── Delegations to AgentHeartbeatHelper
  enableHeartbeat(...args: Parameters<AgentHeartbeatHelper['enableHeartbeat']>) { return this.heartbeat.enableHeartbeat(...args); }
  disableHeartbeat(...args: Parameters<AgentHeartbeatHelper['disableHeartbeat']>) { return this.heartbeat.disableHeartbeat(...args); }
}

/**
 * Translate a legacy `type` parameter ('fact', 'preference', 'context',
 * 'episode', 'instruction') into a canonical memory tier. The legacy
 * type field carried two orthogonal axes — durability and shape —
 * that the canonical schema separates: durability becomes `tier`, shape
 * becomes free-form metadata. This mapping keeps existing prompts and
 * agent definitions working without re-prompting.
 */
export function legacyTypeToTier(t: string | undefined): Tier {
  switch (t) {
    case 'context':
      return 'short';
    case 'fact':
    case 'preference':
    case 'instruction':
      return 'long';
    case 'episode':
    default:
      return 'project';
  }
}
