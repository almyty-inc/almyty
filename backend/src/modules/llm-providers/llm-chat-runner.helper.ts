import { BadRequestException, Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  callOpenAI,
  callOpenAIStream,
  callAnthropic,
  callAnthropicStream,
  callGoogle,
  callCohere,
  callHuggingFace,
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
  ) {}

  async callLlmProvider(
    provider: LlmProvider,
    request: ChatRequest,
    session: Conversation,
    tools: Tool[]
  ): Promise<ChatResponse> {
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
        return callOpenAI(provider, request, session, tools, startTime, costFn);
      case LlmProviderType.ANTHROPIC:
        return callAnthropic(provider, request, session, tools, startTime, costFn);
      case LlmProviderType.GOOGLE:
        return callGoogle(provider, request, session, tools, startTime, costFn);
      case LlmProviderType.COHERE:
        return callCohere(provider, request, session, tools, startTime, costFn);
      case LlmProviderType.HUGGINGFACE:
        return callHuggingFace(provider, request, session, tools, startTime);
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
        if (!config.apiKey) {
          throw new BadRequestException(`${type} provider requires an API key`);
        }
        break;

      case LlmProviderType.AZURE_OPENAI:
        if (!config.apiKey || !config.azure?.resourceName || !config.azure?.deploymentName) {
          throw new BadRequestException('Azure OpenAI provider requires API key, resource name, and deployment name');
        }
        break;

      case LlmProviderType.AWS_BEDROCK:
        if (!config.bedrock?.region) {
          throw new BadRequestException('AWS Bedrock provider requires region');
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
