import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

import { callOpenAI, callAnthropic, callGoogle, callCohere, callHuggingFace, callCustomProvider } from './providers';
import { LlmProvider, LlmProviderType, LlmProviderStatus, LlmProviderConfig } from '../../entities/llm-provider.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { LlmSession, SessionStatus, SessionType } from '../../entities/llm-session.entity';
import { LlmMessage, MessageRole, MessageType, MessageStatus, ToolCall, MessageContent } from '../../entities/llm-message.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool } from '../../entities/tool.entity';
import { ToolExecutorService, ToolExecutionOptions } from '../tools/tool-executor.service';
import { callLlmProviderHttp } from './providers/safe-request';

export interface CreateLlmProviderDto {
  name: string;
  description?: string;
  type: LlmProviderType;
  configuration: LlmProviderConfig;
  capabilities?: LlmProvider['capabilities'];
  metadata?: LlmProvider['metadata'];
}

export interface UpdateLlmProviderDto {
  name?: string;
  description?: string;
  configuration?: Partial<LlmProviderConfig>;
  capabilities?: Partial<LlmProvider['capabilities']>;
  metadata?: Partial<LlmProvider['metadata']>;
}

export interface ChatRequest {
  messages: Array<{
    role: MessageRole;
    content: string | MessageContent[];
    toolCalls?: ToolCall[];
    toolCallId?: string;
  }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, any>;
  }>;
  toolIds?: string[];
  stream?: boolean;
  sessionId?: string;
  gatewayId?: string;
  skipToolExecution?: boolean; // When true, return tool_calls without executing them (used by agent runtime)
}

export interface ChatResponse {
  message: {
    role: MessageRole;
    content?: string;
    toolCalls?: ToolCall[];
    finishReason?: string;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  cost: number;
  model: string;
  sessionId: string;
  messageId: string;
  cached?: boolean;
  responseTime: number;
}

export interface LlmProviderSearchFilters {
  search?: string;
  type?: LlmProviderType;
  status?: LlmProviderStatus;
  organizationId: string;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'createdAt' | 'lastUsedAt' | 'totalRequests';
  sortOrder?: 'ASC' | 'DESC';
}

// Strip values that look like API keys / secrets / tokens from anywhere
// in a JSON-like object. LLM provider error bodies occasionally include
// the request that was echoed back (so an unauthorized-key error can
// include part of the Authorization header) — we never want that to
// land in logs or in the provider's `lastError` column.
const SECRET_KEY_PATTERNS = /(authorization|api[-_]?key|secret|token|password|bearer|x-api-key|proxy[-_]?authorization)/i;
const SECRET_VALUE_PATTERN = /(sk-[a-zA-Z0-9_-]{20,}|ey[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]+)/g;

function redactSecrets(value: any, depth = 0): any {
  if (depth > 4) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => redactSecrets(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_PATTERNS.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function safeErrorMessage(error: any): string {
  const raw = typeof error?.message === 'string' ? error.message : 'Unknown error';
  return raw.replace(SECRET_VALUE_PATTERN, '[REDACTED]').slice(0, 500);
}

function safeErrorBody(errorBody: any): string | null {
  if (errorBody == null) return null;
  try {
    const redacted = redactSecrets(errorBody);
    return JSON.stringify(redacted).slice(0, 2000);
  } catch {
    return null;
  }
}

@Injectable()
export class LlmProvidersService {
  private readonly logger = new Logger(LlmProvidersService.name);

  constructor(
    @InjectRepository(LlmProvider)
    private llmProviderRepository: Repository<LlmProvider>,
    @InjectRepository(LlmSession)
    private llmSessionRepository: Repository<LlmSession>,
    @InjectRepository(LlmMessage)
    private llmMessageRepository: Repository<LlmMessage>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    private toolExecutorService: ToolExecutorService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async createProvider(
    createDto: CreateLlmProviderDto,
    organizationId: string,
    userId: string
  ): Promise<LlmProvider> {
    try {
      // Verify organization and user permissions
      const organization = await this.organizationRepository.findOne({
        where: { id: organizationId },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_llm_providers')) {
        throw new ForbiddenException('User does not have permission to manage LLM providers');
      }

      // Validate configuration
      this.validateProviderConfiguration(createDto.type, createDto.configuration);

      // Set default capabilities if not provided
      const capabilities = createDto.capabilities || this.getDefaultCapabilities(createDto.type);

      // Create provider
      const provider = this.llmProviderRepository.create({
        ...createDto,
        organizationId,
        capabilities,
        status: LlmProviderStatus.ACTIVE,
      });

      const savedProvider = await this.llmProviderRepository.save(provider);

      // Perform initial health check. Pass the org we just created
      // under so the scoped lookup inside performHealthCheck finds
      // the row.
      setTimeout(
        () => this.performHealthCheck(savedProvider.id, organizationId),
        1000,
      );

      this.logger.log(`LLM provider '${savedProvider.name}' created for organization ${organizationId}`);

      // Audit log (fire-and-forget)
      this.auditLogService.logCreate(organizationId, userId, AuditResource.LLM_PROVIDER, savedProvider.id, savedProvider.name, { type: savedProvider.type });

      return savedProvider;

    } catch (error) {
      this.logger.error(`Failed to create LLM provider: ${error.message}`);
      throw error;
    }
  }

  async updateProvider(
    providerId: string,
    updateDto: UpdateLlmProviderDto,
    organizationId: string,
    userId: string
  ): Promise<LlmProvider> {
    try {
      const provider = await this.llmProviderRepository.findOne({
        where: { id: providerId, organizationId },
      });

      if (!provider) {
        throw new NotFoundException('LLM provider not found');
      }

      // Check permissions
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_llm_providers')) {
        throw new ForbiddenException('User does not have permission to manage LLM providers');
      }

      // Update configuration
      if (updateDto.configuration) {
        provider.configuration = { ...provider.configuration, ...updateDto.configuration };
        this.validateProviderConfiguration(provider.type, provider.configuration);
      }

      // Update other fields
      if (updateDto.name) provider.name = updateDto.name;
      if (updateDto.description !== undefined) provider.description = updateDto.description;
      if (updateDto.capabilities) {
        provider.capabilities = { ...provider.capabilities, ...updateDto.capabilities };
      }
      if (updateDto.metadata) {
        provider.metadata = { ...provider.metadata, ...updateDto.metadata };
      }

      const updatedProvider = await this.llmProviderRepository.save(provider);

      // Perform health check after update, scoped to the same org
      // we just validated membership in.
      setTimeout(
        () => this.performHealthCheck(provider.id, organizationId),
        1000,
      );

      this.logger.log(`LLM provider '${updatedProvider.name}' updated`);

      // Audit log (fire-and-forget)
      this.auditLogService.logUpdate(organizationId, userId, AuditResource.LLM_PROVIDER, updatedProvider.id, updatedProvider.name);

      return updatedProvider;

    } catch (error) {
      this.logger.error(`Failed to update LLM provider: ${error.message}`);
      throw error;
    }
  }

  async getProvider(
    providerId: string,
    organizationId: string,
    includeSecrets = false
  ): Promise<LlmProvider> {
    const provider = await this.llmProviderRepository.findOne({
      where: { id: providerId, organizationId },
    });

    if (!provider) {
      throw new NotFoundException('LLM provider not found');
    }

    return includeSecrets ? provider : provider.maskSensitiveData() as LlmProvider;
  }

  async getProviders(filters: LlmProviderSearchFilters): Promise<{
    providers: LlmProvider[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;

    const queryBuilder = this.llmProviderRepository
      .createQueryBuilder('provider')
      .where('provider.organizationId = :organizationId', { organizationId: filters.organizationId });

    // Apply filters
    if (filters.search) {
      queryBuilder.andWhere(
        '(provider.name ILIKE :search OR provider.description ILIKE :search)',
        { search: `%${filters.search}%` }
      );
    }

    if (filters.type) {
      queryBuilder.andWhere('provider.type = :type', { type: filters.type });
    }

    if (filters.status) {
      queryBuilder.andWhere('provider.status = :status', { status: filters.status });
    }

    // Apply sorting
    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder || 'DESC';
    queryBuilder.orderBy(`provider.${sortBy}`, sortOrder);

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const providers = await queryBuilder
      .skip(skip)
      .take(limit)
      .getMany();

    // Mask sensitive data
    const maskedProviders = providers.map(provider => provider.maskSensitiveData() as LlmProvider);

    const totalPages = Math.ceil(total / limit);

    return {
      providers: maskedProviders,
      total,
      page,
      limit,
      totalPages,
    };
  }

  async deleteProvider(
    providerId: string,
    organizationId: string,
    userId: string
  ): Promise<void> {
    const provider = await this.getProvider(providerId, organizationId);

    // Check permissions
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['organizationMemberships'],
    });

    if (!user?.hasPermissionInOrganization(organizationId, 'manage_llm_providers')) {
      throw new ForbiddenException('User does not have permission to manage LLM providers');
    }

    await this.llmProviderRepository.remove(provider);

    this.logger.log(`LLM provider '${provider.name}' deleted`);

    // Audit log (fire-and-forget)
    this.auditLogService.logDelete(organizationId, userId, AuditResource.LLM_PROVIDER, providerId, provider.name);
  }

  async chat(
    providerId: string,
    request: ChatRequest,
    organizationId: string,
    userId?: string
  ): Promise<ChatResponse> {
    const startTime = Date.now();

    try {
      const provider = await this.getProvider(providerId, organizationId, true);

      if (!provider.isHealthy) {
        throw new BadRequestException('LLM provider is not healthy');
      }

      // Get or create session
      let session: LlmSession;
      if (request.sessionId) {
        session = await this.llmSessionRepository.findOne({
          where: { id: request.sessionId, organizationId },
        });
        if (!session) {
          throw new NotFoundException('Session not found');
        }
      } else {
        session = LlmSession.createSession({
          providerId: provider.id,
          organizationId,
          gatewayId: request.gatewayId,
          userId,
          type: SessionType.CHAT,
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
        session = await this.llmSessionRepository.save(session);
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
        await this.executeToolCalls(response.message.toolCalls, session, organizationId);

        // Save the assistant's tool-call message
        await this.llmMessageRepository.save(this.llmMessageRepository.create({
          sessionId: session.id,
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
      const message = this.llmMessageRepository.create({
        sessionId: session.id,
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

      const savedMessage = await this.llmMessageRepository.save(message);

      // Update session stats atomically. The old path was
      // `session.addMessage(...) + session.addToolCall(...) +
      // llmSessionRepository.save(session)` — a classic
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
        sessionId: session.id,
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
   * Atomic session counter bump. Single UPDATE with column
   * expressions so two concurrent chat calls on the same session
   * can never lose an increment. Mirrors the pattern we use on
   * agent-execution and tool-executor stats.
   */
  private async bumpSessionStats(
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
    await this.llmSessionRepository
      .createQueryBuilder()
      .update(LlmSession)
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
  private async bumpProviderStats(
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

  private async callLlmProvider(
    provider: LlmProvider,
    request: ChatRequest,
    session: LlmSession,
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
  private async dispatchProviderCall(
    provider: LlmProvider,
    request: ChatRequest,
    session: LlmSession,
    tools: Tool[],
    startTime: number,
  ): Promise<ChatResponse> {
    const costFn = this.calculateProviderCost.bind(this);
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

  private async prepareTools(
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

  private async executeToolCalls(
    toolCalls: ToolCall[],
    session: LlmSession,
    organizationId: string
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

        // Execute the tool
        const executionOptions: ToolExecutionOptions = {
          userId: session.userId || 'system',
          organizationId,
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

  private validateProviderConfiguration(type: LlmProviderType, config: LlmProviderConfig): void {
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

  /**
   * Fetch available models dynamically from the provider's API.
   * Falls back to hardcoded defaults if the API call fails.
   */
  async fetchModelsFromProvider(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    try {
      switch (provider.type) {
        case LlmProviderType.OPENAI:
        case LlmProviderType.MISTRAL:
        case LlmProviderType.XAI:
        case LlmProviderType.DEEPSEEK:
        case LlmProviderType.GROQ:
        case LlmProviderType.TOGETHER:
        case LlmProviderType.OPENROUTER:
          return this.fetchOpenAIModels(provider);
        case LlmProviderType.ANTHROPIC:
          return this.fetchAnthropicModels(provider);
        case LlmProviderType.GOOGLE:
          return this.fetchGoogleModels(provider);
        default:
          // For other providers, return the hardcoded defaults
          return this.getDefaultCapabilities(provider.type).supportedModels.map(m => ({
            id: m,
            name: m,
          }));
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch models from ${provider.type} API: ${error.message}`);
      // Fallback to hardcoded defaults
      return this.getDefaultCapabilities(provider.type).supportedModels.map(m => ({
        id: m,
        name: m,
      }));
    }
  }

  private async fetchOpenAIModels(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    const apiUrl = provider.configuration.apiUrl || 'https://api.openai.com/v1';
    // callLlmProviderHttp runs the SSRF gate and applies the shared
    // content / redirect hygiene defaults before delegating to axios.
    const response = await callLlmProviderHttp({
      method: 'GET',
      url: `${apiUrl}/models`,
      headers: {
        'Authorization': `Bearer ${provider.configuration.apiKey}`,
      },
      timeout: 10000,
    });

    const models = response.data?.data || [];

    // Filter to chat-compatible models and sort by created date (newest first)
    const isOpenAI = provider.type === LlmProviderType.OPENAI;
    const chatModels = models
      .filter((m: any) => {
        const id = m.id?.toLowerCase() || '';
        // Always exclude non-chat models
        if (id.includes('embedding') || id.includes('whisper') || id.includes('tts')
          || id.includes('dall-e') || id.includes('realtime') || id.includes('moderation')) {
          return false;
        }
        // For OpenAI specifically, only include GPT and o-series models
        if (isOpenAI) {
          return id.includes('gpt') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4');
        }
        // For other OpenAI-compatible providers, include all non-excluded models
        return true;
      })
      .sort((a: any, b: any) => (b.created || 0) - (a.created || 0))
      .map((m: any) => ({
        id: m.id,
        name: m.id,
        created: m.created,
        owned_by: m.owned_by,
      }));

    return chatModels;
  }

  private async fetchAnthropicModels(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    const apiUrl = provider.configuration.apiUrl || 'https://api.anthropic.com/v1';
    const response = await callLlmProviderHttp({
      method: 'GET',
      url: `${apiUrl}/models`,
      headers: {
        'x-api-key': provider.configuration.apiKey,
        'anthropic-version': provider.configuration.apiVersion || '2023-06-01',
      },
      timeout: 10000,
    });

    const models = response.data?.data || [];

    return models
      .sort((a: any, b: any) => {
        // Sort by created_at descending (newest first)
        const aDate = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bDate = b.created_at ? new Date(b.created_at).getTime() : 0;
        return bDate - aDate;
      })
      .map((m: any) => ({
        id: m.id,
        name: m.display_name || m.id,
        created: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : undefined,
        owned_by: 'anthropic',
      }));
  }

  private async fetchGoogleModels(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    const apiKey = provider.configuration.apiKey;
    // URL-encode the apiKey. The previous shape interpolated it raw,
    // so a key containing `&`, `#`, or a newline would have broken
    // URL parsing or injected extra query params. Google keys are
    // normally `[A-Za-z0-9_-]` only, but defence in depth.
    const target = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(apiKey || '')}`;
    const response = await callLlmProviderHttp({
      method: 'GET',
      url: target,
      timeout: 10000,
    });

    const models = response.data?.models || [];

    return models
      .filter((m: any) => {
        // Only include generative models
        const methods = m.supportedGenerationMethods || [];
        return methods.includes('generateContent');
      })
      .map((m: any) => ({
        id: m.name?.replace('models/', '') || m.name,
        name: m.displayName || m.name,
        owned_by: 'google',
      }));
  }

  /**
   * Fetch models by provider type and API key without needing a saved provider.
   * Used during provider creation to show available models before the provider is saved.
   */
  async fetchModelsByType(type: LlmProviderType, apiKey: string): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    // Create a temporary provider-like object
    const tempProvider = new LlmProvider();
    tempProvider.type = type;
    tempProvider.configuration = { apiKey };

    return this.fetchModelsFromProvider(tempProvider);
  }

  private getDefaultCapabilities(type: LlmProviderType): LlmProvider['capabilities'] {
    const baseCapabilities = {
      supportedModels: [],
      maxTokens: 4096,
      supportsFunctionCalling: false,
      supportsStreaming: false,
      supportsBatching: false,
      supportsVision: false,
      supportsAudio: false,
      supportsToolUse: false,
      supportedToolFormats: [],
    };

    // Models are fetched dynamically from provider APIs via fetchModelsFromProvider().
    // These defaults only define capability flags — supportedModels is intentionally
    // empty because the real list comes from the API at runtime.
    const openaiCompatible = {
      ...baseCapabilities,
      supportedModels: [],
      supportsFunctionCalling: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportedToolFormats: ['openai'],
    };

    switch (type) {
      case LlmProviderType.OPENAI:
        return { ...openaiCompatible, maxTokens: 128000, supportsVision: true };

      case LlmProviderType.ANTHROPIC:
        return {
          ...baseCapabilities,
          supportedModels: [],
          maxTokens: 200000,
          supportsStreaming: true,
          supportsVision: true,
          supportsToolUse: true,
          supportedToolFormats: ['anthropic'],
        };

      case LlmProviderType.GOOGLE:
        return {
          ...baseCapabilities,
          supportedModels: [],
          maxTokens: 1000000,
          supportsStreaming: true,
          supportsVision: true,
          supportsToolUse: true,
          supportedToolFormats: ['google'],
        };

      case LlmProviderType.MISTRAL:
        return { ...openaiCompatible, maxTokens: 128000 };

      case LlmProviderType.XAI:
        return { ...openaiCompatible, maxTokens: 131072, supportsVision: true };

      case LlmProviderType.DEEPSEEK:
        return { ...openaiCompatible, maxTokens: 64000 };

      case LlmProviderType.GROQ:
        return { ...openaiCompatible, maxTokens: 131072 };

      case LlmProviderType.TOGETHER:
        return { ...openaiCompatible, maxTokens: 131072 };

      case LlmProviderType.OPENROUTER:
        return { ...openaiCompatible, maxTokens: 200000, supportsVision: true };

      case LlmProviderType.AZURE_OPENAI:
        return { ...openaiCompatible, maxTokens: 128000, supportsVision: true };

      case LlmProviderType.AWS_BEDROCK:
        return { ...baseCapabilities, supportedModels: [], maxTokens: 200000 };

      case LlmProviderType.COHERE:
        return { ...openaiCompatible, maxTokens: 128000 };

      case LlmProviderType.HUGGINGFACE:
        return { ...baseCapabilities, supportedModels: [], supportsStreaming: true };

      default:
        return baseCapabilities;
    }
  }

  /**
   * Calculate the cost of a provider call in dollars.
   * Uses configured pricing from metadata if available, otherwise falls back
   * to default pricing for well-known models.
   */
  private calculateProviderCost(provider: LlmProvider, inputTokens: number, outputTokens: number): number {
    // 1. Use the provider's configured pricing from metadata if available
    const modelInfo = provider.metadata?.modelInfo;
    if (modelInfo?.inputTokenCost && modelInfo?.outputTokenCost) {
      return ((inputTokens / 1000) * modelInfo.inputTokenCost) + ((outputTokens / 1000) * modelInfo.outputTokenCost);
    }

    // 2. Fall back to default pricing for well-known models (per 1K tokens, in dollars)
    const model = (provider.configuration?.model || '').toLowerCase();
    const pricing = this.getDefaultModelPricing(model, provider.type);
    if (pricing) {
      return ((inputTokens / 1000) * pricing.input) + ((outputTokens / 1000) * pricing.output);
    }

    return 0;
  }

  /**
   * Default per-1K-token pricing for common models.
   * Returns { input, output } in dollars per 1K tokens, or null if model is unknown.
   */
  private getDefaultModelPricing(
    model: string,
    providerType: LlmProviderType,
  ): { input: number; output: number } | null {
    // OpenAI models
    if (model.includes('gpt-4o-mini')) return { input: 0.00015, output: 0.0006 };
    if (model.includes('gpt-4o')) return { input: 0.0025, output: 0.01 };
    if (model.includes('gpt-4-turbo') || model.includes('gpt-4-1106')) return { input: 0.01, output: 0.03 };
    if (model.includes('gpt-4')) return { input: 0.03, output: 0.06 };
    if (model.includes('gpt-3.5-turbo')) return { input: 0.0005, output: 0.0015 };
    if (model.includes('o1-mini')) return { input: 0.003, output: 0.012 };
    if (model.includes('o1')) return { input: 0.015, output: 0.06 };

    // Anthropic models
    if (model.includes('claude-3-5-sonnet') || model.includes('claude-sonnet-4')) return { input: 0.003, output: 0.015 };
    if (model.includes('claude-3-opus') || model.includes('claude-opus-4')) return { input: 0.015, output: 0.075 };
    if (model.includes('claude-3-5-haiku') || model.includes('claude-3-haiku')) return { input: 0.00025, output: 0.00125 };

    // Google models
    if (model.includes('gemini-1.5-pro')) return { input: 0.00125, output: 0.005 };
    if (model.includes('gemini-1.5-flash')) return { input: 0.000075, output: 0.0003 };
    if (model.includes('gemini-pro') || model.includes('gemini-2')) return { input: 0.00125, output: 0.005 };

    // DeepSeek models
    if (model.includes('deepseek-chat') || model.includes('deepseek-v3')) return { input: 0.00027, output: 0.0011 };
    if (model.includes('deepseek-reasoner') || model.includes('deepseek-r1')) return { input: 0.00055, output: 0.0022 };

    return null;
  }


  async performHealthCheck(
    providerId: string,
    /**
     * The caller's current organization. REQUIRED for any invocation
     * that came from an HTTP request — the controller endpoint used
     * to pass providerId through with no org check, which let any
     * authenticated member POST /llm-providers/<foreign-provider-id>/test
     * and force an outbound LLM call spending another tenant's API
     * credits (and probing the provider's configured baseURL for
     * SSRF-worthy responses). Scope the lookup to `{id, organizationId}`
     * so a cross-tenant provider id simply returns 'Provider not found'.
     *
     * The two internal callers in createProvider/updateProvider pass
     * the org they just saved into, so the normal post-create
     * kick-off still works.
     */
    organizationId: string,
  ): Promise<{
    isHealthy: boolean;
    responseTime?: number;
    error?: string;
    details?: Record<string, any>;
  }> {
    try {
      const provider = await this.llmProviderRepository.findOne({
        where: { id: providerId, organizationId },
      });

      if (!provider) {
        return { isHealthy: false, error: 'Provider not found' };
      }

      const startTime = Date.now();

      // Perform a simple health check request
      const testRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
        maxTokens: 10,
        temperature: 0.1,
      };

      const session = LlmSession.createSession({
        providerId: provider.id,
        organizationId: provider.organizationId,
        type: SessionType.CHAT,
        title: 'Health Check',
      });

      const response = await this.callLlmProvider(provider, testRequest, session, []);
      const responseTime = Date.now() - startTime;

      // Update provider health status. Partial UPDATE so we don't
      // race with concurrent writers who might also be touching
      // totalRequests / lastError via the save() path.
      await this.llmProviderRepository.update(
        { id: provider.id },
        { isHealthy: true, lastHealthCheckAt: new Date(), lastError: null },
      );

      return {
        isHealthy: true,
        responseTime,
        details: {
          model: response.model,
          tokenUsage: response.usage.totalTokens,
          cost: response.cost,
        },
      };
    } catch (error: any) {
      // Record a failed health check on the provider row (still
      // org-scoped so we don't touch a foreign provider on errors
      // either). Partial UPDATE for the same race reason.
      try {
        await this.llmProviderRepository.update(
          { id: providerId, organizationId },
          {
            isHealthy: false,
            lastHealthCheckAt: new Date(),
            lastError: error.message,
          },
        );
      } catch (updateError: any) {
        this.logger.warn(`Failed to update provider health status: ${updateError.message}`);
      }

      return {
        isHealthy: false,
        // The old shape had `Date.now() - Date.now()` which always
        // resolved to 0 — it was computing the diff against itself.
        // The caller only gets a response time when the request
        // actually started, so leave it undefined on the error path.
        responseTime: undefined,
        error: error.message,
      };
    }
  }

  // Session management methods
  async createSession(
    providerId: string,
    organizationId: string,
    userId?: string,
    sessionData?: Partial<LlmSession>
  ): Promise<LlmSession> {
    const provider = await this.getProvider(providerId, organizationId);

    const session = LlmSession.createSession({
      providerId: provider.id,
      organizationId,
      userId,
      ...sessionData,
    });

    return this.llmSessionRepository.save(session);
  }

  async getSession(sessionId: string, organizationId: string): Promise<LlmSession> {
    const session = await this.llmSessionRepository.findOne({
      where: { id: sessionId, organizationId },
      relations: ['provider', 'messages'],
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    return session;
  }

  async getSessions(
    organizationId: string,
    providerId?: string,
    userId?: string,
    status?: SessionStatus,
    page = 1,
    limit = 20
  ): Promise<{
    sessions: LlmSession[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const skip = (page - 1) * limit;
    
    const queryBuilder = this.llmSessionRepository
      .createQueryBuilder('session')
      .leftJoinAndSelect('session.provider', 'provider')
      .where('session.organizationId = :organizationId', { organizationId });

    if (providerId) {
      queryBuilder.andWhere('session.providerId = :providerId', { providerId });
    }

    if (userId) {
      queryBuilder.andWhere('session.userId = :userId', { userId });
    }

    if (status) {
      queryBuilder.andWhere('session.status = :status', { status });
    }

    queryBuilder.orderBy('session.createdAt', 'DESC');

    const total = await queryBuilder.getCount();
    const sessions = await queryBuilder.skip(skip).take(limit).getMany();

    return {
      sessions,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async updateSession(
    sessionId: string,
    organizationId: string,
    updates: Partial<{
      status: SessionStatus;
      title: string;
      context: LlmSession['context'];
      metadata: LlmSession['metadata'];
    }>
  ): Promise<LlmSession> {
    const session = await this.getSession(sessionId, organizationId);

    Object.assign(session, updates);

    return this.llmSessionRepository.save(session);
  }

  async deleteSession(sessionId: string, organizationId: string): Promise<void> {
    const session = await this.getSession(sessionId, organizationId);
    await this.llmSessionRepository.remove(session);
  }
}