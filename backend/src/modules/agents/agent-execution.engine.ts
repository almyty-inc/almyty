import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent, AgentPipeline, AgentPipelineNode, AgentPipelineEdge } from '../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../entities/agent-execution.entity';
import { AgentNodeExecutor, NodeExecutionResult } from './agent-node-executor';
import { ExecutionContext } from './agent-template-resolver';

export interface ExecuteAgentOptions {
  input?: Record<string, any>;
  variables?: Record<string, any>;
  metadata?: Record<string, any>;
}

@Injectable()
export class AgentExecutionEngine {
  private readonly logger = new Logger(AgentExecutionEngine.name);

  constructor(
    @InjectRepository(Agent)
    private agentRepository: Repository<Agent>,
    @InjectRepository(AgentExecution)
    private agentExecutionRepository: Repository<AgentExecution>,
    private readonly nodeExecutor: AgentNodeExecutor,
  ) {}

  /**
   * Execute an agent pipeline.
   * 1. Create execution record (running)
   * 2. Build adjacency list from edges
   * 3. Topological sort (Kahn's algorithm)
   * 4. Process nodes sequentially
   * 5. Collect output and update records
   */
  async execute(
    agent: Agent,
    organizationId: string,
    userId: string,
    options: ExecuteAgentOptions = {},
  ): Promise<AgentExecution> {
    const startTime = Date.now();

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

    try {
      const pipeline = agent.pipeline;
      if (!pipeline || !pipeline.nodes || !pipeline.edges) {
        throw new BadRequestException('Agent pipeline is not configured');
      }

      // 2. Build adjacency list and in-degree map
      const { adjacencyList, inDegree } = this.buildGraph(pipeline);

      // 3. Topological sort
      const sortedNodeIds = this.topologicalSort(pipeline.nodes, adjacencyList, inDegree);

      // 4. Initialize context
      const context: ExecutionContext = {
        input: options.input || {},
        nodes: {},
        variables: { ...(agent.variables || {}), ...(options.variables || {}) },
      };

      // 5. Process nodes in topological order
      const nodeMap = new Map<string, AgentPipelineNode>();
      for (const node of pipeline.nodes) {
        nodeMap.set(node.id, node);
      }

      const nodeResults: Record<string, any> = {};
      let totalCost = 0;
      let totalTokens = 0;
      let finalOutput: any = null;

      for (const nodeId of sortedNodeIds) {
        const node = nodeMap.get(nodeId);
        if (!node) continue;

        this.logger.log(`[EXECUTE] Processing node '${nodeId}' (type=${node.type}) for agent=${agent.id}`);

        // 6. Execute node
        const result: NodeExecutionResult = await this.nodeExecutor.execute(
          node,
          context,
          organizationId,
          userId,
        );

        // Store result in context for downstream nodes
        context.nodes[nodeId] = { output: result.output };
        nodeResults[nodeId] = {
          output: result.output,
          cost: result.cost || 0,
          tokens: result.tokens || 0,
          executionTime: result.executionTime || 0,
        };

        totalCost += result.cost || 0;
        totalTokens += result.tokens || 0;

        // 7. If this is an output node, capture it
        if (node.type === 'output') {
          finalOutput = result.output;
        }
      }

      const executionTime = Date.now() - startTime;

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

      return execution;
    } catch (error) {
      const executionTime = Date.now() - startTime;

      // Update execution with error
      execution.status = AgentExecutionStatus.FAILED;
      execution.error = error.message || 'Unknown error';
      execution.executionTime = executionTime;
      await this.agentExecutionRepository.save(execution);

      // Update agent stats (failed)
      agent.incrementExecution(false, executionTime, 0);
      await this.agentRepository.save(agent);

      this.logger.error(`[EXECUTE] Agent ${agent.id} execution failed: ${error.message}`, error.stack);

      return execution;
    }
  }

  /**
   * Build adjacency list and in-degree map from pipeline edges.
   */
  private buildGraph(pipeline: AgentPipeline): {
    adjacencyList: Map<string, string[]>;
    inDegree: Map<string, number>;
  } {
    const adjacencyList = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    // Initialize all nodes
    for (const node of pipeline.nodes) {
      adjacencyList.set(node.id, []);
      inDegree.set(node.id, 0);
    }

    // Build edges
    for (const edge of pipeline.edges) {
      const neighbors = adjacencyList.get(edge.source) || [];
      neighbors.push(edge.target);
      adjacencyList.set(edge.source, neighbors);

      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    }

    return { adjacencyList, inDegree };
  }

  /**
   * Topological sort using Kahn's algorithm.
   * Throws if cycle detected.
   */
  private topologicalSort(
    nodes: AgentPipelineNode[],
    adjacencyList: Map<string, string[]>,
    inDegree: Map<string, number>,
  ): string[] {
    const queue: string[] = [];
    const sorted: string[] = [];

    // Make a mutable copy of in-degrees
    const degrees = new Map(inDegree);

    // Find all nodes with in-degree 0
    for (const node of nodes) {
      if ((degrees.get(node.id) || 0) === 0) {
        queue.push(node.id);
      }
    }

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      sorted.push(nodeId);

      const neighbors = adjacencyList.get(nodeId) || [];
      for (const neighbor of neighbors) {
        const newDegree = (degrees.get(neighbor) || 0) - 1;
        degrees.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    if (sorted.length !== nodes.length) {
      throw new BadRequestException('Pipeline contains a cycle — topological sort failed');
    }

    return sorted;
  }
}
