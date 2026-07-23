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
import { LlmStatsHelper } from './llm-stats.helper';
import { LlmChatRunnerHelper } from './llm-chat-runner.helper';
import { LlmProvidersService } from './llm-providers.service';
import { ChatRequest, ChatResponse, StreamChunk } from './dto/llm-providers.dto';
import { callLlmProviderHttp } from './providers/safe-request';
import { safeErrorBody, safeErrorMessage, extractUpstreamErrorMessage, LLM_HEALTH_GATE_MESSAGE } from './llm-providers.service';
import { ToolExecutionOptions } from '../tools/tool-executor.service';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';

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
    @Inject(forwardRef(() => ToolExecutorService))
    private readonly toolExecutorService: ToolExecutorService,
    private readonly auditLogService: AuditLogService,
    private readonly modelsHelper: LlmModelsHelper,
    @Inject(forwardRef(() => LlmProvidersService))
    @Inject(forwardRef(() => LlmProvidersService))
    private readonly providers: LlmProvidersService,
    private readonly stats: LlmStatsHelper,
    private readonly runner: LlmChatRunnerHelper,
    private readonly envelopeCrypto: EnvelopeCryptoService,
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
        throw new BadRequestException(LLM_HEALTH_GATE_MESSAGE);
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
        tools = await this.runner.prepareTools(request.tools || [], organizationId);
      }

      // Make API call to LLM provider
      let response = await this.runner.callLlmProvider(provider, request, session, tools);

      // Agentic tool call loop: execute tools and send results back until LLM is done
      let toolRound = 0;
      const maxToolRounds = 5;
      const currentMessages = [...request.messages];

      while (response.message.toolCalls && response.message.toolCalls.length > 0 && toolRound < maxToolRounds && !request.skipToolExecution) {
        toolRound++;
        this.logger.log(`[CHAT] Tool call round ${toolRound}: ${response.message.toolCalls.length} tool(s)`);

        // Execute each tool call
        await this.runner.executeToolCalls(
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
        response = await this.runner.callLlmProvider(provider, followUpRequest, session, tools);
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
      await this.stats.bumpSessionStats(session.id, {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cost: response.cost * 100,
        toolCall: hasToolCalls,
        toolCallSuccess: hasToolCalls,
      });

      // Same race existed on provider stats — replace with atomic
      // SQL UPDATE via bumpProviderStats.
      await this.stats.bumpProviderStats(provider.id, {
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
      //
      // lastError gets the UPSTREAM provider message (redacted) —
      // not the bare axios transport line, and never our own
      // health-gate wording, which would overwrite the real upstream
      // error with a circular "not healthy" note.
      const upstreamMsg = extractUpstreamErrorMessage(error);
      try {
        await this.stats.bumpProviderStats(providerId, {
          tokens: 0,
          cost: 0,
          success: false,
        });
        if (upstreamMsg !== LLM_HEALTH_GATE_MESSAGE) {
          await this.llmProviderRepository.update(
            { id: providerId, organizationId },
            { lastError: upstreamMsg },
          );
        }
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
        throw new BadRequestException(LLM_HEALTH_GATE_MESSAGE);
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

      // Resolve tools.
      //
      // Agent-runtime callers pass skipToolExecution: true together
      // with fully-inline tool defs (built-ins like request_approval /
      // wait, plus sub-agent function shims) that have no DB Tool
      // row. Re-resolving by name through prepareTools would silently
      // drop those — which is how request_approval ended up unreachable
      // in the dashboard's autonomous-agent flow. When the caller has
      // already inlined the shape, hand it to the provider verbatim
      // (the provider only reads .name / .description / .parameters).
      let tools: Tool[] = [];
      if (request.toolIds && request.toolIds.length > 0) {
        tools = await this.toolRepository.find({
          where: request.toolIds.map(id => ({ id, organizationId })),
        });
      } else if (request.skipToolExecution && Array.isArray(request.tools) && request.tools.length > 0) {
        tools = request.tools.map(t => ({
          name: t.name,
          description: (t as any).description ?? '',
          parameters: (t as any).parameters ?? { type: 'object', properties: {} },
        })) as unknown as Tool[];
      } else {
        tools = await this.runner.prepareTools(request.tools || [], organizationId);
      }

      const costFn = this.modelsHelper.calculateProviderCost.bind(this.modelsHelper);
      let response: ChatResponse;

      // Streaming dispatches straight to callOpenAIStream/callAnthropicStream
      // (bypassing runner.callLlmProvider), so warm the org's DEK here too
      // before the sync getAuthHeaders read. No-op for non-KMS orgs.
      await this.envelopeCrypto.warmOrg(provider.organizationId);

      switch (provider.type) {
        case LlmProviderType.OPENAI:
        case LlmProviderType.AZURE_OPENAI:
        case LlmProviderType.MISTRAL:
        case LlmProviderType.XAI:
        case LlmProviderType.DEEPSEEK:
        case LlmProviderType.GROQ:
        case LlmProviderType.TOGETHER:
        case LlmProviderType.OPENROUTER:
        case LlmProviderType.OLLAMA:
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
      await this.stats.bumpSessionStats(session.id, {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cost: response.cost * 100,
        toolCall: hasToolCalls,
        toolCallSuccess: hasToolCalls,
      });

      // Update provider stats atomically
      await this.stats.bumpProviderStats(provider.id, {
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

      // Persist the UPSTREAM provider message (redacted) — and never
      // our own health-gate wording, which would overwrite the real
      // upstream error with a circular "not healthy" note.
      const upstreamMsg = extractUpstreamErrorMessage(error);
      try {
        await this.stats.bumpProviderStats(providerId, {
          tokens: 0,
          cost: 0,
          success: false,
        });
        if (upstreamMsg !== LLM_HEALTH_GATE_MESSAGE) {
          await this.llmProviderRepository.update(
            { id: providerId, organizationId },
            { lastError: upstreamMsg },
          );
        }
      } catch (updateError: any) {
        this.logger.warn(`Failed to update provider error stats: ${updateError.message}`);
      }

      throw error;
    }
  }



}