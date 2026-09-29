import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Inject, forwardRef } from '@nestjs/common';
import { LlmProvider, LlmProviderType, LlmProviderStatus, LlmProviderConfig } from '../../entities/llm-provider.entity';
import { decideEgress, hostMatches } from '../connections/egress-policy';
import { llmCallOptionsFor } from './providers/safe-request';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditResource } from '../../entities/audit-log.entity';
import { Conversation, ConversationStatus } from '../../entities/conversation.entity';
import { Message, MessageRole } from '../../entities/message.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool } from '../../entities/tool.entity';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { LlmChatHelper } from './llm-chat.helper';
import { LlmStatsHelper } from './llm-stats.helper';
import { LlmChatRunnerHelper } from './llm-chat-runner.helper';
import { LlmModelsHelper } from './llm-models.helper';
import { DefaultModelResolver } from './default-model.resolver';
import { findModelNotFound, isKeyRejection } from './model-errors';
import { getProviderDisplayName, getProviderKeyUrl } from './llm-provider-catalog';
import type { Model } from '../../entities/model.entity';
import { ModelCatalogService } from '../model-catalog/model-catalog.service';

import { AccessPolicyService, normaliseVisibility } from '../../common/authorization/access-policy.service';
import { assertManageable } from '../../common/authorization/read-rule';
import { ProviderNotUsableError, providerUsableByUser } from './private-provider';
import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';
import { providerListsModels } from './provider-profile';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { Credential } from '../../entities/credential.entity';
import { LlmProviderSecretsHelper, MASKED_PROVIDER_KEY } from './llm-provider-secrets.helper';

import { StreamChunk, CreateLlmProviderDto, UpdateLlmProviderDto, ChatRequest, ChatResponse, LlmProviderSearchFilters, ConnectProviderInput } from './dto/llm-providers.dto';
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
    userId: string,
    /** checkInRequest: the caller runs the key check and the sync itself (connect). */
    options: { checkInRequest?: boolean } = {},
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
      // Validate team scoping before persisting.
      await this.accessPolicy.assertCanScopeToTeam(
        userId,
        organizationId,
        createDto.visibility,
        createDto.teamId,
      );
      const scope = normaliseVisibility(createDto.visibility, createDto.teamId);
      // Before anything reads the key (the model probe below does): a
      // private connection only backs a provider private to its owner, a
      // team connection a provider of its team.
      await this.secrets.assertKeysServable(
        {
          organizationId,
          visibility: scope.visibility,
          teamId: scope.teamId,
          ownerUserId: userId,
          credentialId: createAny.credentialId ?? null,
          usageCredentialId: createAny.usageCredentialId ?? null,
        },
        userId,
      );

      await this.assertProviderEgressAllowed(createDto.type, configuration as LlmProviderConfig, organizationId);
      await this.assertModelIsServed(createDto.type, configuration, organizationId, { apiKey, credentialId: createAny.credentialId, principal: { id: userId } });

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
        visibility: scope.visibility,
        teamId: scope.teamId,
        // Always record who made it: a private provider needs its owner,
        // and one flipped to private later keeps its creator.
        ownerUserId: userId,
      });

      // Save first so the key rows can name the provider they belong to;
      // a failure to store the key removes the half-made provider again.
      const savedProvider = await this.llmProviderRepository.save(provider);
      try {
        await this.secrets.applyKey(savedProvider, 'inference', { plaintext: apiKey, credentialId: createAny.credentialId ?? undefined });
        await this.secrets.applyKey(savedProvider, 'usage', { plaintext: usageApiKey, credentialId: createAny.usageCredentialId ?? undefined });
        // A pasted key becomes a row this provider manages; it takes the
        // provider's scope, so a private provider's key is private too.
        await this.secrets.syncManagedScope(savedProvider);
      } catch (error) {
        try { await this.llmProviderRepository.remove(savedProvider); } catch { /* best effort */ }
        throw error;
      }
      const withKeys = await this.llmProviderRepository.save(savedProvider);

      // Perform initial health check. Pass the org we just created
      // under so the scoped lookup inside performHealthCheck finds
      // the row. Connect runs the check itself, in the request.
      if (!options.checkInRequest) {
        setTimeout(
          () => this.performHealthCheck(withKeys.id, organizationId),
          1000,
        );
        this.scheduleCatalogSync(withKeys.id, organizationId, 'provider_created');
      }

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
   * Connect a provider in one request: save it, check the key with a real
   * call, and list its models. Every model it lists is usable at once,
   * because the key check passed (the readiness rule, docs/models.md).
   *
   * A check that fails leaves nothing behind: the provider and the key
   * row it made are removed, and the caller gets one plain sentence
   * ("OpenAI rejected this key.") with the vendor's own words beside it.
   * Keeping a provider whose key does not work would put a dead entry in
   * every model list and leave its cleanup to the person who just failed.
   */
  async connectProvider(
    input: ConnectProviderInput,
    organizationId: string,
    userId: string,
  ): Promise<{ provider: LlmProvider; models: Model[]; check: { ok: true; responseTime?: number } }> {
    const displayName = getProviderDisplayName(input.type);
    // Nothing to find the models in, so the one to use has to be named.
    // Said before anything is saved or called, in the words the form shows.
    if (!providerListsModels(input.type) && !input.configuration?.model?.trim()) {
      throw new BadRequestException({
        code: 'MODEL_REQUIRED',
        message: `${displayName} does not list its models. Enter the model you want to use.`,
      });
    }
    const provider = await this.createProvider(
      {
        name: input.name?.trim() || displayName,
        type: input.type,
        configuration: input.configuration ?? {},
        visibility: input.visibility,
        teamId: input.teamId,
        credentialId: input.credentialId ?? undefined,
      } as CreateLlmProviderDto,
      organizationId,
      userId,
      { checkInRequest: true },
    );

    const check = await this.performHealthCheck(provider.id, organizationId);
    if (!check.isHealthy) {
      await this.discardUncheckedProvider(provider, organizationId, userId);
      throw new BadRequestException({
        code: check.keyRejected ? 'KEY_REJECTED' : 'CHECK_FAILED',
        message: check.keyRejected ? `${displayName} rejected this key.` : `Could not connect to ${displayName}.`,
        detail: check.error,
        keyUrl: getProviderKeyUrl(input.type) || undefined,
      });
    }

    let models: Model[] = [];
    if (this.catalog) {
      try {
        models = await this.catalog.syncAndListProvider(organizationId, provider.id);
      } catch (error: any) {
        // The key works (a real call just passed); a vendor whose list
        // could not be read this once is read again by the periodic sweep.
        // What is known already (the model the check called) still shows.
        this.logger.warn(`Model list for provider ${provider.id} failed after a passing check: ${error?.message ?? error}`);
        models = await this.catalog.list(organizationId, { providerId: provider.id });
      }
    }
    const fresh = (await this.llmProviderRepository.findOne({ where: { id: provider.id, organizationId } })) ?? provider;
    return { provider: fresh, models, check: { ok: true, responseTime: check.responseTime } };
  }

  /** Undo a connect whose check failed: the provider, and the key row it made (a shared connection stays). */
  private async discardUncheckedProvider(provider: LlmProvider, organizationId: string, userId: string): Promise<void> {
    try {
      await this.secrets.release(provider);
      await this.llmProviderRepository.remove(provider);
      this.auditLogService.logDelete(organizationId, userId, AuditResource.LLM_PROVIDER, provider.id, provider.name);
    } catch (error: any) {
      this.logger.error(`Failed to remove provider ${provider.id} after a failed check: ${error?.message ?? error}`);
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
    // Never from the request body. The stamp is what lets a name past DNS
    // pinning at connect, so accepting it as input would let anyone grant
    // themselves the thing this gate exists to decide.
    delete (configuration as any).egressApprovedHost;

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

    // Record the host whenever the organization has vouched for it, not
    // only when the string gate needed the allowlist to say yes. A NAME
    // passes that gate on its own — it is not knowably private until it
    // resolves — so keying the stamp off the refusal would never fire for
    // the case the stamp exists to serve.
    let host: string | undefined;
    try {
      host = new URL(url).hostname;
    } catch {
      host = undefined;
    }
    const allowlist = organization?.settings?.egressAllowlist ?? [];
    if (host && allowlist.some((pattern) => hostMatches(host as string, pattern))) {
      configuration.egressApprovedHost = host;
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

      // A provider the caller may not read (another member's private one,
      // a team's they are not on) does not exist for them: 404. Can read it
      // but not manage it: 403.
      await assertManageable(this.accessPolicy, userId, provider, 'Provider');

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
      // A newly referenced connection, or a change of the provider's scope,
      // is checked against the scope the provider is about to have, before
      // the model probe below reads the key or anything is written.
      const scopeChanging = updateDto.visibility !== undefined || updateDto.teamId !== undefined;
      if (updateAny.credentialId || updateAny.usageCredentialId || scopeChanging) {
        const next = normaliseVisibility(
          updateDto.visibility ?? provider.visibility,
          updateDto.teamId !== undefined ? updateDto.teamId : provider.teamId,
        );
        await this.secrets.assertKeysServable(
          {
            id: provider.id,
            organizationId,
            visibility: next.visibility as LlmProvider['visibility'],
            teamId: next.teamId,
            ownerUserId: provider.ownerUserId ?? userId,
            credentialId: updateAny.credentialId || (scopeChanging && updateAny.credentialId === undefined ? provider.credentialId : null),
            usageCredentialId: updateAny.usageCredentialId || (scopeChanging && updateAny.usageCredentialId === undefined ? provider.usageCredentialId : null),
          },
          userId,
        );
      }
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
          principal: { id: userId },
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

      // Scope (visibility + teamId) from the dashboard VisibilityField.
      // 'org' and 'private' carry no teamId.
      if (updateDto.visibility !== undefined || updateDto.teamId !== undefined) {
        const scope = normaliseVisibility(
          updateDto.visibility ?? provider.visibility,
          updateDto.teamId !== undefined ? updateDto.teamId : provider.teamId,
        );
        provider.visibility = scope.visibility;
        provider.teamId = scope.teamId;
      }
      if (provider.visibility === 'private') {
        // Only the recorded owner can make a provider private; a row made
        // before owners were recorded becomes the caller's.
        if (!provider.ownerUserId) {
          provider.ownerUserId = userId;
        } else if (provider.ownerUserId !== userId) {
          throw new ForbiddenException('Only the provider\'s owner can make it private');
        }
      }

      // Move the keys: paste -> managed row, credentialId -> shared row,
      // an inline key still on the row (shim) -> managed row. The org's
      // envelope is warmed first so a customer-managed inline value can
      // be read for the move.
      await this.envelopeCrypto.warmOrg(organizationId);
      await this.secrets.applyKey(provider, 'inference', { plaintext: pastedKey, credentialId: updateAny.credentialId });
      await this.secrets.applyKey(provider, 'usage', { plaintext: pastedUsageKey, credentialId: updateAny.usageCredentialId });
      // A private connection only backs a provider private to its owner,
      // and the key rows the provider manages take the provider's scope.
      await this.secrets.assertKeysServable(provider, userId);
      await this.secrets.syncManagedScope(provider);
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

  /**
   * Load a provider of the organization. `caller` is who is asking, or who
   * a run acts as -- the run's ExecutionPrincipal, so a gateway run is
   * judged by its gateway's scope: another user's private provider, and a
   * team provider outside the caller's team (or the gateway's team), are
   * reported exactly like a missing one (ProviderNotUsableError, a 404
   * naming the caller). Pass null for a path with no known user -- only
   * organization-wide providers are then found. Omit it only on internal
   * paths that act on a row already authorized upstream.
   */
  async getProvider(
    providerId: string,
    organizationId: string,
    includeSecrets = false,
    caller?: { id: string } | ExecutionPrincipal | null,
  ): Promise<LlmProvider> {
    const provider = await this.llmProviderRepository.findOne({
      where: { id: providerId, organizationId },
    });

    if (caller !== undefined) {
      // On someone's behalf, missing and not theirs to use are one answer.
      if (!provider || !(await providerUsableByUser(this.accessPolicy, provider, caller))) {
        throw new ProviderNotUsableError(caller);
      }
    } else if (!provider) {
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
      // A system listing acts for nobody, so it never sees a private provider.
      queryBuilder.where('provider.organizationId = :_orgId', { _orgId: filters.organizationId });
      queryBuilder.andWhere("provider.visibility <> 'private'");
    } else if (filters.caller) {
      await this.accessPolicy.applyListFilter(queryBuilder, filters.caller, filters.organizationId, 'provider', { ownerColumn: 'ownerUserId' });
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
    const provider = await this.getProvider(providerId, organizationId, false, { id: userId });

    // A provider the caller may not read (another member's private one, a
    // team's they are not on) is not found, not forbidden. Can read it but
    // not manage it: 403.
    await assertManageable(this.accessPolicy, userId, provider, 'Provider');

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
    /** syncModels: false when the caller lists the models itself next (the boot and on-load catalog sync). */
    options: { syncModels?: boolean } = {},
  ): Promise<{
    isHealthy: boolean;
    responseTime?: number;
    error?: string;
    details?: Record<string, any>;
    /** The vendor refused the key (401/403 or its wording), as opposed to an outage. */
    keyRejected?: boolean;
    /** The model the check called (configured, or the vendor's current default). */
    probedModel?: string;
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

      // The probe was a real call with a real model and this key: every
      // model the provider lists becomes usable (the readiness rule), the
      // probed one records its latency, and the list is refreshed.
      await this.applyCatalogCheck(provider, { passed: true });
      // Awaited: a vendor with no model list (Vertex AI, Qwen, Ark) serves
      // this model and nothing else anyone can see, and connect lists next.
      await this.recordCatalogValidation(provider, healthCheckModel, { passed: true, latencyMs: responseTime });
      if (options.syncModels !== false) this.scheduleCatalogSync(provider.id, provider.organizationId, 'health_check');
      void this.secrets.recordHealth(provider, true);

      return {
        isHealthy: true,
        responseTime,
        probedModel: healthCheckModel,
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
              // Dated, so the page shows the failed check as current and
              // not as the history of some earlier call.
              lastErrorAt: new Date(),
            },
          );
        } catch (updateError: any) {
          this.logger.warn(`Failed to update provider health status: ${updateError.message}`);
        }
      }

      // A key the vendor refuses takes every model of this provider out
      // of the list until a check passes again. Other failures (outage,
      // timeout) leave the models alone; the router skips the provider.
      const keyRejected = !notFound && isKeyRejection(error);
      if (keyRejected && provider) {
        await this.applyCatalogCheck(provider, { passed: false, keyRejected: true, error: upstreamMessage });
      }

      return {
        isHealthy: false,
        // The old shape had `Date.now() - Date.now()` which always
        // resolved to 0 — it was computing the diff against itself.
        // The caller only gets a response time when the request
        // actually started, so leave it undefined on the error path.
        responseTime: undefined,
        error: upstreamMessage,
        keyRejected,
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
  calculateProviderCost(provider: LlmProvider, inputTokens: number, outputTokens: number, requestedModel?: string) {
    return this.modelsHelper.calculateProviderCost(provider, inputTokens, outputTokens, requestedModel);
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
    key: { apiKey?: string; credentialId?: string | null; credential?: Credential | null; principal?: { id: string } } = {},
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
        await this.secrets.withResolvedSecrets(probe, { principal: key.principal, context: { purpose: 'model_list', resourceType: 'llm_provider' } });
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

  /** The readiness rule's writer (see ModelCatalogService.applyProviderCheck). Awaited, never throws. */
  private async applyCatalogCheck(
    provider: { id: string; organizationId: string },
    outcome: { passed: boolean; keyRejected?: boolean; error?: string },
  ): Promise<void> {
    if (!this.catalog) return;
    try {
      await this.catalog.applyProviderCheck(provider.organizationId, provider.id, outcome);
    } catch (err: any) {
      this.logger.warn(`catalog readiness update for provider ${provider.id} failed: ${err?.message ?? err}`);
    }
  }

  private scheduleCatalogSync(providerId: string, organizationId: string, reason: string): void {
    if (!this.catalog) return;
    void this.catalog.syncInBackground(organizationId, providerId, reason);
  }

  /**
   * Record what a check learned about the model it called. Awaitable, so a
   * caller that lists the provider's models next (connect) sees the card;
   * never rejects.
   */
  private async recordCatalogValidation(
    provider: { id: string; organizationId: string },
    vendorModelId: string | undefined,
    outcome: { passed: boolean; latencyMs?: number; error?: string },
  ): Promise<void> {
    if (!this.catalog || !vendorModelId) return;
    try {
      await this.catalog.recordExternalValidation(provider.organizationId, provider.id, vendorModelId, { ...outcome, source: 'health_check' });
    } catch (err: any) {
      this.logger.warn(`catalog validation record for ${vendorModelId} failed: ${err?.message ?? err}`);
    }
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
