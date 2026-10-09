import { Inject, Injectable, Optional, forwardRef } from '@nestjs/common';
import { In, Not } from 'typeorm';

import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { Message, MessageRole } from '../../entities/message.entity';
import { AgentRuntimeService } from './agent-runtime.service';
import { ChatRequest, ChatResponse } from '../llm-providers/llm-providers.service';
import { ToolExecutionOptions, ToolExecutionResult } from '../tools/tool-executor.service';
import { Agent } from '../../entities/agent.entity';
import { AgentVerifierHelper, VerifyPanelResult } from './agent-verifier.helper';
import { AgentContextCompactor } from './agent-context-compactor.helper';
import { checkRunLimits, describeLimitTrip, formatToolError } from './run-limits';
import { AgentConstraintsService } from '../agent-constraints/agent-constraints.service';
import { findModelNotFound, isModelNotFoundError } from '../llm-providers/model-errors';
import type { RoutingPolicy } from '../model-catalog/routing/model-router';
import { decideEscalation, nextRoutingPolicy, planPosition } from '../model-catalog/routing/verify-escalation';
import { AgentMemoryKeeper } from './agent-memory.keeper';
import { agentApiIds, agentEnvironmentId, agentRunnerId, callsAgents, mayCallAgent } from './agent-capabilities';
import { Tool, ToolStatus } from '../../entities/tool.entity';
import { emitStreamChunk } from './llm-stream-events';
import { answerCallMessages, composesFinalAnswer } from './final-answer';
import { AgentRoleCall, ModelRoleCall, Team, TeamRole, stampOf, teamOf, teammateToolName } from './autonomous-team';
import { AutonomousStrategyRunner, answeredBy, chargeRole, checkedBy } from './autonomous-strategy.runner';
import type { ResolvedRunLimits } from './run-limits';
import { hitDetail, type ApprovalGateHit } from '../tools/tool-approval-gate.service';
import { NamedTool, readableToolName } from '../tools/tool-readable-name';


/**
 * `processStep` was the bulk of AgentRuntimeService — a single 500-line
 * method orchestrating the autonomous-agent inner loop. Splitting it
 * into its own class keeps the runtime service focused on
 * lifecycle / public API.
 *
 * The processor holds a `forwardRef` to AgentRuntimeService so it can
 * reach the same repos and helpers without re-injecting them. All
 * other state (run rows, conversations, messages) is read from the
 * database fresh on every step — there is no per-instance state on
 * this class.
 */

/**
 * Per-step input/output cap in the persisted json column. Shared with
 * the workflow engine's node results via `persist-cap`, so the two
 * execution shapes truncate at the same size and with the same marker.
 */
import { capPersistedPayload } from './persist-cap';
import { canReference } from '../../common/authorization/private-visibility';
import { describePrincipal, principalOfRun } from '../../common/authorization/execution-access.service';
import { updateRequestContext } from '../../common/request-context';
import { Model } from '../../entities/model.entity';
import { Api } from '../../entities/api.entity';
import { ToolDiscoveryService } from '../tool-discovery/tool-discovery.service';
import { CALL_TOOL, GET_TOOL, META_TOOL_DEFINITIONS, RUN_CODE, RUN_CODE_DEFINITION, SEARCH_TOOLS } from '../tool-discovery/meta-tools';
import { codeNames } from '../tool-discovery/tool-signature';
import { ToolModeDecision, decideToolMode } from './agent-tool-mode';
import { Organization } from '../../entities/organization.entity';
import { CodeModeService } from '../code-mode/code-mode.service';
import { codeModeLimits } from '../code-mode/code-mode.settings';
import { CodeModeConfig, grantsLeftFor } from '../code-mode/code-write-policy';
import { buildExtract } from '../code-mode/code-extract';
import { CodeResultForModel, changeSetOutcomeForModel, codeResultForModel } from '../code-mode/code-result';
import { AlwaysOnService } from './always-on/always-on.service';
import { WORKSPACE_WAKING } from '../runner/hosted-dispatch';

/** One line per namespace a script can use: `petstore (19 functions)`. */
function namespaceSummary(tools: Tool[]): string[] {
  const counts = new Map<string, number>();
  for (const { namespace } of codeNames(tools).values()) counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([ns, n]) => `${ns} (${n} function${n === 1 ? '' : 's'})`);
}
/**
 * A run in one of these is finished and no worker may write it back to
 * running — the same list `AgentRun.isDone()` answers with.
 */
const TERMINAL_STATUSES: AgentRunStatus[] = [
  AgentRunStatus.COMPLETED,
  AgentRunStatus.FAILED,
  AgentRunStatus.CANCELLED,
  AgentRunStatus.TIMEOUT,
];

/**
 * The agent columns an autonomous step actually reads.
 *
 * `relations: { agent: true }` pulled the whole agent row once per step of
 * every run, and the two heaviest columns on it — `pipeline` (workflow-only)
 * and `metadata` (which carries the inline version history) — are never read
 * on this path. Listing the rest narrows the join without costing a second
 * query. `agent-columns.spec.ts` fails if a new Agent column is added and
 * not classified here.
 */
export const AGENT_STEP_COLUMNS = {
  id: true,
  name: true,
  description: true,
  organizationId: true,
  visibility: true,
  teamId: true,
  status: true,
  version: true,
  variables: true,
  settings: true,
  mode: true,
  instructions: true,
  personality: true,
  alwaysOn: true,
  toolIds: true,
  modelConfig: true,
  memoryConfig: true,
  agentConfig: true,
  isTemporary: true,
  parentRunId: true,
  collaboration: true,
  models: true,
  webhookUrl: true,
  totalExecutions: true,
  successfulExecutions: true,
  totalCost: true,
  averageExecutionTime: true,
  lastExecutedAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Agent columns deliberately left out of AGENT_STEP_COLUMNS. Branding and
 * visitor rules face the public on the agent's channels; the limits a
 * visitor run is held to arrive on the run itself (maxCostCents, set by
 * the channel policy), so no step reads them.
 */
export const AGENT_STEP_COLUMNS_OMITTED = ['pipeline', 'metadata', 'branding', 'visitorRules', 'apiGatewayId', 'apiAccessScope', 'apiAccessTeamId'] as const;

/**
 * How long a resolved tool set stays usable across steps of a run.
 *
 * The same `IN (toolIds)` query ran on every step. A tool definition only
 * feeds the model's prompt here — ToolExecutorService re-loads the row by id
 * before it runs anything — so a short window of staleness cannot change what
 * executes, only how the next prompt describes it.
 */
const TOOL_CACHE_TTL_MS = 60_000;
/** Cap on distinct (org, toolIds) keys held at once. */
const TOOL_CACHE_MAX_ENTRIES = 200;

/** The call a run's recorded final step describes. */
type FinalCall = {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  routing?: ChatResponse['routing'];
  /** The model that answered, as the provider named it. */
  model?: string;
  messageCount: number;
  toolCount: number;
  startedAt: number;
  /** Set when the answer call did not produce the answer and the draft stood in. */
  fallback?: 'error' | 'empty';
  error?: string;
};

/**
 * A tool call an approval policy's amount rule held, waiting on
 * `run.workingMemory.gatedToolCalls` for its approval.
 */
type GatedToolCall = {
  toolCallId: string;
  toolId: string;
  toolName: string;
  parameters: Record<string, any>;
  approvalId: string;
  /** The rule in plain words. */
  rule: string;
};

/**
 * A script's change set waiting for a person (code mode), on
 * `run.workingMemory.pendingChangeSets`: the run_code call it answers, its
 * trace, its approval, and what the model will read with the outcome.
 */
type PendingChangeSet = {
  toolCallId: string;
  codeExecutionId: string;
  approvalId: string;
  forModel: CodeResultForModel;
};

@Injectable()
export class AgentStepProcessor {
  constructor(
    @Inject(forwardRef(() => AgentRuntimeService))
    private readonly s: AgentRuntimeService,
    private readonly verifier: AgentVerifierHelper,
    private readonly compactor: AgentContextCompactor,
    private readonly constraints: AgentConstraintsService,
    @Optional() discovery?: ToolDiscoveryService,
    // run_code (code mode); without it the code tool mode answers that it is not available.
    @Optional() private readonly codeMode?: CodeModeService,
    // Always on: wakes that arrive while a standing-thread run works are
    // handed to it before its next model call.
    @Optional() @Inject(forwardRef(() => AlwaysOnService)) private readonly alwaysOn?: AlwaysOnService,
  ) {
    this.discovery = discovery ?? new ToolDiscoveryService();
  }

  /** search_tools and get_tool for discover mode; keyword-only when embeddings are not wired. */
  private readonly discovery: ToolDiscoveryService;

  /**
   * Tool sets resolved for (organizationId, toolIds), with the capped payload
   * of each step memoized alongside. Bounded and TTL'd; see the constants.
   */
  private readonly toolCache = new Map<
    string,
    { at: number; tools: Awaited<ReturnType<AgentStepProcessor['loadTools']>> }
  >();

  /**
   * Per-step-object memo of the capped payload written to Postgres.
   *
   * `commitStep` rewrites the whole `steps` array every step, so capping it
   * from scratch each time re-serialized every prior step's input and output:
   * step k paid for k payloads, Σk = N²/2 for an N-step run. The step objects
   * themselves are append-only, so each one only has to be capped once. A
   * WeakMap keyed on the step object means nothing has to be invalidated and
   * a finished run's entries are collectable.
   */
  private readonly cappedStepCache = new WeakMap<object, any>();

  async processStep(runId: string): Promise<'continue' | 'done' | 'waiting'> {
    const run = await this.s.runRepository.findOne({
      where: { id: runId },
      relations: { agent: true },
      // Narrow the joined agent: `pipeline` and `metadata` are the two
      // biggest columns on the row and neither is read on the autonomous
      // path. Still one query.
      select: { agent: { ...AGENT_STEP_COLUMNS } } as any,
    });
    if (!run) {
      this.s.logger.warn(`Run ${runId} not found, skipping`);
      return 'done';
    }

    // Check if run is still active
    if (run.isDone()) {
      this.s.logger.debug(`Run ${runId} already done (${run.status}), skipping`);
      return 'done';
    }

    // Optimistic-lock token: the step number we believe we're processing.
    // Every step-completing write is guarded on this via commitStep(), so a
    // duplicate/concurrent processing of the same step can't double-count
    // cost or steps — the loser's UPDATE matches 0 rows and it aborts.
    const expectedStep = run.currentStep;

    // The organization used to be loaded twice per step with the identical
    // query — once inside resolveLimits and again ~80 lines below to build
    // the system prompt. Load it once and hand it to both.
    const organization = await this.loadOrganization(run.organizationId);

    // Enforce limits. The trip carries both a machine-readable code and
    // an explanation, so a caller can decide whether to retry smaller,
    // raise the ceiling, or escalate, rather than seeing a bare stop.
    const resolvedLimits = await this.s.misc.resolveLimits(run, organization);
    const limitCheck = checkRunLimits(run, resolvedLimits);
    if (limitCheck) {
      run.status = AgentRunStatus.FAILED;
      run.error = `${limitCheck.code}: ${limitCheck.message}`;
      run.metadata = { ...(run.metadata || {}), limitTrip: limitCheck };
      // Guarded like every other terminal write (see commitStep): the
      // trip must not overwrite a status that is already final.
      if (!(await this.commitStep(run, expectedStep))) return 'done';
      this.s.emitEvent(runId, 'run.failed', {
        error: run.error,
        reasonCode: limitCheck.code,
        reason: limitCheck.message,
      });
      return 'done';
    }

    const stepStart = Date.now();
    const agent = run.agent;

    // The run's scope, re-checked against its agent on every step, not only
    // when the run started: a run resumed after input, an approval or a
    // wait -- or one whose starter left the agent's team mid-run, or whose
    // agent moved to another team -- stops here with a reason instead of
    // carrying on in a scope it no longer has.
    const principal = principalOfRun(run);
    // An agent acting as itself is the actor of every audit row this step
    // writes (AuditLogService reads it from the scope).
    updateRequestContext({ actor: principal.kind === 'agent' ? { kind: 'agent', agentId: principal.agentId } : null });
    const agentAccess = await this.s.executionAccess.canExecute(principal, agent);
    if (!agentAccess.allowed) {
      run.status = AgentRunStatus.FAILED;
      run.error = `Run stopped: ${describePrincipal(principal)} can no longer run this agent (${agentAccess.reason}).`;
      if (!(await this.commitStep(run, expectedStep))) return 'done';
      this.s.emitEvent(runId, 'run.failed', { error: run.error, reasonCode: 'SCOPE_REVOKED' });
      return 'done';
    }

    // Enforce collaboration rules.maxTotalCost across sibling runs
    if (run.parentRunId && agent.collaboration?.rules?.maxTotalCost) {
      const siblingRuns = await this.s.runRepository.find({ where: { parentRunId: run.parentRunId } });
      const totalSiblingCost = siblingRuns.reduce((sum, sr) => sum + (sr.totalCost || 0), 0);
      if (totalSiblingCost >= agent.collaboration.rules.maxTotalCost) {
        run.status = AgentRunStatus.FAILED;
        run.error = `Collaboration total cost limit exceeded ($${totalSiblingCost.toFixed(2)} >= $${agent.collaboration.rules.maxTotalCost})`;
        // Guarded like every other terminal write (see commitStep): a run
        // cancelled while this worker was starting up stays cancelled.
        if (!(await this.commitStep(run, expectedStep))) return 'done';
        this.s.emitEvent(runId, 'run.failed', { error: run.error });
        return 'done';
      }
    }

    // If this is a collaboration orchestrator (and NOT a child run), delegate to collaboration handler
    if (agent.collaboration?.strategy && agent.collaboration.participants?.length > 0 && !run.parentRunId) {
      return this.s.collaboration.processCollaborationStep(run, agent);
    }

    try {
      // Load the agent's tools, org-scoped. `agent.toolIds` is a plain
      // string array with no referential integrity, so an id from another
      // tenant survives in it — and these tool names, descriptions and
      // parameter schemas go straight into the model's prompt. Execution
      // fails closed in ToolExecutorService, so the scoping here is what
      // keeps the disclosure from happening in the first place.
      // The same goes for team and private tools outside the run's scope:
      // they are neither described to the model nor, in ToolExecutorService,
      // run for it.
      // (principal: the run's, resolved above)
      const tools = await this.s.executionAccess.filterExecutable(principal, await this.resolveTools(agent));

      // Calls an approval policy held on an earlier step, and scripts'
      // change sets, now decided: the approved ones run, as a step of their
      // own, before the model is asked anything (it needs their results).
      if (
        (Array.isArray(run.workingMemory?.gatedToolCalls) && run.workingMemory.gatedToolCalls.length > 0) ||
        (Array.isArray(run.workingMemory?.pendingChangeSets) && run.workingMemory.pendingChangeSets.length > 0)
      ) {
        return await this.runApprovedCalls(run, agent, tools, resolvedLimits, expectedStep, stepStart);
      }

      // The roles this step works with (autonomous-team.ts), read from the
      // agent on every step like its instructions are.
      const team = teamOf(agent, run);
      const runner = new AutonomousStrategyRunner(this.s, this.verifier);

      // Direct, discover or code (agent-tool-mode.ts), decided once per run.
      // In discover mode the model sees the three meta-tools plus the pinned
      // tools; every other tool is found with search_tools and run with
      // call_tool, and stays exactly as callable as in direct mode. Code mode
      // adds run_code.
      const toolMode = await this.toolModeFor(run, agent, team, tools);
      const discover = toolMode.mode !== 'direct';
      const pinned = new Set(Array.isArray(agent.agentConfig?.pinnedToolIds) ? agent.agentConfig.pinnedToolIds : []);
      const offeredTools = discover ? tools.filter((t) => pinned.has(t.id)) : tools;

      // Explore, extract, patch opens with its explorers and the brief, as
      // a step of its own, before the main role's first call.
      if (team.strategy === 'explore_extract_patch' && !run.workingMemory?.brief) {
        return await this.explorePhase(run, agent, team, runner, resolvedLimits, expectedStep, stepStart);
      }

      // Recall memories if memory is enabled: from the scope and the account
      // the agent's Memory section names (AgentMemoryKeeper).
      const memory = new AgentMemoryKeeper(this.s, runner);
      let memoryContext = '';
      if (agent.memoryConfig?.enabled) {
        try {
          const recentMessages = run.conversationId
            ? await this.s.messageRepository.find({ where: { conversationId: run.conversationId, role: MessageRole.USER as any }, order: { createdAt: 'DESC' }, take: 1 })
            : [];
          const lastUserMessage = recentMessages[0];
          if (lastUserMessage) {
            memoryContext = await memory.recallContext(
              agent,
              run,
              typeof lastUserMessage.content === 'string' ? lastUserMessage.content : JSON.stringify(lastUserMessage.content),
            );
          }
        } catch (err) {
          this.s.logger.warn(`Failed to recall memories for run ${runId}: ${err.message}`);
        }
      }

      // Explore, extract, patch: the main role works from the brief the
      // explorers and the summariser prepared (explorePhase).
      if (run.workingMemory?.brief) {
        memoryContext +=
          '\n\n## Brief from exploration\n' +
          'Other models explored this task with the tools, and a summariser condensed what they found. ' +
          'Work from it; check anything you rely on.\n' +
          JSON.stringify(run.workingMemory.brief, null, 2);
      }
      // An explorer's own run: gather, do not solve.
      if (team.main.purpose === 'explorer') {
        memoryContext +=
          '\n\n## Your job on this run\n' +
          'You are exploring for another model. Use the tools to find what matters for the task: facts, ' +
          'records, files, results, dead ends. Report what you found, with specifics, rather than a finished answer.';
      }

      // Always on: wakes that came in while this run of the standing thread
      // was working join it here, as one message, before the model is asked
      // anything (AlwaysOnService.drainInto). A no-op for any other run.
      if (this.alwaysOn && run.metadata?.triggerType === 'always_on') {
        try {
          await this.alwaysOn.drainInto(run);
        } catch (err: any) {
          this.s.logger.warn(`Could not hand queued wakes to run ${runId}: ${err?.message ?? err}`);
        }
      }

      // Build messages for the LLM, reusing the organization loaded above.
      // In code mode the prompt names the namespaces a script can call
      // (a line per API), never the functions: those are found as needed.
      const codeNamespaces = toolMode.mode === 'code' ? namespaceSummary(await this.withApiNames(tools)) : undefined;
      let messages = await this.s.builders.buildMessages(agent, run, offeredTools, memoryContext, organization, { discover, codeNamespaces });

      // Compact long-running context (off unless the agent opts in). Folds the
      // old prefix into a summary so per-step token cost doesn't grow unbounded.
      // An always-on standing thread lives for months, so it is always
      // compacted, with the agent's own settings when it has them.
      const compaction = run.metadata?.triggerType === 'always_on'
        ? { ...(agent.modelConfig?.compaction ?? {}), enabled: true }
        : agent.modelConfig?.compaction;
      if (compaction?.enabled) {
        const compacted = await this.compactor.compact(
          messages,
          run,
          { ...compaction, providerId: compaction.providerId ?? agent.modelConfig?.providerId },
          run.organizationId,
          principalOfRun(run),
        );
        messages = compacted.messages;
        run.totalCost += compacted.cost;
        run.totalTokens += compacted.tokens;
      }

      // Build tool definitions for the LLM (user tools + built-in tools)
      const llmTools = [
        ...(discover ? META_TOOL_DEFINITIONS : []),
        ...(toolMode.mode === 'code' ? [RUN_CODE_DEFINITION] : []),
        ...this.s.builders.buildToolDefinitions(offeredTools, agent),
      ];

      // Resolve sub-agent tools: exactly the agents its Capabilities section
      // lets it call (agent-capabilities.ts), and of those only the ones
      // this run could start.
      let subAgentDefs: Array<{ name: string; description: string; parameters: Record<string, any> }> = [];
      const subAgentMap = new Map<string, string>();
      if (callsAgents(agent)) {
        const otherAgents = await this.s.agentRepository.find({
          where: { organizationId: run.organizationId, status: 'active' as any, isTemporary: false },
          select: { id: true, name: true, description: true, organizationId: true, visibility: true, teamId: true, createdBy: true },
        });
        // Another member's private agents are not callable (nor named) here,
        // and an agent that is not private cannot call even its owner's.
        // Nor is a team agent the run's principal is not a member for: the
        // model is only offered what this run could start (startRun checks
        // again, so a name it was never offered still refuses).
        const callable = await this.s.executionAccess.filterExecutable(
          principal,
          otherAgents.filter(a => mayCallAgent(agent, a.id) && canReference({ visibility: agent.visibility, ownerId: agent.createdBy }, a)),
        );
        subAgentDefs = callable
          .filter(a => a.id !== agent.id)
          .map(a => ({
            name: `call_agent_${a.name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
            description: `Call sub-agent "${a.name}": ${a.description || 'No description'}`,
            parameters: {
              type: 'object',
              properties: {
                input: { type: 'string', description: 'The input/message to send to this agent' },
              },
              required: ['input'],
            },
          }));
        for (const a of callable.filter(a => a.id !== agent.id)) {
          subAgentMap.set(`call_agent_${a.name.replace(/[^a-zA-Z0-9_]/g, '_')}`, a.id);
        }
      }

      // Teammates: every role of the agent's models whose purpose is
      // `teammate` is offered to the loop's model as a tool it can hand work
      // to. An agent teammate is offered only when this run's scope could
      // start it, the same rule sub-agents follow.
      const teammateMap = new Map<string, TeamRole>();
      const teammateDefs: Array<{ name: string; description: string; parameters: Record<string, any> }> = [];
      if (team.teammates.length > 0) {
        const agentIds = team.teammates.filter((t): t is AgentRoleCall => t.kind === 'agent').map((t) => t.agentId);
        const runnable = new Set<string>();
        if (agentIds.length > 0) {
          const rows = await this.s.agentRepository.find({
            where: { id: In(agentIds), organizationId: run.organizationId },
            select: { id: true, name: true, organizationId: true, visibility: true, teamId: true, createdBy: true },
          });
          const callable = await this.s.executionAccess.filterExecutable(
            principal,
            rows.filter((a) => canReference({ visibility: agent.visibility, ownerId: agent.createdBy }, a)),
          );
          for (const a of callable) runnable.add(a.id);
        }
        for (const t of team.teammates) {
          if (t.kind === 'agent' && !runnable.has(t.agentId)) continue;
          const name = teammateToolName(t);
          teammateMap.set(name, t);
          teammateDefs.push({
            name,
            description:
              `Hand a piece of work to ${t.name}, a teammate (${t.kind === 'agent' ? 'another agent' : 'another model'}), and get its answer back.` +
              (t.instructions ? ` ${t.name}: ${t.instructions}` : ''),
            parameters: {
              type: 'object',
              properties: { input: { type: 'string', description: `What to ask ${t.name}` } },
              required: ['input'],
            },
          });
        }
      }

      const allToolDefs = [...llmTools, ...subAgentDefs, ...teammateDefs];

      // Which role makes this step's call. Cascade: the drafter, unless the
      // checker failed its last answer, in which case the main role redoes
      // the step. Every other strategy: the main role runs the loop.
      const escalated = team.strategy === 'cascade' && run.workingMemory?.cascadeEscalated === true;
      const acting: ModelRoleCall = team.strategy === 'cascade' && !escalated ? team.drafter! : team.main;

      // Determine the LLM provider, or the routing policy that picks one
      // per step. A revision after a verifier rejection may carry a policy
      // in working memory that skips the candidates already tried; that
      // policy is the main role's.
      const providerId = acting.providerId;
      const routing: RoutingPolicy | undefined =
        acting === team.main ? (run.workingMemory?.routing ?? acting.routing) : acting.routing;
      if (!providerId && !routing) {
        throw new Error(
          acting === team.main
            ? 'Agent has no LLM provider configured (modelConfig.providerId or modelConfig.routing is missing)'
            : `The ${acting.purpose} role "${acting.name}" has no provider or routing policy`,
        );
      }
      if (run.metadata?.strategy !== team.strategy) run.metadata = { ...(run.metadata || {}), strategy: team.strategy };

      // Build the chat request
      const chatRequest: ChatRequest = {
        messages: messages as any[],
        model: routing ? undefined : acting.model,
        temperature: acting.temperature,
        maxTokens: acting.maxTokens,
        tools: allToolDefs.length > 0 ? allToolDefs : undefined,
        skipToolExecution: true, // We handle tool execution ourselves
        ...(routing ? { routing } : {}),
      };

      // Call the LLM
      this.s.logger.debug(`Run ${runId} step ${run.currentStep}: ${acting.name} calling LLM with ${messages.length} messages, ${allToolDefs.length} tools`);

      // A composing run (final-answer.ts) says up front which calls are the
      // visitor's answer: only one that offers no tools. Every other call
      // is working, and a visitor surface shows none of it.
      const composing = composesFinalAnswer(run, agent);
      const offersTools = !!chatRequest.tools;
      this.s.emitEvent(runId, 'llm.started', {
        step: run.currentStep,
        role: stampOf(acting),
        ...(composing ? { answer: !offersTools } : {}),
      });

      const llmResponse: ChatResponse = await this.s.llmProvidersService.chatStream(
        providerId,
        chatRequest,
        run.organizationId,
        // As the run's principal, inherited: a gateway run reaches its
        // gateway team's providers and keys, never the run row's user's.
        principalOfRun(run),
        (chunk) => emitStreamChunk((type, data) => this.s.emitEvent(runId, type, data), run.currentStep, chunk),
      );

      // Track cost and tokens
      const stepCost = llmResponse.cost || 0;
      const stepInputTokens = llmResponse.usage?.inputTokens || 0;
      const stepOutputTokens = llmResponse.usage?.outputTokens || 0;
      const stepTotalTokens = llmResponse.usage?.totalTokens || (stepInputTokens + stepOutputTokens);

      run.totalCost += stepCost;
      run.totalTokens += stepTotalTokens;
      chargeRole(run, acting, stepCost, stepTotalTokens);

      // The user may have cancelled while the model was answering. Stop
      // here, before a single tool runs, rather than at the next commit.
      if (await this.abandonIfTerminal(run, expectedStep)) return 'done';

      const responseMessage = llmResponse.message;
      const calledTools = !!responseMessage.toolCalls?.length;

      // The tool work is done. In a composing run this reply is a draft,
      // and a no-tools call writes the answer as the next step -- unless
      // that step would take the run past a ceiling, in which case this
      // reply is the answer, as it would be on any other run. Tool calls
      // and nesting are not what the answer call spends, so those two
      // ledgers do not decide it.
      const composeAnswer =
        composing &&
        offersTools &&
        !calledTools &&
        !checkRunLimits(
          {
            currentStep: run.currentStep + 1,
            totalCost: run.totalCost,
            totalTokens: run.totalTokens,
            createdAt: run.createdAt,
          },
          resolvedLimits,
        );

      this.s.emitEvent(runId, 'llm.response', {
        step: run.currentStep,
        content: responseMessage.content,
        toolCalls: responseMessage.toolCalls?.map(tc => ({ id: tc.id, name: tc.name })),
        usage: { inputTokens: stepInputTokens, outputTokens: stepOutputTokens },
        cost: stepCost,
        // Which card answered, on the live event and not only on the
        // persisted step. A client watching a run could show the cost as
        // it accrued but not the model it was accruing on, which is the
        // half that makes multi-model routing legible.
        ...(llmResponse.routing ? { routing: llmResponse.routing } : {}),
        // Which of the agent's roles made the call.
        role: stampOf(acting),
        // In a composing run, whether this reply is the visitor's answer.
        ...(composing ? { answer: !offersTools || (!calledTools && !composeAnswer) } : {}),
      });

      // Check if the LLM returned tool calls
      if (responseMessage.toolCalls && responseMessage.toolCalls.length > 0) {
        // Persist assistant message with tool calls
        if (run.conversationId) {
          const assistantMsg = Message.createToolCallMessage(run.conversationId, responseMessage.toolCalls);
          assistantMsg.content = responseMessage.content || '';
          assistantMsg.runId = run.id;
          await this.s.messageRepository.save(assistantMsg);
        }

        // Calls an approval policy's amount rule held for a person.
        const gated: GatedToolCall[] = [];
        // Scripts' change sets waiting for a person (code mode).
        const changeSets: PendingChangeSet[] = [];
        // A hosted workspace that was starting when a call needed it.
        let wakeRetryMs: number | null = null;
        // Execute each tool call
        for (const toolCall of responseMessage.toolCalls) {
          // The tool-call budget, spent per call rather than per step.
          // `maxToolCalls` was resolved on every step and compared against
          // `run.toolCallCount` -- a column no code ever incremented, so the
          // comparison was always against zero and TOOL_CALL_LIMIT_EXCEEDED
          // was unreachable. One step may carry any number of tool calls, so
          // the once-per-step check at the top of processStep is no ceiling
          // on its own even now that the ledger is real.
          if ((run.toolCallCount ?? 0) >= resolvedLimits.maxToolCalls) {
            const trip = describeLimitTrip('TOOL_CALL_LIMIT_EXCEEDED');
            run.status = AgentRunStatus.FAILED;
            run.error = `${trip.code}: ${trip.message}`;
            run.metadata = { ...(run.metadata || {}), limitTrip: trip };
            run.executionTime += Date.now() - stepStart;
            if (!(await this.commitStep(run, expectedStep))) return 'done';
            this.s.emitEvent(runId, 'run.failed', {
              error: run.error,
              reasonCode: trip.code,
              reason: trip.message,
            });
            return 'done';
          }
          run.toolCallCount = (run.toolCallCount ?? 0) + 1;

          const toolExecStart = Date.now();

          // Check for built-in tools first
          this.s.emitEvent(runId, 'tool.started', { step: run.currentStep, toolCallId: toolCall.id, tool: toolCall.name });

          // Memory tools go through the agent's memory settings (whose
          // memory, which account, the never-save rules); offered, and so
          // answered, only when its memory is on.
          const memoryTool = !!agent.memoryConfig?.enabled && (toolCall.name === 'store_memory' || toolCall.name === 'recall_memory');
          const builtInResult: { result?: any; error?: string; status?: 'sleeping' | 'waiting_input' } | null = memoryTool
            ? toolCall.name === 'store_memory'
              ? await memory.store(agent, run, team, toolCall.parameters || {})
              : await memory.recall(agent, run, toolCall.parameters || {})
            : await this.s.builtInTools.executeBuiltInTool(toolCall.name, toolCall.parameters || {}, run, agent);
          if (builtInResult) {
            // Built-in tool was handled
            toolCall.result = builtInResult.result;
            toolCall.error = builtInResult.error;
            toolCall.executionTime = Date.now() - toolExecStart;

            this.s.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: toolCall.name,
              success: !builtInResult.error,
              executionTime: toolCall.executionTime,
            });

            // Persist tool result message
            if (run.conversationId) {
              const toolResultContent = builtInResult.error || (typeof builtInResult.result === 'string' ? builtInResult.result : JSON.stringify(builtInResult.result));
              const toolMsg = Message.createToolResultMessage(run.conversationId, toolCall.id, toolResultContent, builtInResult.error);
              toolMsg.runId = run.id;
              await this.s.messageRepository.save(toolMsg);
            }

            // Record tool call step
            run.steps.push({
              type: 'tool_call',
              input: { tool: toolCall.name, parameters: toolCall.parameters },
              output: builtInResult.result,
              duration: Date.now() - toolExecStart,
              timestamp: new Date().toISOString(),
              error: builtInResult.error,
            });

            // Handle special statuses from built-in tools
            if (builtInResult.status === 'sleeping') {
              // wait tool: save and return waiting, the job is re-enqueued with delay
              const stepDuration = Date.now() - stepStart;
              run.steps.push({
                type: 'llm_call',
                role: stampOf(acting),
                input: { messageCount: messages.length, toolCount: allToolDefs.length },
                output: { status: 'sleeping', reason: toolCall.parameters?.reason, ...answeredBy(llmResponse, acting) },
                cost: stepCost,
                tokens: { input: stepInputTokens, output: stepOutputTokens },
                duration: stepDuration,
                timestamp: new Date().toISOString(),
              });
              run.currentStep++;
              run.executionTime += stepDuration;
              if (!(await this.commitStep(run, expectedStep))) return 'done';
              this.s.emitEvent(runId, 'step.completed', { step: run.currentStep, status: 'sleeping' });
              return 'waiting';
            }

            if (builtInResult.status === 'waiting_input') {
              const stepDuration = Date.now() - stepStart;
              run.steps.push({
                type: 'llm_call',
                role: stampOf(acting),
                input: { messageCount: messages.length, toolCount: allToolDefs.length },
                output: { status: 'waiting_input', question: toolCall.parameters?.question, ...answeredBy(llmResponse, acting) },
                cost: stepCost,
                tokens: { input: stepInputTokens, output: stepOutputTokens },
                duration: stepDuration,
                timestamp: new Date().toISOString(),
              });
              run.currentStep++;
              run.executionTime += stepDuration;
              if (!(await this.commitStep(run, expectedStep))) return 'done';
              this.s.emitEvent(runId, 'step.completed', { step: run.currentStep, status: 'waiting_input' });
              return 'waiting';
            }

            continue;
          }

          // A teammate: another role of this agent's models, handed a
          // piece of work through its ask_<key> tool.
          const teammate = teammateMap.get(toolCall.name);
          if (teammate) {
            const asked = await runner.askTeammate(run, teammate, String(toolCall.parameters?.input ?? ''), resolvedLimits);
            toolCall.result = asked.result;
            toolCall.error = asked.error;
            toolCall.executionTime = Date.now() - toolExecStart;
            if (run.conversationId) {
              const content = asked.error || asked.result || '';
              const msg = Message.createToolResultMessage(run.conversationId, toolCall.id, content, asked.error);
              msg.runId = run.id;
              await this.s.messageRepository.save(msg);
            }
            this.s.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: toolCall.name,
              success: !asked.error,
              executionTime: toolCall.executionTime,
            });
            continue;
          }

          // Check for sub-agent calls
          const subAgentId = subAgentMap.get(toolCall.name);
          if (subAgentId) {
            // tool.started was already emitted above (before built-in check)
            try {
              const subRun = await this.s.startRun(
                subAgentId,
                run.organizationId,
                run.userId,
                toolCall.parameters?.input || '',
                {
                  parentRunId: run.id,
                  maxSteps: 20,
                  maxCostCents: 50,
                  // The child runs in this run's scope, unchanged.
                  principal: principalOfRun(run),
                },
              );
              // Wait for the sub-run to complete (poll with timeout)
              const subResult = await this.s.misc.waitForRun(subRun.id, 120000);
              toolCall.result = subResult?.output || 'Sub-agent completed without output';
              toolCall.error = subResult?.error;
              toolCall.executionTime = Date.now() - toolExecStart;
            } catch (err) {
              toolCall.error = `Sub-agent call failed: ${err.message}`;
              toolCall.executionTime = Date.now() - toolExecStart;
            }

            // Persist sub-agent tool result
            if (run.conversationId) {
              const subContent = toolCall.error || (typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result));
              const subMsg = Message.createToolResultMessage(run.conversationId, toolCall.id, subContent, toolCall.error);
              subMsg.runId = run.id;
              await this.s.messageRepository.save(subMsg);
            }

            this.s.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: toolCall.name,
              success: !toolCall.error,
              executionTime: toolCall.executionTime,
            });

            run.steps.push({
              type: 'sub_agent_call',
              input: { agentId: subAgentId, input: toolCall.parameters?.input },
              output: toolCall.result,
              duration: Date.now() - toolExecStart,
              timestamp: new Date().toISOString(),
              error: toolCall.error,
            });

            continue;
          }

          // Code mode: run_code runs a script over this run's own tools
          // (code-mode/). Its result goes back as this call's result, unless
          // it staged changes: then a person decides the whole set first, and
          // the result comes with the outcome (runApprovedCalls).
          if (toolMode.mode === 'code' && toolCall.name === RUN_CODE) {
            const ran = await this.runCode(run, agent, toolCall, tools, resolvedLimits, organization ?? null);
            toolCall.result = ran.forModel;
            toolCall.error = ran.error;
            toolCall.executionTime = Date.now() - toolExecStart;
            run.steps.push({
              type: 'tool_call',
              input: { tool: RUN_CODE, parameters: { code: typeof toolCall.parameters?.code === 'string' ? toolCall.parameters.code : '' } },
              output: ran.stepOutput,
              duration: toolCall.executionTime,
              timestamp: new Date().toISOString(),
              error: ran.error,
            });
            if (ran.pending) {
              changeSets.push(ran.pending);
              continue;
            }
            this.s.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: RUN_CODE,
              success: !ran.error,
              executionTime: toolCall.executionTime,
            });
            if (run.conversationId) {
              const msg = Message.createToolResultMessage(run.conversationId, toolCall.id, JSON.stringify(ran.forModel), ran.error);
              msg.runId = run.id;
              await this.s.messageRepository.save(msg);
            }
            continue;
          }

          // Discover mode (agent-tool-mode.ts): search_tools and get_tool are
          // answered here, over this run's own tools (the set it could call
          // directly, after filterExecutable). call_tool names a tool of the
          // same set and runs exactly like a direct call below.
          let callName = toolCall.name;
          let callParams: Record<string, any> = toolCall.parameters || {};
          if (toolMode.mode !== 'direct' && (toolCall.name === SEARCH_TOOLS || toolCall.name === GET_TOOL)) {
            const answer = await this.answerDiscovery(toolCall.name, callParams, tools, run.organizationId);
            toolCall.result = answer.result;
            toolCall.error = answer.error;
            toolCall.executionTime = Date.now() - toolExecStart;
            this.s.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: toolCall.name,
              success: !answer.error,
              executionTime: toolCall.executionTime,
            });
            if (run.conversationId) {
              const content = answer.error ? `Error: ${answer.error}` : JSON.stringify(answer.result);
              const msg = Message.createToolResultMessage(run.conversationId, toolCall.id, content, answer.error);
              msg.runId = run.id;
              await this.s.messageRepository.save(msg);
            }
            run.steps.push({
              type: 'tool_call',
              input: { tool: toolCall.name, parameters: callParams },
              output: answer.result,
              duration: toolCall.executionTime,
              timestamp: new Date().toISOString(),
              error: answer.error,
            });
            continue;
          }
          if (toolMode.mode !== 'direct' && toolCall.name === CALL_TOOL) {
            callName = typeof callParams.name === 'string' ? callParams.name : '';
            const inner = callParams.arguments;
            callParams = inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : {};
          }

          // Regular tool execution via ToolExecutorService
          const matchingTool = tools.find(
            t => t.name.replace(/[^a-zA-Z0-9_-]/g, '_') === callName || t.name === callName,
          );

          if (!matchingTool) {
            toolCall.error = `Tool '${callName}' not found`;
            toolCall.executionTime = Date.now() - toolExecStart;

            this.s.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: callName,
              success: false,
              executionTime: toolCall.executionTime,
            });

            if (run.conversationId) {
              const errMsg = Message.createToolResultMessage(run.conversationId, toolCall.id, `Error: Tool '${callName}' not found`, toolCall.error);
              errMsg.runId = run.id;
              await this.s.messageRepository.save(errMsg);
            }

            run.steps.push({
              type: 'tool_call',
              input: { tool: callName, parameters: callParams },
              error: toolCall.error,
              duration: Date.now() - toolExecStart,
              timestamp: new Date().toISOString(),
            });

            continue;
          }

          try {
            const execOptions: ToolExecutionOptions = {
              // No user is no user: 'system' is not a users.id, and the
              // executor's membership lookup sent it to a uuid column,
              // which Postgres refuses -- every tool call of a userless
              // run (heartbeat, A2A) failed on that error.
              userId: run.userId ?? undefined,
              // The run's principal, inherited: the model cannot reach a
              // team or private tool its run's starter could not run.
              principal: principalOfRun(run),
              organizationId: run.organizationId,
              // Retries are an agent-level budget decision, not a
              // per-tool default: a run with a tight wall clock cannot
              // afford a tool quietly retrying three times with
              // exponential backoff. The tool's own `retries` still wins
              // when it sets one, so a genuinely flaky integration can
              // still override.
              retries: resolvedLimits.toolErrorRetries,
              // The machine this agent's runner-backed tools must run on.
              runnerLabels: agent.agentConfig?.runnerLabels,
              // The one runner they run on, when the agent is pinned to one.
              pinnedRunnerId: agentRunnerId(agent) ?? undefined,
              // Or the hosted environment they run on (agentConfig.environmentId).
              environmentId: agentEnvironmentId(agent) ?? undefined,
              // The run and agent a runner workspace made for this call
              // belongs to (RunWorkspaceService).
              runId: run.id,
              agentId: agent.id,
              // A team's approval rules hold only that team's agents' calls.
              agentTeamId: agent.teamId ?? null,
              // This run pauses and asks a person itself (holdForApproval).
              holdForApproval: 'caller',
            };

            const toolResult: ToolExecutionResult = await this.s.toolExecutorService.executeTool(
              matchingTool.id,
              callParams,
              execOptions,
            );

            // Held by an approval policy's amount rule: the call did not
            // run. Ask a person, and run it once they approve.
            if (toolResult.approvalRequired) {
              const held = await this.holdForApproval(run, agent, matchingTool, { id: toolCall.id, parameters: callParams }, toolResult.approvalRequired);
              gated.push(held);
              toolCall.executionTime = Date.now() - toolExecStart;
              this.s.emitEvent(runId, 'tool.result', {
                step: run.currentStep,
                toolCallId: toolCall.id,
                tool: matchingTool.name,
                success: false,
                awaitingApproval: true,
                executionTime: toolCall.executionTime,
              });
              run.steps.push({
                type: 'tool_call',
                input: { tool: matchingTool.name, toolId: matchingTool.id, parameters: callParams },
                output: { status: 'waiting_approval', rule: held.rule, approvalId: held.approvalId },
                duration: toolCall.executionTime,
                timestamp: new Date().toISOString(),
              });
              continue;
            }

            toolCall.result = toolResult.data;
            if (!toolResult.success && toolResult.metadata?.runnerErrorCode === WORKSPACE_WAKING) {
              wakeRetryMs = Math.max(wakeRetryMs ?? 0, Number(toolResult.metadata?.retryAfterMs) || 0);
            }
            toolCall.error = toolResult.success ? undefined : toolResult.error;
            toolCall.executionTime = toolResult.executionTime;
            toolCall.cached = toolResult.cached;

            this.s.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: matchingTool.name,
              success: toolResult.success,
              executionTime: toolResult.executionTime,
            });

            if (run.conversationId) {
              // How much of a failure re-enters context is policy, not a
              // constant: some tools' errors echo the request payload
              // back, which is not always something the model should see.
              const toolContent = toolResult.success
                ? (typeof toolResult.data === 'string' ? toolResult.data : JSON.stringify(toolResult.data))
                : formatToolError(toolResult.error, resolvedLimits.toolErrorFeedback);
              const toolMsg = Message.createToolResultMessage(run.conversationId, toolCall.id, toolContent, toolResult.success ? undefined : toolResult.error);
              toolMsg.runId = run.id;
              await this.s.messageRepository.save(toolMsg);
            }

            run.steps.push({
              type: 'tool_call',
              input: { tool: matchingTool.name, toolId: matchingTool.id, parameters: callParams },
              output: toolResult.data,
              cost: toolResult.metadata?.cost || 0,
              duration: toolResult.executionTime,
              timestamp: new Date().toISOString(),
              error: toolResult.success ? undefined : toolResult.error,
            });
          } catch (err) {
            toolCall.error = err.message;
            toolCall.executionTime = Date.now() - toolExecStart;

            this.s.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: matchingTool.name,
              success: false,
              executionTime: toolCall.executionTime,
            });

            if (run.conversationId) {
              const errMsg = Message.createToolResultMessage(run.conversationId, toolCall.id, `Error executing tool: ${err.message}`, err.message);
              errMsg.runId = run.id;
              await this.s.messageRepository.save(errMsg);
            }

            run.steps.push({
              type: 'tool_call',
              input: { tool: matchingTool.name, toolId: matchingTool.id, parameters: callParams },
              error: err.message,
              duration: Date.now() - toolExecStart,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // A call an approval policy's amount rule held, or a script's change
        // set: the run waits for a person. The other calls of this reply have
        // run; the held ones run, and the change sets are run or dropped, on
        // the step after they are decided (runApprovedCalls).
        if (gated.length > 0 || changeSets.length > 0) {
          const stepDuration = Date.now() - stepStart;
          run.steps.push({
            type: 'llm_call',
            role: stampOf(acting),
            input: { messageCount: messages.length, toolCount: allToolDefs.length },
            output: {
              status: 'waiting_approval',
              ...(gated.length ? { heldToolCalls: gated.map((g) => ({ tool: g.toolName, rule: g.rule })) } : {}),
              ...(changeSets.length ? { heldChangeSets: changeSets.map((c) => ({ codeExecutionId: c.codeExecutionId, approvalId: c.approvalId })) } : {}),
              ...answeredBy(llmResponse, acting),
            },
            cost: stepCost,
            tokens: { input: stepInputTokens, output: stepOutputTokens },
            duration: stepDuration,
            timestamp: new Date().toISOString(),
          });
          run.workingMemory = {
            ...(run.workingMemory || {}),
            ...(gated.length ? { gatedToolCalls: gated } : {}),
            ...(changeSets.length ? { pendingChangeSets: changeSets } : {}),
          };
          run.status = AgentRunStatus.WAITING_APPROVAL;
          run.currentStep++;
          run.executionTime += stepDuration;
          if (!(await this.commitStep(run, expectedStep))) return 'done';
          this.s.emitEvent(runId, 'step.completed', { step: run.currentStep, status: 'waiting_approval' });
          return 'waiting';
        }

        // A hosted workspace was still starting: the call told the model so,
        // and the run sleeps until the machine should be up, then takes its
        // next step -- the wait tool's own sleep. A machine that does not
        // come up within the wake budget fails the next call for good
        // (HostedRunnersService.resolveTarget), so this cannot loop.
        if (wakeRetryMs !== null) {
          await this.s.builtInTools.executeBuiltInTool('wait', { seconds: Math.max(1, Math.ceil(wakeRetryMs / 1000)) }, run, agent);
          const stepDuration = Date.now() - stepStart;
          run.steps.push({
            type: 'llm_call',
            role: stampOf(acting),
            input: { messageCount: messages.length, toolCount: allToolDefs.length },
            output: { status: 'sleeping', reason: 'the hosted workspace is starting', ...answeredBy(llmResponse, acting) },
            cost: stepCost,
            tokens: { input: stepInputTokens, output: stepOutputTokens },
            duration: stepDuration,
            timestamp: new Date().toISOString(),
          });
          run.currentStep++;
          run.executionTime += stepDuration;
          if (!(await this.commitStep(run, expectedStep))) return 'done';
          this.s.emitEvent(runId, 'step.completed', { step: run.currentStep, status: 'sleeping' });
          return 'waiting';
        }

        // Record the LLM call step
        const stepDuration = Date.now() - stepStart;
        run.steps.push({
          type: 'llm_call',
          role: stampOf(acting),
          input: { messageCount: messages.length, toolCount: allToolDefs.length },
          output: { toolCalls: responseMessage.toolCalls.map(tc => ({ name: tc.name, hasResult: !!tc.result })), ...answeredBy(llmResponse, acting) },
          cost: stepCost,
          tokens: { input: stepInputTokens, output: stepOutputTokens },
          duration: stepDuration,
          timestamp: new Date().toISOString(),
        });

        run.currentStep++;
        run.executionTime += stepDuration;
        // A cascade step the main role redid is done: the next step goes
        // back to the drafter.
        if (escalated) run.workingMemory = { ...(run.workingMemory || {}), cascadeEscalated: false };

        // Advisory mid-run verification (every_n_steps / on_tool_result). May
        // append a course-correction message + verify step before we commit.
        await this.maybeMidLoopVerify(run, agent, responseMessage, runId);
        if (!(await this.commitStep(run, expectedStep))) return 'done';

        this.s.emitEvent(runId, 'step.completed', { step: run.currentStep, total: run.maxSteps });
        return 'continue';

      } else {
        // No tool calls — the agent has a final response
        let finalContent = responseMessage.content || '';
        // What the recorded final step says about the call that wrote it.
        let finalCall: FinalCall = {
          cost: stepCost,
          inputTokens: stepInputTokens,
          outputTokens: stepOutputTokens,
          routing: llmResponse.routing,
          messageCount: messages.length,
          toolCount: allToolDefs.length,
          startedAt: stepStart,
        };
        finalCall.model = llmResponse.model;

        // The strategy's say on this answer (docs/autonomous-models.md).
        // Single has none: the loop's answer is the answer.
        if (team.strategy === 'cascade' && !escalated) {
          // The drafter answered. The checker reviews it, refute-only; only
          // a failed check sends the step to the main role, which redoes it
          // as the next step. An unreadable verdict is a fail, so "we could
          // not tell" escalates rather than passing an unchecked draft.
          const check = await runner.check(run, team.checker!, finalContent, agent.agentConfig?.verify?.spec);
          if (await this.abandonIfTerminal(run, expectedStep)) return 'done';
          const checkDuration = Date.now() - stepStart;
          if (!check.passed) {
            run.steps.push({
              type: 'llm_call',
              role: stampOf(acting),
              input: { messageCount: messages.length, toolCount: allToolDefs.length },
              output: { status: 'escalated', content: finalContent.substring(0, 200), ...answeredBy(llmResponse, acting) },
              cost: stepCost,
              tokens: { input: stepInputTokens, output: stepOutputTokens },
              duration: checkDuration,
              timestamp: new Date().toISOString(),
            });
            run.steps.push({
              type: 'verify',
              role: stampOf(team.checker!),
              input: { mode: 'cascade', policy: check.policy, checkers: check.checkers.length },
              output: { verdict: 'fail', escalateTo: team.main.key, failures: check.failures, ...checkedBy(check) },
              cost: check.cost,
              duration: checkDuration,
              timestamp: new Date().toISOString(),
            });
            run.workingMemory = { ...(run.workingMemory || {}), cascadeEscalated: true };
            run.currentStep++;
            run.executionTime += checkDuration;
            if (!(await this.commitStep(run, expectedStep))) return 'done';
            this.s.emitEvent(runId, 'cascade.escalated', {
              step: run.currentStep,
              from: acting.key,
              to: team.main.key,
              failures: check.failures,
            });
            this.s.emitEvent(runId, 'step.completed', { step: run.currentStep, status: 'escalated' });
            return 'continue';
          }
          run.steps.push({
            type: 'verify',
            role: stampOf(team.checker!),
            input: { mode: 'cascade', policy: check.policy, checkers: check.checkers.length },
            output: { verdict: 'pass', failures: [], ...checkedBy(check) },
            cost: check.cost,
            duration: checkDuration,
            timestamp: new Date().toISOString(),
          });
        } else if (team.strategy === 'best_of_n') {
          const chosen = await runner.bestOfN({
            run,
            main: team.main,
            judge: team.checker!,
            loopRequest: chatRequest,
            first: finalContent,
            n: team.candidates,
            limits: resolvedLimits,
          });
          finalContent = chosen.content;
          if (await this.abandonIfTerminal(run, expectedStep)) return 'done';
        } else if (team.strategy === 'panel') {
          const agreed = await runner.panel({
            run,
            main: team.main,
            panelists: team.panelists,
            // The judge role writes the agreed answer; without one, the main role does.
            judge: team.judge ?? team.main,
            loopRequest: chatRequest,
            first: finalContent,
            limits: resolvedLimits,
          });
          finalContent = agreed.content;
          if (await this.abandonIfTerminal(run, expectedStep)) return 'done';
        } else if (team.strategy === 'explore_extract_patch') {
          // The main role acted on the brief; the checker verifies. A
          // failure goes back to the main role to revise, within the same
          // revision budget the verify gate uses.
          const check = await runner.check(run, team.checker!, finalContent, agent.agentConfig?.verify?.spec);
          if (await this.abandonIfTerminal(run, expectedStep)) return 'done';
          const maxLoops = agent.agentConfig?.verify?.maxReviseLoops ?? 2;
          const revisions = run.workingMemory?.patchRevisions ?? 0;
          const checkDuration = Date.now() - stepStart;
          if (!check.passed && revisions < maxLoops) {
            run.workingMemory = { ...(run.workingMemory || {}), patchRevisions: revisions + 1 };
            if (run.conversationId) {
              const candidate = Message.createAssistantMessage(run.conversationId, finalContent);
              candidate.runId = run.id;
              candidate.metadata = { internal: true, internalPurpose: 'verification_candidate' };
              await this.s.messageRepository.save(candidate);
              const critique = Message.createUserMessage(
                run.conversationId,
                this.verifier.formatFailuresForRevision(check.failures, revisions + 1, maxLoops),
              );
              critique.runId = run.id;
              critique.metadata = { internal: true, internalPurpose: 'verification_revision' };
              await this.s.messageRepository.save(critique);
            }
            run.steps.push({
              type: 'llm_call',
              role: stampOf(acting),
              input: { messageCount: messages.length, toolCount: allToolDefs.length },
              output: { status: 'revising', content: finalContent.substring(0, 200), ...answeredBy(llmResponse, acting) },
              cost: stepCost,
              tokens: { input: stepInputTokens, output: stepOutputTokens },
              duration: checkDuration,
              timestamp: new Date().toISOString(),
            });
            run.steps.push({
              type: 'verify',
              role: stampOf(team.checker!),
              input: { mode: 'patch', policy: check.policy, checkers: check.checkers.length },
              output: { verdict: 'fail', revision: revisions + 1, failures: check.failures, ...checkedBy(check) },
              cost: check.cost,
              duration: checkDuration,
              timestamp: new Date().toISOString(),
            });
            run.currentStep++;
            run.executionTime += checkDuration;
            if (!(await this.commitStep(run, expectedStep))) return 'done';
            this.s.emitEvent(runId, 'verify.failed', { step: run.currentStep, revision: revisions + 1, failures: check.failures });
            this.s.emitEvent(runId, 'step.completed', { step: run.currentStep, status: 'revising' });
            return 'continue';
          }
          run.steps.push({
            type: 'verify',
            role: stampOf(team.checker!),
            input: { mode: 'patch', policy: check.policy, checkers: check.checkers.length },
            output: { verdict: check.verdict, exhausted: !check.passed, failures: check.failures, ...checkedBy(check) },
            cost: check.cost,
            duration: checkDuration,
            timestamp: new Date().toISOString(),
          });
        }
        if (escalated) run.workingMemory = { ...(run.workingMemory || {}), cascadeEscalated: false };

        // A composing run sets this reply aside as a draft and has the
        // answer written by a call that offers no tools (final-answer.ts).
        if (composeAnswer) {
          const composed = await this.composeAnswer(run, runId, acting, chatRequest, finalContent, finalCall);
          finalCall = composed;
          finalContent = composed.content;
          if (await this.abandonIfTerminal(run, expectedStep)) return 'done';
        }

        // Prepare the candidate, but do not expose it until verification ends.
        let finalMsg: Message | null = null;
        if (run.conversationId) {
          finalMsg = Message.createAssistantMessage(run.conversationId, finalContent);
          finalMsg.runId = run.id;
        }

        // Autonomous verify gate: a refute-only checker panel reviews the
        // final answer. On failure within the revision budget, the failures
        // are fed back as synthetic user feedback and the agent loops again
        // instead of completing.
        const verifyPanel = await this.runAutonomousVerify(run, agent, finalContent);
        if (verifyPanel) {
          const cfg = agent.agentConfig?.verify;
          const maxLoops = cfg?.maxReviseLoops ?? 2;
          const revisions = run.workingMemory?.verifyRevisions ?? 0;
          const verifyStepDuration = Date.now() - stepStart;

          if (!verifyPanel.passed && revisions < maxLoops) {
            // Send the answer back for revision.
            run.workingMemory = { ...(run.workingMemory || {}), verifyRevisions: revisions + 1 };
            this.escalateRouteOnVerifyFail(run, agent, verifyPanel, llmResponse);
            const critique = this.verifier.formatFailuresForRevision(
              verifyPanel.failures,
              revisions + 1,
              maxLoops,
            );
            if (finalMsg) {
              finalMsg.metadata = {
                internal: true,
                internalPurpose: 'verification_candidate',
              };
              await this.s.messageRepository.save(finalMsg);
            }
            if (run.conversationId) {
              const critiqueMsg = Message.createUserMessage(run.conversationId, critique);
              critiqueMsg.runId = run.id;
              critiqueMsg.metadata = {
                internal: true,
                internalPurpose: 'verification_revision',
              };
              await this.s.messageRepository.save(critiqueMsg);
            }
            run.steps.push({
              type: 'llm_call',
              role: stampOf(acting),
              input: { messageCount: messages.length, toolCount: allToolDefs.length },
              output: { status: 'revising', content: finalContent.substring(0, 200), ...answeredBy(llmResponse, acting) },
              cost: stepCost,
              tokens: { input: stepInputTokens, output: stepOutputTokens },
              duration: verifyStepDuration,
              timestamp: new Date().toISOString(),
            });
            run.steps.push({
              type: 'verify',
              input: { policy: verifyPanel.policy, checkers: verifyPanel.checkers.length },
              output: { verdict: 'fail', revision: revisions + 1, failures: verifyPanel.failures },
              cost: verifyPanel.cost,
              duration: verifyStepDuration,
              timestamp: new Date().toISOString(),
            });
            run.currentStep++;
            run.executionTime += verifyStepDuration;
            if (!(await this.commitStep(run, expectedStep))) return 'done';
            this.s.emitEvent(runId, 'verify.failed', {
              step: run.currentStep,
              revision: revisions + 1,
              failures: verifyPanel.failures,
            });
            this.s.emitEvent(runId, 'step.completed', { step: run.currentStep, status: 'revising' });
            return 'continue';
          }

          // Passed, or the revision budget is exhausted: record the verdict and
          // let the run complete with this answer.
          run.steps.push({
            type: 'verify',
            input: { policy: verifyPanel.policy, checkers: verifyPanel.checkers.length },
            output: {
              verdict: verifyPanel.verdict,
              exhausted: !verifyPanel.passed && revisions >= maxLoops,
              failures: verifyPanel.failures,
            },
            cost: verifyPanel.cost,
            duration: verifyStepDuration,
            timestamp: new Date().toISOString(),
          });
          run.metadata = {
            ...(run.metadata || {}),
            verify: {
              verdict: verifyPanel.verdict,
              revisions,
              exhausted: !verifyPanel.passed && revisions >= maxLoops,
            },
          };
        }

        // Verification candidates are only committed to customer-visible
        // history after they pass (or exhaust the configured revision budget).
        if (finalMsg) await this.s.messageRepository.save(finalMsg);

        run.status = AgentRunStatus.COMPLETED;
        run.output = finalContent;

        const stepDuration = Date.now() - finalCall.startedAt;
        run.steps.push({
          type: 'llm_call',
          role: stampOf(acting),
          input: { messageCount: finalCall.messageCount, toolCount: finalCall.toolCount },
          // Routing attribution belongs on this step too. The
          // tool-calling branch stamps it; this one did not, so the
          // commonest shape of all — a one-step answer with no tool
          // calls — recorded a cost with no model behind it, and the
          // documented invariant that a routed call stamps attribution
          // on the response, the node result and the audit log was
          // false for exactly the case people look at most.
          output: {
            status: 'completed',
            content: finalContent.substring(0, 200),
            ...answeredBy({ model: finalCall.model, routing: finalCall.routing }, acting),
            ...(finalCall.fallback ? { answerFallback: finalCall.fallback } : {}),
          },
          cost: finalCall.cost,
          tokens: { input: finalCall.inputTokens, output: finalCall.outputTokens },
          duration: stepDuration,
          timestamp: new Date().toISOString(),
          ...(finalCall.error ? { error: finalCall.error } : {}),
        });

        run.currentStep++;
        run.executionTime += stepDuration;

        // Commit the completion with a CAS first: if another worker already
        // advanced this step, abort without double-counting stats/cost.
        if (!(await this.commitStep(run, expectedStep))) return 'done';

        // Update agent stats atomically (see bumpAgentStats rationale).
        await this.s.misc.bumpAgentStats(agent.id, true, run.executionTime, run.totalCost);

        this.s.emitEvent(runId, 'run.completed', { output: run.output });

        // What the run leaves in memory (facts, or the exchange), after the
        // answer is out so nobody waits on it. Its calls are the run's cost
        // like any other, so the run row takes them and the memory_save step.
        const stepsBefore = run.steps.length;
        await memory.afterRun(agent, run, team);
        if (run.steps.length !== stepsBefore) {
          await this.s.runRepository.update(
            { id: run.id },
            { steps: run.steps, totalCost: run.totalCost, totalTokens: run.totalTokens, metadata: run.metadata } as any,
          );
        }
        return 'done';
      }
    } catch (error) {
      this.s.logger.error(`Step failed for run ${runId}: ${error.message}`, error.stack);

      // Leave a note on the agent when its model has been retired, so the
      // dashboard can say "pick a new model" instead of showing one more
      // failed run. Best effort: never let bookkeeping mask the real error.
      if (isModelNotFoundError(error)) {
        await this.flagModelIssue(agent, error);
      }


      const stepDuration = Date.now() - stepStart;
      run.steps.push({
        type: 'error',
        error: error.message,
        timestamp: new Date().toISOString(),
        duration: stepDuration,
      });
      run.status = AgentRunStatus.FAILED;
      run.error = error.message;
      run.executionTime += stepDuration;

      // Commit the failure with a CAS first: a worker that lost the step
      // race must not also bump stats or clobber a concurrent success.
      if (!(await this.commitStep(run, expectedStep))) return 'done';

      // bumpAgentStats swallows DB errors internally; no outer try/catch.
      await this.s.misc.bumpAgentStats(agent.id, false, run.executionTime, run.totalCost);

      // Learn a failure-memory constraint from this failed run (opt-in).
      if (agent.agentConfig?.constraints?.autoLearn) {
        await this.constraints.recordFromRun(run, { distill: agent.agentConfig.constraints.distill });
      }
      this.s.emitEvent(runId, 'run.failed', { error: error.message });
      return 'done';
    }
  }

  /**
   * Persist the current run state with an optimistic compare-and-swap on
   * currentStep. If another worker already advanced this step (duplicate
   * enqueue or concurrent processing), the guarded UPDATE matches 0 rows
   * and we return false so the caller aborts without re-counting cost or
   * steps. Returns true when this worker won the step.
   */
  /**
   * Record on the agent that its model is no longer served by the vendor.
   * Best effort: a failure here must not hide the run failure itself.
   */
  private async flagModelIssue(agent: Agent, error: unknown): Promise<void> {
    try {
      const cause = findModelNotFound(error);
      const settings = {
        ...(agent.settings || {}),
        modelIssue: {
          code: 'MODEL_NOT_FOUND',
          model: cause?.model ?? agent.modelConfig?.model ?? 'unknown',
          providerId: cause?.providerId ?? agent.modelConfig?.providerId,
          message: cause?.message ?? (error as Error)?.message ?? 'Model not available',
          detectedAt: new Date().toISOString(),
        },
      };
      await this.s.agentRepository.update({ id: agent.id }, { settings: settings as Record<string, any> });
      agent.settings = settings;
    } catch (flagError: any) {
      this.s.logger.warn(`Could not record model issue on agent ${agent.id}: ${flagError.message}`);
    }
  }

  /**
   * Bound what a step contributes to the persisted row.
   *
   * `steps` is a json column that is rewritten whole on every commit, so
   * a run that grows it linearly writes O(n^2) bytes of TOAST and WAL --
   * and the pushes carry untruncated tool results, where the HTTP
   * executor allows 10MB responses and the default ceiling is 100 tool
   * calls. The in-memory array the current tick reasons over is left
   * alone; this only bounds what goes to Postgres, the same trade the
   * request logger already makes with its bodies.
   *
   * Capping used to re-run on every prior step at every commit, so step k
   * re-serialized k payloads -- Σk = N²/2 JSON.stringify passes per run, on
   * the event loop. Step objects are append-only once pushed, so each one is
   * capped once and the result is memoized against the step object itself.
   */
  private boundStepsForPersist(steps: AgentRun['steps']): AgentRun['steps'] {
    if (!Array.isArray(steps)) return steps;

    return steps.map((step) => {
      if (!step || typeof step !== 'object') return step;
      const memo = this.cappedStepCache.get(step as object);
      if (memo !== undefined) return memo;
      const capped = {
        ...step,
        input: capPersistedPayload((step as any).input),
        output: capPersistedPayload((step as any).output),
      };
      this.cappedStepCache.set(step as object, capped);
      return capped;
    }) as AgentRun['steps'];
  }

  /**
   * The run's organization, once per step.
   *
   * A ceiling we cannot read must not become a ceiling we ignore, so a
   * failure here is warned and returns null — resolveRunLimits still clamps
   * to the operator env floor. Same contract resolveLimits had when it did
   * this load itself.
   */
  private async loadOrganization(organizationId: string) {
    try {
      return await this.s.organizationRepository.findOne({ where: { id: organizationId } });
    } catch (err: any) {
      this.s.logger.warn(
        `Could not load organization ${organizationId} for this step: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * The tools this agent may use: the single tools it was given, and every
   * active tool of each API it was given (agentConfig.apiIds), including
   * tools added to the API after the agent was saved. The run's scope is
   * applied to the result by the caller (filterExecutable).
   */
  private async loadTools(agent: Agent) {
    const apiIds = agentApiIds(agent);
    const where: any[] = [];
    if (agent.toolIds?.length) where.push({ id: In(agent.toolIds), organizationId: agent.organizationId });
    if (apiIds.length) where.push({ apiId: In(apiIds), organizationId: agent.organizationId, status: ToolStatus.ACTIVE });
    if (!where.length) return [];
    const rows = await this.s.toolRepository.find({ where });
    const seen = new Set<string>();
    return rows.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  }

  /**
   * The agent's tools for this step, served from a short-lived cache.
   *
   * The identical query ran on every step of every run. The result only
   * shapes the prompt — ToolExecutorService re-loads the tool row by id
   * before executing anything — so a stale entry cannot change what runs.
   */
  private async resolveTools(agent: Agent) {
    const apiIds = agentApiIds(agent);
    if (!agent.toolIds?.length && !apiIds.length) return [];
    const key = `${agent.organizationId}:${[...(agent.toolIds ?? [])].sort().join(',')}|${[...apiIds].sort().join(',')}`;
    const now = Date.now();
    const hit = this.toolCache.get(key);
    if (hit && now - hit.at < TOOL_CACHE_TTL_MS) {
      // Refresh recency for the LRU eviction below.
      this.toolCache.delete(key);
      this.toolCache.set(key, hit);
      return hit.tools;
    }
    const tools = await this.loadTools(agent);
    this.toolCache.set(key, { at: now, tools });
    while (this.toolCache.size > TOOL_CACHE_MAX_ENTRIES) {
      const oldest = this.toolCache.keys().next().value;
      if (oldest === undefined) break;
      this.toolCache.delete(oldest);
    }
    return tools;
  }

  /**
   * Cancellation is a row, not a signal.
   *
   * The model call runs for seconds to minutes and nothing looked at the
   * run again in that window, so a user who cancelled watched the UI go
   * to cancelled while this worker carried on: it ran the tool calls and
   * then committed the step -- cancel leaves `currentStep` alone, so the
   * CAS matched -- writing `running` back over CANCELLED. Look before
   * spending anything more, and bank the cost of the call already paid
   * for without touching status or currentStep.
   */
  private async abandonIfTerminal(run: AgentRun, expectedStep: number): Promise<AgentRunStatus | null> {
    const live = await this.s.runRepository.findOne({
      where: { id: run.id },
      select: { id: true, status: true },
    });
    if (!live || !TERMINAL_STATUSES.includes(live.status)) return null;
    await this.s.runRepository.update(
      { id: run.id, currentStep: expectedStep },
      { totalCost: run.totalCost, totalTokens: run.totalTokens },
    );
    this.s.logger.log(`Run ${run.id} is ${live.status}; abandoning step ${expectedStep} instead of finishing it`);
    return live.status;
  }

  /**
   * The answer call of a composing run (final-answer.ts).
   *
   * The draft is recorded as a step of its own, with its cost, and the
   * same model is asked again with the same request minus its tools: same
   * provider or routing policy, model, sampling, system prompt, memory and
   * conversation, the tool turns written out as text. That reply streams
   * as the next step, marked as the answer, and is what the run returns.
   * Its cost and tokens go on the run like any step's, and it counts as a
   * step against maxSteps. Should the call fail or come back empty, the
   * draft is the answer after all, sent whole.
   */
  private async composeAnswer(
    run: AgentRun,
    runId: string,
    acting: ModelRoleCall,
    chatRequest: ChatRequest,
    draft: string,
    draftCall: FinalCall,
  ): Promise<FinalCall & { content: string }> {
    const providerId = acting.providerId;
    const draftDuration = Date.now() - draftCall.startedAt;
    run.steps.push({
      type: 'llm_call',
      role: stampOf(acting),
      input: { messageCount: draftCall.messageCount, toolCount: draftCall.toolCount },
      output: {
        status: 'drafted',
        content: draft.substring(0, 200),
        ...answeredBy({ model: draftCall.model, routing: draftCall.routing }, acting),
      },
      cost: draftCall.cost,
      tokens: { input: draftCall.inputTokens, output: draftCall.outputTokens },
      duration: draftDuration,
      timestamp: new Date().toISOString(),
    });
    run.currentStep++;
    run.executionTime += draftDuration;

    const step = run.currentStep;
    const startedAt = Date.now();
    const answerRequest: ChatRequest = {
      ...chatRequest,
      messages: answerCallMessages(chatRequest.messages as any[]) as ChatRequest['messages'],
      tools: undefined,
    };
    const answered = {
      messageCount: answerRequest.messages.length,
      toolCount: 0,
      startedAt,
    };
    const standIn = (fallback: 'error' | 'empty', error?: string, spent?: Partial<FinalCall>) => {
      this.s.emitEvent(runId, 'llm.response', { step, content: draft, answer: true, fallback });
      return {
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        ...spent,
        ...answered,
        fallback,
        ...(error ? { error } : {}),
        content: draft,
      };
    };

    this.s.emitEvent(runId, 'llm.started', { step, answer: true });
    let response: ChatResponse;
    try {
      response = await this.s.llmProvidersService.chatStream(
        providerId,
        answerRequest,
        run.organizationId,
        principalOfRun(run),
        (chunk) => emitStreamChunk((type, data) => this.s.emitEvent(runId, type, data), step, chunk),
      );
    } catch (err: any) {
      this.s.logger.warn(`Run ${runId}: the answer call failed, answering with the draft: ${err?.message}`);
      return standIn('error', `Answer call failed: ${err?.message}`);
    }

    const spent = {
      cost: response.cost || 0,
      inputTokens: response.usage?.inputTokens || 0,
      outputTokens: response.usage?.outputTokens || 0,
      routing: response.routing,
      model: response.model,
    };
    const spentTokens = response.usage?.totalTokens || spent.inputTokens + spent.outputTokens;
    run.totalCost += spent.cost;
    run.totalTokens += spentTokens;
    chargeRole(run, acting, spent.cost, spentTokens);

    const content = response.message?.content || '';
    if (!content.trim() && draft.trim()) return standIn('empty', undefined, spent);

    this.s.emitEvent(runId, 'llm.response', {
      step,
      content,
      usage: { inputTokens: spent.inputTokens, outputTokens: spent.outputTokens },
      cost: spent.cost,
      ...(spent.routing ? { routing: spent.routing } : {}),
      answer: true,
    });
    return { ...spent, ...answered, content };
  }

  /**
   * The first step of an explore-extract-patch run: every explorer as its
   * own run of this agent on the explorer's model, in parallel, then the
   * summariser's brief. The brief goes into working memory, where every
   * later step of the main role reads it. It counts as one step against
   * maxSteps; its cost is the explorers' runs and the summariser's call,
   * each charged to its role. A failure (no explorer found anything, a
   * brief that does not validate) fails the run from processStep's catch,
   * with the steps that did happen kept.
   */
  private async explorePhase(
    run: AgentRun,
    agent: Agent,
    team: Team,
    runner: AutonomousStrategyRunner,
    limits: ResolvedRunLimits,
    expectedStep: number,
    stepStart: number,
  ): Promise<'continue' | 'done'> {
    const latest = run.conversationId
      ? await this.s.messageRepository.find({
          where: { conversationId: run.conversationId, role: MessageRole.USER as any },
          order: { createdAt: 'DESC' },
          take: 1,
        })
      : [];
    const said = latest[0]?.content;
    const task =
      typeof said === 'string' && said.trim()
        ? said
        : said !== undefined && said !== null
          ? JSON.stringify(said)
          : typeof run.input === 'string'
            ? run.input
            : JSON.stringify(run.input ?? '');

    this.s.emitEvent(run.id, 'explore.started', { step: run.currentStep, explorers: team.explorers.map(stampOf) });
    const brief = await runner.exploreAndExtract({
      run,
      agentId: agent.id,
      explorers: team.explorers,
      summariser: team.summariser!,
      task,
      limits,
    });
    if (await this.abandonIfTerminal(run, expectedStep)) return 'done';

    const duration = Date.now() - stepStart;
    run.workingMemory = { ...(run.workingMemory || {}), brief };
    run.metadata = { ...(run.metadata || {}), strategy: team.strategy };
    run.currentStep++;
    run.executionTime += duration;
    if (!(await this.commitStep(run, expectedStep))) return 'done';
    this.s.emitEvent(run.id, 'explore.completed', { step: run.currentStep, brief });
    this.s.emitEvent(run.id, 'step.completed', { step: run.currentStep, status: 'explored' });
    return 'continue';
  }

  /**
   * How this run shows the model its tools (agent-tool-mode.ts), decided on
   * the first step and kept in working memory: the tools array then stays
   * the same for the whole run, so a provider's prefix cache holds. `auto`
   * compares the definitions' size with a share of the main model's context
   * window (its model card), or with the agent's own threshold.
   */
  private async toolModeFor(run: AgentRun, agent: Agent, team: Team, tools: Tool[]): Promise<ToolModeDecision> {
    const kept = run.workingMemory?.toolMode;
    if (kept && (kept.mode === 'direct' || kept.mode === 'discover' || kept.mode === 'code')) return kept as ToolModeDecision;
    const definitions = this.s.builders.buildToolDefinitions(tools, agent).slice(0, tools.length);
    let contextLength: number | null = null;
    const main = team.main;
    if (main.kind === 'model' && main.providerId && main.model && !main.routing) {
      try {
        const card = await this.s.toolRepository.manager.getRepository(Model).findOne({
          where: { organizationId: run.organizationId, providerId: main.providerId, vendorModelId: main.model },
          select: { id: true, contextLength: true },
        });
        contextLength = card?.contextLength ?? null;
      } catch (err) {
        this.s.logger.warn(`No model card for the tool-mode threshold on run ${run.id}: ${err.message}`);
      }
    }
    const decision = decideToolMode({
      configured: agent.agentConfig?.toolMode,
      definitions,
      contextLength,
      overrideTokens: agent.agentConfig?.toolModeThresholdTokens,
    });
    run.workingMemory = { ...(run.workingMemory || {}), toolMode: decision };
    return decision;
  }

  /**
   * search_tools and get_tool for an agent in discover mode, over the tools
   * this run may call. Names are the ones the model calls (sanitised, as in
   * the tools array), so call_tool takes what search_tools returned.
   */
  private async answerDiscovery(
    name: string,
    params: Record<string, any>,
    tools: Tool[],
    organizationId: string,
  ): Promise<{ result?: unknown; error?: string }> {
    const nameOf = (t: Tool) => t.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (name === SEARCH_TOOLS) {
      const query = typeof params.query === 'string' ? params.query.trim() : '';
      if (!query) return { error: 'search_tools needs a query' };
      const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : undefined;
      const { results, total } = await this.discovery.search(tools, query, { organizationId, limit, nameOf });
      return { result: { tools: results, total } };
    }
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = toolName ? this.discovery.resolve(tools, toolName, nameOf) : null;
    if (!tool) return { error: `Tool '${toolName}' not found. Use search_tools to find it.` };
    const detail = params.detail === 'name' || params.detail === 'description' ? params.detail : 'full';
    return { result: this.discovery.describe(await this.withApiNames(tools), tool, detail, nameOf) };
  }

  /** The tools with their API's name attached (the code namespace), without loading the APIs' schemas. */
  private async withApiNames(tools: Tool[]): Promise<Tool[]> {
    const ids = [...new Set(tools.filter((t) => t.apiId && !t.api).map((t) => t.apiId as string))];
    if (!ids.length) return tools;
    const apis = await this.s.toolRepository.manager.getRepository(Api).find({ where: { id: In(ids) }, select: { id: true, name: true } });
    const byId = new Map(apis.map((a) => [a.id, a]));
    return tools.map((t) => (t.apiId && !t.api && byId.has(t.apiId) ? ({ ...t, api: byId.get(t.apiId) } as Tool) : t));
  }

  /**
   * One run_code call (code mode, docs/design/code-mode.md parts C and D):
   * the script runs over exactly this run's executable tools, every call it
   * makes goes through the executor as this run, and what it staged becomes
   * one approval request for the whole set. Extract calls, the CPU it used
   * and the calls it made are charged to the run.
   */
  private async runCode(
    run: AgentRun,
    agent: Agent,
    toolCall: { id: string; parameters?: Record<string, any> },
    tools: Tool[],
    resolvedLimits: ResolvedRunLimits,
    organization: Organization | null,
  ): Promise<{ forModel: CodeResultForModel | { error: string }; error?: string; stepOutput: Record<string, unknown>; pending?: PendingChangeSet }> {
    if (!this.codeMode) {
      const error = 'Code mode is not available on this server.';
      return { forModel: { error }, error, stepOutput: { error } };
    }
    const params = toolCall.parameters || {};
    const config: CodeModeConfig | undefined = agent.agentConfig?.codeMode;
    // A script's calls come out of the run's tool-call budget too, so it may
    // make at most what is left of it (run_code itself was counted above).
    const orgLimits = codeModeLimits((organization?.settings as any)?.codeMode);
    const limits = { ...orgLimits, maxCalls: Math.min(orgLimits.maxCalls, Math.max(0, resolvedLimits.maxToolCalls - (run.toolCallCount ?? 0))) };
    const principal = principalOfRun(run);
    const outcome = await this.codeMode.run({
      code: params.code,
      timeoutMs: params.timeoutMs,
      scope: await this.withApiNames(tools),
      context: {
        organizationId: run.organizationId,
        userId: run.userId ?? null,
        principal,
        runId: run.id,
        agentId: agent.id,
        agentTeamId: agent.teamId ?? null,
        runnerLabels: agent.agentConfig?.runnerLabels,
        pinnedRunnerId: agentRunnerId(agent) ?? undefined,
        environmentId: agentEnvironmentId(agent) ?? undefined,
        retries: resolvedLimits.toolErrorRetries,
      },
      policy: config,
      grantsLeft: grantsLeftFor(config, run.workingMemory?.codeGrantsUsed),
      limits,
      extract: buildExtract({
        chat: (providerId, request) => this.s.llmProvidersService.chat(providerId, request as any, run.organizationId, principal),
        extractor: config?.extractor ?? null,
        routing: organization?.settings?.defaultRouting ?? null,
      }),
    });

    // Charged to the run like any other step: extract()'s model calls, and
    // every tool call the script made against the run's tool-call budget.
    run.totalCost += outcome.extractCost;
    run.totalTokens += outcome.extractTokens;
    run.toolCallCount = (run.toolCallCount ?? 0) + outcome.calls.filter((c) => c.op === 'tool' || c.op === 'call').length;
    if (Object.keys(outcome.grantsUsed).length) {
      const used: Record<string, number> = { ...(run.workingMemory?.codeGrantsUsed ?? {}) };
      for (const [toolId, n] of Object.entries(outcome.grantsUsed)) used[toolId] = (used[toolId] ?? 0) + n;
      run.workingMemory = { ...(run.workingMemory || {}), codeGrantsUsed: used };
    }

    const forModel = codeResultForModel(outcome, limits.resultCapChars + limits.logCapChars + 8_192);
    const stepOutput = {
      codeExecutionId: outcome.codeExecutionId,
      status: outcome.status,
      calls: forModel.calls,
      cpuMs: outcome.cpuMs,
      ...(outcome.staged.length ? { staged: outcome.staged.length } : {}),
    };
    if (outcome.status !== 'waiting_approval') {
      return { forModel, error: outcome.error?.message, stepOutput };
    }
    const n = outcome.staged.length;
    const approval = await this.s.approvals.create({
      organizationId: run.organizationId,
      teamId: agent.teamId ?? null,
      runId: run.id,
      agentId: agent.id,
      toolCallId: toolCall.id,
      reason: `A script wants to make ${n} change${n === 1 ? '' : 's'}. Approve to make all of them, or reject to make none.`,
      payload: {
        kind: 'change_set',
        tool: 'run_code',
        codeExecutionId: outcome.codeExecutionId,
        changeSet: outcome.staged,
      },
      principal,
    });
    await this.codeMode.attachApproval(outcome.codeExecutionId, approval.id);
    return {
      forModel,
      stepOutput: { ...stepOutput, approvalId: approval.id },
      pending: { toolCallId: toolCall.id, codeExecutionId: outcome.codeExecutionId, approvalId: approval.id, forModel },
    };
  }

  /**
   * Ask a person about a call an approval policy's amount rule held. The
   * approval request carries the tool, the arguments and the rule, so the
   * approver sees exactly what would run; `_gate` is how the executor
   * later recognises the approval as covering this call and no other.
   */
  private async holdForApproval(
    run: AgentRun,
    agent: Agent,
    tool: { id: string; name: string },
    toolCall: { id: string; parameters?: Record<string, any> },
    hit: ApprovalGateHit,
  ): Promise<GatedToolCall> {
    const parameters = toolCall.parameters || {};
    const approval = await this.s.approvals.create({
      organizationId: run.organizationId,
      teamId: agent.teamId ?? null,
      runId: run.id,
      agentId: agent.id,
      toolCallId: toolCall.id,
      reason: hit.kind === 'tool_call' ? `${hit.summary}.` : `${hit.summary}. On this call ${hitDetail(hit)}.`,
      payload: {
        tool: readableToolName(tool as NamedTool),
        parameters,
        _gate: {
          kind: hit.kind ?? 'tool_amount',
          policyId: hit.policyId,
          toolId: hit.toolId,
          argument: hit.argument,
          value: hit.value,
          op: hit.op,
          amount: hit.amount,
          paramsHash: hit.paramsHash,
          rule: hit.summary,
        },
      },
      principal: principalOfRun(run),
    });
    return {
      toolCallId: toolCall.id,
      toolId: tool.id,
      toolName: tool.name,
      parameters,
      approvalId: approval.id,
      rule: hit.summary,
    };
  }

  /**
   * The step after a held call or a script's change set is decided: run
   * each approved call with its approval, exactly as it was asked for, run
   * or drop each decided change set, and hand the model the results.
   * Anything still waiting keeps the run waiting. A rejected held call never
   * gets here: it cancels the run. A rejected change set does: the model is
   * told nothing in it ran, and carries on.
   */
  private async runApprovedCalls(
    run: AgentRun,
    agent: Agent,
    tools: Tool[],
    resolvedLimits: ResolvedRunLimits,
    expectedStep: number,
    stepStart: number,
  ): Promise<'continue' | 'done' | 'waiting'> {
    const runId = run.id;
    // Scripts' change sets a person has now decided (code mode, part D):
    // an approved set runs in order through the executor with the approval,
    // under its script; a rejected or expired one runs nothing. Either way
    // the model gets one result for its run_code call.
    const sets: PendingChangeSet[] = run.workingMemory?.pendingChangeSets ?? [];
    const setsWaiting: PendingChangeSet[] = [];
    for (const set of sets) {
      const started = Date.now();
      const approval = await this.s.approvals.findInOrganization(set.approvalId, run.organizationId);
      if (!approval || approval.status === 'pending' || !this.codeMode) {
        setsWaiting.push(set);
        continue;
      }
      const decision = approval.status === 'approved' ? 'approved' : approval.status === 'expired' ? 'expired' : 'rejected';
      const entries =
        decision === 'approved'
          ? await this.codeMode.applyChangeSet(set.codeExecutionId, set.approvalId, tools, {
              organizationId: run.organizationId,
              userId: run.userId ?? null,
              principal: principalOfRun(run),
              runId: run.id,
              agentId: agent.id,
              agentTeamId: agent.teamId ?? null,
              runnerLabels: agent.agentConfig?.runnerLabels,
              pinnedRunnerId: agentRunnerId(agent) ?? undefined,
              environmentId: agentEnvironmentId(agent) ?? undefined,
            })
          : await this.codeMode.rejectChangeSet(set.codeExecutionId, run.organizationId);
      const answer = changeSetOutcomeForModel(set.forModel, decision, entries, approval.decisionReason);
      const failed = entries.find((e) => e.outcome === 'failed');
      this.s.emitEvent(runId, 'tool.result', {
        step: run.currentStep,
        toolCallId: set.toolCallId,
        tool: RUN_CODE,
        success: decision === 'approved' && !failed,
        executionTime: Date.now() - started,
      });
      if (run.conversationId) {
        const msg = Message.createToolResultMessage(run.conversationId, set.toolCallId, JSON.stringify(answer), failed?.error);
        msg.runId = run.id;
        await this.s.messageRepository.save(msg);
      }
      run.steps.push({
        type: 'tool_call',
        input: { tool: RUN_CODE, codeExecutionId: set.codeExecutionId, approvalId: set.approvalId },
        output: answer.changeSet,
        duration: Date.now() - started,
        timestamp: new Date().toISOString(),
        ...(failed ? { error: failed.error } : {}),
      });
    }

    const held: GatedToolCall[] = run.workingMemory?.gatedToolCalls ?? [];
    const waiting: GatedToolCall[] = [];
    for (const call of held) {
      const started = Date.now();
      const tool = tools.find((t) => t.id === call.toolId);
      const result: ToolExecutionResult = tool
        ? await this.s.toolExecutorService.executeTool(tool.id, call.parameters, {
            userId: run.userId ?? undefined,
            principal: principalOfRun(run),
            organizationId: run.organizationId,
            retries: resolvedLimits.toolErrorRetries,
            runnerLabels: agent.agentConfig?.runnerLabels,
            pinnedRunnerId: agentRunnerId(agent) ?? undefined,
            environmentId: agentEnvironmentId(agent) ?? undefined,
            runId: run.id,
            agentId: agent.id,
            agentTeamId: agent.teamId ?? null,
            approvedGate: { approvalId: call.approvalId },
            holdForApproval: 'caller',
          })
        : {
            success: false,
            error: `Tool '${call.toolName}' is no longer available to this run`,
            executionTime: 0,
            cached: false,
            rateLimited: false,
            retryCount: 0,
          };
      if (result.approvalRequired) {
        waiting.push(call);
        continue;
      }
      this.s.emitEvent(runId, 'tool.result', {
        step: run.currentStep,
        toolCallId: call.toolCallId,
        tool: call.toolName,
        success: result.success,
        executionTime: result.executionTime,
      });
      if (run.conversationId) {
        const content = result.success
          ? typeof result.data === 'string'
            ? result.data
            : JSON.stringify(result.data)
          : formatToolError(result.error, resolvedLimits.toolErrorFeedback);
        const msg = Message.createToolResultMessage(run.conversationId, call.toolCallId, content, result.success ? undefined : result.error);
        msg.runId = run.id;
        await this.s.messageRepository.save(msg);
      }
      run.steps.push({
        type: 'tool_call',
        input: { tool: call.toolName, toolId: call.toolId, parameters: call.parameters, approvalId: call.approvalId },
        output: result.data,
        cost: result.metadata?.cost || 0,
        duration: Date.now() - started,
        timestamp: new Date().toISOString(),
        error: result.success ? undefined : result.error,
      });
    }
    const { gatedToolCalls: _done, pendingChangeSets: _sets, ...rest } = run.workingMemory || {};
    run.workingMemory = {
      ...rest,
      ...(waiting.length ? { gatedToolCalls: waiting } : {}),
      ...(setsWaiting.length ? { pendingChangeSets: setsWaiting } : {}),
    };
    const stillWaiting = waiting.length > 0 || setsWaiting.length > 0;
    if (stillWaiting) run.status = AgentRunStatus.WAITING_APPROVAL;
    run.currentStep++;
    run.executionTime += Date.now() - stepStart;
    if (!(await this.commitStep(run, expectedStep))) return 'done';
    this.s.emitEvent(runId, 'step.completed', {
      step: run.currentStep,
      ...(stillWaiting ? { status: 'waiting_approval' } : { total: run.maxSteps }),
    });
    return stillWaiting ? 'waiting' : 'continue';
  }

  private async commitStep(run: AgentRun, expectedStep: number): Promise<boolean> {
    const res = await this.s.runRepository.update(
      // The step number alone was not enough. Cancelling a run sets the
      // status and leaves `currentStep` where it was, so this CAS still
      // matched: `status` was written back to running, the step
      // advanced, and the next one was enqueued -- while the UI said
      // cancelled and the SSE consumer had already detached. A terminal
      // status is final, whoever gets there first.
      { id: run.id, currentStep: expectedStep, status: Not(In(TERMINAL_STATUSES)) },
      {
        status: run.status,
        currentStep: run.currentStep,
        totalCost: run.totalCost,
        totalTokens: run.totalTokens,
        // The tool-call ledger, persisted with everything else the step
        // advanced. Held only in memory it would reset to the row's value
        // on the next step, and a per-step counter is no run budget.
        toolCallCount: run.toolCallCount ?? 0,
        executionTime: run.executionTime,
        steps: this.boundStepsForPersist(run.steps),
        output: run.output,
        error: run.error,
        workingMemory: run.workingMemory,
        metadata: run.metadata,
      },
    );
    return (res.affected ?? 0) > 0;
  }

  /**
   * Run the autonomous verify panel against a candidate final answer. Returns
   * the merged panel result, or null when verify is not configured/enabled or
   * has no checkers (so the caller completes normally). Aggregate checker
   * cost/tokens are added to the run here so the caller doesn't double-count.
   */
  /**
   * Tier 2 routing: after a verifier rejection, move the revision to the
   * next candidate of the route when the policy allows it. Working memory
   * carries the adjusted policy and the escalation count; the next step
   * reads it in place of the agent's own policy. No policy, flag off, or
   * budget spent means the revision stays on the same model.
   */
  escalateRouteOnVerifyFail(run: AgentRun, agent: Agent, verifyPanel: { passed: boolean; failures?: any[] }, llmResponse: { routing?: { attempt?: number } } | undefined): void {
    const activePolicy: RoutingPolicy | undefined = run.workingMemory?.routing ?? agent.modelConfig?.routing;
    const escalation = decideEscalation(activePolicy, verifyPanel, {
      attempt: planPosition(llmResponse?.routing?.attempt, activePolicy),
      escalations: run.workingMemory?.routeEscalations ?? 0,
    });
    if (escalation.action !== 'escalate' || !activePolicy) return;
    run.workingMemory = {
      ...(run.workingMemory || {}),
      routing: nextRoutingPolicy(activePolicy, escalation),
      routeEscalations: (run.workingMemory?.routeEscalations ?? 0) + 1,
    };
    this.s.emitEvent(run.id, 'route.escalated', { step: run.currentStep, reason: escalation.reason, nextAttempt: escalation.nextAttempt });
  }

  private async runAutonomousVerify(
    run: AgentRun,
    agent: Agent,
    finalContent: string,
  ): Promise<VerifyPanelResult | null> {
    if (!this.hasFinalOutputVerification(agent, finalContent)) return null;
    const cfg = agent.agentConfig!.verify!;
    const panel = await this.verifier.runPanel(
      { target: finalContent, spec: cfg.spec, checkers: cfg.checkers!, policy: cfg.policy },
      run.organizationId,
      principalOfRun(run),
    );
    run.totalCost += panel.cost;
    run.totalTokens += panel.tokens;
    return panel;
  }

  private hasFinalOutputVerification(agent: Agent, finalContent: string): boolean {
    const cfg = agent.agentConfig?.verify;
    return !!(
      cfg?.enabled &&
      Array.isArray(cfg.checkers) &&
      cfg.checkers.length > 0 &&
      (cfg.triggers ?? ['on_final_output']).includes('on_final_output') &&
      finalContent.trim()
    );
  }

  /**
   * Advisory mid-run verification. Unlike the final-output gate (which can send
   * the answer back for revision), this reviews in-progress work on the
   * configured triggers (`every_n_steps`, `on_tool_result`) and, on failure,
   * injects a synthetic user note so the agent can course-correct on the next
   * step — it never ends or revises the run. Runs inside the current step,
   * before commitStep, so its cost and the synthetic message persist together.
   */
  private async maybeMidLoopVerify(
    run: AgentRun,
    agent: Agent,
    responseMessage: any,
    runId: string,
  ): Promise<void> {
    const cfg = agent.agentConfig?.verify;
    if (!cfg?.enabled || !Array.isArray(cfg.checkers) || cfg.checkers.length === 0) return;
    const triggers = cfg.triggers ?? ['on_final_output'];
    const everyN = cfg.everyNSteps ?? 5;

    const hadToolResults =
      Array.isArray(responseMessage?.toolCalls) &&
      responseMessage.toolCalls.some((tc: any) => tc.result !== undefined || tc.error);
    const fires =
      (triggers.includes('every_n_steps') && everyN > 0 && run.currentStep % everyN === 0) ||
      (triggers.includes('on_tool_result') && hadToolResults);
    if (!fires) return;

    // Target = this step's assistant content plus the tool results it produced.
    const toolSummary = (responseMessage?.toolCalls || [])
      .map((tc: any) => `${tc.name}: ${tc.error ? `ERROR ${tc.error}` : this.stringifyResult(tc.result)}`)
      .join('\n');
    const target = `Assistant: ${responseMessage?.content || ''}\n\nTool results:\n${toolSummary}`.trim();

    const panel = await this.verifier.runPanel(
      { target, spec: cfg.spec, checkers: cfg.checkers, policy: cfg.policy },
      run.organizationId,
      principalOfRun(run),
    );
    run.totalCost += panel.cost;
    run.totalTokens += panel.tokens;

    run.steps.push({
      type: 'verify',
      input: { mode: 'mid_loop', policy: panel.policy, checkers: panel.checkers.length },
      output: { verdict: panel.verdict, advisory: true, failures: panel.failures },
      cost: panel.cost,
      timestamp: new Date().toISOString(),
    });

    if (!panel.passed) {
      const note =
        `Mid-run verification flagged issues with your progress so far:\n\n` +
        panel.failures
          .map((f, i) => `${i + 1}. ${f.rule}${f.evidence ? ` — ${f.evidence}` : ''}`)
          .join('\n') +
        `\n\nAccount for these as you continue; do not repeat them.`;
      if (run.conversationId) {
        const msg = Message.createUserMessage(run.conversationId, note);
        msg.runId = run.id;
        msg.metadata = {
          internal: true,
          internalPurpose: 'verification_advisory',
        };
        await this.s.messageRepository.save(msg);
      }
      this.s.emitEvent(runId, 'verify.advisory', { step: run.currentStep, failures: panel.failures });
    }
  }

  private stringifyResult(r: any): string {
    if (r === undefined || r === null) return '';
    const s = typeof r === 'string' ? r : JSON.stringify(r);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  }
}
