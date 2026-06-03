import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

import { Inject, forwardRef } from '@nestjs/common';
import { callOpenAI, callOpenAIStream, callAnthropic, callAnthropicStream, callGoogle, callCohere, callHuggingFace, callCustomProvider } from './providers';
import { LlmProvider, LlmProviderType, LlmProviderStatus, LlmProviderConfig } from '../../entities/llm-provider.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { Conversation, ConversationStatus } from '../../entities/conversation.entity';
import { Message, MessageRole, MessageType, MessageStatus, ToolCall, MessageContent } from '../../entities/message.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool } from '../../entities/tool.entity';
import { ToolExecutorService, ToolExecutionOptions } from '../tools/tool-executor.service';
import { callLlmProviderHttp } from './providers/safe-request';
import { LlmChatHelper } from './llm-chat.helper';
import { LlmStatsHelper } from './llm-stats.helper';
import { LlmChatRunnerHelper } from './llm-chat-runner.helper';
import { LlmModelsHelper } from './llm-models.helper';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';

import { StreamChunk, CreateLlmProviderDto, UpdateLlmProviderDto, ChatRequest, ChatResponse, LlmProviderSearchFilters } from './dto/llm-providers.dto';
export type { StreamChunk, CreateLlmProviderDto, UpdateLlmProviderDto, ChatRequest, ChatResponse, LlmProviderSearchFilters };

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

export function safeErrorMessage(error: any): string {
  const raw = typeof error?.message === 'string' ? error.message : 'Unknown error';
  return raw.replace(SECRET_VALUE_PATTERN, '[REDACTED]').slice(0, 500);
}

export function safeErrorBody(errorBody: any): string | null {
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
    @InjectRepository(Conversation)
    private conversationRepository: Repository<Conversation>,
    @InjectRepository(Message)
    private messageRepository: Repository<Message>,
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
    private readonly modelsHelper: LlmModelsHelper,
    @Inject(forwardRef(() => LlmChatHelper))
    private readonly chatHelper: LlmChatHelper,
    private readonly statsHelper: LlmStatsHelper,
    private readonly runner: LlmChatRunnerHelper,
    private readonly accessPolicy: AccessPolicyService,
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
      this.runner.validateProviderConfiguration(createDto.type, createDto.configuration);

      // Set default capabilities if not provided
      const capabilities = createDto.capabilities || this.modelsHelper.getDefaultCapabilities(createDto.type);

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

      // Authorization: org owner/admin always, team-scoped requires team lead
      const decision = await this.accessPolicy.canAccess({ id: userId }, provider, 'manage');
      if (!decision.allowed) {
        throw new ForbiddenException(decision.reason);
      }

      // Update configuration
      if (updateDto.configuration) {
        provider.configuration = { ...provider.configuration, ...updateDto.configuration };
        this.runner.validateProviderConfiguration(provider.type, provider.configuration);
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

      // Team-scoping fields (visibility + teamId) from the dashboard
      // VisibilityField. Clear a dangling teamId when visibility flips
      // back to 'org'.
      if (updateDto.visibility !== undefined) {
        provider.visibility = updateDto.visibility;
        provider.teamId = updateDto.visibility === 'team' ? (updateDto.teamId ?? null) : null;
      } else if (updateDto.teamId !== undefined && provider.visibility === 'team') {
        provider.teamId = updateDto.teamId;
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

    const queryBuilder = this.llmProviderRepository.createQueryBuilder('provider');
    if (filters.bypassTeamFilter) {
      queryBuilder.where('provider.organizationId = :_orgId', { _orgId: filters.organizationId });
    } else if (filters.caller) {
      await this.accessPolicy.applyListFilter(queryBuilder, filters.caller, filters.organizationId, 'provider');
    } else {
      throw new Error('getProviders requires either caller or bypassTeamFilter');
    }

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

    // Authorization: org owner/admin always, team-scoped requires team lead
    const decision = await this.accessPolicy.canAccess({ id: userId }, provider, 'manage');
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason);
    }

    await this.llmProviderRepository.remove(provider);

    this.logger.log(`LLM provider '${provider.name}' deleted`);

    // Audit log (fire-and-forget)
    this.auditLogService.logDelete(organizationId, userId, AuditResource.LLM_PROVIDER, providerId, provider.name);
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

      const session = Conversation.createConversation({
        providerId: provider.id,
        organizationId: provider.organizationId,
        title: 'Health Check',
      });

      const response = await this.runner.callLlmProvider(provider, testRequest, session, []);
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
    sessionData?: Partial<Conversation>
  ): Promise<Conversation> {
    const provider = await this.getProvider(providerId, organizationId);

    const session = Conversation.createConversation({
      providerId: provider.id,
      organizationId,
      userId,
      ...sessionData,
    });

    return this.conversationRepository.save(session);
  }

  async getSession(sessionId: string, organizationId: string): Promise<Conversation> {
    const session = await this.conversationRepository.findOne({
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
    status?: ConversationStatus,
    page = 1,
    limit = 20
  ): Promise<{
    sessions: Conversation[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const skip = (page - 1) * limit;
    
    const queryBuilder = this.conversationRepository
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
      status: ConversationStatus;
      title: string;
      context: Conversation['context'];
      metadata: Conversation['metadata'];
    }>
  ): Promise<Conversation> {
    const session = await this.getSession(sessionId, organizationId);

    Object.assign(session, updates);

    return this.conversationRepository.save(session);
  }

  async deleteSession(sessionId: string, organizationId: string): Promise<void> {
    const session = await this.getSession(sessionId, organizationId);
    await this.conversationRepository.remove(session);
  }

  // ── Delegations to LlmModelsHelper (kept for backward-compat with existing tests/callers) ──
  fetchModelsFromProvider(provider: LlmProvider) { return this.modelsHelper.fetchModelsFromProvider(provider); }
  fetchModelsByType(type: LlmProviderType, apiKey: string) { return this.modelsHelper.fetchModelsByType(type, apiKey); }
  getDefaultCapabilities(type: LlmProviderType) { return this.modelsHelper.getDefaultCapabilities(type); }
  calculateProviderCost(provider: LlmProvider, inputTokens: number, outputTokens: number) {
    return this.modelsHelper.calculateProviderCost(provider, inputTokens, outputTokens);
  }

  // ── Delegations to LlmChatHelper ──
  chat(...args: Parameters<LlmChatHelper['chat']>) { return this.chatHelper.chat(...args); }
  validateProviderConfiguration(...args: Parameters<LlmChatRunnerHelper['validateProviderConfiguration']>) { return this.runner.validateProviderConfiguration(...args); }
  callLlmProvider(...args: Parameters<LlmChatRunnerHelper['callLlmProvider']>) { return this.runner.callLlmProvider(...args); }
  prepareTools(...args: Parameters<LlmChatRunnerHelper['prepareTools']>) { return this.runner.prepareTools(...args); }
  executeToolCalls(...args: Parameters<LlmChatRunnerHelper['executeToolCalls']>) { return this.runner.executeToolCalls(...args); }
  bumpSessionStats(...args: Parameters<LlmStatsHelper['bumpSessionStats']>) { return this.statsHelper.bumpSessionStats(...args); }
  bumpProviderStats(...args: Parameters<LlmStatsHelper['bumpProviderStats']>) { return this.statsHelper.bumpProviderStats(...args); }
  dispatchProviderCall(...args: Parameters<LlmChatRunnerHelper['dispatchProviderCall']>) { return this.runner.dispatchProviderCall(...args); }
  chatStream(...args: Parameters<LlmChatHelper['chatStream']>) { return this.chatHelper.chatStream(...args); }
}