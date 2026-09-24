import { Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent, AgentPipelineNode } from '../../entities/agent.entity';
import { AgentTemplateResolver, ExecutionContext } from './agent-template-resolver';
import { AgentExecutionEngine } from './agent-execution.engine';
import { A2AClientService } from '../a2a/a2a-client.service';
import { ExternalAgentsService } from '../a2a/external-agents.service';
import { partsToText } from '../a2a/a2a-part.mapper';
import { NodeExecutionOptions, NodeExecutionResult } from './agent-node-executor';
import { userPrincipal } from '../../common/authorization/execution-access.service';

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

    // Resolve the input mapping.
    //
    // The builder writes this as an array of {key, value} rows; a pipeline
    // written by hand against the API may use a plain object. Reading it
    // with Object.entries alone turned an array into ["0", {key, value}]:
    // the child agent was invoked with a numeric key whose value was the
    // row object itself, so the template never reached the resolver and
    // arrived at the child as the literal text "{{input.message}}".
    // tool_call's parameterMapping has always accepted both shapes; this
    // reads the same way.
    const subInput: Record<string, any> = {};
    const mappingEntries: Array<[string, any]> = !inputMapping
      ? []
      : Array.isArray(inputMapping)
        ? inputMapping.map((m: any) => [m?.key, m?.value])
        : Object.entries(inputMapping);
    // A row added in the builder and left blank is not a mapping.
    const usableEntries = mappingEntries.filter(([key]) => typeof key === 'string' && key !== '');

    if (usableEntries.length > 0) {
      for (const [key, template] of usableEntries) {
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

    // The sub-agent runs in the parent run's scope, handed down unchanged.
    // The engine checks it against the sub-agent before anything runs: a
    // team agent the run's starter is not a member for, or somebody else's
    // private agent, is refused as not found.
    const principal = options.principal ?? userPrincipal(options.userId);
    let result;
    try {
      result = await this.executionEngine.execute(
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
          principal,
        },
        undefined,
        {
          nestingDepth: currentDepth + 1,
          maxNestingDepth: maxDepth,
        },
      );
    } catch (err: any) {
      if (err instanceof NotFoundException) throw new Error(`Sub-agent '${agentId}' not found`);
      throw err;
    }

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
    // Extract text from A2A response. `p.type` was the v0.1.x draft
    // discriminator and matches no released version of the spec: v0.2/v0.3
    // use `kind`, v1.0 discriminates by which member of the `content` oneof
    // is present. Reading it meant every remote agent's answer fell through
    // to the raw JSON-RPC envelope. partsToText handles all three dialects.
    let output: any = rpcResponse;
    if (rpcResponse?.result) {
      const task = rpcResponse.result;
      if (task.artifacts?.length) {
        output = partsToText(task.artifacts.flatMap((a: any) => a.parts || []));
      } else if (task.status?.message?.parts?.length) {
        output = partsToText(task.status.message.parts);
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
