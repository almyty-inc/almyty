import { Injectable, Logger, BadRequestException, Optional } from '@nestjs/common';
import { findModelNotFound } from '../llm-providers/model-errors';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import { Agent, AgentPipeline, AgentPipelineNode, AgentPipelineEdge } from '../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus, TERMINAL_EXECUTION_STATUSES } from '../../entities/agent-execution.entity';
import { AgentNodeExecutor, NodeExecutionResult } from './agent-node-executor';
import { AgentWebhookService } from './agent-webhook.service';
import { AgentExecutionStateHelper } from './agent-execution-state.helper';
import { ExecutionContext } from './agent-template-resolver';
import { StreamEvent } from './stream-event.types';
import { NotificationsService } from '../notifications/notifications.service';
import { Organization } from '../../entities/organization.entity';
import { resolveRunLimits } from './run-limits';
import { BudgetsService } from '../budgets/budgets.service';
import { AgentExecutionCancellationService } from './agent-execution-cancellation.service';

// Re-export so existing `import { StreamEvent } from './agent-execution.engine'`
// continues to work without changing every consumer in one shot.
export { StreamEvent } from './stream-event.types';

export interface ExecuteAgentOptions {
  input?: Record<string, any>;
  variables?: Record<string, any>;
  metadata?: Record<string, any>;
  /**
   * Cooperative cancellation signal. When this fires (e.g. the HTTP
   * client that kicked off the run disconnected, or a parent agent
   * run was cancelled) the engine:
   *
   *   1. stops queueing new layers — no more nodes will be dispatched
   *   2. marks the execution CANCELLED and saves it
   *   3. emits an execution.failed event with errorType=CANCELLED
   *   4. propagates the signal into every leaf call-site via
   *      NodeExecutionOptions → LlmProvidersService.chat
   *      (request.signal) and ToolExecutorService.executeTool
   *      (options.signal), which in turn thread it into the axios
   *      `signal` config so in-flight HTTP calls abort at the
   *      socket level rather than waiting for the upstream timeout
   *
   * Nodes currently mid-flight inside a layer will see the axios
   * abort surface as an error, which the per-node try/catch
   * converts into a failed-node result; the layer then finishes,
   * the post-layer abort check fires, and the run marks CANCELLED.
   */
  signal?: AbortSignal;
}

export interface EngineInternalOptions {
  nestingDepth?: number;
  maxNestingDepth?: number;
}

/**
 * How long a timed-out layer's aborted nodes are given to come back
 * before the run is written off. Long enough for an aborted HTTP call
 * to reject and report what it spent, short enough that a run already
 * past its wall-clock budget is not held open on work that may never
 * return.
 */
const LAYER_TIMEOUT_DRAIN_MS = 2_000;

/**
 * Cap on the run-level error string. It is assembled from every failed
 * node, stored in an unbounded `text` column, posted to the agent's
 * webhook and rendered into a failure email, so it needs a ceiling of its
 * own. Each node's own message is already capped by safeErrorMessage.
 */
const MAX_EXECUTION_ERROR_CHARS = 2_000;

import { safeErrorMessage } from '../llm-providers/llm-providers.service';

import {
  buildGraph,
  computeLayers,
  markBranchAsSkipped,
} from './agent-execution-graph.helper';
import { StrategyPipelineResolver } from './strategies/strategy-pipeline.resolver';
import { AgentRolesService } from './agent-roles.service';
import { evaluateBudget } from './strategies/budget-policy';
import { capPersistedPayload } from './persist-cap';
import { runWithRequestContext, updateRequestContext } from '../../common/request-context';
import {
  classifiedError,
  classifyNodeError,
  ExecutionErrorType,
  validateInput,
  validatePipelineSize,
} from './agent-execution-validators.helper';

// Re-export for existing
// `import { ExecutionErrorType } from './agent-execution.engine'`
// callers.
export { ExecutionErrorType } from './agent-execution-validators.helper';

@Injectable()
export class AgentExecutionEngine {
  private readonly logger = new Logger(AgentExecutionEngine.name);

  constructor(
    @InjectRepository(Agent)
    private agentRepository: Repository<Agent>,
    @InjectRepository(AgentExecution)
    private agentExecutionRepository: Repository<AgentExecution>,
    private readonly nodeExecutor: AgentNodeExecutor,
    private readonly webhookService: AgentWebhookService,
    private readonly state: AgentExecutionStateHelper,
    // Notification pipeline (@Global module) — @Optional() and appended
    // last so existing test harnesses that construct/compile the engine
    // without it resolve to undefined and skip run.failed emission.
    @Optional()
    private readonly notifications?: NotificationsService,
    // L5. @Optional() so the existing harnesses that construct the engine
    // without it keep working: an agent that has chosen no strategy runs
    // its own graph either way.
    @Optional()
    private readonly strategyPipelines?: StrategyPipelineResolver,
    // L4, needed whenever a compiled strategy is what runs.
    @Optional()
    private readonly agentRoles?: AgentRolesService,
    // Only used to read the organization's run ceiling.
    @Optional()
    @InjectRepository(Organization)
    private readonly organizationRepository?: Repository<Organization>,
    // Spend budgets. Appended last, like every optional dependency on this
    // class: the spec harnesses construct it positionally, so a parameter
    // inserted above silently shifts strategyPipelines and agentRoles along
    // and the engine runs the drawn graph instead of the compiled strategy,
    // with no type error to show for it.
    @Optional()
    private readonly budgets?: BudgetsService,
    // The in-process registry of running executions. Appended last for the
    // same positional reason as everything above it. @Optional() so the
    // spec harnesses that construct the engine without it still run -- an
    // engine with no registry simply cannot be cancelled out-of-band.
    @Optional()
    private readonly cancellations?: AgentExecutionCancellationService,
  ) {}

  /**
   * Execute an agent pipeline with parallel execution, condition branching,
   * timeout/budget enforcement, and optional streaming events.
   *
   * Execution flow:
   * 1. Validate input
   * 2. Create execution record (running)
   * 3. Build graph from pipeline edges
   * 4. Compute execution layers via topological sort (nodes grouped by dependency depth)
   * 5. Process each layer — within a layer, execute independent nodes in parallel
   * 6. Handle condition branching: skip nodes on untaken branches
   * 7. Enforce timeout and budget limits
   * 8. Collect output and update records
   */
  async execute(
    agent: Agent,
    organizationId: string,
    userId: string,
    options: ExecuteAgentOptions = {},
    onEvent?: (event: StreamEvent) => void,
    internalOptions?: EngineInternalOptions,
  ): Promise<AgentExecution> {
    const startTime = Date.now();

    // ── Input validation ────────────────────────────────────────────────
    validateInput(options.input, internalOptions);

    // Spend budgets, before the execution row exists so a rejected run
    // leaves nothing behind. enforceForRun had exactly one caller --
    // agent-runtime.service, gated on mode === 'autonomous' -- so a budget
    // set to 'reject' never stopped a workflow agent, whatever it spent.
    // Workflow spend still counted toward the org total, so the budget
    // could block somebody else's autonomous run while never blocking the
    // run that exhausted it. Every path into a workflow run goes through
    // here: the execution controller, the scheduler, both compat APIs and
    // the sub-agent executor.
    if (this.budgets) {
      await this.budgets.enforceForRun(organizationId, agent.id);
    }

    // 1. Create execution record
    const execution = this.agentExecutionRepository.create({
      agentId: agent.id,
      organizationId,
      userId,
      status: AgentExecutionStatus.RUNNING,
      input: options.input || {},
      metadata: options.metadata || {},
    });
    await this.agentExecutionRepository.save(execution);

    // Now that the execution has an id, put it in the cancellation registry
    // and run on the registry's signal rather than the caller's. The two are
    // the same signal as far as the nodes are concerned -- register() mirrors
    // the caller's abort into it -- but the registry's is reachable by id,
    // which is what lets POST .../executions/:id/cancel stop a run the
    // caller is no longer holding.
    const cancelController = this.cancellations?.register(execution.id, organizationId, options.signal);
    const runSignal: AbortSignal | undefined = cancelController?.signal ?? options.signal;

    // Put this run in the correlation scope. Every log line for the rest
    // of the run, and every row written under it (a tool execution, a
    // model_routed audit row), picks the run up from here instead of
    // having it threaded through each signature in between.
    updateRequestContext({ runId: execution.id, organizationId });

    // Emit execution started
    this.state.emitEvent(onEvent, {
      type: 'execution.started',
      data: { executionId: execution.id, agentId: agent.id },
      timestamp: Date.now(),
    });

    // Declared out here, not inside the try, so the crash path below can
    // still save them. An unexpected throw used to save `status` and
    // `error` and nothing else — discarding every node that had already
    // succeeded, and recording the run's spend as zero though the LLM
    // calls it made were billed. The normal-failure and timeout paths
    // always saved these, which is what made the crash path's omission a
    // bug rather than a decision.
    const nodeResults: Record<string, any> = {};
    let totalCost = 0;
    let totalTokens = 0;
    // Kept alongside totalTokens rather than derived from it: a run mixes
    // llm nodes (which have a split) with tool and transform nodes (which
    // do not), so the two input/output figures sum to at most totalTokens,
    // never necessarily to it.
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    try {
      // A chosen strategy IS the pipeline for this run. Compiled here
      // rather than saved onto the agent, so the shape stays a choice you
      // can change and the graph stays what the person drew.
      // The request text is what an orchestrator decides on, so it has to
      // reach the resolver rather than being rebuilt from the graph later.
      const requestText =
        typeof options.input === 'string'
          ? options.input
          : typeof (options.input as any)?.message === 'string'
            ? (options.input as any).message
            : JSON.stringify(options.input ?? {});

      const compiled = await this.strategyPipelines?.pipelineFor(agent, requestText).catch((err) => {
        throw classifiedError(err?.message ?? 'Could not compile this strategy', ExecutionErrorType.VALIDATION_ERROR);
      });
      if (compiled) {
        execution.metadata = {
          ...(execution.metadata ?? {}),
          strategyKey: compiled.strategyKey,
          // Recorded so a run can answer "why this shape?" — a fallback
          // that looks like a choice is how an orchestrator silently
          // stops working.
          ...(compiled.chosenBy ? { strategyChosenBy: compiled.chosenBy } : {}),
          ...(compiled.fallbackReason ? { strategyFallbackReason: compiled.fallbackReason } : {}),
        };
        // Guarded, and a column update rather than a whole-entity save.
        // `execution` is held in memory with status RUNNING for the life
        // of the run, so saving the entity here would write RUNNING back
        // over a row another replica had just cancelled — resurrecting a
        // cancelled run in the UI and to any scheduler reading status.
        // Only the metadata this block just computed needs to land.
        await this.agentExecutionRepository.update(
          { id: execution.id, status: Not(In([...TERMINAL_EXECUTION_STATUSES])) },
          { metadata: execution.metadata },
        );
      }

      // A compiled strategy names roles on its nodes, so the roles have to
      // be filled before any of them runs. Without this the executor threw
      // "names role principal, which this agent does not define" on an
      // agent that defines exactly that role, because nothing had resolved
      // it — the compiler was wired to the engine and L4 was not.
      let resolvedRoles: Array<{ key: string; modelId: string; via: 'pinned' | 'resolved'; rationale?: string }> | undefined;
      if (compiled && this.agentRoles) {
        try {
          resolvedRoles = await this.agentRoles.resolveRoles(organizationId, agent.id, {}, userId ? { id: userId } : undefined);
        } catch (err: any) {
          // A role that cannot be filled stops the run here, naming the
          // role, rather than surfacing as a confusing node error later.
          throw classifiedError(err?.message ?? 'A role could not be filled', ExecutionErrorType.VALIDATION_ERROR);
        }
      }

      const pipeline = compiled?.pipeline ?? agent.pipeline;
      if (!pipeline || !pipeline.nodes || !pipeline.edges) {
        throw classifiedError('Agent pipeline is not configured', ExecutionErrorType.VALIDATION_ERROR);
      }

      // Validate pipeline size
      validatePipelineSize(pipeline);

      // 2. Build graph
      const { adjacencyList, inDegree, reverseAdjacencyList } = buildGraph(pipeline);

      // 3. Compute execution layers (topological levels)
      const layers = computeLayers(pipeline.nodes, adjacencyList, inDegree);

      // 4. Initialize context
      // The maxSteps/maxToolCalls clamp in agent-node-executor reads
      // context.runLimits. Nothing ever set it, so every loop and tool
      // budget in the product was declared, read, and inert -- a loop node
      // could outrun the run's budget as many times as it liked. The
      // organization row is a best-effort read: resolveRunLimits clamps to
      // the env ceiling whether or not it arrives, so a database hiccup
      // cannot turn a ceiling into no ceiling.
      let organization: Organization | null = null;
      if (this.organizationRepository) {
        try {
          organization = await this.organizationRepository.findOne({ where: { id: organizationId } });
        } catch (err: any) {
          this.logger.warn(
            `Could not load organization run limits for execution ${execution.id}: ${err.message}`,
          );
        }
      }
      const runLimits = resolveRunLimits({ organization, agent });

      const context: ExecutionContext = {
        input: options.input || {},
        nodes: {},
        variables: { ...(agent.variables || {}), ...(options.variables || {}) },
        runLimits: { maxSteps: runLimits.maxSteps, maxToolCalls: runLimits.maxToolCalls },
        // The run-scoped tool-call ledger. `maxToolCalls` was resolved,
        // written onto the context, and compared by nothing -- the comment
        // above claims the node executor clamps on it, and no such clamp
        // existed. One counter per run, shared by reference with every node
        // of every layer, so a fan-out layer's tool nodes count against the
        // same budget instead of each one seeing zero.
        toolCalls: { count: 0 },
      };

      // Build node map
      const nodeMap = new Map<string, AgentPipelineNode>();
      for (const node of pipeline.nodes) {
        nodeMap.set(node.id, node);
      }

      // What the layer just finished cost, used as the estimate for the
      // next one. A projection has to come from somewhere, and the last
      // layer is the only honest signal available between stages.
      let lastLayerCost = 0;
      let finalOutput: any = null;
      // Track whether an `output` node actually ran. Distinguishes
      // "no output node was reached" (failure) from "output node ran and
      // legitimately produced null" (success).
      let outputCaptured = false;
      const skippedNodes = new Set<string>();

      // Timeout and budget settings
      const maxExecutionTime = agent.settings?.maxExecutionTime || 300000; // 5 minutes default
      // Use ?? not || so a user-supplied budgetLimit of 0 ("don't spend
      // anything") is honoured instead of being silently replaced with Infinity.
      const budgetLimit = agent.settings?.budgetLimit ?? Infinity;

      // 5. Process each layer
      for (const layer of layers) {
        // Check cancellation FIRST. If the caller's context was
        // aborted between layers (client disconnected, parent
        // cancelled, job killed), stop dispatching more work and
        // mark the run CANCELLED. This fires before timeout/budget
        // checks so a genuine cancel doesn't get mis-classified.
        if (runSignal?.aborted) {
          execution.status = AgentExecutionStatus.CANCELLED;
          execution.error = 'Execution cancelled';
          execution.executionTime = Date.now() - startTime;
          execution.totalCost = totalCost;
          execution.totalTokens = totalTokens;
          execution.inputTokens = totalInputTokens;
          execution.outputTokens = totalOutputTokens;
          execution.nodeResults = nodeResults;
          if (!(await this.commitTerminal(execution, agent.id, onEvent, totalCost))) return execution;
          await this.state.bumpAgentStats(agent.id, false, Date.now() - startTime, totalCost);

          this.state.emitEvent(onEvent, {
            type: 'execution.failed',
            data: {
              error: execution.error,
              errorType: 'CANCELLED',
              executionId: execution.id,
            },
            timestamp: Date.now(),
          });

          return execution;
        }

        // Check timeout
        if (Date.now() - startTime > maxExecutionTime) {
          execution.status = AgentExecutionStatus.TIMEOUT;
          execution.error = `Execution timed out after ${maxExecutionTime}ms`;
          execution.executionTime = Date.now() - startTime;
          execution.nodeResults = nodeResults;
          if (!(await this.commitTerminal(execution, agent.id, onEvent, totalCost))) return execution;
          await this.state.bumpAgentStats(agent.id, false, Date.now() - startTime, totalCost);

          this.state.emitEvent(onEvent, {
            type: 'execution.failed',
            data: { error: execution.error, errorType: ExecutionErrorType.TIMEOUT, executionId: execution.id },
            timestamp: Date.now(),
          });

          this.notifyRunFailed(agent, execution).catch(() => {});
          return execution;
        }

        // Stop rules, before the hard cap. A run that has already got
        // what it needs should finish because it is DONE, not because it
        // ran out of money — and the recorded reason should say which.
        // An agent with no budget policy is unaffected: evaluateBudget
        // returns continue for an absent policy.
        const budgetVerdict = evaluateBudget(agent.settings?.budget as any, {
          spentCents: Math.round(totalCost * 100),
          // The layer just run is the closest estimate of the next one.
          nextStageCents: Math.round(lastLayerCost * 100),
        });
        if (budgetVerdict.action === 'stop') {
          execution.status = AgentExecutionStatus.COMPLETED;
          execution.metadata = {
            ...(execution.metadata ?? {}),
            budgetStop: { reason: budgetVerdict.reason, projection: budgetVerdict.projection },
          };
          execution.executionTime = Date.now() - startTime;
          execution.totalCost = totalCost;
          execution.totalTokens = totalTokens;
          execution.inputTokens = totalInputTokens;
          execution.outputTokens = totalOutputTokens;
          execution.nodeResults = nodeResults;
          execution.output = context.nodes;
          if (!(await this.commitTerminal(execution, agent.id, onEvent, totalCost))) return execution;
          this.logger.log(`[EXECUTE] Agent ${agent.id} stopped on budget policy: ${budgetVerdict.reason}`);
          return execution;
        }

        // Check budget
        if (totalCost > budgetLimit) {
          execution.status = AgentExecutionStatus.FAILED;
          execution.error = `Budget limit ($${budgetLimit}) exceeded: $${totalCost.toFixed(4)}`;
          execution.executionTime = Date.now() - startTime;
          execution.totalCost = totalCost;
          execution.totalTokens = totalTokens;
          execution.inputTokens = totalInputTokens;
          execution.outputTokens = totalOutputTokens;
          execution.nodeResults = nodeResults;
          if (!(await this.commitTerminal(execution, agent.id, onEvent, totalCost))) return execution;
          await this.state.bumpAgentStats(agent.id, false, Date.now() - startTime, totalCost);

          this.state.emitEvent(onEvent, {
            type: 'execution.failed',
            data: { error: execution.error, errorType: ExecutionErrorType.BUDGET_EXCEEDED, executionId: execution.id },
            timestamp: Date.now(),
          });

          this.notifyRunFailed(agent, execution).catch(() => {});
          return execution;
        }

        // Filter out skipped nodes in this layer
        const activeNodes = layer.filter(nodeId => !skippedNodes.has(nodeId));

        if (activeNodes.length === 0) continue;

        // Budget-aware cancellation for this layer. A fan-out layer runs all
        // its nodes in parallel, so without this a single layer could blow
        // well past budgetLimit before the between-layer check fires. We trip
        // this AbortSignal the moment accumulated cost crosses the limit, so
        // in-flight LLM/tool calls abort instead of running to completion.
        // It also mirrors the caller's cancellation signal, so nodes get one
        // signal covering both client-cancel and budget.
        const layerAbort = new AbortController();
        const forwardCallerAbort = () => layerAbort.abort();
        if (runSignal) {
          if (runSignal.aborted) layerAbort.abort();
          else runSignal.addEventListener('abort', forwardCallerAbort, { once: true });
        }
        let layerRunningCost = totalCost;

        // Execute all nodes in this layer in parallel — each wrapped in try/catch
        const layerPromises = activeNodes.map(async (nodeId) => {
          const node = nodeMap.get(nodeId);
          if (!node) return;

          const nodeStartedAt = Date.now();

          this.logger.log(`[EXECUTE] Processing node '${nodeId}' (type=${node.type}) for agent=${agent.id}`);

          this.state.emitEvent(onEvent, {
            type: 'node.started',
            nodeId,
            nodeType: node.type,
            timestamp: Date.now(),
          });

          try {
            // Execute node. Thread the cancellation signal through
            // NodeExecutionOptions so leaf calls (LLM, tool, sub-agent)
            // can propagate it into their own axios / sub-execute paths
            // and abort mid-flight on client disconnect.
            // A real nested scope, not an in-place update: the nodes of a
            // layer run concurrently under Promise.all, so mutating one
            // shared store would have them overwrite each other's nodeId.
            const result: NodeExecutionResult = await runWithRequestContext(
              { nodeId },
              () =>
                this.nodeExecutor.execute(
                  node,
                  context,
                  organizationId,
                  userId,
                  {
                    organizationId,
                    userId,
                    edges: pipeline.edges,
                    nestingDepth: internalOptions?.nestingDepth,
                    // A nested run inherits the ceiling its parent was
                    // given; a top-level run gets the one resolved for it.
                    // Without the fallback the sub-agent executor reached
                    // its own hard-coded `|| 5` on every top-level run, so
                    // `maxRecursionDepth` -- an organization setting with an
                    // operator env floor (RUN_LIMIT_MAX_RECURSION_DEPTH) --
                    // was resolved and then governed nothing.
                    maxNestingDepth: internalOptions?.maxNestingDepth ?? runLimits.maxRecursionDepth,
                    signal: layerAbort.signal,
                    // Filled once for the whole run, above, rather than per
                    // node: a role is one decision, and resolving it per node
                    // would let two nodes of the same run answer from
                    // different models.
                    resolvedRoles,
                  },
                ),
            );

            const nodeCompletedAt = Date.now();

            // Accumulate this node's cost and trip the layer abort if we've
            // crossed the budget, so any still-running siblings stop early.
            layerRunningCost += result.cost || 0;
            if (budgetLimit !== Infinity && layerRunningCost > budgetLimit) {
              layerAbort.abort();
            }

            return {
              nodeId,
              node,
              result,
              error: null as string | null,
              errorType: null as ExecutionErrorType | null,
              errorCode: undefined as string | undefined,
              errorModel: undefined as string | undefined,
              errorProviderId: undefined as string | undefined,
              // What the node was actually given, so the run is
              // reproducible from its own record.
              resolvedInput: result?.resolvedInput,
              startedAt: nodeStartedAt,
              completedAt: nodeCompletedAt,
            };
          } catch (err: any) {
            const nodeCompletedAt = Date.now();
            const errorType = classifyNodeError(err);

            this.logger.error(
              `[EXECUTE] Node '${nodeId}' failed (${errorType}): ${err.message}`,
              err.stack,
            );

            return {
              nodeId,
              node,
              result: null as NodeExecutionResult | null,
              error: safeErrorMessage(err),
              errorType,
              // Typed cause, so callers that only see the persisted node
              // results (the scheduler) can still act on MODEL_NOT_FOUND.
              errorCode: err?.code as string | undefined,
              triedModels: Array.isArray(err?.tried) ? err.tried : undefined,
              errorModel: findModelNotFound(err)?.model,
              errorProviderId: findModelNotFound(err)?.providerId,
              // A failing node's resolved prompt is exactly what someone
              // needs to reproduce the failure, and it was persisted
              // nowhere.
              resolvedInput: err?.resolvedInput,
              attemptedProviderId: err?.attemptedProviderId as string | undefined,
              attemptedModel: err?.attemptedModel as string | undefined,
              startedAt: nodeStartedAt,
              completedAt: nodeCompletedAt,
            };
          }
        });

        // Wrap layer execution in timeout. If we hit the layer-level timeout,
        // surface it as TIMEOUT (not generic FAILED) so callers can distinguish
        // a slow run from a logic failure.
        const remainingTime = maxExecutionTime - (Date.now() - startTime);
        let layerResults;
        try {
          layerResults = await this.state.withTimeout(
            Promise.all(layerPromises),
            remainingTime,
            `Layer execution timed out`,
            // Stop the work, not just the waiting. Promise.race abandons
            // the layer's promises but they keep running — against the
            // provider, on our bill — and could still write side effects
            // after the execution row says TIMEOUT.
            () => layerAbort.abort(),
          );
        } catch (timeoutErr: any) {
          runSignal?.removeEventListener('abort', forwardCallerAbort);

          // Give the aborted nodes a bounded moment to come back, so the
          // cost they already incurred is counted. `layerRunningCost`
          // accumulates as each node returns, and the timeout path used
          // to persist `totalCost` — the total as of the *previous*
          // layer — discarding this layer's spend entirely and feeding
          // that undercount to bumpAgentStats, which is what budget
          // enforcement reads.
          const drained = await this.state.settleWithin(layerPromises, LAYER_TIMEOUT_DRAIN_MS);

          // A node that never reported has a cost we cannot know. Record
          // that, rather than letting a missing number read as zero.
          const unaccounted: string[] = [];
          activeNodes.forEach((nodeId, i) => {
            const settled = drained.results[i];
            const reported = settled?.status === 'fulfilled' && !!(settled.value as any)?.result;
            if (reported) return;
            unaccounted.push(nodeId);
            nodeResults[nodeId] = {
              error: 'Aborted by the layer timeout',
              errorType: ExecutionErrorType.TIMEOUT,
              // Explicitly not "cost 0": the node was cancelled in
              // flight and never told us what it had spent.
              costAccounted: false,
            };
          });

          execution.status = AgentExecutionStatus.TIMEOUT;
          execution.error = unaccounted.length
            ? `Execution timed out after ${maxExecutionTime}ms; the cost of ${unaccounted.length} ` +
              `node(s) (${unaccounted.join(', ')}) could not be determined`
            : `Execution timed out after ${maxExecutionTime}ms`;
          execution.executionTime = Date.now() - startTime;
          execution.totalCost = layerRunningCost;
          execution.totalTokens = totalTokens;
          execution.inputTokens = totalInputTokens;
          execution.outputTokens = totalOutputTokens;
          execution.nodeResults = nodeResults;
          if (!(await this.commitTerminal(execution, agent.id, onEvent, layerRunningCost))) return execution;
          await this.state.bumpAgentStats(agent.id, false, Date.now() - startTime, layerRunningCost);

          this.state.emitEvent(onEvent, {
            type: 'execution.failed',
            data: { error: execution.error, errorType: ExecutionErrorType.TIMEOUT, executionId: execution.id },
            timestamp: Date.now(),
          });

          this.notifyRunFailed(agent, execution).catch(() => {});
          return execution;
        }

        // Done with this layer's abort; the next layer installs its own.
        runSignal?.removeEventListener('abort', forwardCallerAbort);

        // Track whether any node in this layer failed
        let layerHasFailure = false;

        // Process layer results
        let layerCost = 0;
        for (const item of layerResults) {
          if (!item) continue;
          const { nodeId, node, result, error, errorType, errorCode, errorModel, errorProviderId, startedAt, completedAt } = item;

          if (error || !result) {
            // Node failed — record error but continue with other branches
            layerHasFailure = true;
            nodeResults[nodeId] = {
              error,
              errorType,
              ...(errorCode ? { errorCode, errorModel, errorProviderId } : {}),
              // Which models were tried before giving up. A node where every
              // candidate failed leaves no routing attribution, because
              // nothing answered -- so without this the co-failures would be
              // invisible exactly when they matter most.
              ...(item.triedModels?.length ? { triedModels: item.triedModels } : {}),
              // The resolved prompt / parameters this node was given, so a
              // failure can be reproduced from the record rather than
              // guessed at from the graph and the templates.
              ...(item.resolvedInput !== undefined
                ? { input: capPersistedPayload(item.resolvedInput) }
                : {}),
              ...(item.attemptedProviderId ? { providerId: item.attemptedProviderId } : {}),
              ...(item.attemptedModel ? { model: item.attemptedModel } : {}),
              startedAt,

              completedAt,
              executionTime: completedAt - startedAt,
            };
            // Marked, not just blanked: a downstream node reading upstream state must be able to tell a failure from a legitimate undefined.
            context.nodes[nodeId] = { output: undefined, status: 'failed' };

            this.state.emitEvent(onEvent, {
              type: 'node.completed',
              nodeId,
              nodeType: node.type,
              data: { error, errorType },
              timestamp: Date.now(),
            });

            // Skip all downstream nodes of a failed node
            const neighbors = adjacencyList.get(nodeId) || [];
            for (const neighbor of neighbors) {
              markBranchAsSkipped(neighbor, adjacencyList, skippedNodes, pipeline.edges);
            }
            continue;
          }

          // Store result in context
          context.nodes[nodeId] = { output: result.output };
          nodeResults[nodeId] = {
            output: result.output,
            cost: result.cost || 0,
            tokens: result.tokens || 0,
            executionTime: result.executionTime || 0,
            startedAt,
            completedAt,
            ...(result.resolvedInput !== undefined
              ? { input: capPersistedPayload(result.resolvedInput) }
              : {}),
            // Model attribution for the spend on this step, routed or
            // pinned. A step used to carry a cost with no model beside
            // it whenever the agent pinned a provider.
            ...(result.providerId ? { providerId: result.providerId } : {}),
            ...(result.model ? { model: result.model } : {}),
            ...(result.routing ? { routing: result.routing } : {}),
            // A template reference that resolved to nothing was substituted
            // with an empty string. That is correct for an optional field and
            // is also what a typo looks like, so the reference is carried here
            // rather than left in a server-side log the person reading the run
            // will never see.
            ...(result.unresolvedReferences?.length
              ? { unresolvedReferences: result.unresolvedReferences }
              : {}),
          };


          totalCost += result.cost || 0;
          layerCost += result.cost || 0;
          totalTokens += result.tokens || 0;
          totalInputTokens += result.inputTokens || 0;
          totalOutputTokens += result.outputTokens || 0;

          this.state.emitEvent(onEvent, {
            type: 'node.output',
            nodeId,
            nodeType: node.type,
            data: { output: result.output },
            timestamp: Date.now(),
          });

          this.state.emitEvent(onEvent, {
            type: 'node.completed',
            nodeId,
            nodeType: node.type,
            data: {
              cost: result.cost || 0,
              tokens: result.tokens || 0,
              executionTime: result.executionTime || 0,
            },
            timestamp: Date.now(),
          });

          // Handle condition branching: skip nodes on the untaken branch
          if (node.type === 'condition' && result.output?.__condition) {
            const conditionResult = result.output.result;
            const outgoingEdges = pipeline.edges.filter(e => e.source === nodeId);

            for (const edge of outgoingEdges) {
              const handle = edge.sourceHandle || edge.label || '';
              const isTrueBranch = handle === 'true' || handle === 'yes';
              const isFalseBranch = handle === 'false' || handle === 'no';

              // Skip the untaken branch
              if ((conditionResult && isFalseBranch) || (!conditionResult && isTrueBranch)) {
                markBranchAsSkipped(edge.target, adjacencyList, skippedNodes, pipeline.edges);
              }
            }
          }

          // Handle decision branching: skip every option branch that was
          // not chosen.
          //
          // Without this the decision node is a classifier with a label on
          // it rather than a router. It would name the option it picked,
          // the run would proceed down EVERY option edge anyway, and the
          // failure would not look like a failure: each branch produces a
          // plausible result and the merge downstream reports success. The
          // threshold would be the most misleading part, because the whole
          // point of routing a low-confidence answer to abstain is that the
          // confident branches do not run.
          if (node.type === 'decision' && result.output?.__decision) {
            const chosen = result.output.selectedOption;
            const outgoingEdges = pipeline.edges.filter(e => e.source === nodeId);

            for (const edge of outgoingEdges) {
              const handle = edge.sourceHandle || edge.label || '';
              if (handle && handle !== chosen) {
                markBranchAsSkipped(edge.target, adjacencyList, skippedNodes, pipeline.edges);
              }
            }
          }

          // Capture output node
          if (node.type === 'output') {
            finalOutput = result.output;
            outputCaptured = true;
          }
        }

        // Carried to the next iteration's budget check: the layer just
        // finished is the closest thing to an estimate of the next one.
        lastLayerCost = layerCost;

        // Mark skipped nodes in nodeResults
        for (const nodeId of layer) {
          if (skippedNodes.has(nodeId) && !nodeResults[nodeId]) {
            const node = nodeMap.get(nodeId);
            nodeResults[nodeId] = { skipped: true };
            context.nodes[nodeId] = { output: undefined, status: 'skipped' };

            this.state.emitEvent(onEvent, {
              type: 'node.skipped',
              nodeId,
              nodeType: node?.type,
              timestamp: Date.now(),
            });
          }
        }
      }

      // Final budget check. The between-layer check only fires before a NEXT
      // layer, so a last layer that crossed the limit (mid-flight abort or
      // not) is classified here as BUDGET_EXCEEDED instead of falling through
      // to the generic node-failure path below.
      if (totalCost > budgetLimit) {
        execution.status = AgentExecutionStatus.FAILED;
        execution.error = `Budget limit ($${budgetLimit}) exceeded: $${totalCost.toFixed(4)}`;
        execution.executionTime = Date.now() - startTime;
        execution.totalCost = totalCost;
        execution.totalTokens = totalTokens;
        execution.inputTokens = totalInputTokens;
        execution.outputTokens = totalOutputTokens;
        execution.nodeResults = nodeResults;
        if (!(await this.commitTerminal(execution, agent.id, onEvent, totalCost))) return execution;
        await this.state.bumpAgentStats(agent.id, false, Date.now() - startTime, totalCost);
        this.state.emitEvent(onEvent, {
          type: 'execution.failed',
          data: { error: execution.error, errorType: ExecutionErrorType.BUDGET_EXCEEDED, executionId: execution.id },
          timestamp: Date.now(),
        });
        this.notifyRunFailed(agent, execution).catch(() => {});
        return execution;
      }

      const executionTime = Date.now() - startTime;

      // A cancel that arrives while the LAST layer is running has no next
      // layer for the between-layer check to guard, so without this the
      // engine would write a terminal status straight over the CANCELLED row
      // the cancellation service just persisted, and the caller who asked to
      // stop would be told the run finished. Keyed on an explicit cancel,
      // not on the signal: a client that merely disconnected as the run
      // landed still gets its answer recorded.
      //
      // Checked BEFORE the node-failure branch below, not after. Aborting the
      // last layer is exactly what a cancel does, so its nodes come back as
      // errors and no `output` node captures -- which sent the run down the
      // `hasNodeFailures && !outputCaptured` path and recorded a cancel as
      // "Pipeline failed: ...". The guard was written for this case and sat
      // one branch too late to ever see it.
      if (this.cancellations?.isCancelled(execution.id)) {
        execution.status = AgentExecutionStatus.CANCELLED;
        execution.error = 'Execution cancelled';
        execution.output = finalOutput;
        execution.nodeResults = nodeResults;
        execution.executionTime = executionTime;
        execution.totalCost = totalCost;
        execution.totalTokens = totalTokens;
        execution.inputTokens = totalInputTokens;
        execution.outputTokens = totalOutputTokens;
        if (!(await this.commitTerminal(execution, agent.id, onEvent, totalCost))) return execution;
        await this.state.bumpAgentStats(agent.id, false, executionTime, totalCost);
        this.state.emitEvent(onEvent, {
          type: 'execution.failed',
          data: { error: execution.error, errorType: 'CANCELLED', executionId: execution.id },
          timestamp: Date.now(),
        });
        return execution;
      }

      // Check if any node failed — if the output node was never reached, mark as failed.
      // Use the explicit `outputCaptured` flag instead of `finalOutput === null` so an
      // output node that legitimately produced `null` isn't treated as "no output ran".
      const hasNodeFailures = Object.values(nodeResults).some((r: any) => r.error);

      if (hasNodeFailures && !outputCaptured) {
        // Capped. `execution.error` is a `text` column with no length of its
        // own and this concatenates every failed node of a pipeline that may
        // have a hundred of them; the same string is posted to the agent's
        // webhook and rendered into a failure email. Each node's message has
        // already been through safeErrorMessage above.
        const failedNodes = Object.entries(nodeResults)
          .filter(([, r]: [string, any]) => r.error)
          .map(([id, r]: [string, any]) => `${id}: ${r.error}`)
          .join('; ');

        execution.status = AgentExecutionStatus.FAILED;
        execution.error = `Pipeline failed: ${failedNodes}`.slice(0, MAX_EXECUTION_ERROR_CHARS);
        execution.output = null;
        execution.nodeResults = nodeResults;
        execution.executionTime = executionTime;
        execution.totalCost = totalCost;
        execution.totalTokens = totalTokens;
        execution.inputTokens = totalInputTokens;
        execution.outputTokens = totalOutputTokens;
        if (!(await this.commitTerminal(execution, agent.id, onEvent, totalCost))) return execution;

        await this.state.bumpAgentStats(agent.id, false, executionTime, totalCost);

        this.state.emitEvent(onEvent, {
          type: 'execution.failed',
          data: { error: execution.error, executionId: execution.id },
          timestamp: Date.now(),
        });

        this.notifyRunFailed(agent, execution).catch(() => {});

        return execution;
      }

      // 8. Update execution record
      execution.status = AgentExecutionStatus.COMPLETED;
      execution.output = finalOutput;
      execution.nodeResults = nodeResults;
      execution.executionTime = executionTime;
      execution.totalCost = totalCost;
      execution.totalTokens = totalTokens;
      execution.inputTokens = totalInputTokens;
      execution.outputTokens = totalOutputTokens;
      if (!(await this.commitTerminal(execution, agent.id, onEvent, totalCost))) return execution;

      // 9. Update agent stats atomically via SQL UPDATE.
      await this.state.bumpAgentStats(agent.id, true, executionTime, totalCost);

      this.logger.log(`[EXECUTE] Agent ${agent.id} execution completed in ${executionTime}ms, cost=${totalCost}`);

      this.state.emitEvent(onEvent, {
        type: 'execution.completed',
        data: {
          executionId: execution.id,
          output: finalOutput,
          executionTime,
          totalCost,
          totalTokens,
        },
        timestamp: Date.now(),
      });

      // Send webhook notification (fire-and-forget)
      this.webhookService.sendExecutionWebhook(agent, execution).catch(() => {});

      return execution;
    } catch (error) {
      const executionTime = Date.now() - startTime;

      // Update execution with error — always, even on unexpected crashes.
      // Everything that had already happened is saved with it: the nodes
      // that succeeded before the throw, and the cost and tokens they
      // actually spent. Saving `status` and `error` alone threw away the
      // run's whole record and reported its spend as zero, which made the
      // crash both unreproducible and free.
      execution.status = AgentExecutionStatus.FAILED;
      execution.error = safeErrorMessage(error);
      execution.executionTime = executionTime;
      execution.nodeResults = nodeResults;
      execution.totalCost = totalCost;
      execution.totalTokens = totalTokens;
      execution.inputTokens = totalInputTokens;
      execution.outputTokens = totalOutputTokens;
      // Logged before the write, so a crash is still diagnosable even
      // when the write below turns out to have lost a race and returns
      // early.
      this.logger.error(
        `[EXECUTE] Agent ${agent.id} execution failed: ${error.message} ` +
          `(nodes=${Object.keys(nodeResults).length}, cost=${totalCost})`,
        error.stack,
      );

      // Guarded like every other terminal write: a crash here must not
      // overwrite a terminal status another replica already recorded —
      // a cancel, most often.
      let committed = true;
      try {
        committed = await this.commitTerminal(execution, agent.id, onEvent, totalCost);
      } catch (saveError) {
        this.logger.error(`[EXECUTE] Failed to persist execution record on crash: ${saveError.message}`);
      }
      // commitTerminal has already banked the spend and announced the
      // outcome that stands; announcing this crash over it would tell the
      // caller their cancelled run failed instead.
      if (!committed) return execution;

      // Separate try, so a failed row write does not also cost us the
      // stats bump — and with the real cost, not 0. The LLM calls the run
      // made before it crashed were billed, so passing 0 here
      // undercounted every spend surface and every budget check
      // downstream of it.
      try {
        await this.state.bumpAgentStats(agent.id, false, executionTime, totalCost);
      } catch (statsError) {
        this.logger.error(`[EXECUTE] Failed to bump agent stats on crash: ${statsError.message}`);
      }

      this.state.emitEvent(onEvent, {
        type: 'execution.failed',
        data: { error: error.message, executionId: execution.id },
        timestamp: Date.now(),
      });

      // Send webhook notification for failures too (fire-and-forget)
      this.webhookService.sendExecutionWebhook(agent, execution).catch(() => {});
      this.notifyRunFailed(agent, execution).catch(() => {});

      return execution;
    } finally {
      // Every exit from this method -- completed, failed, timed out,
      // cancelled, crashed -- stops tracking the execution. A registry that
      // leaked entries would both grow without bound and let a cancel abort
      // a controller nothing is listening to.
      this.cancellations?.release(execution.id);
    }
  }

  /**
   * Persist a terminal outcome for this run, guarded on the row not
   * already being terminal, and report whether ours is the one that
   * landed.
   *
   * The API runs more than one replica and the cancellation registry is
   * per-process, so a cancel routinely lands on a replica that is not the
   * one running the execution: that replica writes CANCELLED and answers
   * 200 while this one carries on to the end of the pipeline. An
   * unguarded `save()` then wrote COMPLETED straight over the CANCELLED
   * row — the user was told it stopped, it did not, and the record then
   * claimed it had finished normally. Same shape as the autonomous path's
   * `commitStep`: a terminal status is final, whoever gets there first.
   *
   * This is the half that holds on its own. The cross-replica cancel
   * signal stops the wasted spend; this stops the lie about it, and keeps
   * doing so whenever the signal cannot be delivered (no Redis, a dropped
   * subscription, a replica that started the run before it subscribed).
   *
   * When the guard rejects the write, the in-memory entity is refreshed
   * from the row so the caller returns the outcome that actually stands
   * rather than the one this replica wanted; the spend this run really
   * incurred is still banked against the agent; and what any attached
   * stream is told is `execution.failed`/CANCELLED rather than whatever
   * this replica was about to announce.
   */
  private async commitTerminal(
    execution: AgentExecution,
    agentId: string,
    onEvent: ((event: StreamEvent) => void) | undefined,
    costForStats: number,
  ): Promise<boolean> {
    // Captured before the reload below, which replaces them with the
    // winning writer's values.
    const executionTime = execution.executionTime ?? 0;

    // Statuses this write is allowed to land on: the two non-terminal
    // ones, plus the outcome we are about to write.
    //
    // That last entry is not a loophole. The cancellation service records
    // CANCELLED with status and error alone, because it is answering an
    // HTTP request and has no idea what the run spent; the engine then
    // arrives with the cost, the tokens and the node results for the same
    // CANCELLED outcome. Letting it complete the record it agrees with is
    // not overwriting somebody else's answer — refusing it would just
    // lose the spend off a cancelled run.
    const writableFrom = [
      AgentExecutionStatus.PENDING,
      AgentExecutionStatus.RUNNING,
      execution.status,
    ];

    const result = await this.agentExecutionRepository.update(
      { id: execution.id, status: In(writableFrom) },
      {
        status: execution.status,
        error: execution.error,
        output: execution.output,
        nodeResults: execution.nodeResults,
        executionTime: execution.executionTime,
        totalCost: execution.totalCost,
        totalTokens: execution.totalTokens,
        inputTokens: execution.inputTokens,
        outputTokens: execution.outputTokens,
        metadata: execution.metadata,
      },
    );
    if ((result.affected ?? 0) > 0) return true;

    // Lost the race. Answer with the row, not with our own intent.
    const live = await this.agentExecutionRepository.findOne({ where: { id: execution.id } });
    if (live) Object.assign(execution, live);

    this.logger.warn(
      `[EXECUTE] Execution ${execution.id} already reached ${execution.status} elsewhere; ` +
        "discarding this replica's terminal write instead of overwriting it",
    );

    // The model calls this run made were billed whoever won the race, so
    // the spend is still banked — as a failure, which is what the row now
    // says the run was.
    try {
      await this.state.bumpAgentStats(agentId, false, executionTime, costForStats);
    } catch (statsError: any) {
      this.logger.error(`[EXECUTE] Failed to bump agent stats after a lost terminal write: ${statsError?.message}`);
    }

    this.state.emitEvent(onEvent, {
      type: 'execution.failed',
      data: {
        error: execution.error ?? 'Execution cancelled',
        errorType: 'CANCELLED',
        executionId: execution.id,
      },
      timestamp: Date.now(),
    });

    return false;
  }

  /**
   * run.failed notification for UNATTENDED runs only. An interactive
   * Try-It invocation surfaces its failure directly in the UI the user
   * is looking at; a scheduled (or webhook-triggered) run failing at
   * 3am would otherwise go unnoticed. Detection is by the triggerType
   * the scheduler/webhook path stamps into execution.metadata.
   * In-app row by default; email only for users who explicitly enabled
   * it (the defaults matrix has run.failed email OFF).
   */
  private async notifyRunFailed(agent: Agent, execution: AgentExecution): Promise<void> {
    try {
      if (!this.notifications) return;
      const triggerType = (execution.metadata as any)?.triggerType;
      if (triggerType !== 'scheduled' && triggerType !== 'webhook') return;
      if (!execution.userId) return;
      const baseUrl = process.env.FRONTEND_URL || 'https://app.staging.almyty.com';
      await this.notifications.emit({
        type: 'run.failed',
        organizationId: execution.organizationId,
        userIds: [execution.userId],
        title: `Run failed: ${agent.name}`,
        body: execution.error || 'Run failed',
        link: `/agents/${agent.id}`,
        email: {
          template: 'run.failed',
          params: {
            agentName: agent.name,
            error: execution.error,
            triggerType,
            agentUrl: `${baseUrl}/agents/${agent.id}`,
          },
        },
      });
    } catch {
      // Notification delivery must never affect the execution result.
    }
  }

}
