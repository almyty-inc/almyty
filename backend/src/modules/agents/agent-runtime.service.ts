import { Injectable, Logger, NotFoundException, BadRequestException, Inject, Optional, forwardRef, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { AgentRun, AgentRunStatus, AgentMode } from '../../entities/agent-run.entity';
import { Agent } from '../../entities/agent.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Organization } from '../../entities/organization.entity';
import { Tool } from '../../entities/tool.entity';
import { EventEmitter } from 'events';
import { LlmProvidersService } from '../llm-providers/llm-providers.service';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { CanonicalMemoryService } from '../memory/canonical/canonical-memory.service';
import { Tier } from '../memory/canonical/canonical.types';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { AgentRuntimeBuilders } from './agent-runtime-builders';
import { AgentCollaborationHelper } from './agent-collaboration.helper';
import { AgentHeartbeatHelper } from './agent-heartbeat.helper';
import { AgentBuiltInToolsHelper } from './agent-builtin-tools.helper';
import { AgentRuntimeEventsHelper } from './agent-runtime-events.helper';
import { AgentRuntimeMiscHelper } from './agent-runtime-misc.helper';
import { AgentStepProcessor } from './agent-step-processor';
import { ApprovalsService } from '../approvals/approvals.service';
import { describeLimitTrip } from './run-limits';
import { BudgetsService } from '../budgets/budgets.service';
import {
  ExecutionAccessService,
  ExecutionPrincipal,
  userPrincipal,
} from '../../common/authorization/execution-access.service';

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
  request_approval: {
    name: 'request_approval',
    description: 'Pause execution and request human approval before proceeding. The run halts at WAITING_APPROVAL until an authorized user approves or rejects via the UI. On approval, this tool resolves with { approved: true, decision_reason }; on rejection the run terminates as cancelled.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why this action requires human approval (shown to the approver).' },
        payload: { type: 'object', description: 'Optional structured details about what would happen on approval (the action plan, tool args, diff, etc.).' },
      },
      required: ['reason'],
    },
  },
};


/** Page size for GET /agents/:id/runs when the caller does not ask for one. */
export const DEFAULT_RUNS_PAGE_SIZE = 20;
/**
 * Hard ceiling on one page of runs. Matches the ceiling `tools.service.ts`
 * and `gateways.service.ts` already apply to their own list endpoints.
 */
export const MAX_RUNS_PAGE_SIZE = 100;

/**
 * Columns the runs list response emits. `workingMemory` is deliberately
 * absent — it is the run's scratch state, is never rendered in the list, and
 * is one of the larger json columns on the row.
 */
export const AGENT_RUN_LIST_COLUMNS = {
  id: true,
  agentId: true,
  organizationId: true,
  userId: true,
  endUserId: true,
  conversationId: true,
  mode: true,
  status: true,
  steps: true,
  currentStep: true,
  maxSteps: true,
  input: true,
  output: true,
  error: true,
  totalCost: true,
  totalTokens: true,
  executionTime: true,
  recursionDepth: true,
  toolCallCount: true,
  metadata: true,
  limits: true,
  parentRunId: true,
  createdAt: true,
  updatedAt: true,
} as const;
@Injectable()
export class AgentRuntimeService implements OnModuleInit {
  readonly logger = new Logger(AgentRuntimeService.name);

  onModuleInit(): void {
    // Wire the emitter cleanup hook so terminal events flush
    // collaboration-temp agents tied to the run.
    this.events.setCleanupHook((runId) => this.misc.cleanupTemporaryAgents(runId));
    // HITL: when an approval is decided, resume or terminate the run.
    this.approvals.on('approval.decided', async (approval: any) => {
      try {
        await this.handleApprovalDecided(approval);
      } catch (err: any) {
        this.logger.error(`approval.decided handler failed for run ${approval?.runId}: ${err?.message ?? err}`);
      }
    });
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
    // Optional so the runtime still constructs in tests and in any
    // context where the audit module is not wired; a missing audit sink
    // must not stop runs.
    @Optional()
    private readonly auditLogService: AuditLogService | undefined,
    @Inject(forwardRef(() => AgentStepProcessor))
    readonly processor: AgentStepProcessor,
    @Inject(forwardRef(() => ApprovalsService))
    readonly approvals: ApprovalsService,
    readonly budgets: BudgetsService,
    // The team/private execution gate every run start goes through.
    readonly executionAccess: ExecutionAccessService,
  ) {}

  /**
   * Start a new autonomous agent run
   */
  /**
   * Start an autonomous run.
   *
   * `userId` is a dashboard user, or null when a visitor on a published
   * surface started this. Their identity goes in `options.endUserId`:
   * an end user has no account here, so putting their id in `userId`
   * writes a value into a column that references `users` and every
   * conversation write after it fails.
   */
  async startRun(
    agentId: string,
    organizationId: string,
    userId: string | null,
    input: any,
    options?: {
      maxSteps?: number;
      maxCostCents?: number;
      maxDurationMs?: number;
      parentRunId?: string;
      conversationId?: string;
      endUserId?: string | null;
      /** Extra run metadata the surface wants the runtime to see (e.g. visitorMemory). */
      metadata?: Record<string, any>;
      /**
       * Whose scope the run executes in. A top-level run is its starter's
       * (session, API key, the owner at a heartbeat) or its gateway's; a
       * child run passes its parent's (principalOfRun) so the whole tree
       * stays in the scope it started in. Without one the run is `userId`'s.
       */
      principal?: ExecutionPrincipal;
      /**
       * The caller drives this run's steps itself, through processStep, and
       * waits on nothing: no first step is queued. A strategy's child run
       * (an explorer, an agent panelist or teammate) is driven this way by
       * the worker already running its parent, so a parent never holds the
       * only worker while its child waits in the queue behind it.
       */
      inline?: boolean;
    },

  ): Promise<AgentRun> {
    const principal: ExecutionPrincipal = options?.principal ?? userPrincipal(userId);
    const agent = await this.agentRepository.findOne({ where: { id: agentId, organizationId } });
    // A team agent runs only for its team (and org owners/admins, the same
    // rule that lets them see it); another member's private agent runs for
    // nobody else -- as a top-level run, a collaboration participant, or a
    // child run. Same answer as a missing agent.
    await this.executionAccess.assertCanExecute(principal, agent, 'Agent');

    if (agent.mode !== 'autonomous') {
      throw new BadRequestException('Agent is not in autonomous mode. Use /invoke for workflow agents.');
    }

    // Cross-run spend-budget enforcement (P2 cost governance). Runs
    // BEFORE any conversation/run row is created so a rejected run
    // leaves no residue. For a `reject` budget this throws
    // BudgetExceededException (403); for `warn_log` it records an alert
    // and returns; with no matching budget it is a no-op. This is the
    // org/period ceiling — the per-run `maxCostCents` cap below is
    // unchanged and still stops an individual run mid-flight.
    await this.budgets.enforceForRun(organizationId, agentId);

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
    // How many ancestors this run will have. Persisted onto the row as
    // `recursionDepth`, which is the ledger `checkRunLimits` compares
    // `maxRecursionDepth` against -- a column nothing ever wrote, so that
    // comparison was always 0 > N and RECURSION_DEPTH_EXCEEDED could not
    // fire. Depth 0 is a top-level run.
    let recursionDepth = 0;
    if (options?.parentRunId) {
      // Hard, unconditional ceiling on recursive run nesting. A per-agent
      // collaboration.rules.maxChainDepth may tighten this but never loosen
      // it. Without an absolute cap, an autonomous agent with
      // canCallAgents/canCreateAgents (or a cycle A->B->A) could spawn child
      // runs without bound — a fork-bomb that exhausts the worker pool, DB,
      // and LLM budget.
      const HARD_MAX_CHAIN_DEPTH = 10;
      const configured = agent.collaboration?.rules?.maxChainDepth;
      const maxChainDepth = configured
        ? Math.min(configured, HARD_MAX_CHAIN_DEPTH)
        : HARD_MAX_CHAIN_DEPTH;
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
          select: { id: true, parentRunId: true },
        });
        if (!parentRun || !parentRun.parentRunId) break;
        depth++;
        currentParentId = parentRun.parentRunId;
      }
      recursionDepth = depth;

      // The configured ceiling, on top of the absolute one above.
      // `maxRecursionDepth` is resolved min-wins across the operator env
      // floor, the organization and the agent, and until now the only thing
      // that ever read it was a comparison against a column that stayed 0 --
      // so an operator who set RUN_LIMIT_MAX_RECURSION_DEPTH got the
      // hard-coded 10 regardless. Rejected here rather than at the child's
      // first step, so a run that cannot be allowed leaves no row behind.
      const nestedLimits = await this.misc.resolveLimits({
        organizationId,
        agent,
        maxSteps: options?.maxSteps,
        limits: {
          ...(options?.maxSteps ? { maxSteps: options.maxSteps } : {}),
          ...(options?.maxCostCents ? { maxCostCents: options.maxCostCents } : {}),
          ...(options?.maxDurationMs ? { maxDurationMs: options.maxDurationMs } : {}),
        },
      } as unknown as AgentRun);
      if (recursionDepth > nestedLimits.maxRecursionDepth) {
        const trip = describeLimitTrip('RECURSION_DEPTH_EXCEEDED');
        throw new BadRequestException(`${trip.code}: ${trip.message}`);
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
        userId: userId ?? undefined,
        endUserId: options?.endUserId ?? null,
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
      userId: userId ?? null,
      endUserId: options?.endUserId ?? null,
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
      // Whose scope the run executes in, for every step the queue worker
      // processes later: child runs and tool calls are authorized against
      // this, not against the resources they name.
      principal,
      // The nesting ledger, counted above. Written here so the per-step
      // `checkRunLimits` compares a real number instead of the column's
      // default 0 -- which is what made RECURSION_DEPTH_EXCEEDED dead code.
      recursionDepth,
      toolCallCount: 0,
      ...(options?.metadata ? { metadata: { ...options.metadata } } : {}),
    });

    const savedRun = await this.runRepository.save(run);

    savedRun.agent = agent;

    // Audit the ceilings that actually applied, resolved rather than
    // requested, so a later question of "which limits governed this run"
    // has an answer that does not depend on replaying today's policy
    // against yesterday's run.
    void this.recordResolvedLimits(savedRun, agent, userId);

    // Create event emitter for this run (for SSE streaming)
    this.events.ensureRunEmitter(savedRun.id);

    // Enqueue first step, unless the caller drives the run itself.
    if (!options?.inline) {
      await this.runtimeQueue.add('next-step', { runId: savedRun.id, seq: 0 }, {
        jobId: `step:${savedRun.id}:0`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      });
    }

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
      relations: { agent: true },
    });
    if (!run) throw new NotFoundException('Run not found');
    return run;
  }

  /**
   * List runs for an agent.
   *
   * `limit` is caller-set, so it needs a ceiling: `?limit=100000` used to put
   * 100,000 rows in heap each carrying its full `steps` array. The number is
   * the same one `tools.service.ts` and `gateways.service.ts` already use.
   * `workingMemory` is projected away — it is the run's scratch state and
   * nothing in the list response emits it.
   */
  async listRuns(agentId: string, organizationId: string, page = 1, limit = 20) {
    const take = Math.min(
      Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_RUNS_PAGE_SIZE,
      MAX_RUNS_PAGE_SIZE,
    );
    const currentPage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const skip = (currentPage - 1) * take;
    const [data, total] = await this.runRepository.findAndCount({
      where: { agentId, organizationId },
      order: { createdAt: 'DESC' },
      select: AGENT_RUN_LIST_COLUMNS,
      skip,
      take,
    });
    return { data, total, page: currentPage, limit: take, totalPages: Math.ceil(total / take) };
  }

  /**
   * Cancel a run. Optional agentId argument asserts the run belongs
   * to that agent (for the /agents/:id/runs/:runId/cancel route).
   * Optional userId names who did it on the audit row; both are appended
   * last so no existing positional caller shifts.
   */
  async cancelRun(runId: string, organizationId: string, agentId?: string, userId?: string): Promise<AgentRun> {
    const run = await this.getRun(runId, organizationId, agentId);
    if (run.isDone()) {
      throw new BadRequestException('Run is already completed');
    }
    run.status = AgentRunStatus.CANCELLED;
    await this.runRepository.save(run);
    this.emitEvent(runId, 'run.cancelled', {});

    // RUN_CANCEL was declared on AuditAction and emitted by nothing.
    // Cancelling stops work the organization is paying for and any member
    // can do it, so it leaves a row like every other sensitive action.
    // Fire and forget, for the same reason run_start is.
    this.auditLogService
      ?.log({
        organizationId,
        userId,
        action: AuditAction.RUN_CANCEL,
        resourceType: AuditResource.AGENT_RUN,
        resourceId: run.id,
        details: {
          kind: 'autonomous_run',
          agentId: run.agentId,
          cancelledAtStep: run.currentStep,
          totalCost: run.totalCost,
          totalTokens: run.totalTokens,
        },
      })
      .catch((err: any) => {
        this.logger.warn(`Could not audit cancel for run ${run.id}: ${err?.message}`);
      });

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

    // Resume execution. Seed the seq from a timestamp so the resumed
    // job's id sits outside the sequential range used before the pause,
    // and a duplicate resume within the same tick still collapses to one.
    const resumeSeq = Date.now();
    await this.runtimeQueue.add('next-step', { runId, seq: resumeSeq }, {
      jobId: `step:${runId}:${resumeSeq}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });

    return run;
  }

  /** Get SSE event emitter for a run. */
  /**
   * Emit a run_start audit event carrying the resolved limits snapshot.
   *
   * Fire and forget: an audit write must never be the reason a run fails
   * to start, and the ceilings are enforced at the point of use whether
   * or not this row lands.
   */
  private async recordResolvedLimits(
    run: AgentRun,
    agent: Agent,
    userId: string | null,
  ): Promise<void> {
    try {
      const limits = await this.misc.resolveLimits(run);
      await this.auditLogService?.log({
        organizationId: run.organizationId,
        userId: userId ?? undefined,
        action: AuditAction.RUN_START,
        resourceType: AuditResource.AGENT,
        resourceId: agent.id,
        resourceName: agent.name,
        details: { runId: run.id, resolvedLimits: limits },
      });
    } catch (err: any) {
      this.logger.warn(`Could not audit resolved limits for run ${run.id}: ${err.message}`);
    }
  }

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

  /**
   * React to an approval decision. On 'approved' the run is moved
   * back to RUNNING and re-queued for the next step. On 'rejected'
   * /'expired' the run is cancelled with the decision_reason.
   */
  private async handleApprovalDecided(approval: {
    runId: string;
    status: 'approved' | 'rejected' | 'expired';
    decisionReason: string | null;
    toolCallId: string | null;
  }): Promise<void> {
    const run = await this.runRepository.findOne({ where: { id: approval.runId } });
    if (!run) return;
    if (run.status !== AgentRunStatus.WAITING_APPROVAL) return;

    if (approval.status === 'approved') {
      run.status = AgentRunStatus.RUNNING;
      await this.runRepository.save(run);
      // Same seq-from-timestamp rule as the resume path above, and for
      // the same reason. Without a seq the processor read it as 0 and
      // enqueued the next step as `step:<runId>:1` -- an id already in
      // Redis from before the pause, which Bull drops silently. The run
      // then sat RUNNING with nothing queued until the reaper timed it
      // out half an hour later with a misleading "worker likely
      // terminated".
      const resumeSeq = Date.now();
      await this.runtimeQueue.add('next-step', { runId: run.id, seq: resumeSeq }, {
        jobId: `step:${run.id}:${resumeSeq}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      });
      this.logger.log(`run ${run.id} resumed after approval`);
    } else {
      run.status = AgentRunStatus.CANCELLED;
      run.error = approval.status === 'expired'
        ? 'approval expired'
        : `approval rejected${approval.decisionReason ? `: ${approval.decisionReason}` : ''}`;
      await this.runRepository.save(run);
      this.logger.log(`run ${run.id} cancelled after approval ${approval.status}`);
    }
  }
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
