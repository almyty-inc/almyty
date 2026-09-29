import { Injectable, Logger, Inject, Optional, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';

import { AgentTemplateResolver, ExecutionContext } from './agent-template-resolver';
import { LlmProvidersService, ChatRequest, ChatResponse } from '../llm-providers/llm-providers.service';
import { extractUpstreamErrorMessage, safeErrorBody } from '../llm-providers/llm-providers.service';
import type { RouteAttribution } from '../model-catalog/routing/model-router.service';
import { ModelRouterService } from '../model-catalog/routing/model-router.service';
import type { RoutingPolicy } from '../model-catalog/routing/model-router';
import { Organization } from '../../entities/organization.entity';

import { ToolExecutorService } from '../tools/tool-executor.service';
import { Agent, AgentPipelineNode, AgentPipelineEdge } from '../../entities/agent.entity';
import { AgentExecutionEngine } from './agent-execution.engine';
import { A2AClientService } from '../a2a/a2a-client.service';
import { ExternalAgentsService } from '../a2a/external-agents.service';
import { AgentSubAgentExecutors } from './agent-subagent-executors.helper';
import { AgentVerifierHelper, VerifyPolicy } from './agent-verifier.helper';
import {
  EXTRACT_CONTEXT_INSTRUCTION,
  ExtractedContext,
  ExtractedContextInvalid,
  extractJsonObject,
  parseExtractedContext,
} from './strategies/extract-context';
import {
  DecideAnswer,
  DecideAudit,
  DecideQuestion,
  abstainOptionOf,
  validateQuestion,
} from '../model-catalog/decide/decide-contract';
import { DEFAULT_SCORING_MODE, scoreOptions } from '../model-catalog/decide/option-scoring';
import { InputSchemaViolation, schemaConstrainsAnything, schemaProblems } from './input-schema';
import { describeLimitTrip } from './run-limits';
import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';
import { bestOfNJudgePrompt, consensusJudgePrompt, parseBestOfNPick, parseConsensus } from './strategies/judging';

export interface NodeExecutionResult {
  output: any;
  cost?: number;
  tokens?: number;
  /**
   * The prompt/completion split behind `tokens`. Providers return it
   * (LLMResponse.usage), but every layer above collapsed it into one
   * number, so the OpenAI-compatible route had no honest value for
   * `prompt_tokens`/`completion_tokens` and reported zeros. Optional
   * because a non-llm node has no split to report.
   */
  inputTokens?: number;
  outputTokens?: number;
  executionTime?: number;
  /** Which catalog card answered, when the node was routed rather than pinned to a provider. */
  routing?: RouteAttribution;
  /**
   * What the node was actually given, after every template was resolved:
   * the prompt messages an llm_call sent, the parameters a tool_call
   * passed. No node result recorded its input before, on success or on
   * failure, so a failing node's resolved prompt existed nowhere and the
   * run could not be reproduced from its record. Capped by the engine
   * before it is persisted.
   */
  resolvedInput?: unknown;
  /**
   * Which provider and model answered, whether or not the router chose
   * them. `routing` only lands for a routed call, so a node pinned to a
   * provider recorded cost and tokens with no model attached to them —
   * which is why "spend by model last week" had no query.
   */
  providerId?: string;
  model?: string;
  /**
   * Template references in this node's config that resolved to nothing and
   * were substituted with an empty string. A typo -- `{{nodes.llm1.output}}`
   * for `{{nodes.llm_1.output}}` -- used to leave nothing behind but a
   * server-side warning, so the node produced a prompt with a hole in it and
   * a plausible, wrong answer that nobody could trace back to the typo.
   * Carried onto the run record so it is visible where the run is debugged.
   */
  unresolvedReferences?: string[];
}

export interface NodeExecutionOptions {
  organizationId: string;
  userId?: string;
  /**
   * The run's principal (ExecuteAgentOptions.principal), handed to every
   * tool call and sub-agent run this node makes. Never re-derived here.
   */
  principal?: ExecutionPrincipal;
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
  /**
   * The agent's roles, filled once for this run (L4). A node naming a
   * roleKey reads its model from here rather than deciding again, which
   * is what keeps a pinned role away from the router and lets a run
   * always name the concrete model behind each role.
   */
  resolvedRoles?: Array<{ key: string; modelId: string; via: 'pinned' | 'resolved'; rationale?: string }>;
}
/** How long an organization's default routing policy is reused before it is read again. */
const DEFAULT_ROUTING_TTL_MS = 30_000;

// Verify-node types (VerifyPolicy, etc.) now live with the shared verifier.

/**
 * Unwrap a well-formed quoted string literal.
 *
 * The condition builder in the UI writes the operand it was given as a quoted
 * literal, while the template resolver substitutes the other side unquoted, so
 * the executor has to take the quotes back off before it compares the two.
 *
 * "Well-formed" means the value opens and closes with the same quote character
 * and contains no unescaped occurrence of it in between -- so a value that
 * merely starts and ends with a quote (`'a' + 'b'`, or an LLM answer that is
 * itself a quotation) is left alone rather than being silently truncated.
 */
function unquoteLiteral(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value[value.length - 1] !== quote) {
    return value;
  }

  const inner = value.slice(1, -1);
  let unescaped = '';
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === quote || next === '\\') {
        unescaped += next;
        i++;
        continue;
      }
    }
    // An unescaped copy of the delimiter means this was never one literal.
    if (char === quote) return value;
    unescaped += char;
  }

  return unescaped;
}

/**
 * The floor a verbalised option weight is clamped to before it is logged.
 *
 * A model that says an option is worth 0 is saying it is impossible, and
 * `Math.log(0)` is -Infinity, which the scorer refuses as a non-finite
 * logprob. Flooring keeps such an option at effectively zero mass without
 * turning one confident exclusion into a failed node.
 */
const MIN_DECIDE_WEIGHT = 1e-9;

/**
 * The instruction a `decision` node sends.
 *
 * Kept next to the parse so the shape asked for and the shape accepted
 * cannot drift apart. It asks for a weight per declared option rather than
 * for a winner: a winner carries no confidence, and a threshold needs one.
 */
function decideInstruction(question: DecideQuestion): string {
  const options = (question.options ?? [])
    .map((option) => {
      const abstain = option.abstain ? '  [abstain: pick this when the state does not answer the question]' : '';
      return `  ${option.id}${option.description ? ` — ${option.description}` : ''}${abstain}`;
    })
    .join('\n');

  return [
    'You are answering one typed question over a fixed option set.',
    'Do not pick a winner. Give every option a non-negative weight for how well it fits the state.',
    'Answer with a single JSON object and nothing else:',
    '  {"scores": {"<option id>": <number>, ...}}',
    'Include every option id exactly once, including the abstain option.',
    '',
    'Options:',
    options,
  ].join('\n');
}

/**
 * Read the weights out of a model's answer.
 *
 * Strict about the option set and forgiving about the surroundings, for
 * the same reason `extract_context` is: models wrap JSON in prose and
 * fences, and failing on that is flakiness unrelated to the work. What it
 * will not do is default a missing option to zero — an option the model
 * never mentioned would then read as a confident exclusion, which is the
 * exact claim a `decide` answer exists to stop a caller making by
 * accident.
 */
function parseDecideWeights(
  raw: string,
  optionOrder: string[],
  nodeId: string,
): Record<string, number> {
  const fail = (reason: string): never => {
    throw Object.assign(new Error(`Decision node '${nodeId}' got an unusable answer: ${reason}`), {
      code: 'DECIDE_ANSWER_INVALID',
      raw,
    });
  };

  const json = extractJsonObject((raw ?? '').trim());
  if (!json) fail('no JSON object in the answer');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json as string);
  } catch (err) {
    fail(`the JSON did not parse: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('the answer was not a JSON object');
  }

  const obj = parsed as Record<string, unknown>;
  // Either the documented `{scores: {...}}` envelope or a bare map of
  // option id to weight. The envelope is what is asked for; the bare map
  // is what models hand back often enough that refusing it would be
  // pedantry rather than a contract rule.
  const scoresRaw = (obj.scores ?? obj) as Record<string, unknown>;
  if (typeof scoresRaw !== 'object' || scoresRaw === null || Array.isArray(scoresRaw)) {
    fail('`scores` was not an object of option id to weight');
  }

  const weights: Record<string, number> = {};
  for (const optionId of optionOrder) {
    const value = (scoresRaw as Record<string, unknown>)[optionId];
    if (value === undefined || value === null) {
      fail(`option '${optionId}' has no weight; every declared option needs one`);
    }
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num) || num < 0) {
      fail(`option '${optionId}' has weight ${JSON.stringify(value)}, which is not a non-negative number`);
    }
    weights[optionId] = num;
  }

  return weights;
}

@Injectable()
export class AgentNodeExecutor {
  private readonly logger = new Logger(AgentNodeExecutor.name);
  private readonly defaultRoutingCache = new Map<string, { policy: RoutingPolicy | null; expiresAt: number }>();

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
    private readonly verifier: AgentVerifierHelper,
    // Optional so the many specs that build the executor without it keep
    // working; without it there is simply no organization default.
    // Optional: an install with no catalog still runs agents whose nodes
    // name a providerId directly. Only a node naming a role needs it.
    @Optional() private readonly modelRouter?: ModelRouterService,
    @Optional() @InjectRepository(Organization)
    private readonly organizationRepository?: Repository<Organization>,
  ) {}

  /**
   * The organization's default routing policy (organization settings,
   * `defaultRouting`), consulted only when an llm_call node names neither
   * a provider nor a policy. Cached briefly so a pipeline of many nodes
   * reads it once; null when unset or when the repository is not wired.
   */
  async defaultRoutingFor(organizationId: string): Promise<RoutingPolicy | null> {
    const hit = this.defaultRoutingCache.get(organizationId);
    if (hit && hit.expiresAt > Date.now()) return hit.policy;
    let policy: RoutingPolicy | null = null;
    if (this.organizationRepository) {
      try {
        const org = await this.organizationRepository.findOne({ where: { id: organizationId }, select: { id: true, settings: true } });
        const raw = org?.settings?.defaultRouting;
        policy = raw && typeof raw === 'object' ? raw : null;
      } catch (err: any) {
        this.logger.warn(`Could not read default routing for organization ${organizationId}: ${err?.message ?? err}`);
      }
    }
    this.defaultRoutingCache.set(organizationId, { policy, expiresAt: Date.now() + DEFAULT_ROUTING_TTL_MS });
    return policy;
  }

  /**
   * Executes a single pipeline node and returns the result.
   * Supports: input, output, llm_call, tool_call, condition, transform, loop, parallel, merge, sub_agent, verify, extract_context, decision
   */
  async execute(
    node: AgentPipelineNode,
    context: ExecutionContext,
    organizationId: string,
    userId?: string,
    options?: NodeExecutionOptions,
  ): Promise<NodeExecutionResult> {
    const execOptions: NodeExecutionOptions = {
      organizationId,
      userId,
      ...options,
    };

    // Each node gets its own sink, so two nodes running side by side in a
    // layer cannot collect each other's unresolved references. The copy
    // shares `nodes`, `input` and `variables` by reference, so everything a
    // node reads or writes through the context still behaves as before.
    const unresolvedReferences: string[] = [];
    const nodeContext: ExecutionContext = { ...context, unresolvedReferences };

    const result = await this.dispatch(node, nodeContext, organizationId, userId, execOptions);

    return unresolvedReferences.length > 0
      ? { ...result, unresolvedReferences }
      : result;
  }

  private async dispatch(
    node: AgentPipelineNode,
    context: ExecutionContext,
    organizationId: string,
    userId: string | undefined,
    execOptions: NodeExecutionOptions,
  ): Promise<NodeExecutionResult> {
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

      case 'verify':
        return this.executeVerifyNode(node, context, organizationId, userId, execOptions);

      case 'extract_context':
        return this.executeExtractContextNode(node, context, organizationId, userId, execOptions);

      case 'decision':
        return this.executeDecisionNode(node, context, organizationId, userId, execOptions);

      default:
        throw new Error(`Unsupported node type: ${node.type}`);
    }
  }

  private async executeInputNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    // The input node declares the run's contract, so this is where it is
    // held to. A schema that constrains nothing — the builder's default
    // `{type: 'object', properties: {}}` — is treated as "unspecified"
    // rather than "must be an object", because an agent answering a chat
    // surface should not start refusing its own input the moment somebody
    // opens the schema editor and closes it again.
    const schema = (node.data || node.config || {}).schema;
    if (schemaConstrainsAnything(schema)) {
      const problems = schemaProblems(schema, context.input);
      if (problems.length) throw new InputSchemaViolation(problems);
    }

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

    return this.callModelForNode(node, config, messages, organizationId, userId, options);
  }

  /**
   * The model call a node makes: role/provider/routing resolution, the
   * chat itself, and the accounting on the way out.
   *
   * Shared so that `llm_call`, `extract_context` and a `merge` node's
   * judge cannot drift in how they fill a role or attribute a routed
   * call. They differ only in what they say and in what they do with the
   * answer, which is where the difference belongs.
   */
  private async callModelForNode(
    node: AgentPipelineNode,
    config: Record<string, any>,
    messages: ChatRequest['messages'],
    organizationId: string,
    userId?: string,
    options?: NodeExecutionOptions,
  ): Promise<NodeExecutionResult> {
    const startTime = Date.now();
    const which = `${node.type} node '${node.id}'`;
    // Who every model call of this node acts as: the run's principal.
    const caller = options?.principal ?? userId;

    // A node may name a role instead of a provider or a policy. The role
    // was filled once for the whole run (L4), so this is a lookup, not a
    // second routing decision: a pinned role must never reach the router,
    // and calling plan() here would be exactly that. The per-node model
    // field stays valid and is used when no role is named.
    const roleKey = typeof config.roleKey === 'string' ? config.roleKey : undefined;
    const filledRole = roleKey ? options?.resolvedRoles?.find((r) => r.key === roleKey) : undefined;
    if (roleKey && !filledRole) {
      throw new Error(
        `The ${which} names role '${roleKey}', which this agent does not define. ` +
          'Add the role, or give the node a providerId or routing policy.',
      );
    }

    // Resolve provider ID. A node may instead carry a routing policy and
    // let the catalog pick the model per call; a node with neither uses
    // the organization's default policy when one is set.
    const providerId = config.providerId;
    let routing: RoutingPolicy | undefined = config.routing && typeof config.routing === 'object' ? config.routing : undefined;
    let routingSource = routing ? 'node' : undefined;
    if (!filledRole && !providerId && !routing) {
      const orgDefault = await this.defaultRoutingFor(organizationId);
      if (orgDefault) {
        routing = orgDefault;
        routingSource = 'organization default';
      }
    }
    if (!filledRole && !providerId && !routing) {
      throw new Error(`The ${which} is missing 'providerId' or 'routing' in config, and the organization has no default routing policy`);
    }

    // Build chat request — thread the agent-execution signal in
    // so the LLM HTTP call and its embedded tool-call loop both
    // abort on client disconnect.
    // A filled role names the model. Looked up, never planned: see the
    // comment on roleKey above.
    let roleProviderId: string | undefined;
    let roleModel: string | undefined;
    if (filledRole) {
      if (!this.modelRouter) {
        throw new Error(
          `The ${which} names role '${filledRole.key}', but the model catalog is not available on this install`,
        );
      }
      const { card, provider } = await this.modelRouter.providerForModelId(organizationId, filledRole.modelId, caller);
      roleProviderId = provider.id;
      roleModel = card.vendorModelId;
    }

    const chatRequest: ChatRequest = {
      messages,
      model: roleModel ?? config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      toolIds: config.toolIds,
      signal: options?.signal,
      routing,
    };


    this.logger.log(`[NODE_EXEC] Executing ${which} with provider=${roleProviderId ? `role ${filledRole!.key} (${filledRole!.via})` : providerId ?? `routed (${routingSource})`}, model=${config.model ?? (routing ? 'routed' : 'default')}`);

    let response: ChatResponse;
    try {
      // The chat() method handles the full agentic tool call loop internally.
      // As the run's principal, inherited: a gateway run reaches the
      // providers, keys and tools of its gateway's team, whoever the run
      // row names.
      response = await this.llmProvidersService.chat(
        roleProviderId ?? providerId,
        chatRequest,
        organizationId,
        caller,
      );
    } catch (err: any) {
      // A provider error body can echo the request back, Authorization
      // header included, so it never reaches a log line or a persisted
      // `error` column unredacted. extractUpstreamErrorMessage picks the
      // same candidate the old code did but redacts and caps it; the
      // body goes through safeErrorBody for the same reason. What lands
      // here ends up in nodeResults[nodeId].error and
      // agent_executions.error, which are read back in the UI.
      const detail = extractUpstreamErrorMessage(err);
      const safeBody = safeErrorBody(err.response?.data);
      this.logger.error(
        `[NODE_EXEC] LLM call failed for node '${node.id}': ${detail}${safeBody ? ` body=${safeBody}` : ''}`,
      );
      // Keep the typed cause (e.g. ModelNotFoundError) reachable: the
      // scheduler and the UI act on its code, not on the message text.
      // The resolved prompt rides along so the engine can persist the
      // input of a node that FAILED — the case where being able to
      // reproduce the call matters most.
      throw Object.assign(
        new Error(`LLM call failed: ${detail}`),
        {
          cause: err,
          code: err?.code,
          resolvedInput: { messages },
          attemptedProviderId: roleProviderId ?? providerId ?? undefined,
          attemptedModel: roleModel ?? config.model,
        },
      );

    }

    const executionTime = Date.now() - startTime;

    // Attribution for the spend, whether or not the router chose the
    // model. `routing` only lands for a routed call, so a node pinned to
    // a provider recorded a cost and a token count with no model and no
    // provider attached — which is why there was no query that answered
    // "spend by model last week".
    const answeredProviderId =
      response.routing?.providerId ?? roleProviderId ?? providerId ?? undefined;
    const answeredModel =
      response.model || response.routing?.vendorModelId || roleModel || config.model;

    return {
      output: response.message.content || response.message,
      cost: response.cost || 0,
      tokens: response.usage?.totalTokens || 0,
      inputTokens: response.usage?.inputTokens || 0,
      outputTokens: response.usage?.outputTokens || 0,
      executionTime,
      resolvedInput: { messages },
      ...(answeredProviderId ? { providerId: answeredProviderId } : {}),
      ...(answeredModel ? { model: answeredModel } : {}),
      ...(response.routing ? { routing: response.routing } : {}),
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

    // The run's tool-call budget, spent here because this is the only place
    // in the workflow path that calls a tool. `maxToolCalls` reached the
    // execution context and was read by nothing, so an organization that
    // capped tool calls at ten still ran a hundred-node pipeline's hundred
    // tool nodes. Counted before the call, not after, so the ceiling is the
    // number of calls actually made.
    const toolBudget = context.runLimits?.maxToolCalls;
    if (context.toolCalls && typeof toolBudget === 'number') {
      if (context.toolCalls.count >= toolBudget) {
        const trip = describeLimitTrip('TOOL_CALL_LIMIT_EXCEEDED');
        throw Object.assign(new Error(`${trip.code}: ${trip.message}`), { code: trip.code });
      }
      context.toolCalls.count++;
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
      // The run's principal, inherited: a tool_call node cannot run a team
      // or private tool the run's starter could not have run directly.
      principal: options.principal,
      // Propagate the agent-level cancellation context into the
      // tool executor so its axios call honours a disconnected
      // client or parent-cancelled run.
      signal: options.signal,
    });

    const executionTime = Date.now() - startTime;

    if (!result.success) {
      // The resolved parameters ride on the error so a failed tool call's
      // input is persisted too, not just its message.
      throw Object.assign(new Error(result.error || 'Tool execution failed'), {
        resolvedInput: { toolId, parameters: resolvedParams },
      });
    }

    return {
      output: result.data,
      executionTime,
      resolvedInput: { toolId, parameters: resolvedParams },
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

    let result: boolean;
    // Checked before the comparison form: this one is anchored to the whole
    // expression, so it cannot swallow a real comparison, while a haystack
    // containing "==" could otherwise be mistaken for one.
    const methodMatch = resolvedStr.match(
      /^(!?)\s*(.+)\.(includes|startsWith|endsWith)\(\s*(.*?)\s*\)$/s,
    );
    // Try to evaluate as a comparison expression (e.g. "overweight == overweight", "29.4 > 25")
    const comparisonMatch = methodMatch
      ? null
      : resolvedStr.match(/^(.+?)\s*(===?|!==?|>=?|<=?)\s*(.+)$/);

    if (methodMatch) {
      // contains / does not contain / starts with / ends with. The builder
      // offers these four; nothing evaluated them, so they fell through to the
      // truthiness branch below and a non-empty string always took the true
      // branch -- the leading "!" included, since it is just a character.
      const [, negate, receiver, method, rawArg] = methodMatch;
      const haystack = unquoteLiteral(receiver.trim());
      const needle = unquoteLiteral(rawArg.trim());
      const matched =
        method === 'includes'
          ? haystack.includes(needle)
          : method === 'startsWith'
            ? haystack.startsWith(needle)
            : haystack.endsWith(needle);
      result = negate === '!' ? !matched : matched;
    } else if (comparisonMatch) {
      const [, left, op, right] = comparisonMatch;
      // The visual builder emits the right-hand side as a quoted literal
      // ("{{...}} === 'positive'") while the template resolver substitutes the
      // left-hand side unquoted. Comparing them raw made every string equality
      // built in the builder false, and every "not equals" true.
      const lVal = unquoteLiteral(left.trim());
      const rVal = unquoteLiteral(right.trim());
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
    } else if (/^!?\s*.+\.\s*[A-Za-z_$][\w$]*\s*\(.*\)$/s.test(resolvedStr)) {
      // The whole expression looks like a method call, but not one we
      // implement. Falling through to truthiness would make an expression we
      // could not evaluate silently take the true branch -- exactly how the
      // four operators above stayed broken for so long. Refuse instead.
      throw new Error(
        `Condition node '${node.id}' uses an expression this engine cannot evaluate: ` +
          `'${resolvedStr}'. Supported operators are ==, ===, !=, !==, >, <, >=, <=, ` +
          'includes(), startsWith() and endsWith().',
      );
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
    // The loop guard and the run budget were two separate mechanisms,
    // so a loop node could iterate 100 times inside a run allowed 25
    // steps. The node may still tighten, never loosen.
    const runCeiling = context.runLimits?.maxSteps;
    const requested = config.maxIterations || 100;
    const maxIterations = runCeiling ? Math.min(requested, runCeiling) : requested;

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
   * Execute a merge node — collects outputs from all incoming edges and
   * applies a merge strategy.
   *
   * The two judged strategies (`best_of_n`, `consensus`) take their model
   * the same way an `llm_call` node does: a `roleKey`, a `providerId`, a
   * routing policy, or the organization default, in that order. They used
   * to insist on `judgeConfig.providerId` and nothing else, which made
   * both unreachable from a compiled strategy — the compiler names a role
   * and never a provider, on purpose, so `best_of_n` and `panel` threw
   * "requires judgeConfig.providerId" the moment they reached the merge.
   * `judgeConfig` still works for a hand-drawn graph that pins a provider.
   */
  private async executeMergeNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
    options: NodeExecutionOptions,
  ): Promise<NodeExecutionResult> {
    const config = node.data || node.config || {};
    const { strategy, judgeConfig } = config;
    const startTime = Date.now();

    // Collect outputs from all incoming edges
    const incomingOutputs = this.getIncomingOutputs(node, context, options.edges);

    /** What the judge is: the node's own role/provider, with judgeConfig as the pinned override. */
    const judgeCall = (messages: ChatRequest['messages']) =>
      this.callModelForNode(
        node,
        {
          roleKey: config.roleKey,
          providerId: judgeConfig?.providerId,
          model: judgeConfig?.model ?? config.model,
          routing: judgeConfig?.routing ?? config.routing,
          temperature: judgeConfig?.temperature,
          maxTokens: judgeConfig?.maxTokens,
        },
        messages,
        options.organizationId,
        options.userId,
        options,
      );

    const asText = (o: any): string => (typeof o === 'string' ? o : JSON.stringify(o));

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
        // One candidate is not a choice. Judging it anyway would spend a
        // call to rediscover the only answer there is.
        if (incomingOutputs.length < 2) {
          return {
            output: incomingOutputs[0],
            executionTime: Date.now() - startTime,
          };
        }
        // `judgePrompt` is what the builder's Judge Prompt box writes.
        // It was read by nothing: anyone who typed a judging rubric in
        // the UI had it silently discarded in favour of the default.
        const prompt =
          config.judgePrompt ||
          judgeConfig?.prompt ||
          bestOfNJudgePrompt(incomingOutputs);
        const judged = await judgeCall([{ role: 'user' as any, content: prompt }]);

        const answer = typeof judged.output === 'string' ? judged.output : asText(judged.output);
        const selectedIndex = parseBestOfNPick(answer, incomingOutputs.length).index;

        return {
          ...judged,
          output: incomingOutputs[selectedIndex],
          executionTime: Date.now() - startTime,
        };
      }

      case 'consensus': {
        // "Disagreement is the signal" only means something if the
        // agreement is measured. The judge is asked for both: how many of
        // the answers agree, and the combined answer. `consensusThreshold`
        // then decides whether that counted as consensus — it is a
        // configurable field with a control in the builder, and before
        // this it was read by nothing.
        const threshold =
          typeof config.consensusThreshold === 'number' ? config.consensusThreshold : 0.5;

        if (incomingOutputs.length < 2) {
          return {
            output: {
              answer: incomingOutputs[0],
              agreement: 1,
              consensusReached: 1 >= threshold,
              threshold,
              responses: incomingOutputs.length,
            },
            executionTime: Date.now() - startTime,
          };
        }

        const judged = await judgeCall([{ role: 'user' as any, content: consensusJudgePrompt(incomingOutputs) }]);
        const raw = typeof judged.output === 'string' ? judged.output : asText(judged.output);
        // A judge that did not return JSON still said something useful, so
        // its text is kept -- but the agreement is then genuinely unknown,
        // and unknown agreement is not consensus: a downstream condition
        // node branching on this must not read "we could not tell" as
        // "they agreed".
        const { answer, agreement, consensusReached } = parseConsensus(raw, incomingOutputs.length, threshold);

        return {
          ...judged,
          output: {
            answer,
            agreement,
            consensusReached,
            threshold,
            responses: incomingOutputs.length,
          },
          executionTime: Date.now() - startTime,
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

      if (incomingEdges.length > 0) {
        // The graph names this node's upstreams, so they are the only honest
        // answer. Falling through to "every other node's output, in insertion
        // order" used to hand a merge whose branches had all failed some
        // unrelated node's value -- typically the input node's, i.e. the run's
        // own payload echoed back -- which the output node then captured, so
        // the run was saved COMPLETED. It was also nondeterministic, since
        // insertion order under a fan-out is Promise.all settle order.
        if (outputs.length === 0) {
          const states = incomingEdges
            .map(e => {
              const upstream = context.nodes[e.source];
              if (!upstream) return `${e.source} (did not run)`;
              return `${e.source} (${upstream.status ?? 'no output'})`;
            })
            .join(', ');
          throw new Error(
            `Node '${node.id}' has no upstream output to work with: ${states}. ` +
              'Every step feeding this one failed, was skipped, or produced nothing.',
          );
        }
        return outputs;
      }
    }

    // No edges recorded for this node at all (or no edge list supplied):
    // nothing declares what feeds it, so gather what the run has produced.
    if (outputs.length === 0) {
      for (const [nodeId, nodeResult] of Object.entries(context.nodes)) {
        if (nodeId !== node.id && nodeResult.output !== undefined) {
          outputs.push(nodeResult.output);
        }
      }
    }

    return outputs;
  }

  /**
   * Execute a verify node — runs N refute-only checkers in parallel, each its
   * own vendor/model (per checker.providerId), then merges their verdicts per
   * policy. A checker's only job is to refute: it sees the target + spec and
   * returns structured JSON. The node never throws on a failing verdict — it
   * emits the failure list so a downstream `condition` node can branch
   * (retry / escalate / halt).
   *
   * Config (node.data || node.config): {
   *   target?: any | string   // value or template; defaults to the incoming node output
   *   spec?: any | string     // validation rules (template-resolved)
   *   checkers: Array<{ name?, providerId, model?, instructions?, temperature?, maxTokens? }>
   *   policy?: 'all_pass' | 'majority' | 'any_fail_blocks'   // default: any_fail_blocks
   * }
   */
  private async executeVerifyNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
    organizationId: string,
    userId?: string,
    options?: NodeExecutionOptions,
  ): Promise<NodeExecutionResult> {
    const config = node.data || node.config || {};
    const startTime = Date.now();

    const checkers = Array.isArray(config.checkers) ? config.checkers : [];
    if (checkers.length === 0) {
      throw new Error(`Verify node '${node.id}' requires at least one checker`);
    }
    const policy: VerifyPolicy = config.policy || 'any_fail_blocks';

    // Resolve the target to check: an explicit template/value wins, else fall
    // back to the upstream node output(s) reaching this node.
    let target: any;
    if (config.target !== undefined) {
      target =
        typeof config.target === 'string'
          ? this.templateResolver.resolve(config.target, context)
          : config.target;
    } else {
      const incoming = this.getIncomingOutputs(node, context, options?.edges);
      target = incoming.length === 1 ? incoming[0] : incoming;
    }

    const spec = config.spec
      ? typeof config.spec === 'string'
        ? this.templateResolver.resolve(config.spec, context)
        : JSON.stringify(config.spec, null, 2)
      : '';

    // A checker that names a role has to be turned into a provider before the
    // panel sees it. The compiler emits role-named checkers for every verify
    // step in a strategy, and runChecker reads only `providerId` -- so a
    // checker with a roleKey and no providerId returned verdict 'error',
    // mergeVerdicts turned an all-error panel into 'fail', and the cascade
    // strategy escalated to the expensive role on every single run while
    // reporting a completed run with a failed check. Resolved here, the same
    // way callModelForNode resolves a node's own role.
    const resolvedCheckers = await Promise.all(
      checkers.map(async (checker: any) => {
        if (checker?.providerId || !checker?.roleKey) return checker;
        const filled = options?.resolvedRoles?.find((r) => r.key === checker.roleKey);
        if (!filled) {
          throw new Error(
            `Verify node '${node.id}' has a checker naming role '${checker.roleKey}', which this agent does not define.`,
          );
        }
        if (!this.modelRouter) {
          throw new Error(
            `Verify node '${node.id}' has a checker naming role '${checker.roleKey}', but the model catalog is not available on this install`,
          );
        }
        const { card, provider } = await this.modelRouter.providerForModelId(
          organizationId,
          filled.modelId,
          options?.principal ?? userId,
        );
        return { ...checker, providerId: provider.id, model: checker.model ?? card.vendorModelId };
      }),
    );

    // The checker panel (fan-out, per-checker provider/model, verdict merge)
    // is owned by the shared verifier so the autonomous step processor reuses
    // the same logic.
    const panel = await this.verifier.runPanel(
      { target, spec, checkers: resolvedCheckers, policy },
      organizationId,
      options?.principal ?? userId,
      options?.signal,
    );

    return {
      output: {
        verdict: panel.verdict,
        passed: panel.passed,
        policy: panel.policy,
        failures: panel.failures,
        passed_rules: panel.passedRules,
        checkers: panel.checkers,
      },
      cost: panel.cost,
      tokens: panel.tokens,
      executionTime: Date.now() - startTime,
    };
  }

  /**
   * Execute an extract_context node — one call that compresses what the
   * incoming steps learned into a small structured brief, which later
   * steps read instead of every transcript.
   *
   * The step exists so that compression is visible: it carries its own
   * cost, and the saving in explore-extract-patch is the expensive role
   * downstream reading a brief rather than N rollouts. So the call itself
   * goes through the same path as an llm_call node — same role lookup,
   * same routing attribution, same accounting — and this method adds only
   * the instruction and the parse.
   *
   * Config (node.data || node.config), every field optional:
   *   roleKey / providerId / model / routing / temperature / maxTokens
   *   task     — what the brief is for; defaults to the run input
   *   sources  — what to compress; defaults to the incoming node outputs
   *   instruction — overrides the built-in extraction instruction
   *
   * A brief that does not parse fails the node. Falling back to passing
   * the raw transcripts through would look like a cheap extraction while
   * handing the expensive role the full context the step was meant to
   * spare it.
   */
  private async executeExtractContextNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
    organizationId: string,
    userId?: string,
    options?: NodeExecutionOptions,
  ): Promise<NodeExecutionResult> {
    const config = node.data || node.config || {};

    const asText = (value: any): string =>
      typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2);
    const field = (value: any): string =>
      typeof value === 'string' ? this.templateResolver.resolve(value, context) : asText(value);

    const task = config.task !== undefined ? field(config.task) : asText(context.input);
    const sources =
      config.sources !== undefined
        ? field(config.sources)
        : this.getIncomingOutputs(node, context, options?.edges).map(asText).join('\n\n---\n\n');

    if (!sources.trim()) {
      throw new Error(
        `Extract context node '${node.id}' has nothing to compress: give it 'sources', ` +
          'or put it downstream of a step that produces output.',
      );
    }

    const messages: ChatRequest['messages'] = [
      {
        role: 'system' as any,
        content:
          typeof config.instruction === 'string' ? config.instruction : EXTRACT_CONTEXT_INSTRUCTION,
      },
      {
        role: 'user' as any,
        content: [
          'Task:',
          task.trim() || '(not given)',
          '',
          'Attempts to compress:',
          sources,
        ].join('\n'),
      },
    ];

    const result = await this.callModelForNode(node, config, messages, organizationId, userId, options);

    const raw = typeof result.output === 'string' ? result.output : asText(result.output);
    let brief: ExtractedContext;
    try {
      brief = parseExtractedContext(raw);
    } catch (err) {
      // Keep the typed cause reachable: the code is what the UI and the
      // step processor branch on, and the raw answer is what a user needs
      // to see to understand why the extraction was rejected.
      throw Object.assign(new Error((err as Error).message), {
        cause: err,
        code: (err as ExtractedContextInvalid).code,
      });
    }

    return { ...result, output: brief };
  }


  /**
   * Execute a `decision` node — one typed question over a declared option
   * set, answered with a distribution instead of prose.
   *
   * `decide` is an invocation mode, not a second routing system, so the
   * call goes through `callModelForNode` exactly like an `llm_call` node:
   * same role / providerId / routing / organization-default ladder, same
   * accounting, and the same `routing` attribution stamped on the node
   * result. Only the ask and the parse differ, which is where the
   * difference belongs.
   *
   * Config (node.data || node.config):
   *   question    — a DecideQuestion; required
   *   thresholds  — optional minimum winning probability, per option id
   *   state       — what to decide over; defaults to the upstream outputs
   *   roleKey / providerId / model / routing / temperature / maxTokens
   *
   * The execution path is always `constrained`. Nothing on ChatRequest
   * exposes token logprobs, so the model verbalises a weight per option
   * and the answer is normalised over the declared options only. The
   * contract is explicit that this path is never calibrated, so the answer
   * carries `calibrated: false` and the numbers are conditional scores —
   * they order the options and mean nothing on their own.
   */
  private async executeDecisionNode(
    node: AgentPipelineNode,
    context: ExecutionContext,
    organizationId: string,
    userId?: string,
    options?: NodeExecutionOptions,
  ): Promise<NodeExecutionResult> {
    const config = node.data || node.config || {};
    const question: DecideQuestion | undefined = config.question;

    if (!question || typeof question !== 'object') {
      throw new Error(`Decision node '${node.id}' is missing 'question' in config`);
    }

    // The contract rules are the contract's to enforce, not this node's:
    // re-deriving "a choice question needs an abstain option" here is how
    // the two copies drift. Thrown before any model is called, so a
    // question that cannot produce an honest answer costs nothing.
    validateQuestion(question);

    if (question.type === 'boolean') {
      // A boolean question declares no options, so it has no abstain
      // option and therefore no edge for a below-threshold answer to take.
      // Model it as a choice with an explicit abstain instead of quietly
      // serving a two-way question that the threshold cannot protect.
      throw new Error(
        `Decision node '${node.id}' asks a boolean question, which declares no options and so no ` +
          'abstain edge. Ask it as a choice question with yes/no/abstain options.',
      );
    }

    if (question.optionsOrderPolicy && question.optionsOrderPolicy !== 'asis') {
      // Refused rather than silently served `asis`: a caller who asked for
      // the order to be debiased and got the declared order back has no
      // way to tell from the distribution.
      throw new Error(
        `Decision node '${node.id}' asks for optionsOrderPolicy '${question.optionsOrderPolicy}', ` +
          'which this node does not serve. Only `asis` is implemented.',
      );
    }

    const declared = question.options ?? [];
    const optionOrder = declared.map((option) => option.id);

    const asText = (value: any): string =>
      typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2);

    const state =
      config.state !== undefined
        ? typeof config.state === 'string'
          ? this.templateResolver.resolve(config.state, context)
          : asText(config.state)
        : this.getIncomingOutputs(node, context, options?.edges).map(asText).join('\n\n---\n\n') ||
          asText(context.input);

    const messages: ChatRequest['messages'] = [
      { role: 'system' as any, content: decideInstruction(question) },
      {
        role: 'user' as any,
        content: ['State:', state.trim() || '(empty)', '', 'Question:', question.prompt].join('\n'),
      },
    ];

    const result = await this.callModelForNode(node, config, messages, organizationId, userId, options);

    const raw = typeof result.output === 'string' ? result.output : asText(result.output);
    const weights = parseDecideWeights(raw, optionOrder, node.id);

    // The scorer is the one arithmetic seam for every path: softmax over a
    // reduced per-option score, restricted to the declared options. Feeding
    // it log(weight) makes the verbalised weights normalise exactly as the
    // logits path does, so argmax and entropy are computed once rather than
    // twice. A zero weight is floored rather than passed as -Infinity,
    // which the scorer refuses as a non-finite logprob.
    const scored = scoreOptions(
      optionOrder.map((optionId) => ({
        optionId,
        tokenLogprobs: [Math.log(Math.max(weights[optionId], MIN_DECIDE_WEIGHT))],
      })),
      DEFAULT_SCORING_MODE,
    );

    const distribution: Record<string, number> = {};
    for (const score of scored.scores) distribution[score.optionId] = score.probability;

    const answer: DecideAnswer = {
      type: question.type,
      argmax: scored.argmax,
      distribution,
      entropy: scored.entropy,
      agreement: null,
      calibrated: false,
      conditionalScores: true,
    };

    const audit: DecideAudit = {
      provider: result.providerId ?? 'unknown',
      modelRevision: result.model ?? 'unknown',
      promptHash: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
      optionOrder,
      servingConfig: {
        temperature: typeof config.temperature === 'number' ? config.temperature : 0,
        ...(typeof config.seed === 'number' ? { seed: config.seed } : {}),
        // No `scoring` here, deliberately. The constrained path reads no
        // token logprobs at all, so naming a mode would assert a
        // measurement that never happened, and an audit row that claims a
        // reading it did not take is worse than one that is silent about
        // it. The field is absent until a scoring path fills it in.
      },
      latencyMs: result.executionTime ?? 0,
      tokens: { input: result.inputTokens ?? 0, output: result.outputTokens ?? 0 },
    };

    const thresholds: Record<string, number> =
      config.thresholds && typeof config.thresholds === 'object' ? config.thresholds : {};
    const rawThreshold = thresholds[answer.argmax];
    const threshold = typeof rawThreshold === 'number' ? rawThreshold : null;
    const winningProbability = distribution[answer.argmax];
    const belowThreshold = threshold !== null && winningProbability < threshold;

    // The whole point of the threshold: an answer the model is not
    // confident enough about takes the abstain edge rather than the
    // argmax edge. `validateQuestion` guarantees exactly one abstain
    // option exists on every question that reaches here, so the edge is
    // always there to take.
    //
    // It stops at abstain. Sending a below-threshold decision to a human
    // is a separate decision: the pipeline DAG engine has no approval node
    // (human-in-the-loop lives on the autonomous runtime, as the
    // `request_approval` tool), and inventing one here would be a second
    // HITL mechanism rather than a reuse of the existing one.
    const abstain = abstainOptionOf(question);
    const selectedOption = belowThreshold && abstain ? abstain.id : answer.argmax;

    const outgoing = (options?.edges ?? []).filter((edge) => edge.source === node.id);
    const selectedEdge =
      outgoing.find((edge) => (edge.sourceHandle || edge.label || '') === selectedOption) ?? null;

    return {
      ...result,
      output: {
        __decision: true,
        selectedOption,
        selectedEdgeId: selectedEdge?.id ?? null,
        argmax: answer.argmax,
        abstained: selectedOption !== answer.argmax,
        probability: winningProbability,
        threshold,
        distribution,
        answer,
        audit,
      },
      resolvedInput: { messages },
    };
  }

}
