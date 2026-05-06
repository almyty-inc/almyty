import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent, AgentPipelineNode } from '../../entities/agent.entity';
import { AgentTemplateResolver, ExecutionContext } from './agent-template-resolver';
import { AgentExecutionEngine } from './agent-execution.engine';
import { A2AClientService } from '../a2a/a2a-client.service';
import { ExternalAgentsService } from '../a2a/external-agents.service';
import { NodeExecutionOptions, NodeExecutionResult } from './agent-node-executor';

/**
 * Sub-agent execution branches extracted from AgentNodeExecutor:
 * sub_agent dispatch, native re-entry through AgentExecutionEngine,
 * and A2A client calls for external agents.
 *
 * Lives in its own class so the main executor can stay focused on
 * the per-node-type dispatch.
 */
@Injectable()
export class AgentSubAgentExecutors {
  private readonly logger = new Logger(AgentSubAgentExecutors.name);

  constructor(
    private readonly templateResolver: AgentTemplateResolver,
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    @Inject(forwardRef(() => AgentExecutionEngine))
    private readonly executionEngine: AgentExecutionEngine,
    private readonly a2aClientService: A2AClientService,
    private readonly externalAgentsService: ExternalAgentsService,
  ) {}

  async executeSubAgentNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
    options: NodeExecutionOptions,
  ): Promise<NodeExecutionResult> {
    const config = node.data || node.config || {};
    const { inputMapping, target } = config;
    const startTime = Date.now();

    const currentDepth = options.nestingDepth || 0;
    const maxDepth = options.maxNestingDepth || 5;

    if (currentDepth >= maxDepth) {
      throw new Error(`Max nesting depth (${maxDepth}) exceeded at node '${node.id}'`);
    }

    // Resolve input mapping
    const subInput: Record<string, any> = {};
    if (inputMapping) {
      for (const [key, template] of Object.entries(inputMapping)) {
        if (typeof template === 'string') {
          subInput[key] = this.templateResolver.resolve(template, context);
        } else {
          subInput[key] = template;
        }
      }
    } else {
      // Default: pass entire context input
      Object.assign(subInput, context.input);
    }

    // Determine target kind — legacy nodes have agentId at the top level
    const resolvedTarget = target
      ? target
      : config.agentId
        ? { kind: 'native' as const, agentId: config.agentId }
        : null;

    if (!resolvedTarget) {
      throw new Error(`Sub-agent node '${node.id}' is missing 'target' or 'agentId' in config`);
    }

    if (resolvedTarget.kind === 'external_a2a') {
      return this.executeExternalA2ASubAgent(node, resolvedTarget.externalAgentId, subInput, options, startTime);
    }

    // Default: native sub-agent
    return this.executeNativeSubAgent(node, resolvedTarget.agentId, subInput, options, startTime);
  }

  /**
   * Execute a native (local) sub-agent via the execution engine.
   */
  async executeNativeSubAgent(
    node: AgentPipelineNode,
    agentId: string,
    subInput: Record<string, any>,
    options: NodeExecutionOptions,
    startTime: number,
  ): Promise<NodeExecutionResult> {
    if (!agentId) {
      throw new Error(`Sub-agent node '${node.id}' is missing 'agentId' in target`);
    }

    const currentDepth = options.nestingDepth || 0;
    const maxDepth = options.maxNestingDepth || 5;

    // Load sub-agent. CRITICAL: scope to the caller's organizationId.
    const subAgent = await this.agentRepository.findOne({
      where: { id: agentId, organizationId: options.organizationId },
    });
    if (!subAgent) {
      throw new Error(`Sub-agent '${agentId}' not found`);
    }

    const result = await this.executionEngine.execute(
      subAgent,
      options.organizationId,
      options.userId,
      {
        input: subInput,
        metadata: {
          parentNodeId: node.id,
          nestingDepth: currentDepth + 1,
        },
        signal: options.signal,
      },
      undefined,
      {
        nestingDepth: currentDepth + 1,
        maxNestingDepth: maxDepth,
      },
    );

    const executionTime = Date.now() - startTime;

    if (result.status === 'failed') {
      throw new Error(`Sub-agent execution failed: ${result.error}`);
    }

    return {
      output: result.output,
      cost: result.totalCost || 0,
      tokens: result.totalTokens || 0,
      executionTime,
    };
  }

  /**
   * Execute a remote external agent via the A2A protocol.
   */
  async executeExternalA2ASubAgent(
    node: AgentPipelineNode,
    externalAgentId: string,
    subInput: Record<string, any>,
    options: NodeExecutionOptions,
    startTime: number,
  ): Promise<NodeExecutionResult> {
    if (!externalAgentId) {
      throw new Error(`Sub-agent node '${node.id}' is missing 'externalAgentId' in target`);
    }

    const externalAgent = await this.externalAgentsService.findById(
      externalAgentId,
      options.organizationId,
    );

    // Build a text message from the sub-input
    const text = typeof subInput === 'string'
      ? subInput
      : subInput.text || subInput.message || subInput.prompt || JSON.stringify(subInput);

    const rpcResponse = await this.a2aClientService.sendMessage(externalAgent, text);
    const executionTime = Date.now() - startTime;

    // Extract text from A2A response
    let output: any = rpcResponse;
    if (rpcResponse?.result) {
      const task = rpcResponse.result;
      // Try to extract text from artifacts or status message
      if (task.artifacts?.length) {
        const textParts = task.artifacts
          .flatMap((a: any) => a.parts || [])
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text);
        output = textParts.length === 1 ? textParts[0] : textParts.join('\n');
      } else if (task.status?.message?.parts?.length) {
        const textParts = task.status.message.parts
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text);
        output = textParts.length === 1 ? textParts[0] : textParts.join('\n');
      }
    } else if (rpcResponse?.error) {
      throw new Error(`A2A call failed: ${rpcResponse.error.message || JSON.stringify(rpcResponse.error)}`);
    }

    return {
      output,
      executionTime,
    };
  }
}
