import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

import { Inject, forwardRef } from '@nestjs/common';
import { callOpenAI, callOpenAIStream, callAnthropic, callAnthropicStream, callGoogle, callPerplexity, callPerplexityStream, callCustomProvider } from './providers';
import { LlmProvider, LlmProviderType, LlmProviderStatus, LlmProviderConfig } from '../../entities/llm-provider.entity';
import { decideEgress } from '../connections/egress-policy';
import { llmCallOptionsFor } from './providers/safe-request';
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
import { DefaultModelResolver } from './default-model.resolver';
import { findModelNotFound } from './model-errors';
import { ModelCatalogService } from '../model-catalog/model-catalog.service';

import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { Credential } from '../../entities/credential.entity';
import { LlmProviderSecretsHelper, MASKED_PROVIDER_KEY } from './llm-provider-secrets.helper';

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

/**
 * Wording of the pre-flight health gate in LlmChatHelper.chat(). This
 * message describes our OWN gate, not an upstream provider failure, so
 * it must never be persisted as a provider's `lastError` — doing so
 * overwrites the real upstream error with a circular "not healthy
 * because it is not healthy".
 */
export const LLM_HEALTH_GATE_MESSAGE = 'This provider is not healthy';

/**
 * Extract the human-useful upstream provider error from an axios-style
 * error. Provider APIs put the actionable message in the response body
 * (e.g. Anthropic: `{ type: 'error', error: { message: '...' } }`,
 * OpenAI: `{ error: { message: '...' } }`) while `error.message` is the
 * bare transport line ("Request failed with status code 400"). Same
 * extraction order as the agent-node executor's LLM error handler.
 * The result is secret-redacted and length-capped like safeErrorMessage.
 */
export function extractUpstreamErrorMessage(error: any): string {
  const data = error?.response?.data;
  const candidates = [
    data?.error?.message,
    data?.message,
    typeof data === 'string' ? data : undefined,
    typeof error?.message === 'string' ? error.message : undefined,
  ];
  const first = candidates.find(
    (c) => typeof c === 'string' && c.trim().length > 0,
  ) || 'Unknown error';
  return String(first).replace(SECRET_VALUE_PATTERN, '[REDACTED]').slice(0, 500);
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
    @Inject(forwardRef(() => ToolExecutorService))
    private toolExecutorService: ToolExecutorService,
    private readonly auditLogService: AuditLogService,
    private readonly modelsHelper: LlmModelsHelper,
    @Inject(forwardRef(() => LlmChatHelper))
    private readonly chatHelper: LlmChatHelper,
    private readonly statsHelper: LlmStatsHelper,
    private readonly runner: LlmChatRunnerHelper,
    private readonly defaultModels: DefaultModelResolver,

    private readonly accessPolicy: AccessPolicyService,
    private readonly envelopeCrypto: EnvelopeCryptoService,
    private readonly secrets: LlmProviderSecretsHelper,
    // The catalog listens to provider lifecycle (sync on create, on a
    // configuration change and after a passing health check). Optional:
    // it arrives through a forwardRef and some specs build this service
    // without it.
    @Optional() @Inject(forwardRef(() => ModelCatalogService))
    private readonly catalog?: ModelCatalogService,
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
        relations: { organizationMemberships: true },
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_llm_providers')) {
        throw new ForbiddenException('User does not have permission to manage providers');
      }

      // Keys never land on the provider row: a pasted key becomes a
      // Credential row the provider manages, a credentialId points at a
      // shared connection. Validation sees the key either way.
      const createAny = createDto as CreateLlmProviderDto & { credentialId?: string | null; usageCredentialId?: string | null };
      const { configuration, apiKey, usageApiKey } = LlmProviderSecretsHelper.splitKeys(createDto.configuration);
      this.runner.validateProviderConfiguration(createDto.type, {
        ...configuration,
        apiKey: apiKey ?? (createAny.credentialId ? MASKED_PROVIDER_KEY : undefined),
        usageApiKey,
      });
      await this.assertProviderEgressAllowed(createDto.type, configuration as LlmProviderConfig, organizationId);
      await this.assertModelIsServed(createDto.type, configuration, organizationId, { apiKey, credentialId: createAny.credentialId });


      // Validate team scoping before persisting.
      await this.accessPolicy.assertCanScopeToTeam(
        userId,
        organizationId,
        (createDto as any).visibility,
        (createDto as any).teamId,
      );

      // Set default capabilities if not provided
      const capabilities = createDto.capabilities || this.modelsHelper.getDefaultCapabilities(createDto.type);

      // Create provider
      const { credentialId: _credentialId, usageCredentialId: _usageCredentialId, ...providerFields } = createAny;
      const provider = this.llmProviderRepository.create({
        ...providerFields,
        configuration,
        organizationId,
        capabilities,
        status: LlmProviderStatus.ACTIVE,
      });

      // Save first so the key rows can name the provider they belong to;
      // a failure to store the key removes the half-made provider again.
      const savedProvider = await this.llmProviderRepository.save(provider);
      try {
        await this.secrets.applyKey(savedProvider, 'inference', { plaintext: apiKey, credentialId: createAny.credentialId ?? undefined });
        await this.secrets.applyKey(savedProvider, 'usage', { plaintext: usageApiKey, credentialId: createAny.usageCredentialId ?? undefined });
      } catch (error) {
        try { await this.llmProviderRepository.remove(savedProvider); } catch { /* best effort */ }
        throw error;
      }
      const withKeys = await this.llmProviderRepository.save(savedProvider);

      // Perform initial health check. Pass the org we just created
      // under so the scoped lookup inside performHealthCheck finds
      // the row.
      setTimeout(
        () => this.performHealthCheck(withKeys.id, organizationId),
        1000,
      );
      this.scheduleCatalogSync(withKeys.id, organizationId, 'provider_created');

      this.logger.log(`LLM provider '${withKeys.name}' created for organization ${organizationId}`);

      // Audit log (fire-and-forget)
      this.auditLogService.logCreate(organizationId, userId, AuditResource.LLM_PROVIDER, withKeys.id, withKeys.name, { type: withKeys.type });

      return withKeys;

    } catch (error) {
      this.logger.error(`Failed to create LLM provider: ${error.message}`);
      throw error;
    }
  }

  /**
   * Refuse a provider whose URL points somewhere private, unless this
   * organization has said that host is theirs.
   *
   * Save time is the right gate: the URL is user-supplied here and used
   * on every call afterwards, so one check here covers every later
   * request rather than being re-argued per call site. The DNS-pinning
   * agent still refuses a name that resolves privately at connect, which
   * is the case this check cannot see.
   */
  private async assertProviderEgressAllowed(
    type: LlmProviderType,
    configuration: LlmProviderConfig,
    organizationId: string,
  ): Promise<void> {
    // Build the URL the way the entity will, so the gate judges exactly
    // what the caller will dial rather than a guess at it.
    const probe = Object.assign(new LlmProvider(), { type, configuration });
    let url: string;
    try {
      url = probe.getApiUrl();
    } catch {
      return; // No URL to judge; configuration validation owns that.
    }
    if (!url) return;

    // The install-wide escape hatches still apply where they always did:
    // an operator running Ollama on localhost has already said yes to
    // private URLs for that provider type across the install.
    if (llmCallOptionsFor(probe).allowPrivateUrls) return;

    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } });
    const decision = decideEgress(url, { allowlist: organization?.settings?.egressAllowlist ?? [] });
    if (!decision.allowed) {
      throw new BadRequestException({ code: 'EGRESS_NOT_ALLOWED', message: decision.reason });
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
        throw new NotFoundException('Provider not found');
      }

      // Authorization: org owner/admin always, team-scoped requires team lead
      const decision = await this.accessPolicy.canAccess({ id: userId }, provider, 'manage');
      if (!decision.allowed) {
        throw new ForbiddenException(decision.reason);
      }

      // Re-validate team scoping if it's being changed.
      const updateAnyEarly = updateDto as any;
      if (updateAnyEarly.visibility !== undefined || updateAnyEarly.teamId !== undefined) {
        const nextVis = updateAnyEarly.visibility ?? provider.visibility;
        const nextTeamId = updateAnyEarly.teamId !== undefined ? updateAnyEarly.teamId : provider.teamId;
        await this.accessPolicy.assertCanScopeToTeam(userId, organizationId, nextVis, nextTeamId);
      }

      // Update configuration. Keys are split off first: the plaintext
      // never lands on the provider row, it becomes (or rotates) a
      // Credential row. A credentialId in the body points the provider at
      // a shared connection; null clears it.
      const updateAny = updateDto as UpdateLlmProviderDto & { credentialId?: string | null; usageCredentialId?: string | null };
      let pastedKey: string | undefined;
      let pastedUsageKey: string | undefined;
      if (updateDto.configuration) {
        const split = LlmProviderSecretsHelper.splitKeys(updateDto.configuration);
        pastedKey = split.apiKey;
        pastedUsageKey = split.usageApiKey;
        provider.configuration = { ...provider.configuration, ...split.configuration };
      }
      if (updateDto.configuration) {
        await this.assertProviderEgressAllowed(provider.type, provider.configuration, organizationId);
      }
      if (updateDto.configuration || updateAny.credentialId !== undefined) {
        this.runner.validateProviderConfiguration(
          provider.type,
          this.validationView(provider, { apiKey: pastedKey, usageApiKey: pastedUsageKey, credentialId: updateAny.credentialId }),
        );
      }
      if (updateDto.configuration?.model !== undefined) {
        await this.assertModelIsServed(provider.type, provider.configuration, organizationId, {
          apiKey: pastedKey,
          credentialId: updateAny.credentialId === undefined ? provider.credentialId : updateAny.credentialId,
          credential: provider.credential,
        });
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

      // Move the keys: paste -> managed row, credentialId -> shared row,
      // an inline key still on the row (shim) -> managed row. The org's
      // envelope is warmed first so a customer-managed inline value can
      // be read for the move.
      await this.envelopeCrypto.warmOrg(organizationId);
      await this.secrets.applyKey(provider, 'inference', { plaintext: pastedKey, credentialId: updateAny.credentialId });
      await this.secrets.applyKey(provider, 'usage', { plaintext: pastedUsageKey, credentialId: updateAny.usageCredentialId });
      const updatedProvider = await this.llmProviderRepository.save(provider);

      // Perform health check after update, scoped to the same org
      // we just validated membership in.
      setTimeout(
        () => this.performHealthCheck(provider.id, organizationId),
        1000,
      );
      if (updateDto.configuration) {
        this.scheduleCatalogSync(provider.id, organizationId, 'provider_configuration_changed');
      }

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
      throw new NotFoundException('Provider not found');
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

    // The list is a query builder, where eager relations do not apply;
    // join the credential rows so the masked view can name the connection.
    const queryBuilder = this.llmProviderRepository.createQueryBuilder('provider')
      .leftJoinAndSelect('provider.credential', 'credential')
      .leftJoinAndSelect('provider.usageCredential', 'usageCredential');
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

    // Retire the cards while they can still be found by providerId; the
    // FK nulls it on delete. Kept, not deleted: runs reference card ids.
    if (this.catalog) {
      try {
        await this.catalog.retireProviderCards(organizationId, providerId);
      } catch (error: any) {
        this.logger.warn(`Failed to retire catalog cards for provider ${providerId}: ${error.message}`);
      }
    }

    // The key rows this provider created go with it; a shared
    // connection it pointed at stays.
    await this.secrets.release(provider);
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
    let provider: LlmProvider | null = null;
    try {
      provider = await this.llmProviderRepository.findOne({
        where: { id: providerId, organizationId },
      });

      if (!provider) {
        return { isHealthy: false, error: 'Provider not found' };
      }

      // The policy seam and a fresh read of the credential row, before
      // the sync key reads inside the runner.
      await this.secrets.withResolvedSecrets(provider, { context: { purpose: 'health_check', resourceType: 'llm_provider', resourceId: provider.id } });
      const startTime = Date.now();

      // Probe with the provider's configured model, else whatever the
      // vendor currently serves (DefaultModelResolver). Never a literal:
      // a fixed id here marked Mistral, Groq and DeepSeek unhealthy with
      // valid keys, and rotted for Anthropic when the id was retired.
      const healthCheckModel = await this.defaultModels.resolve(provider);

      // Perform a simple health check request
      const testRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
        model: healthCheckModel,
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

      // The probe was a real call with a real model: that is a validation
      // run for the matching card, and a good moment to refresh the list.
      this.recordCatalogValidation(provider, healthCheckModel, { passed: true, latencyMs: responseTime });
      this.scheduleCatalogSync(provider.id, provider.organizationId, 'health_check');
      void this.secrets.recordHealth(provider, true);

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
      // Surface the upstream provider's own error message (e.g.
      // Anthropic's "Your credit balance is too low...") instead of
      // the bare axios transport line. Never persist the health
      // gate's own wording — that would be circular.
      const upstreamMessage = extractUpstreamErrorMessage(error);

      // A retired or mistyped model is a failed validation run for its card.
      const notFound = findModelNotFound(error);
      if (notFound) {
        this.recordCatalogValidation({ id: providerId, organizationId }, notFound.model, { passed: false, error: upstreamMessage });
      }

      // Record a failed health check on the provider row (still
      // org-scoped so we don't touch a foreign provider on errors
      // either). Partial UPDATE for the same race reason.
      if (upstreamMessage !== LLM_HEALTH_GATE_MESSAGE) {
        void this.secrets.recordHealth({ organizationId, credentialId: provider?.credentialId ?? null }, false, upstreamMessage);
        try {
          await this.llmProviderRepository.update(
            { id: providerId, organizationId },
            {
              isHealthy: false,
              lastHealthCheckAt: new Date(),
              lastError: upstreamMessage,
            },
          );
        } catch (updateError: any) {
          this.logger.warn(`Failed to update provider health status: ${updateError.message}`);
        }
      }

      return {
        isHealthy: false,
        // The old shape had `Date.now() - Date.now()` which always
        // resolved to 0 — it was computing the diff against itself.
        // The caller only gets a response time when the request
        // actually started, so leave it undefined on the error path.
        responseTime: undefined,
        error: upstreamMessage,
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
      relations: { provider: true, messages: true },
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

  /**
   * A configured default model must be one the vendor actually serves.
   * Checked against the live list at save time, because a retired or
   * mistyped id otherwise only shows up as a 404 on the first real call.
   * When the vendor cannot list models (unsupported type, listing failed)
   * there is nothing to check against and the save goes through.
   */
  async assertModelIsServed(
    type: LlmProviderType,
    configuration: LlmProviderConfig | undefined,
    organizationId: string,
    /** The key the probe should use: a pasted plaintext, or the credential the provider points at. */
    key: { apiKey?: string; credentialId?: string | null; credential?: Credential | null } = {},
  ): Promise<void> {
    const model = configuration?.model?.trim();
    if (!model) return;
    const probe = Object.assign(new LlmProvider(), { type, configuration: { ...(configuration ?? {}) }, organizationId });
    if (key.apiKey && key.apiKey !== MASKED_PROVIDER_KEY) {
      probe.configuration.apiKey = key.apiKey;
    } else if (key.credentialId) {
      probe.credentialId = key.credentialId;
      if (key.credential && key.credential.id === key.credentialId) {
        probe.credential = key.credential;
      } else {
        await this.secrets.withResolvedSecrets(probe, { context: { purpose: 'model_list', resourceType: 'llm_provider' } });
      }
    }
    let listed: Array<{ id: string }>;
    try {
      listed = await this.modelsHelper.fetchModelsFromProvider(probe);
    } catch (err: any) {
      // A vendor that cannot be listed (no /models, network) leaves nothing
      // to check against; the first real call reports a wrong id instead.
      this.logger.debug(`model list unavailable for ${type}: ${err?.message ?? err}`);
      return;
    }
    if (listed.length === 0) return;
    if (listed.some((m) => m.id === model)) return;
    const sample = listed.slice(0, 5).map((m) => m.id).join(', ');
    throw new BadRequestException({
      code: 'MODEL_NOT_SERVED',
      message:
        `Model "${model}" is not served by this ${type} provider. ` +
        `It may have been retired. Currently available include: ${sample}.`,
    });
  }

  /**
   * What validateProviderConfiguration should see: the configuration
   * with the key present when the provider has one, on the row (shim),
   * pasted in this request, or referenced.
   */
  private validationView(
    provider: LlmProvider,
    incoming: { apiKey?: string; usageApiKey?: string; credentialId?: string | null },
  ): LlmProviderConfig {
    const hasRef = incoming.credentialId === undefined ? !!provider.credentialId : !!incoming.credentialId;
    const apiKey = incoming.apiKey ?? (hasRef || provider.configuration?.apiKey ? MASKED_PROVIDER_KEY : undefined);
    return { ...provider.configuration, apiKey, usageApiKey: incoming.usageApiKey };
  }

  // Catalog hooks. The catalog is optional at construction time (forwardRef,
  // and some specs build this service without it); every hook is
  // fire-and-forget and logs instead of throwing.

  private scheduleCatalogSync(providerId: string, organizationId: string, reason: string): void {
    if (!this.catalog) return;
    void this.catalog.syncInBackground(organizationId, providerId, reason);
  }

  private recordCatalogValidation(
    provider: { id: string; organizationId: string },
    vendorModelId: string | undefined,
    outcome: { passed: boolean; latencyMs?: number; error?: string },
  ): void {
    if (!this.catalog || !vendorModelId) return;
    void this.catalog
      .recordExternalValidation(provider.organizationId, provider.id, vendorModelId, { ...outcome, source: 'health_check' })
      .catch((err) => this.logger.warn(`catalog validation record for ${vendorModelId} failed: ${err?.message ?? err}`));
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
