import { BadRequestException, Injectable, Logger, Inject, Optional, forwardRef } from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  callOpenAI,
  callOpenAIStream,
  callAnthropic,
  callAnthropicStream,
  callGoogle,
  callPerplexity,
  callVertex,
  callCustomProvider,
} from './providers';
import { LlmProvider, LlmProviderType, LlmProviderConfig } from '../../entities/llm-provider.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Tool } from '../../entities/tool.entity';
import { ToolCall } from '../../entities/message.entity';
import { ToolExecutorService, ToolExecutionOptions } from '../tools/tool-executor.service';
import { ChatRequest, ChatResponse, StreamChunk } from './dto/llm-providers.dto';
import { callLlmProviderHttp } from './providers/safe-request';
import { safeErrorBody, safeErrorMessage } from './llm-providers.service';
import { LlmModelsHelper } from './llm-models.helper';
import { DefaultModelResolver } from './default-model.resolver';
import { ModelNotFoundError, isModelNotFoundResponse, vendorMessage } from './model-errors';
import { ModelRouterService, NoRouteError, ResolvedCandidate, RouteAttribution } from '../model-catalog/routing/model-router.service';


import {
  validateUrl,
  validateUrlAllowingPrivate,
  ollamaPrivateUrlsAllowed,
} from '../../common/security/url-validator';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { LlmProviderSecretsHelper } from './llm-provider-secrets.helper';

/**
 * Provider-call mechanics extracted from LlmChatHelper:
 * retry/backoff loop (`callLlmProvider`), per-provider dispatch,
 * tool-call execution, request-shape validation, and the small
 * timeout/sleep utilities.
 */
@Injectable()
export class LlmChatRunnerHelper {
  private readonly logger = new Logger(LlmChatRunnerHelper.name);

  constructor(
    @InjectRepository(Tool)
    private readonly toolRepository: Repository<Tool>,
    @Inject(forwardRef(() => ToolExecutorService))
    private readonly toolExecutorService: ToolExecutorService,
    private readonly modelsHelper: LlmModelsHelper,
    private readonly envelopeCrypto: EnvelopeCryptoService,
    private readonly defaultModels: DefaultModelResolver,
    @Optional() private readonly router?: ModelRouterService,
    @Optional() private readonly secrets?: LlmProviderSecretsHelper,
  ) {}



  async callLlmProvider(
    provider: LlmProvider,
    request: ChatRequest,
    session: Conversation,
    tools: Tool[]
  ): Promise<ChatResponse> {
    if (request.routing) {
      return this.callRouted(provider?.organizationId ?? session.organizationId, request, session, tools);
    }
    return this.callWithRetries(provider, request, session, tools);
  }

  /**
   * Catalog-routed call: plan the candidate chain for the org, try each in
   * order, move on when a candidate fails for a reason that is not the
   * request's fault. The answer carries which card served it and why.
   */
  async callRouted(
    organizationId: string,
    request: ChatRequest,
    session: Conversation,
    tools: Tool[],
  ): Promise<ChatResponse> {
    if (!this.router) {
      throw new BadRequestException({ code: 'ROUTING_UNAVAILABLE', message: 'Model routing is not available in this deployment' });
    }
    const { routing, ...plain } = request;
    const plan = await this.router.plan(organizationId, routing, session.userId ? { id: session.userId } : undefined);
    if (plan.candidates.length === 0) throw new NoRouteError(plan.rejected);

    const tried: Array<{ modelId: string; reason: string }> = [];
    let lastError: any;
    for (let i = 0; i < plan.candidates.length; i++) {
      const candidate = plan.candidates[i];
      try {
        const response = await this.callWithRetries(candidate.provider, { ...plain, model: candidate.vendorModelId }, session, tools);
        response.routing = {
          modelId: candidate.modelId,
          modelVersionId: candidate.modelVersionId,
          vendorModelId: candidate.vendorModelId,
          providerId: candidate.card.providerId,
          rationale: candidate.rationale,
          attempt: i + 1,
          tried,
          rejected: plan.rejected,
        };
        this.router.recordRoute(organizationId, response.routing, { userId: session.userId ?? undefined, conversationId: session.id });
        if (typeof response.responseTime === 'number') void this.router.recordLatency(candidate.card, response.responseTime);
        return response;
      } catch (error) {
        lastError = error;
        if (!this.canAdvanceRoute(error, request.signal)) throw error;
        const reason = error?.code ?? error?.response?.status ?? error?.message ?? 'failed';
        tried.push({ modelId: candidate.modelId, reason: String(reason).slice(0, 200) });
        this.logger.warn(`route candidate ${candidate.vendorModelId} (${candidate.modelId}) failed: ${reason}; trying next`);
      }
    }
    throw Object.assign(lastError ?? new Error('All route candidates failed'), { code: lastError?.code ?? 'ROUTE_EXHAUSTED', tried });
  }

  /** The provider at the head of the plan; chat() uses it for the session when no provider id was given. */
  /** The head of the plan with its provider; the streaming path uses it since a stream cannot walk the chain mid-answer. */
  async planRouteHead(organizationId: string, request: ChatRequest, principal?: { id: string }): Promise<{ provider: LlmProvider; candidate: ResolvedCandidate; rejected: Array<{ modelId: string; reason: string }> }> {
    if (!this.router) {
      throw new BadRequestException({ code: 'ROUTING_UNAVAILABLE', message: 'Model routing is not available in this deployment' });
    }
    const plan = await this.router.plan(organizationId, request.routing ?? {}, principal);
    if (plan.candidates.length === 0) throw new NoRouteError(plan.rejected);
    return { provider: plan.candidates[0].provider, candidate: plan.candidates[0], rejected: plan.rejected };
  }

  async headProviderForRoute(organizationId: string, request: ChatRequest, principal?: { id: string }): Promise<LlmProvider> {
    return (await this.planRouteHead(organizationId, request, principal)).provider;
  }

  /** Audit + latency bookkeeping for a routed answer produced outside the walk (the streaming head). */
  recordRoute(organizationId: string, attribution: RouteAttribution, context: { userId?: string; conversationId?: string }): void {
    this.router?.recordRoute(organizationId, attribution, context);
  }

  /**
   * Whether a failed candidate should be walked past.
 Request-shaped
   * failures (bad input, payload too large, unprocessable) and a caller
   * abort stop the walk; everything else (retired model, quota, outage,
   * auth on that one provider) moves to the next card.
   */
  private canAdvanceRoute(error: any, signal?: AbortSignal): boolean {
    if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'CanceledError') return false;
    const status = error?.response?.status ?? error?.status ?? 0;
    return ![400, 413, 422].includes(status);
  }

  async callWithRetries(
    provider: LlmProvider,
    request: ChatRequest,
    session: Conversation,
    tools: Tool[]
  ): Promise<ChatResponse> {
    // Warm the org's DEK cache before any sync key read (getAuthHeaders /
    // getDecryptedApiKey). No-op for non-KMS orgs. This is the single choke
    // point for outbound provider calls, so it covers chat, streaming, and the
    // health check path.
    await this.envelopeCrypto.warmOrg(provider.organizationId);
    // The credential reference: policy check (grants seam) and a fresh
    // read of the row before the sync getters run. Optional only for
    // specs that build the runner by hand; the module always wires it.
    if (this.secrets) {
      await this.secrets.withResolvedSecrets(provider, {
        principal: session?.userId ? { id: session.userId } : undefined,
        context: { purpose: 'llm_call', resourceType: 'llm_provider', resourceId: provider.id },
      });
    }

    // Settle the model once, up front. Provider implementations never
    // guess: when neither the request nor the provider names one, the
    // vendor's current list decides (see DefaultModelResolver).
    if (!request.model) {
      request = { ...request, model: await this.defaultModels.resolve(provider) };
    }
    const maxRetries = 2;
    const backoffDelays = [1000, 3000]; // 1s, 3s exponential backoff
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();

      try {
        const callPromise = this.dispatchProviderCall(provider, request, session, tools, startTime);

        // Enforce a hard timeout per call (provider timeout + 5s buffer, max 120s)
        const callTimeout = Math.min(
          (provider.configuration?.timeout || 30000) + 5000,
          120000,
        );

        const response = await this.withCallTimeout(callPromise, callTimeout);
        return response;

      } catch (error) {
        const responseTime = Date.now() - startTime;
        lastError = error;

        // Log a sanitized view of the provider error — the raw body
        // can echo Authorization headers and other secrets.
        const statusCode = error.response?.status || error.status || 0;
        const safeBody = safeErrorBody(error.response?.data || error.response?.body);
        const safeMsg = safeErrorMessage(error);
        this.logger.error(
          `LLM provider call failed (attempt ${attempt + 1}/${maxRetries + 1}) after ${responseTime}ms: ` +
          `status=${statusCode} message=${safeMsg}` +
          (safeBody ? ` body=${safeBody}` : ''),
        );

        // The old shape tried to update provider health metrics on
        // every failed attempt, but only mutated the in-memory
        // `provider` object and never saved it — so the counters
        // were lost the moment this function returned. The outer
        // catch in chat() now issues a single atomic failure bump
        // via bumpProviderStats, which is the right place for the
        // persistent record. Keep the per-attempt log above.

        // A retired or mistyped model id is not transient: surface it as
        // a typed error the scheduler and UI can act on, and forget any
        // cached default so the next call re-asks the vendor.
        if (isModelNotFoundResponse(statusCode, error.response?.data || error.response?.body)) {
          this.defaultModels.invalidate(provider.id);
          throw new ModelNotFoundError(
            request.model ?? provider.configuration?.model ?? 'unknown',
            provider.id,
            provider.type,
            vendorMessage(error.response?.data || error.response?.body),
          );
        }

        // Retry only on retryable status codes (429, 500, 502, 503)

        const isRetryable = [429, 500, 502, 503].includes(statusCode) ||
          error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';

        if (isRetryable && attempt < maxRetries) {
          const delay = backoffDelays[attempt] || 3000;
          this.logger.warn(`Retrying LLM call after ${delay}ms (attempt ${attempt + 2}/${maxRetries + 1})`);
          await this.sleep(delay);
          continue;
        }

        // Not retryable or exhausted retries
        throw error;
      }
    }

    // Should never reach here, but safety net
    throw lastError;
  }

  /**
   * Dispatch call to the appropriate provider-specific method.
   */
  async dispatchProviderCall(
    provider: LlmProvider,
    request: ChatRequest,
    session: Conversation,
    tools: Tool[],
    startTime: number,
  ): Promise<ChatResponse> {
    const costFn = this.modelsHelper.calculateProviderCost.bind(this.modelsHelper);
    switch (provider.type) {
      case LlmProviderType.OPENAI:
      case LlmProviderType.AZURE_OPENAI:
      case LlmProviderType.MISTRAL:
      case LlmProviderType.XAI:
      case LlmProviderType.DEEPSEEK:
      case LlmProviderType.GROQ:
      case LlmProviderType.TOGETHER:
      case LlmProviderType.OPENROUTER:
      // OpenAI-compatible inference hosts (docs/design/call-only-vendors.md).
      case LlmProviderType.FIREWORKS:
      case LlmProviderType.CEREBRAS:
      case LlmProviderType.DEEPINFRA:
      case LlmProviderType.NOVITA:
      case LlmProviderType.ZAI:
      case LlmProviderType.BASETEN:
      case LlmProviderType.NEBIUS:
      case LlmProviderType.SAMBANOVA:
      // Cloud and aggregator surfaces that speak OpenAI chat completions:
      // Bedrock's /openai/v1 (bearer, no SigV4), Cohere's Compatibility
      // API, and the Hugging Face Inference Providers router. Verified
      // 2026-09-09.
      case LlmProviderType.AWS_BEDROCK:
      case LlmProviderType.AWS_BEDROCK:
      case LlmProviderType.COHERE:
      case LlmProviderType.HUGGINGFACE:
      // First-party model families with OpenAI-compatible APIs.
      case LlmProviderType.MOONSHOT:
      case LlmProviderType.QWEN:
      case LlmProviderType.MINIMAX:
      case LlmProviderType.UPSTAGE:
      case LlmProviderType.WRITER:
      case LlmProviderType.QIANFAN:
      case LlmProviderType.HUNYUAN:
      case LlmProviderType.VOLCENGINE:
      case LlmProviderType.SPARK:
      // The customer's own cloud, and vendor serverless we can call
      // without deploying: all OpenAI-compatible with a static token.
      case LlmProviderType.AZURE_AI_FOUNDRY:
      case LlmProviderType.DIGITALOCEAN:
      case LlmProviderType.RUNPOD:
      case LlmProviderType.MODAL:
      // getAuthHeaders() adds no Authorization header when no key is
      // configured (Ollama needs none).
      case LlmProviderType.OLLAMA:
        return callOpenAI(provider, request, session, tools, startTime, costFn);
      case LlmProviderType.ANTHROPIC:
        return callAnthropic(provider, request, session, tools, startTime, costFn);
      case LlmProviderType.GOOGLE:
        return callGoogle(provider, request, session, tools, startTime, costFn);
      // Perplexity's generally available surface is Responses-shaped, not
      // chat-completions shaped, so it has its own dispatch.
      case LlmProviderType.PERPLEXITY:
        return callPerplexity(provider, request, session, tools, startTime, costFn);
      // Vertex speaks the OpenAI shape but cannot use the synchronous
      // getAuthHeaders(): its adapter mints a short-lived OAuth token from
      // the service-account key first.
      case LlmProviderType.VERTEX_AI:
        return callVertex(provider, request, session, tools, startTime, costFn);
      case LlmProviderType.CUSTOM:
        return callCustomProvider(provider, request, session, tools, startTime);
      default:
        throw new BadRequestException(`Unsupported LLM provider type: ${provider.type}`);
    }
  }

  withCallTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(`LLM call timed out after ${timeoutMs}ms`), { code: 'ECONNABORTED' })),
        timeoutMs,
      );
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timer);
    });
  }

  sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async prepareTools(
    requestTools: ChatRequest['tools'],
    organizationId: string
  ): Promise<Tool[]> {
    if (!requestTools || requestTools.length === 0) {
      return [];
    }

    // Find tools by name SCOPED to the caller's organization. Previously
    // the query had no organizationId filter and only filtered by name on
    // the single-tool path — when more than one tool was requested, the
    // `where` resolved to `{ name: undefined }` (no filter) and fetched
    // EVERY tool in the database, then narrowed by name in JS. Both shapes
    // could surface tools from other organizations to the caller.
    const toolNames = requestTools.map(t => t.name);
    const tools = await this.toolRepository.find({
      where: toolNames.map(name => ({ name, organizationId })),
    });

    // Defense in depth: even though the query is now scoped, double-check
    // every returned tool's organization before handing it to the LLM.
    return tools.filter(tool => tool.organizationId === organizationId && toolNames.includes(tool.name));
  }

  async executeToolCalls(
    toolCalls: ToolCall[],
    session: Conversation,
    organizationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      try {
        // CRITICAL: scope the lookup to the caller's organization. The
        // previous query was `{ name: toolCall.name }` with NO org filter,
        // so an LLM in org A asking for a tool named e.g. `send_email`
        // could resolve and execute org B's `send_email` tool. The
        // downstream tool-executor permission check (`use_tools` in
        // organizationId) was satisfied trivially because the user does
        // have that permission in their OWN org — not in the org that
        // owns the tool.
        const tool = await this.toolRepository.findOne({
          where: { name: toolCall.name, organizationId },
        });

        if (!tool) {
          toolCall.error = `Tool '${toolCall.name}' not found`;
          continue;
        }

        // Execute the tool. Forward the caller's cancellation
        // context so a client disconnect mid-tool-call-loop aborts
        // the outbound tool HTTP request and the LLM provider
        // follow-up both, not just one.
        const executionOptions: ToolExecutionOptions = {
          userId: session.userId || 'system',
          organizationId,
          signal,
        };

        const result = await this.toolExecutorService.executeTool(
          tool.id,
          toolCall.parameters,
          executionOptions
        );

        toolCall.result = result.data;
        toolCall.error = result.success ? undefined : result.error;
        toolCall.executionTime = result.executionTime;
        toolCall.cached = result.cached;

      } catch (error) {
        toolCall.error = error.message;
      }
    }
  }

  validateProviderConfiguration(type: LlmProviderType, config: LlmProviderConfig): void {
    // Optional admin-scoped usage/cost API key (issue #241). Accepted for
    // any type (the capability map decides whether it is used), but it
    // must be a non-empty string when present.
    if (
      config.usageApiKey !== undefined &&
      (typeof config.usageApiKey !== 'string' || config.usageApiKey.length === 0)
    ) {
      throw new BadRequestException('usageApiKey must be a non-empty string when provided');
    }

    switch (type) {
      case LlmProviderType.OPENAI:
      case LlmProviderType.ANTHROPIC:
      case LlmProviderType.GOOGLE:
      case LlmProviderType.MISTRAL:
      case LlmProviderType.XAI:
      case LlmProviderType.DEEPSEEK:
      case LlmProviderType.GROQ:
      case LlmProviderType.TOGETHER:
      case LlmProviderType.OPENROUTER:
      case LlmProviderType.COHERE:
      case LlmProviderType.HUGGINGFACE:
      case LlmProviderType.FIREWORKS:
      case LlmProviderType.CEREBRAS:
      case LlmProviderType.DEEPINFRA:
      case LlmProviderType.NOVITA:
      case LlmProviderType.PERPLEXITY:
      case LlmProviderType.ZAI:
      case LlmProviderType.BASETEN:
      case LlmProviderType.NEBIUS:
      case LlmProviderType.SAMBANOVA:
      case LlmProviderType.MOONSHOT:
      case LlmProviderType.QWEN:
      case LlmProviderType.MINIMAX:
      case LlmProviderType.UPSTAGE:
      case LlmProviderType.WRITER:
      case LlmProviderType.QIANFAN:
      case LlmProviderType.HUNYUAN:
      case LlmProviderType.VOLCENGINE:
      case LlmProviderType.SPARK:
      case LlmProviderType.DIGITALOCEAN:
      case LlmProviderType.MODAL:
        if (!config.apiKey) {
          throw new BadRequestException(`${type} provider requires an API key`);
        }
        break;

      case LlmProviderType.AZURE_AI_FOUNDRY:
        // `model` is the customer's deployment name on this surface, so a
        // resource with no deployment named cannot be called at all.
        if (!config.apiKey || !config.azure?.resourceName || !config.azure?.deploymentName) {
          throw new BadRequestException(
            'Azure AI Foundry provider requires API key, resource name, and deployment name',
          );
        }
        break;

      case LlmProviderType.RUNPOD:
        // Every RunPod URL carries an endpoint: a public catalog slug
        // (nothing to deploy) or the customer's own serverless endpoint id.
        // There is no shared base without one.
        if (!config.apiKey) {
          throw new BadRequestException('RunPod provider requires an API key');
        }
        if (!config.runpod?.endpointId) {
          throw new BadRequestException(
            'RunPod provider requires an endpoint: a public model slug (e.g. gpt-oss-120b) or your own endpoint id',
          );
        }
        break;

      case LlmProviderType.VERTEX_AI:
        // The credential is a service-account JSON key (or a current access
        // token); the project selects whose quota is spent. Location
        // defaults to `global`. There is no model listing on this surface,
        // so a model must be named up front rather than discovered.
        if (!config.apiKey) {
          throw new BadRequestException(
            'Vertex AI provider requires a Google Cloud service-account JSON key as its credential',
          );
        }
        if (!config.vertex?.projectId) {
          throw new BadRequestException('Vertex AI provider requires a Google Cloud project id');
        }
        if (!config.model) {
          throw new BadRequestException(
            'Vertex AI provider requires a model (e.g. google/gemini-3.5-flash): this surface serves no model list to choose from',
          );
        }
        break;

      case LlmProviderType.OLLAMA: {
        // Ollama is keyless by design — the API-key requirement above
        // deliberately does not apply (an optional key is sent as a
        // Bearer token for deployments fronting Ollama with an auth
        // proxy). Validate the effective server URL instead, at save
        // time, so a blocked URL fails fast here rather than on the
        // first chat call. callLlmProviderHttp re-runs the same gate on
        // every outbound request (defense in depth).
        const effectiveUrl = config.apiUrl || 'http://localhost:11434';
        const validation = ollamaPrivateUrlsAllowed()
          ? validateUrlAllowingPrivate(effectiveUrl)
          : validateUrl(effectiveUrl);
        if (!validation.valid) {
          throw new BadRequestException(
            `Ollama URL rejected: ${validation.error}. ` +
            'On hosted almyty the Ollama server must be reachable at a public URL; ' +
            'self-hosted deployments can set OLLAMA_ALLOW_PRIVATE_URLS=true to allow ' +
            'localhost/private-network Ollama servers.',
          );
        }
        break;
      }

      case LlmProviderType.AZURE_OPENAI:
        // The deployment name is the `model` on the /openai/v1 surface, so
        // it is still required: it is what a call actually names.
        if (!config.apiKey || !config.azure?.resourceName || !config.azure?.deploymentName) {
          throw new BadRequestException('Azure OpenAI provider requires API key, resource name, and deployment name');
        }
        break;

      case LlmProviderType.AWS_BEDROCK:
        // Region selects the host and the model set; the Bedrock API key is
        // the bearer token on the OpenAI-compatible surface. Requiring the
        // key here is new: before this change Bedrock validated with a
        // region alone, and then had no dispatch path at all, so a provider
        // saved cleanly and every chat through it threw "Unsupported LLM
        // provider type".
        if (!config.bedrock?.region) {
          throw new BadRequestException('AWS Bedrock provider requires region');
        }
        if (!config.apiKey) {
          throw new BadRequestException('AWS Bedrock provider requires a Bedrock API key');
        }
        break;

      case LlmProviderType.CUSTOM:
        if (!config.apiUrl) {
          throw new BadRequestException('Custom provider requires API URL');
        }
        break;
    }
  }
}
