import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent, AgentPipeline, AgentPipelineNode, AgentPipelineEdge } from '../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../entities/agent-execution.entity';
import { AgentNodeExecutor, NodeExecutionResult } from './agent-node-executor';
import { AgentWebhookService } from './agent-webhook.service';
import { ExecutionContext } from './agent-template-resolver';

export interface ExecuteAgentOptions {
  input?: Record<string, any>;
  variables?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface StreamEvent {
  type: 'execution.started' | 'node.started' | 'node.output' | 'node.completed' | 'node.skipped' | 'execution.completed' | 'execution.failed';
  nodeId?: string;
  nodeType?: string;
  data?: any;
  timestamp: number;
}

export interface EngineInternalOptions {
  nestingDepth?: number;
  maxNestingDepth?: number;
}

/** Error classification for pipeline failures. */
export enum ExecutionErrorType {
  TIMEOUT = 'TIMEOUT',
  LLM_ERROR = 'LLM_ERROR',
  TOOL_ERROR = 'TOOL_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  BUDGET_EXCEEDED = 'BUDGET_EXCEEDED',
  NESTING_EXCEEDED = 'NESTING_EXCEEDED',
}

/** Input size limits. */
const MAX_INPUT_SIZE_BYTES = 100 * 1024; // 100 KB
const MAX_PIPELINE_NODES = 100;
const MAX_PIPELINE_EDGES = 500;
const MAX_NESTING_DEPTH = 10;

/** Regex matching ASCII C0 control characters except tab, newline, carriage return. */
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

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
    this.validateInput(options.input, internalOptions);

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
    this.emitEvent(onEvent, {
      type: 'execution.started',
      data: { executionId: execution.id, agentId: agent.id },
      timestamp: Date.now(),
    });

    try {
      const pipeline = agent.pipeline;
      if (!pipeline || !pipeline.nodes || !pipeline.edges) {
        throw this.classifiedError('Agent pipeline is not configured', ExecutionErrorType.VALIDATION_ERROR);
      }

      // Validate pipeline size
      this.validatePipelineSize(pipeline);

      // 2. Build graph
      const { adjacencyList, inDegree, reverseAdjacencyList } = this.buildGraph(pipeline);

      // 3. Compute execution layers (topological levels)
      const layers = this.computeLayers(pipeline.nodes, adjacencyList, inDegree);

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
      const skippedNodes = new Set<string>();

      // Timeout and budget settings
      const maxExecutionTime = agent.settings?.maxExecutionTime || 300000; // 5 minutes default
      const budgetLimit = agent.settings?.budgetLimit || Infinity;

      // 5. Process each layer
      for (const layer of layers) {
        // Check timeout
        if (Date.now() - startTime > maxExecutionTime) {
          execution.status = AgentExecutionStatus.TIMEOUT;
          execution.error = `Execution timed out after ${maxExecutionTime}ms`;
          execution.executionTime = Date.now() - startTime;
          execution.nodeResults = nodeResults;
          await this.agentExecutionRepository.save(execution);
          agent.incrementExecution(false, Date.now() - startTime, totalCost);
          await this.agentRepository.save(agent);

          this.emitEvent(onEvent, {
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
          agent.incrementExecution(false, Date.now() - startTime, totalCost);
          await this.agentRepository.save(agent);

          this.emitEvent(onEvent, {
            type: 'execution.failed',
            data: { error: execution.error, errorType: ExecutionErrorType.BUDGET_EXCEEDED, executionId: execution.id },
            timestamp: Date.now(),
          });

          return execution;
        }

        // Filter out skipped nodes in this layer
        const activeNodes = layer.filter(nodeId => !skippedNodes.has(nodeId));

        if (activeNodes.length === 0) continue;

        // Execute all nodes in this layer in parallel — each wrapped in try/catch
        const layerPromises = activeNodes.map(async (nodeId) => {
          const node = nodeMap.get(nodeId);
          if (!node) return;

          const nodeStartedAt = Date.now();

          this.logger.log(`[EXECUTE] Processing node '${nodeId}' (type=${node.type}) for agent=${agent.id}`);

          this.emitEvent(onEvent, {
            type: 'node.started',
            nodeId,
            nodeType: node.type,
            timestamp: Date.now(),
          });

          try {
            // Execute node
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
              },
            );

            const nodeCompletedAt = Date.now();

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
            const errorType = this.classifyNodeError(err);

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

        // Wrap layer execution in timeout
        const remainingTime = maxExecutionTime - (Date.now() - startTime);
        const layerResults = await this.withTimeout(
          Promise.all(layerPromises),
          remainingTime,
          `Layer execution timed out`,
        );

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

            this.emitEvent(onEvent, {
              type: 'node.completed',
              nodeId,
              nodeType: node.type,
              data: { error, errorType },
              timestamp: Date.now(),
            });

            // Skip all downstream nodes of a failed node
            const neighbors = adjacencyList.get(nodeId) || [];
            for (const neighbor of neighbors) {
              this.markBranchAsSkipped(neighbor, adjacencyList, skippedNodes, pipeline.edges);
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

          this.emitEvent(onEvent, {
            type: 'node.output',
            nodeId,
            nodeType: node.type,
            data: { output: result.output },
            timestamp: Date.now(),
          });

          this.emitEvent(onEvent, {
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
                this.markBranchAsSkipped(edge.target, adjacencyList, skippedNodes, pipeline.edges);
              }
            }
          }

          // Capture output node
          if (node.type === 'output') {
            finalOutput = result.output;
          }
        }

        // Mark skipped nodes in nodeResults
        for (const nodeId of layer) {
          if (skippedNodes.has(nodeId) && !nodeResults[nodeId]) {
            const node = nodeMap.get(nodeId);
            nodeResults[nodeId] = { skipped: true };
            context.nodes[nodeId] = { output: undefined };

            this.emitEvent(onEvent, {
              type: 'node.skipped',
              nodeId,
              nodeType: node?.type,
              timestamp: Date.now(),
            });
          }
        }
      }

      const executionTime = Date.now() - startTime;

      // Check if any node failed — if the output node was never reached, mark as failed
      const hasNodeFailures = Object.values(nodeResults).some((r: any) => r.error);

      if (hasNodeFailures && finalOutput === null) {
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

        agent.incrementExecution(false, executionTime, totalCost);
        await this.agentRepository.save(agent);

        this.emitEvent(onEvent, {
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

      // 9. Update agent stats
      agent.incrementExecution(true, executionTime, totalCost);
      await this.agentRepository.save(agent);

      this.logger.log(`[EXECUTE] Agent ${agent.id} execution completed in ${executionTime}ms, cost=${totalCost}`);

      this.emitEvent(onEvent, {
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
        agent.incrementExecution(false, executionTime, 0);
        await this.agentRepository.save(agent);
      } catch (saveError) {
        this.logger.error(`[EXECUTE] Failed to persist execution record on crash: ${saveError.message}`);
      }

      this.logger.error(`[EXECUTE] Agent ${agent.id} execution failed: ${error.message}`, error.stack);

      this.emitEvent(onEvent, {
        type: 'execution.failed',
        data: { error: error.message, executionId: execution.id },
        timestamp: Date.now(),
      });

      // Send webhook notification for failures too (fire-and-forget)
      this.webhookService.sendExecutionWebhook(agent, execution).catch(() => {});

      return execution;
    }
  }

  // ── Input validation ─────────────────────────────────────────────────

  private validateInput(input: any, internalOptions?: EngineInternalOptions): void {
    // Validate nesting depth (checked regardless of input)
    if (internalOptions?.nestingDepth !== undefined && internalOptions.nestingDepth > MAX_NESTING_DEPTH) {
      throw new BadRequestException(
        `Nesting depth (${internalOptions.nestingDepth}) exceeds maximum allowed (${MAX_NESTING_DEPTH})`,
      );
    }

    if (input === undefined || input === null) {
      return; // undefined/null input is fine — defaults to {}
    }

    // Must be a plain object (not array, not string, not number, etc.)
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException(
        'Execution input must be a plain object (not an array, string, or primitive)',
      );
    }

    // Size check
    const serialized = JSON.stringify(input);
    if (serialized.length > MAX_INPUT_SIZE_BYTES) {
      throw new BadRequestException(
        `Execution input size (${serialized.length} bytes) exceeds maximum allowed (${MAX_INPUT_SIZE_BYTES} bytes)`,
      );
    }

    // Sanitize string values: strip control characters
    this.sanitizeObject(input);
  }

  private validatePipelineSize(pipeline: AgentPipeline): void {
    if (pipeline.nodes.length > MAX_PIPELINE_NODES) {
      throw new BadRequestException(
        `Pipeline has ${pipeline.nodes.length} nodes, exceeding maximum of ${MAX_PIPELINE_NODES}`,
      );
    }

    if (pipeline.edges.length > MAX_PIPELINE_EDGES) {
      throw new BadRequestException(
        `Pipeline has ${pipeline.edges.length} edges, exceeding maximum of ${MAX_PIPELINE_EDGES}`,
      );
    }
  }

  /**
   * Recursively strip control characters from all string values in an object.
   * Mutates the object in place.
   */
  private sanitizeObject(obj: any): void {
    if (obj === null || obj === undefined) return;
    if (typeof obj !== 'object') return;

    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (typeof value === 'string') {
        obj[key] = value.replace(CONTROL_CHAR_REGEX, '');
      } else if (typeof value === 'object' && value !== null) {
        this.sanitizeObject(value);
      }
    }
  }

  // ── Error classification ──────────────────────────────────────────────

  private classifyNodeError(err: any): ExecutionErrorType {
    const message = (err.message || '').toLowerCase();

    if (message.includes('timeout') || message.includes('timed out')) {
      return ExecutionErrorType.TIMEOUT;
    }
    if (message.includes('budget') || message.includes('budget limit')) {
      return ExecutionErrorType.BUDGET_EXCEEDED;
    }
    if (message.includes('nesting depth')) {
      return ExecutionErrorType.NESTING_EXCEEDED;
    }
    if (
      message.includes('llm') ||
      message.includes('provider') ||
      message.includes('model') ||
      message.includes('rate limit') ||
      message.includes('429')
    ) {
      return ExecutionErrorType.LLM_ERROR;
    }
    if (message.includes('tool') || message.includes('execution failed')) {
      return ExecutionErrorType.TOOL_ERROR;
    }
    return ExecutionErrorType.VALIDATION_ERROR;
  }

  private classifiedError(message: string, type: ExecutionErrorType): Error {
    const err = new BadRequestException(message);
    (err as any).errorType = type;
    return err;
  }

  // ── Graph building ───────────────────────────────────────────────────

  /**
   * Build adjacency list, in-degree map, and reverse adjacency list from pipeline edges.
   */
  private buildGraph(pipeline: AgentPipeline): {
    adjacencyList: Map<string, string[]>;
    inDegree: Map<string, number>;
    reverseAdjacencyList: Map<string, string[]>;
  } {
    const adjacencyList = new Map<string, string[]>();
    const inDegree = new Map<string, number>();
    const reverseAdjacencyList = new Map<string, string[]>();

    // Initialize all nodes
    for (const node of pipeline.nodes) {
      adjacencyList.set(node.id, []);
      reverseAdjacencyList.set(node.id, []);
      inDegree.set(node.id, 0);
    }

    // Build edges
    for (const edge of pipeline.edges) {
      const neighbors = adjacencyList.get(edge.source) || [];
      neighbors.push(edge.target);
      adjacencyList.set(edge.source, neighbors);

      const reverseNeighbors = reverseAdjacencyList.get(edge.target) || [];
      reverseNeighbors.push(edge.source);
      reverseAdjacencyList.set(edge.target, reverseNeighbors);

      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    }

    return { adjacencyList, inDegree, reverseAdjacencyList };
  }

  /**
   * Compute execution layers using Kahn's algorithm with level tracking.
   * Nodes in the same layer have all dependencies satisfied and can run in parallel.
   */
  private computeLayers(
    nodes: AgentPipelineNode[],
    adjacencyList: Map<string, string[]>,
    inDegree: Map<string, number>,
  ): string[][] {
    const layers: string[][] = [];
    const degrees = new Map(inDegree);

    // Find all nodes with in-degree 0
    let currentLayer: string[] = [];
    for (const node of nodes) {
      if ((degrees.get(node.id) || 0) === 0) {
        currentLayer.push(node.id);
      }
    }

    let totalProcessed = 0;

    while (currentLayer.length > 0) {
      layers.push([...currentLayer]);
      totalProcessed += currentLayer.length;

      const nextLayer: string[] = [];

      for (const nodeId of currentLayer) {
        const neighbors = adjacencyList.get(nodeId) || [];
        for (const neighbor of neighbors) {
          const newDegree = (degrees.get(neighbor) || 0) - 1;
          degrees.set(neighbor, newDegree);
          if (newDegree === 0) {
            nextLayer.push(neighbor);
          }
        }
      }

      currentLayer = nextLayer;
    }

    if (totalProcessed !== nodes.length) {
      throw new BadRequestException('Pipeline contains a cycle — topological sort failed');
    }

    return layers;
  }

  /**
   * Recursively mark all downstream nodes of a given node as skipped.
   * Used when a condition branch is not taken.
   * Stops at merge nodes that have other non-skipped incoming edges.
   */
  private markBranchAsSkipped(
    nodeId: string,
    adjacencyList: Map<string, string[]>,
    skippedNodes: Set<string>,
    edges: AgentPipelineEdge[],
  ): void {
    if (skippedNodes.has(nodeId)) return;

    // Check if this node has other incoming edges from non-skipped nodes
    const incomingEdges = edges.filter(e => e.target === nodeId);
    const hasLiveIncoming = incomingEdges.some(e => !skippedNodes.has(e.source));

    // If all incoming sources are skipped (or this is the direct target), mark as skipped
    // But if there's a live incoming edge from a different path, don't skip
    if (hasLiveIncoming && incomingEdges.length > 1) {
      // This is likely a merge point with another live branch — don't skip
      return;
    }

    skippedNodes.add(nodeId);

    // Recurse to downstream nodes
    const neighbors = adjacencyList.get(nodeId) || [];
    for (const neighbor of neighbors) {
      this.markBranchAsSkipped(neighbor, adjacencyList, skippedNodes, edges);
    }
  }

  /**
   * Wrap a promise with a timeout.
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    if (timeoutMs <= 0) {
      throw new Error(message);
    }

    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(message)), timeoutMs),
      ),
    ]);
  }

  /**
   * Emit a streaming event if a callback is provided.
   */
  private emitEvent(onEvent: ((event: StreamEvent) => void) | undefined, event: StreamEvent): void {
    if (onEvent) {
      try {
        onEvent(event);
      } catch (err) {
        this.logger.warn(`Failed to emit stream event: ${err.message}`);
      }
    }
  }
}
