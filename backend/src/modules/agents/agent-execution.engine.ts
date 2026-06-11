import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent, AgentPipeline, AgentPipelineNode, AgentPipelineEdge } from '../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../entities/agent-execution.entity';
import { AgentNodeExecutor, NodeExecutionResult } from './agent-node-executor';
import { AgentWebhookService } from './agent-webhook.service';
import { AgentExecutionStateHelper } from './agent-execution-state.helper';
import { ExecutionContext } from './agent-template-resolver';
import { StreamEvent } from './stream-event.types';

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

import {
  buildGraph,
  computeLayers,
  markBranchAsSkipped,
} from './agent-execution-graph.helper';
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

    // Emit execution started
    this.state.emitEvent(onEvent, {
      type: 'execution.started',
      data: { executionId: execution.id, agentId: agent.id },
      timestamp: Date.now(),
    });

    try {
      const pipeline = agent.pipeline;
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
      const context: ExecutionContext = {
        input: options.input || {},
        nodes: {},
        variables: { ...(agent.variables || {}), ...(options.variables || {}) },
      };

      // Build node map
      const nodeMap = new Map<string, AgentPipelineNode>();
      for (const node of pipeline.nodes) {
        nodeMap.set(node.id, node);
      }

      const nodeResults: Record<string, any> = {};
      let totalCost = 0;
      let totalTokens = 0;
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
        if (options.signal?.aborted) {
          execution.status = AgentExecutionStatus.CANCELLED;
          execution.error = 'Execution cancelled';
          execution.executionTime = Date.now() - startTime;
          execution.totalCost = totalCost;
          execution.totalTokens = totalTokens;
          execution.nodeResults = nodeResults;
          await this.agentExecutionRepository.save(execution);
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
          await this.agentExecutionRepository.save(execution);
          await this.state.bumpAgentStats(agent.id, false, Date.now() - startTime, totalCost);

          this.state.emitEvent(onEvent, {
            type: 'execution.failed',
            data: { error: execution.error, errorType: ExecutionErrorType.TIMEOUT, executionId: execution.id },
            timestamp: Date.now(),
          });

          return execution;
        }

        // Check budget
        if (totalCost > budgetLimit) {
          execution.status = AgentExecutionStatus.FAILED;
          execution.error = `Budget limit ($${budgetLimit}) exceeded: $${totalCost.toFixed(4)}`;
          execution.executionTime = Date.now() - startTime;
          execution.totalCost = totalCost;
          execution.totalTokens = totalTokens;
          execution.nodeResults = nodeResults;
          await this.agentExecutionRepository.save(execution);
          await this.state.bumpAgentStats(agent.id, false, Date.now() - startTime, totalCost);

          this.state.emitEvent(onEvent, {
            type: 'execution.failed',
            data: { error: execution.error, errorType: ExecutionErrorType.BUDGET_EXCEEDED, executionId: execution.id },
            timestamp: Date.now(),
          });

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
        if (options.signal) {
          if (options.signal.aborted) layerAbort.abort();
          else options.signal.addEventListener('abort', forwardCallerAbort, { once: true });
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
            const result: NodeExecutionResult = await this.nodeExecutor.execute(
              node,
              context,
              organizationId,
              userId,
              {
                organizationId,
                userId,
                edges: pipeline.edges,
                nestingDepth: internalOptions?.nestingDepth,
                maxNestingDepth: internalOptions?.maxNestingDepth,
                signal: layerAbort.signal,
              },
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
              error: err.message || 'Unknown node error',
              errorType,
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
          );
        } catch (timeoutErr: any) {
          execution.status = AgentExecutionStatus.TIMEOUT;
          execution.error = `Execution timed out after ${maxExecutionTime}ms`;
          execution.executionTime = Date.now() - startTime;
          execution.totalCost = totalCost;
          execution.totalTokens = totalTokens;
          execution.nodeResults = nodeResults;
          await this.agentExecutionRepository.save(execution);
          await this.state.bumpAgentStats(agent.id, false, Date.now() - startTime, totalCost);

          this.state.emitEvent(onEvent, {
            type: 'execution.failed',
            data: { error: execution.error, errorType: ExecutionErrorType.TIMEOUT, executionId: execution.id },
            timestamp: Date.now(),
          });

          return execution;
        }

        // Done with this layer's abort; the next layer installs its own.
        options.signal?.removeEventListener('abort', forwardCallerAbort);

        // Track whether any node in this layer failed
        let layerHasFailure = false;

        // Process layer results
        for (const item of layerResults) {
          if (!item) continue;
          const { nodeId, node, result, error, errorType, startedAt, completedAt } = item;

          if (error || !result) {
            // Node failed — record error but continue with other branches
            layerHasFailure = true;
            nodeResults[nodeId] = {
              error,
              errorType,
              startedAt,
              completedAt,
              executionTime: completedAt - startedAt,
            };
            context.nodes[nodeId] = { output: undefined };

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
          };

          totalCost += result.cost || 0;
          totalTokens += result.tokens || 0;

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

          // Capture output node
          if (node.type === 'output') {
            finalOutput = result.output;
            outputCaptured = true;
          }
        }

        // Mark skipped nodes in nodeResults
        for (const nodeId of layer) {
          if (skippedNodes.has(nodeId) && !nodeResults[nodeId]) {
            const node = nodeMap.get(nodeId);
            nodeResults[nodeId] = { skipped: true };
            context.nodes[nodeId] = { output: undefined };

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
        execution.nodeResults = nodeResults;
        await this.agentExecutionRepository.save(execution);
        await this.state.bumpAgentStats(agent.id, false, Date.now() - startTime, totalCost);
        this.state.emitEvent(onEvent, {
          type: 'execution.failed',
          data: { error: execution.error, errorType: ExecutionErrorType.BUDGET_EXCEEDED, executionId: execution.id },
          timestamp: Date.now(),
        });
        return execution;
      }

      const executionTime = Date.now() - startTime;

      // Check if any node failed — if the output node was never reached, mark as failed.
      // Use the explicit `outputCaptured` flag instead of `finalOutput === null` so an
      // output node that legitimately produced `null` isn't treated as "no output ran".
      const hasNodeFailures = Object.values(nodeResults).some((r: any) => r.error);

      if (hasNodeFailures && !outputCaptured) {
        const failedNodes = Object.entries(nodeResults)
          .filter(([, r]: [string, any]) => r.error)
          .map(([id, r]: [string, any]) => `${id}: ${r.error}`)
          .join('; ');

        execution.status = AgentExecutionStatus.FAILED;
        execution.error = `Pipeline failed: ${failedNodes}`;
        execution.output = null;
        execution.nodeResults = nodeResults;
        execution.executionTime = executionTime;
        execution.totalCost = totalCost;
        execution.totalTokens = totalTokens;
        await this.agentExecutionRepository.save(execution);

        await this.state.bumpAgentStats(agent.id, false, executionTime, totalCost);

        this.state.emitEvent(onEvent, {
          type: 'execution.failed',
          data: { error: execution.error, executionId: execution.id },
          timestamp: Date.now(),
        });

        return execution;
      }

      // 8. Update execution record
      execution.status = AgentExecutionStatus.COMPLETED;
      execution.output = finalOutput;
      execution.nodeResults = nodeResults;
      execution.executionTime = executionTime;
      execution.totalCost = totalCost;
      execution.totalTokens = totalTokens;
      await this.agentExecutionRepository.save(execution);

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

      // Update execution with error — always, even on unexpected crashes
      try {
        execution.status = AgentExecutionStatus.FAILED;
        execution.error = error.message || 'Unknown error';
        execution.executionTime = executionTime;
        await this.agentExecutionRepository.save(execution);

        // Update agent stats (failed)
        await this.state.bumpAgentStats(agent.id, false, executionTime, 0);
      } catch (saveError) {
        this.logger.error(`[EXECUTE] Failed to persist execution record on crash: ${saveError.message}`);
      }

      this.logger.error(`[EXECUTE] Agent ${agent.id} execution failed: ${error.message}`, error.stack);

      this.state.emitEvent(onEvent, {
        type: 'execution.failed',
        data: { error: error.message, executionId: execution.id },
        timestamp: Date.now(),
      });

      // Send webhook notification for failures too (fire-and-forget)
      this.webhookService.sendExecutionWebhook(agent, execution).catch(() => {});

      return execution;
    }
  }

}
