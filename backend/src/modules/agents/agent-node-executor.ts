import { Injectable, Logger } from '@nestjs/common';
import { AgentTemplateResolver, ExecutionContext } from './agent-template-resolver';
import { LlmProvidersService, ChatRequest, ChatResponse } from '../llm-providers/llm-providers.service';
import { AgentPipelineNode } from '../../entities/agent.entity';

export interface NodeExecutionResult {
  output: any;
  cost?: number;
  tokens?: number;
  executionTime?: number;
}

@Injectable()
export class AgentNodeExecutor {
  private readonly logger = new Logger(AgentNodeExecutor.name);

  constructor(
    private readonly templateResolver: AgentTemplateResolver,
    private readonly llmProvidersService: LlmProvidersService,
  ) {}

  /**
   * Executes a single pipeline node and returns the result.
   * Phase 1 supports: input, output, llm_call
   */
  async execute(
    node: AgentPipelineNode,
    context: ExecutionContext,
    organizationId: string,
    userId?: string,
  ): Promise<NodeExecutionResult> {
    const startTime = Date.now();

    switch (node.type) {
      case 'input':
        return this.executeInputNode(node, context);

      case 'output':
        return this.executeOutputNode(node, context);

      case 'llm_call':
        return this.executeLlmCallNode(node, context, organizationId, userId);

      default:
        throw new Error(`Unsupported node type: ${node.type}. Phase 1 supports: input, output, llm_call`);
    }
  }

  private async executeInputNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    // The input node simply passes through the execution input
    return {
      output: context.input,
    };
  }

  private async executeOutputNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const config = node.config || {};

    // If there's a mapping template, resolve it
    if (config.mapping) {
      if (typeof config.mapping === 'string') {
        const resolved = this.templateResolver.resolve(config.mapping, context);
        return { output: resolved };
      }

      // If mapping is an object, resolve each value
      if (typeof config.mapping === 'object') {
        const resolved: Record<string, any> = {};
        for (const [key, value] of Object.entries(config.mapping)) {
          if (typeof value === 'string') {
            resolved[key] = this.templateResolver.resolve(value, context);
          } else {
            resolved[key] = value;
          }
        }
        return { output: resolved };
      }
    }

    // If there's a source reference, resolve it
    if (config.source) {
      const resolved = this.templateResolver.resolveValue(config.source, context);
      return { output: resolved };
    }

    // Default: return all node outputs
    const allOutputs: Record<string, any> = {};
    for (const [nodeId, nodeResult] of Object.entries(context.nodes)) {
      allOutputs[nodeId] = nodeResult.output;
    }
    return { output: allOutputs };
  }

  private async executeLlmCallNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
    organizationId: string,
    userId?: string,
  ): Promise<NodeExecutionResult> {
    const config = node.config || {};
    const startTime = Date.now();

    // Resolve provider ID
    const providerId = config.providerId;
    if (!providerId) {
      throw new Error(`LLM call node '${node.id}' is missing 'providerId' in config`);
    }

    // Resolve prompts using template resolver
    const systemPrompt = config.systemPrompt
      ? this.templateResolver.resolve(config.systemPrompt, context)
      : undefined;

    const userPrompt = config.userPromptTemplate
      ? this.templateResolver.resolve(config.userPromptTemplate, context)
      : config.userPrompt
        ? this.templateResolver.resolve(config.userPrompt, context)
        : undefined;

    if (!userPrompt) {
      throw new Error(`LLM call node '${node.id}' is missing user prompt (userPromptTemplate or userPrompt)`);
    }

    // Build messages
    const messages: ChatRequest['messages'] = [];
    if (systemPrompt) {
      messages.push({ role: 'system' as any, content: systemPrompt });
    }
    messages.push({ role: 'user' as any, content: userPrompt });

    // Build chat request
    const chatRequest: ChatRequest = {
      messages,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      toolIds: config.toolIds,
    };

    this.logger.log(`[NODE_EXEC] Executing LLM call node '${node.id}' with provider=${providerId}`);

    const response: ChatResponse = await this.llmProvidersService.chat(
      providerId,
      chatRequest,
      organizationId,
      userId,
    );

    const executionTime = Date.now() - startTime;

    return {
      output: response.message.content || response.message,
      cost: response.cost || 0,
      tokens: response.usage?.totalTokens || 0,
      executionTime,
    };
  }
}
