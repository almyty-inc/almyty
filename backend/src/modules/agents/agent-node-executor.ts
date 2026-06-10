import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AgentTemplateResolver, ExecutionContext } from './agent-template-resolver';
import { LlmProvidersService, ChatRequest, ChatResponse } from '../llm-providers/llm-providers.service';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { Agent, AgentPipelineNode, AgentPipelineEdge } from '../../entities/agent.entity';
import { AgentExecutionEngine } from './agent-execution.engine';
import { A2AClientService } from '../a2a/a2a-client.service';
import { ExternalAgentsService } from '../a2a/external-agents.service';
import { AgentSubAgentExecutors } from './agent-subagent-executors.helper';

export interface NodeExecutionResult {
  output: any;
  cost?: number;
  tokens?: number;
  executionTime?: number;
}

export interface NodeExecutionOptions {
  organizationId: string;
  userId?: string;
  nestingDepth?: number;
  maxNestingDepth?: number;
  edges?: AgentPipelineEdge[];
  /**
   * Cancellation signal from the owning agent execution. Flows
   * through into LlmProvidersService.chat (as request.signal),
   * ToolExecutorService.executeTool (as options.signal), and
   * recursive sub-agent execute calls (as options.signal). Each
   * leaf uses it to abort the underlying axios call at the socket
   * layer so a cancel doesn't wait out a 30s upstream timeout.
   */
  signal?: AbortSignal;
}

@Injectable()
export class AgentNodeExecutor {
  private readonly logger = new Logger(AgentNodeExecutor.name);

  constructor(
    private readonly templateResolver: AgentTemplateResolver,
    private readonly llmProvidersService: LlmProvidersService,
    private readonly toolExecutorService: ToolExecutorService,
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    @Inject(forwardRef(() => AgentExecutionEngine))
    private readonly executionEngine: AgentExecutionEngine,
    private readonly a2aClientService: A2AClientService,
    private readonly externalAgentsService: ExternalAgentsService,
    private readonly subAgents: AgentSubAgentExecutors,
  ) {}

  /**
   * Executes a single pipeline node and returns the result.
   * Supports: input, output, llm_call, tool_call, condition, transform, loop, parallel, merge, sub_agent
   */
  async execute(
    node: AgentPipelineNode,
    context: ExecutionContext,
    organizationId: string,
    userId?: string,
    options?: NodeExecutionOptions,
  ): Promise<NodeExecutionResult> {
    const startTime = Date.now();
    const execOptions: NodeExecutionOptions = {
      organizationId,
      userId,
      ...options,
    };

    switch (node.type) {
      case 'input':
        return this.executeInputNode(node, context);

      case 'output':
        return this.executeOutputNode(node, context);

      case 'llm_call':
        return this.executeLlmCallNode(node, context, organizationId, userId, execOptions);

      case 'tool_call':
        return this.executeToolCallNode(node, context, execOptions);

      case 'condition':
        return this.executeConditionNode(node, context);

      case 'transform':
        return this.executeTransformNode(node, context);

      case 'loop':
        return this.executeLoopNode(node, context);

      case 'parallel':
        return this.executeParallelNode(node, context, execOptions);

      case 'merge':
        return this.executeMergeNode(node, context, execOptions);

      case 'sub_agent':
        return this.subAgents.executeSubAgentNode(node, context, execOptions);

      default:
        throw new Error(`Unsupported node type: ${node.type}`);
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
    const config = node.data || node.config || {};

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
    options?: NodeExecutionOptions,
  ): Promise<NodeExecutionResult> {
    const config = node.data || node.config || {};
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

    // Build chat request — thread the agent-execution signal in
    // so the LLM HTTP call and its embedded tool-call loop both
    // abort on client disconnect.
    const chatRequest: ChatRequest = {
      messages,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      toolIds: config.toolIds,
      signal: options?.signal,
    };

    this.logger.log(`[NODE_EXEC] Executing LLM call node '${node.id}' with provider=${providerId}, model=${config.model}`);

    let response: ChatResponse;
    try {
      // The chat() method handles the full agentic tool call loop internally
      response = await this.llmProvidersService.chat(
        providerId,
        chatRequest,
        organizationId,
        userId,
      );
    } catch (err: any) {
      const detail = err.response?.data?.error?.message || err.response?.data?.message || err.response?.data || err.message;
      this.logger.error(`[NODE_EXEC] LLM call failed for node '${node.id}': ${JSON.stringify(detail)}`);
      throw new Error(`LLM call failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }

    const executionTime = Date.now() - startTime;

    return {
      output: response.message.content || response.message,
      cost: response.cost || 0,
      tokens: response.usage?.totalTokens || 0,
      executionTime,
    };
  }

  /**
   * Execute a tool_call node — resolves parameter templates and calls ToolExecutorService.
   */
  private async executeToolCallNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
    options: NodeExecutionOptions,
  ): Promise<NodeExecutionResult> {
    const { toolId, parameterMapping } = node.data || node.config || {};
    const startTime = Date.now();

    if (!toolId) {
      throw new Error(`Tool call node '${node.id}' is missing 'toolId' in config`);
    }

    // Resolve each parameter template
    // parameterMapping can be an array of {key, value} or an object {key: value}
    const resolvedParams: Record<string, any> = {};
    if (parameterMapping) {
      const mappingEntries: Array<[string, any]> = Array.isArray(parameterMapping)
        ? parameterMapping.map((m: any) => [m.key, m.value])
        : Object.entries(parameterMapping);
      for (const [key, template] of mappingEntries) {
        if (typeof template === 'string') {
          resolvedParams[key] = this.templateResolver.resolve(template, context);
        } else {
          resolvedParams[key] = template;
        }
      }
    }

    const result = await this.toolExecutorService.executeTool(toolId, resolvedParams, {
      organizationId: options.organizationId,
      userId: options.userId,
      // Propagate the agent-level cancellation context into the
      // tool executor so its axios call honours a disconnected
      // client or parent-cancelled run.
      signal: options.signal,
    });

    const executionTime = Date.now() - startTime;

    if (!result.success) {
      throw new Error(result.error || 'Tool execution failed');
    }

    return {
      output: result.data,
      executionTime,
    };
  }

  /**
   * Execute a condition node — evaluates an expression and returns a boolean flag.
   * The engine uses the __condition flag to decide which branch to follow.
   */
  private async executeConditionNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const { expression } = node.data || node.config || {};

    if (!expression) {
      throw new Error(`Condition node '${node.id}' is missing 'expression' in config`);
    }

    const resolved = this.templateResolver.resolve(expression, context);
    const resolvedStr = typeof resolved === 'string' ? resolved : String(resolved);

    // Try to evaluate as a comparison expression (e.g. "overweight == overweight", "29.4 > 25")
    let result: boolean;
    const comparisonMatch = resolvedStr.match(/^(.+?)\s*(===?|!==?|>=?|<=?)\s*(.+)$/);
    if (comparisonMatch) {
      const [, left, op, right] = comparisonMatch;
      const lVal = left.trim();
      const rVal = right.trim();
      const lNum = parseFloat(lVal);
      const rNum = parseFloat(rVal);
      const isNumeric = !isNaN(lNum) && !isNaN(rNum);

      switch (op) {
        case '==': case '===':
          result = isNumeric ? lNum === rNum : lVal === rVal;
          break;
        case '!=': case '!==':
          result = isNumeric ? lNum !== rNum : lVal !== rVal;
          break;
        case '>':
          result = isNumeric ? lNum > rNum : lVal > rVal;
          break;
        case '<':
          result = isNumeric ? lNum < rNum : lVal < rVal;
          break;
        case '>=':
          result = isNumeric ? lNum >= rNum : lVal >= rVal;
          break;
        case '<=':
          result = isNumeric ? lNum <= rNum : lVal <= rVal;
          break;
        default:
          result = Boolean(resolved);
      }
    } else if (typeof resolved === 'string') {
      // Simple boolean check: "true", "1", non-empty => true; "false", "0", "" => false
      const lower = resolvedStr.toLowerCase().trim();
      result = lower !== '' && lower !== 'false' && lower !== '0' && lower !== 'null' && lower !== 'undefined';
    } else {
      result = Boolean(resolved);
    }

    return {
      output: { __condition: true, result },
    };
  }

  /**
   * Execute a transform node — resolves an expression template against context.
   */
  private async executeTransformNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const { expression } = node.data || node.config || {};

    if (!expression) {
      throw new Error(`Transform node '${node.id}' is missing 'expression' in config`);
    }

    const resolved = this.templateResolver.resolve(expression, context);

    return {
      output: resolved,
    };
  }

  /**
   * Execute a loop node.
   *
   * Resolves `iterableExpression` to an array and outputs it (capped at
   * `maxIterations`). Downstream nodes consume the collected array via
   * `{{nodes.<loopId>.output}}`.
   *
   * NOTE: this does NOT yet run the downstream sub-graph once per item —
   * the engine executes by layer, not by per-item sub-execution, so true
   * fan-out is a separate engine feature. We intentionally do not expose a
   * `{{loop.item}}`/`{{loop.index}}` context here, because any value set on
   * `context` would be gone by the time a later layer runs and would
   * silently resolve to nothing. Outputting the array is the honest,
   * usable behaviour; per-item fan-out is tracked separately.
   */
  private async executeLoopNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const config = node.data || node.config || {};
    const maxIterations = config.maxIterations || 100;

    if (!config.iterableExpression) {
      throw new Error(`Loop node '${node.id}' is missing 'iterableExpression' in config`);
    }

    // If the expression is a single {{path}} reference, resolve it to its raw
    // value (which may be an array). Otherwise, run it through the template
    // resolver, which produces a string. Without this, arrays passed via
    // {{input.items}} were JSON-stringified and the loop would only iterate
    // a single-element array of the JSON string.
    const expression: string = config.iterableExpression;
    const singleRefMatch =
      typeof expression === 'string' &&
      expression.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
    const resolved = singleRefMatch
      ? this.templateResolver.resolveValue(singleRefMatch[1], context)
      : this.templateResolver.resolve(expression, context);
    const items = Array.isArray(resolved) ? resolved : [resolved];

    return {
      output: items.slice(0, maxIterations),
    };
  }

  /**
   * Execute a parallel node — pass-through; the engine handles fan-out.
   */
  private async executeParallelNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
    options?: NodeExecutionOptions,
  ): Promise<NodeExecutionResult> {
    // Resolve this node's input from its incoming edge (deterministic),
    // not "the first node that happens to have an output" — under parallel
    // fan-out, context.nodes insertion order is the nondeterministic
    // Promise.all settle order, so the old heuristic picked an arbitrary
    // upstream. Fall back to context.input when no edge output is present.
    const incoming = this.getIncomingOutputs(node, context, options?.edges);
    const output = incoming.length > 0 ? incoming[0] : context.input;

    return {
      output: output ?? context.input,
    };
  }

  /**
   * Execute a merge node — collects outputs from all incoming edges and applies a merge strategy.
   */
  private async executeMergeNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
    options: NodeExecutionOptions,
  ): Promise<NodeExecutionResult> {
    const { strategy, judgeConfig } = node.data || node.config || {};
    const startTime = Date.now();

    // Collect outputs from all incoming edges
    const incomingOutputs = this.getIncomingOutputs(node, context, options.edges);

    switch (strategy) {
      case 'first_response':
        return {
          output: incomingOutputs[0],
          executionTime: Date.now() - startTime,
        };

      case 'concatenate':
        return {
          output: incomingOutputs,
          executionTime: Date.now() - startTime,
        };

      case 'best_of_n': {
        if (!judgeConfig?.providerId) {
          throw new Error(`Merge node '${node.id}' with strategy 'best_of_n' requires judgeConfig.providerId`);
        }

        const prompt = judgeConfig.prompt ||
          `You are a judge. Pick the best response from these options:\n\n${incomingOutputs.map((o: any, i: number) => `Option ${i + 1}: ${JSON.stringify(o)}`).join('\n\n')}\n\nRespond with ONLY the number of the best option.`;

        const judgeResult = await this.llmProvidersService.chat(
          judgeConfig.providerId,
          {
            messages: [{ role: 'user' as any, content: prompt }],
            model: judgeConfig.model,
            signal: options.signal,
          },
          options.organizationId,
          options.userId,
        );

        const executionTime = Date.now() - startTime;
        const pick = parseInt(judgeResult?.message?.content || '1') - 1;
        const selectedIndex = Math.max(0, Math.min(pick, incomingOutputs.length - 1));

        return {
          output: incomingOutputs[selectedIndex],
          cost: judgeResult?.cost || 0,
          tokens: judgeResult?.usage?.totalTokens || 0,
          executionTime,
        };
      }

      case 'consensus': {
        if (!judgeConfig?.providerId) {
          throw new Error(`Merge node '${node.id}' with strategy 'consensus' requires judgeConfig.providerId`);
        }

        const prompt = `Analyze these responses and provide a consensus answer that combines the best elements:\n\n${incomingOutputs.map((o: any, i: number) => `Response ${i + 1}: ${JSON.stringify(o)}`).join('\n\n')}\n\nProvide a single consensus response.`;

        const result = await this.llmProvidersService.chat(
          judgeConfig.providerId,
          {
            messages: [{ role: 'user' as any, content: prompt }],
            model: judgeConfig.model,
            signal: options.signal,
          },
          options.organizationId,
          options.userId,
        );

        const executionTime = Date.now() - startTime;

        return {
          output: result?.message?.content,
          cost: result?.cost || 0,
          tokens: result?.usage?.totalTokens || 0,
          executionTime,
        };
      }

      default:
        // Default: return first output
        return {
          output: incomingOutputs[0],
          executionTime: Date.now() - startTime,
        };
    }
  }

  /**
   * Collect all outputs from nodes that have edges targeting this node.
   */
  private getIncomingOutputs(
    node: AgentPipelineNode,
    context: ExecutionContext,
    edges?: AgentPipelineEdge[],
  ): any[] {
    const outputs: any[] = [];

    if (edges) {
      // Use edge information to find incoming nodes
      const incomingEdges = edges.filter(e => e.target === node.id);
      for (const edge of incomingEdges) {
        const sourceOutput = context.nodes[edge.source]?.output;
        if (sourceOutput !== undefined) {
          outputs.push(sourceOutput);
        }
      }
    }

    // Fallback: if no edges provided or no outputs found, gather all node outputs
    if (outputs.length === 0) {
      for (const [nodeId, nodeResult] of Object.entries(context.nodes)) {
        if (nodeId !== node.id && nodeResult.output !== undefined) {
          outputs.push(nodeResult.output);
        }
      }
    }

    return outputs;
  }
}
