import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { callOpenAI, callOpenAIStream, callAnthropic, callAnthropicStream, callGoogle, callCohere, callHuggingFace, callCustomProvider } from './providers';
import { LlmProvider, LlmProviderType, LlmProviderStatus, LlmProviderConfig } from '../../entities/llm-provider.entity';
import { Conversation, ConversationStatus } from '../../entities/conversation.entity';
import { Message, MessageRole, MessageType, MessageStatus, ToolCall, MessageContent } from '../../entities/message.entity';
import { Tool } from '../../entities/tool.entity';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { LlmModelsHelper } from './llm-models.helper';
import { LlmProvidersService } from './llm-providers.service';
import { ChatRequest, ChatResponse, StreamChunk } from './dto/llm-providers.dto';
import { callLlmProviderHttp } from './providers/safe-request';
import { safeErrorBody, safeErrorMessage } from './llm-providers.service';
import { ToolExecutionOptions } from '../tools/tool-executor.service';

@Injectable()
export class LlmChatHelper {
  private readonly logger = new Logger(LlmChatHelper.name);

  constructor(
    @InjectRepository(LlmProvider)
    private readonly llmProviderRepository: Repository<LlmProvider>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(Tool)
    private readonly toolRepository: Repository<Tool>,
    private readonly toolExecutorService: ToolExecutorService,
    private readonly auditLogService: AuditLogService,
    private readonly modelsHelper: LlmModelsHelper,
    @Inject(forwardRef(() => LlmProvidersService))
    private readonly providers: LlmProvidersService,
  ) {}

  async chat(
    providerId: string,
    request: ChatRequest,
    organizationId: string,
    userId?: string
  ): Promise<ChatResponse> {
    const startTime = Date.now();

    try {
      const provider = await this.providers.getProvider(providerId, organizationId, true);

      if (!provider.isHealthy) {
        throw new BadRequestException('LLM provider is not healthy');
      }

      // Get or create session
      let session: Conversation;
      if (request.sessionId) {
        session = await this.conversationRepository.findOne({
          where: { id: request.sessionId, organizationId },
        });
        if (!session) {
          throw new NotFoundException('Session not found');
        }
      } else {
        session = Conversation.createConversation({
          providerId: provider.id,
          organizationId,
          gatewayId: request.gatewayId,
          userId,

          context: {
            model: request.model || provider.configuration.model,
            maxTokens: request.maxTokens || provider.configuration.maxTokens,
            temperature: request.temperature ?? provider.configuration.temperature,
            topP: request.topP ?? provider.configuration.topP,
            topK: request.topK ?? provider.configuration.topK,
            frequencyPenalty: request.frequencyPenalty ?? provider.configuration.frequencyPenalty,
            presencePenalty: request.presencePenalty ?? provider.configuration.presencePenalty,
            stopSequences: request.stopSequences,
            toolsEnabled: (request.tools && request.tools.length > 0) || (request.toolIds && request.toolIds.length > 0),
          },
        });
        session = await this.conversationRepository.save(session);
      }

      // Resolve toolIds to tool entities directly if provided
      let tools: Tool[] = [];
      if (request.toolIds && request.toolIds.length > 0) {
        tools = await this.toolRepository.find({
          where: request.toolIds.map(id => ({ id, organizationId })),
        });
      } else {
        // Prepare tools from inline tool definitions
        tools = await this.prepareTools(request.tools || [], organizationId);
      }

      // Make API call to LLM provider
      let response = await this.callLlmProvider(provider, request, session, tools);

      // Agentic tool call loop: execute tools and send results back until LLM is done
      let toolRound = 0;
      const maxToolRounds = 5;
      const currentMessages = [...request.messages];

      while (response.message.toolCalls && response.message.toolCalls.length > 0 && toolRound < maxToolRounds && !request.skipToolExecution) {
        toolRound++;
        this.logger.log(`[CHAT] Tool call round ${toolRound}: ${response.message.toolCalls.length} tool(s)`);

        // Execute each tool call
        await this.executeToolCalls(
          response.message.toolCalls,
          session,
          organizationId,
          request.signal,
        );

        // Save the assistant's tool-call message
        await this.messageRepository.save(this.messageRepository.create({
          conversationId: session.id,
          role: MessageRole.ASSISTANT,
          type: MessageType.TOOL_CALL,
          content: response.message.content || '',
          toolCalls: response.message.toolCalls,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cost: response.cost * 100,
          responseTime: response.responseTime,
          model: response.model,
          finishReason: response.message.finishReason,
          status: MessageStatus.COMPLETED,
        }));

        session.addMessage(response.usage.inputTokens, response.usage.outputTokens, response.cost * 100);
        session.addToolCall(true);

        // Build follow-up messages with tool results
        currentMessages.push({
          role: MessageRole.ASSISTANT,
          content: response.message.content || '',
          toolCalls: response.message.toolCalls,
        });

        for (const tc of response.message.toolCalls) {
          currentMessages.push({
            role: MessageRole.TOOL,
            content: tc.result != null ? (typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result)) : 'Tool executed successfully',
            toolCallId: tc.id,
          });
        }

        // Call LLM again with tool results
        const followUpRequest = { ...request, messages: currentMessages };
        response = await this.callLlmProvider(provider, followUpRequest, session, tools);
      }

      // Save final message to database
      const message = this.messageRepository.create({
        conversationId: session.id,
        role: response.message.role,
        type: response.message.toolCalls?.length > 0 ? MessageType.TOOL_CALL : MessageType.TEXT,
        content: response.message.content,
        toolCalls: response.message.toolCalls,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cost: response.cost * 100,
        responseTime: response.responseTime,
        model: response.model,
        finishReason: response.message.finishReason,
        status: MessageStatus.COMPLETED,
      });

      const savedMessage = await this.messageRepository.save(message);

      // Update session stats atomically. The old path was
      // `session.addMessage(...) + session.addToolCall(...) +
      // conversationRepository.save(session)` — a classic
      // read-modify-write race. Two concurrent chats against the
      // same session would both read the old counters, both
      // compute `+1` / `+ cost`, both save, and one increment
      // would be silently lost. Replaced with a single atomic
      // SQL UPDATE via bumpSessionStats.
      const hasToolCalls = (response.message.toolCalls?.length || 0) > 0;
      await this.bumpSessionStats(session.id, {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cost: response.cost * 100,
        toolCall: hasToolCalls,
        toolCallSuccess: hasToolCalls,
      });

      // Same race existed on provider stats — replace with atomic
      // SQL UPDATE via bumpProviderStats.
      await this.bumpProviderStats(provider.id, {
        tokens: response.usage.totalTokens,
        cost: response.cost * 100,
        success: true,
      });

      return {
        ...response,
        conversationId: session.id,
        messageId: savedMessage.id,
      };

    } catch (error) {
      const safeBody = safeErrorBody(error.response?.data);
      const safeMsg = safeErrorMessage(error);
      this.logger.error(
        `Chat request failed: ${safeMsg}` +
        (safeBody ? ` response_body=${safeBody}` : ''),
        error.stack,
      );

      // Update provider error stats + lastError atomically. The
      // old path loaded the provider, mutated it, and called
      // save(provider) — racing with any concurrent writer on the
      // same row. Use a scoped partial UPDATE instead.
      try {
        await this.bumpProviderStats(providerId, {
          tokens: 0,
          cost: 0,
          success: false,
        });
        await this.llmProviderRepository.update(
          { id: providerId, organizationId },
          { lastError: safeMsg },
        );
      } catch (updateError: any) {
        this.logger.warn(`Failed to update provider error stats: ${updateError.message}`);
      }

      throw error;
    }
  }

  /**
   * Streaming variant of chat(). Calls the LLM provider with
   * streaming enabled, invoking `onChunk` for each content delta.
   * Returns the same ChatResponse as chat() with the full
   * accumulated response.
   *
   * Falls back to non-streaming chat() for providers that don't
   * support streaming (Google, Cohere, HuggingFace, Custom).
   *
   * The onChunk callback is optional — if omitted, this behaves
   * identically to chat() but uses the streaming transport where
   * available. The agent runtime uses onChunk to emit llm.chunk
   * SSE events in real time.
   */
  async chatStream(
    providerId: string,
    request: ChatRequest,
    organizationId: string,
    userId?: string,
    onChunk?: (chunk: StreamChunk) => void,
  ): Promise<ChatResponse> {
    // If no chunk callback, or skipToolExecution is false (agentic loop),
    // fall through to the non-streaming path to avoid complexity.
    if (!onChunk) {
      return this.chat(providerId, request, organizationId, userId);
    }

    const startTime = Date.now();

    try {
      const provider = await this.providers.getProvider(providerId, organizationId, true);

      if (!provider.isHealthy) {
        throw new BadRequestException('LLM provider is not healthy');
      }

      // Determine if the provider supports streaming
      const supportsStreaming = [
        LlmProviderType.OPENAI,
        LlmProviderType.AZURE_OPENAI,
        LlmProviderType.MISTRAL,
        LlmProviderType.XAI,
        LlmProviderType.DEEPSEEK,
        LlmProviderType.GROQ,
        LlmProviderType.TOGETHER,
        LlmProviderType.OPENROUTER,
        LlmProviderType.ANTHROPIC,
      ].includes(provider.type);

      if (!supportsStreaming) {
        // Fall back to non-streaming for unsupported providers
        return this.chat(providerId, request, organizationId, userId);
      }

      // Get or create session
      let session: Conversation;
      if (request.sessionId) {
        session = await this.conversationRepository.findOne({
          where: { id: request.sessionId, organizationId },
        });
        if (!session) {
          throw new NotFoundException('Session not found');
        }
      } else {
        session = Conversation.createConversation({
          providerId: provider.id,
          organizationId,
          gatewayId: request.gatewayId,
          userId,
          context: {
            model: request.model || provider.configuration.model,
            maxTokens: request.maxTokens || provider.configuration.maxTokens,
            temperature: request.temperature ?? provider.configuration.temperature,
            topP: request.topP ?? provider.configuration.topP,
            topK: request.topK ?? provider.configuration.topK,
            frequencyPenalty: request.frequencyPenalty ?? provider.configuration.frequencyPenalty,
            presencePenalty: request.presencePenalty ?? provider.configuration.presencePenalty,
            stopSequences: request.stopSequences,
            toolsEnabled: (request.tools && request.tools.length > 0) || (request.toolIds && request.toolIds.length > 0),
          },
        });
        session = await this.conversationRepository.save(session);
      }

      // Resolve tools
      let tools: Tool[] = [];
      if (request.toolIds && request.toolIds.length > 0) {
        tools = await this.toolRepository.find({
          where: request.toolIds.map(id => ({ id, organizationId })),
        });
      } else {
        tools = await this.prepareTools(request.tools || [], organizationId);
      }

      const costFn = this.modelsHelper.calculateProviderCost.bind(this.modelsHelper);
      let response: ChatResponse;

      switch (provider.type) {
        case LlmProviderType.OPENAI:
        case LlmProviderType.AZURE_OPENAI:
        case LlmProviderType.MISTRAL:
        case LlmProviderType.XAI:
        case LlmProviderType.DEEPSEEK:
        case LlmProviderType.GROQ:
        case LlmProviderType.TOGETHER:
        case LlmProviderType.OPENROUTER:
          response = await callOpenAIStream(provider, request, session, tools, startTime, costFn, onChunk);
          break;
        case LlmProviderType.ANTHROPIC:
          response = await callAnthropicStream(provider, request, session, tools, startTime, costFn, onChunk);
          break;
        default:
          // Should not reach here due to supportsStreaming check, but safety net
          return this.chat(providerId, request, organizationId, userId);
      }

      // Save final message to database
      const message = this.messageRepository.create({
        conversationId: session.id,
        role: response.message.role,
        type: response.message.toolCalls?.length > 0 ? MessageType.TOOL_CALL : MessageType.TEXT,
        content: response.message.content,
        toolCalls: response.message.toolCalls,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cost: response.cost * 100,
        responseTime: response.responseTime,
        model: response.model,
        finishReason: response.message.finishReason,
        status: MessageStatus.COMPLETED,
      });

      const savedMessage = await this.messageRepository.save(message);

      // Update session stats atomically
      const hasToolCalls = (response.message.toolCalls?.length || 0) > 0;
      await this.bumpSessionStats(session.id, {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cost: response.cost * 100,
        toolCall: hasToolCalls,
        toolCallSuccess: hasToolCalls,
      });

      // Update provider stats atomically
      await this.bumpProviderStats(provider.id, {
        tokens: response.usage.totalTokens,
        cost: response.cost * 100,
        success: true,
      });

      return {
        ...response,
        conversationId: session.id,
        messageId: savedMessage.id,
      };
    } catch (error) {
      const safeBody = safeErrorBody(error.response?.data);
      const safeMsg = safeErrorMessage(error);
      this.logger.error(
        `Chat stream request failed: ${safeMsg}` +
        (safeBody ? ` response_body=${safeBody}` : ''),
        error.stack,
      );

      try {
        await this.bumpProviderStats(providerId, {
          tokens: 0,
          cost: 0,
          success: false,
        });
        await this.llmProviderRepository.update(
          { id: providerId, organizationId },
          { lastError: safeMsg },
        );
      } catch (updateError: any) {
        this.logger.warn(`Failed to update provider error stats: ${updateError.message}`);
      }

      throw error;
    }
  }

  /**
   * Atomic session counter bump. Single UPDATE with column
   * expressions so two concurrent chat calls on the same session
   * can never lose an increment. Mirrors the pattern we use on
   * agent-execution and tool-executor stats.
   */
  async bumpSessionStats(
    sessionId: string,
    delta: {
      inputTokens: number;
      outputTokens: number;
      cost: number;
      toolCall: boolean;
      toolCallSuccess: boolean;
    },
  ): Promise<void> {
    const input = Number(delta.inputTokens) || 0;
    const output = Number(delta.outputTokens) || 0;
    const cost = Number(delta.cost) || 0;
    await this.conversationRepository
      .createQueryBuilder()
      .update(Conversation)
      .set({
        messageCount: () => '"messageCount" + 1',
        totalInputTokens: () => `"totalInputTokens" + ${input}`,
        totalOutputTokens: () => `"totalOutputTokens" + ${output}`,
        totalCost: () => `"totalCost" + ${cost}`,
        toolCalls: delta.toolCall
          ? () => '"toolCalls" + 1'
          : () => '"toolCalls"',
        successfulToolCalls: delta.toolCall && delta.toolCallSuccess
          ? () => '"successfulToolCalls" + 1'
          : () => '"successfulToolCalls"',
        lastActivityAt: new Date(),
      })
      .where('id = :id', { id: sessionId })
      .execute();
  }

  /**
   * Atomic provider counter bump. Same shape as bumpSessionStats —
   * single UPDATE with column expressions so concurrent chat calls
   * don't lose increments on totalRequests / totalTokensUsed /
   * totalCost / successfulRequests.
   */
  async bumpProviderStats(
    providerId: string,
    delta: { tokens: number; cost: number; success: boolean },
  ): Promise<void> {
    const tokens = Number(delta.tokens) || 0;
    const cost = Number(delta.cost) || 0;
    await this.llmProviderRepository
      .createQueryBuilder()
      .update(LlmProvider)
      .set({
        totalRequests: () => '"totalRequests" + 1',
        successfulRequests: delta.success
          ? () => '"successfulRequests" + 1'
          : () => '"successfulRequests"',
        totalTokensUsed: () => `"totalTokensUsed" + ${tokens}`,
        totalCost: () => `"totalCost" + ${cost}`,
        lastRequestAt: new Date(),
      })
      .where('id = :id', { id: providerId })
      .execute();
  }

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

  private withCallTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
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

  private sleep(ms: number): Promise<void> {
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