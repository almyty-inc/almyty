import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Model, ModelCapabilities, ModelPricing, ModelPrivacyTier } from '../../entities/model.entity';
import { ModelVersion } from '../../entities/model-version.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../entities/llm-provider.entity';
import { Conversation } from '../../entities/conversation.entity';
import { MessageRole } from '../../entities/message.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { LlmChatRunnerHelper } from '../llm-providers/llm-chat-runner.helper';
import { LlmModelsHelper } from '../llm-providers/llm-models.helper';
import { PriceFeedService } from './pricing/price-feed.service';
import { ModelRouterService } from './routing/model-router.service';

/** Override as the API accepts it; currency defaults to USD when omitted. */
export type ModelPricingInput = Omit<ModelPricing, 'currency'> & { currency?: string };

function pricingFrom(input: ModelPricingInput | null | undefined): ModelPricing | null {
  if (!input) return null;
  return { inPerMTok: input.inPerMTok, outPerMTok: input.outPerMTok, currency: input.currency ?? 'USD' };
}

export interface RegisterModelInput {

  name: string;
  vendorModelId: string;
  providerId?: string | null;
  endpointRef?: Record<string, any> | null;
  modelVersionId?: string | null;
  capabilities?: ModelCapabilities;
  contextLength?: number | null;
  privacyTier?: ModelPrivacyTier;
  region?: string | null;
  pricingOverride?: ModelPricingInput | null;
  base?: string | null;

  metadata?: Record<string, any> | null;
}

export type UpdateModelInput = Partial<Omit<RegisterModelInput, 'vendorModelId'>> & {
  status?: Model['status'];
};

export interface RegisterEndpointInput {
  name: string;
  /** Base URL of an OpenAI-compatible chat endpoint (the part before /chat/completions). */
  url: string;
  apiKey?: string;
  vendorModelId: string;
  capabilities?: ModelCapabilities;
  contextLength?: number | null;
  privacyTier?: ModelPrivacyTier;
  region?: string | null;
  pricingOverride?: ModelPricingInput | null;
}


export interface ValidationOutcome {
  passed: boolean;
  model: Model;
  latencyMs?: number;
  error?: string;
}

/**
 * The catalog is data: a card exists because someone registered it (by
 * hand, from a provider's list, or from a deployment we made), and it is
 * selectable only once a real call has gone through. There is no code
 * list of supported models anywhere; this service is where "supported"
 * is decided, per org, by evidence.
 */
@Injectable()
export class ModelCatalogService {
  private readonly logger = new Logger(ModelCatalogService.name);

  constructor(
    @InjectRepository(Model) private readonly models: Repository<Model>,
    @InjectRepository(ModelVersion) private readonly versions: Repository<ModelVersion>,
    @InjectRepository(LlmProvider) private readonly providers: Repository<LlmProvider>,
    private readonly router: ModelRouterService,
    @Inject(forwardRef(() => LlmChatRunnerHelper)) private readonly runner: LlmChatRunnerHelper,
    @Inject(forwardRef(() => LlmModelsHelper)) private readonly modelsHelper: LlmModelsHelper,
    @Optional() private readonly priceFeed?: PriceFeedService,
    @Optional() private readonly envelopeCrypto?: EnvelopeCryptoService,
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  list(organizationId: string, filter: { status?: Model['status']; privacyTier?: ModelPrivacyTier; providerId?: string; selectable?: boolean } = {}): Promise<Model[]> {
    const where: Record<string, any> = { organizationId };
    if (filter.status) where.status = filter.status;
    if (filter.privacyTier) where.privacyTier = filter.privacyTier;
    if (filter.providerId) where.providerId = filter.providerId;
    return this.models
      .find({ where, order: { createdAt: 'ASC' } })
      .then((rows) => (filter.selectable ? rows.filter((r) => r.isSelectable()) : rows));
  }

  async get(organizationId: string, id: string): Promise<Model> {
    const card = await this.models.findOne({ where: { id, organizationId } });
    if (!card) throw new NotFoundException('Model not found');
    return card;
  }

  async register(organizationId: string, input: RegisterModelInput, userId?: string): Promise<Model> {
    if (!input.providerId && !input.endpointRef?.url) {
      throw new BadRequestException({ code: 'MODEL_NOT_CALLABLE', message: 'A model needs a providerId or an endpointRef.url to be called through' });
    }
    let providerType: string | null = null;
    if (input.providerId) {
      const provider = await this.providers.findOne({ where: { id: input.providerId, organizationId } });
      if (!provider) throw new NotFoundException('LLM provider not found');
      providerType = provider.type;
    } else {
      providerType = input.endpointRef?.providerType ?? LlmProviderType.CUSTOM;
    }
    if (input.modelVersionId) {
      const version = await this.versions.findOne({ where: { id: input.modelVersionId, organizationId } });
      if (!version) throw new NotFoundException('Model version not found');
    }
    const duplicate = await this.models.findOne({
      where: input.providerId
        ? { organizationId, providerId: input.providerId, vendorModelId: input.vendorModelId }
        : { organizationId, name: input.name },
    });
    if (duplicate) {
      throw new BadRequestException({ code: 'MODEL_EXISTS', message: `A card for ${input.vendorModelId} already exists (${duplicate.id})` });
    }

    const card = this.models.create({
      organizationId,
      name: input.name,
      vendorModelId: input.vendorModelId,
      providerId: input.providerId ?? null,
      providerType,
      endpointRef: input.endpointRef ?? null,
      modelVersionId: input.modelVersionId ?? null,
      base: input.base ?? null,
      capabilities: input.capabilities ?? {},
      contextLength: input.contextLength ?? null,
      privacyTier: input.privacyTier ?? (input.providerId ? 'public' : 'private_cloud'),
      region: input.region ?? null,
      pricingOverride: pricingFrom(input.pricingOverride),
      pricingSource: input.pricingOverride ? 'manual' : 'unpriced',

      status: 'active',
      validationStatus: 'never',
      metadata: input.metadata ?? null,
    });
    this.applyFeedPrice(card);
    const saved = await this.models.save(card);
    this.audit(saved, AuditAction.MODEL_REGISTERED, userId, { providerId: saved.providerId, endpoint: Boolean(saved.endpointRef?.url) });
    return saved;
  }

  /**
   * A hand-registered OpenAI-compatible endpoint: the URL and key become a
   * custom LLM provider row (encrypted like any other), the card points at
   * it. Selectable after one passing validation run, like every card.
   */
  async registerEndpoint(organizationId: string, input: RegisterEndpointInput, userId?: string): Promise<Model> {
    const configuration: Record<string, any> = { baseUrl: input.url, model: input.vendorModelId };
    if (input.apiKey) configuration.apiKey = input.apiKey;
    this.runner.validateProviderConfiguration(LlmProviderType.CUSTOM, configuration);
    const provider = this.providers.create({
      organizationId,
      name: input.name,
      type: LlmProviderType.CUSTOM,
      configuration,
      capabilities: this.modelsHelper.getDefaultCapabilities(LlmProviderType.CUSTOM),
      status: LlmProviderStatus.ACTIVE,
      isHealthy: true,
      metadata: { endpoint: input.url },
    });

    if (this.envelopeCrypto) await provider.encryptSensitiveDataForOrg(this.envelopeCrypto);
    else provider.encryptSensitiveData();
    const savedProvider = await this.providers.save(provider);
    return this.register(
      organizationId,
      {
        name: input.name,
        vendorModelId: input.vendorModelId,
        providerId: savedProvider.id,
        capabilities: input.capabilities,
        contextLength: input.contextLength,
        privacyTier: input.privacyTier ?? 'private_cloud',
        region: input.region,
        pricingOverride: input.pricingOverride,
      },
      userId,
    );
  }

  /** Import the models a stored provider currently lists as unvalidated cards. Existing cards are left alone. */
  async syncFromProvider(organizationId: string, providerId: string, userId?: string): Promise<{ created: Model[]; skipped: number }> {
    const provider = await this.providers.findOne({ where: { id: providerId, organizationId } });
    if (!provider) throw new NotFoundException('LLM provider not found');
    const listed = await this.modelsHelper.fetchModelsFromProvider(provider);
    const existing = await this.models.find({ where: { organizationId, providerId } });
    const known = new Set(existing.map((m) => m.vendorModelId));
    const created: Model[] = [];
    let skipped = 0;
    for (const m of listed) {
      if (known.has(m.id)) { skipped++; continue; }
      const card = this.models.create({
        organizationId,
        name: m.name || m.id,
        vendorModelId: m.id,
        providerId,
        providerType: provider.type,
        capabilities: {},
        privacyTier: provider.type === LlmProviderType.OLLAMA ? 'local' : 'public',
        pricingSource: 'unpriced',
        status: 'active',
        validationStatus: 'never',
        metadata: { syncedFrom: 'provider_list', ownedBy: m.owned_by ?? null },
      });
      this.applyFeedPrice(card);
      created.push(await this.models.save(card));
    }
    if (created.length) this.audit(created[0], AuditAction.MODEL_REGISTERED, userId, { providerId, count: created.length, source: 'provider_list' });
    return { created, skipped };
  }

  async update(organizationId: string, id: string, input: UpdateModelInput, userId?: string): Promise<Model> {
    const card = await this.get(organizationId, id);
    const before = { privacyTier: card.privacyTier, region: card.region, status: card.status, pricingOverride: card.pricingOverride };
    if (input.name !== undefined) card.name = input.name;
    if (input.capabilities !== undefined) card.capabilities = input.capabilities ?? {};
    if (input.contextLength !== undefined) card.contextLength = input.contextLength;
    if (input.privacyTier !== undefined && input.privacyTier) card.privacyTier = input.privacyTier;
    if (input.region !== undefined) card.region = input.region;
    if (input.status !== undefined) card.status = input.status;
    if (input.metadata !== undefined) card.metadata = input.metadata;
    if (input.base !== undefined) card.base = input.base;
    if (input.modelVersionId !== undefined) {
      if (input.modelVersionId) {
        const version = await this.versions.findOne({ where: { id: input.modelVersionId, organizationId } });
        if (!version) throw new NotFoundException('Model version not found');
      }
      card.modelVersionId = input.modelVersionId;
    }
    if (input.pricingOverride !== undefined) {
      card.pricingOverride = pricingFrom(input.pricingOverride);

      if (input.pricingOverride) card.pricingSource = 'manual';
      else if (card.pricing) card.pricingSource = (card.metadata?.pricingFeedSource as Model['pricingSource']) ?? card.pricingSource;
      else card.pricingSource = 'unpriced';
      this.audit(card, AuditAction.MODEL_PRICE_UPDATED, userId, { override: input.pricingOverride });
    }
    const saved = await this.models.save(card);
    this.audit(saved, AuditAction.UPDATE, userId, { before, after: { privacyTier: saved.privacyTier, region: saved.region, status: saved.status, pricingOverride: saved.pricingOverride } });
    return saved;
  }

  async remove(organizationId: string, id: string, userId?: string): Promise<void> {
    const card = await this.get(organizationId, id);
    await this.models.remove(card);
    this.audit(Object.assign(card, { id }), AuditAction.DELETE, userId, {});
  }

  /**
   * The gate to selectability: one real, short chat call through the card's
   * provider with its vendor model id. Passing flips validationStatus; a
   * failure records why. Nothing else marks a card validated.
   */
  async validate(organizationId: string, id: string, userId?: string): Promise<ValidationOutcome> {
    const card = await this.get(organizationId, id);
    const provider = await this.router.providerFor(card);
    if (!provider) {
      return this.recordValidation(card, false, 'Card has no callable provider', userId);
    }
    const session = Conversation.createConversation({
      providerId: provider.id.startsWith('endpoint:') ? undefined : provider.id,
      organizationId,
      title: `Validate ${card.name}`,
    });
    const started = Date.now();
    try {
      const response = await this.runner.callWithRetries(
        provider,
        { messages: [{ role: MessageRole.USER, content: 'Reply with the single word: ready' }], model: card.vendorModelId, maxTokens: 8, temperature: 0 },
        session,
        [],
      );
      const latencyMs = Date.now() - started;
      if (typeof response.usage?.inputTokens === 'number') {
        card.measuredLatencyMs = { p50: latencyMs, p95: latencyMs, updatedAt: new Date().toISOString() };
      }
      return this.recordValidation(card, true, undefined, userId, latencyMs);
    } catch (error: any) {
      const message = error?.message ?? String(error);
      return this.recordValidation(card, false, message.slice(0, 1000), userId, Date.now() - started);
    }
  }

  private async recordValidation(card: Model, passed: boolean, error: string | undefined, userId?: string, latencyMs?: number): Promise<ValidationOutcome> {
    card.validationStatus = passed ? 'passed' : 'failed';
    card.lastValidatedAt = new Date();
    card.lastValidationError = passed ? null : (error ?? 'unknown');
    if (!passed && card.status === 'active') card.status = 'error';
    if (passed && card.status === 'error') card.status = 'active';
    const saved = await this.models.save(card);
    this.audit(saved, AuditAction.MODEL_VALIDATED, userId, { passed, error: saved.lastValidationError, latencyMs });
    return { passed, model: saved, latencyMs, error: saved.lastValidationError ?? undefined };
  }

  /** Feed price at registration time; the daily job keeps it fresh afterwards. */
  private applyFeedPrice(card: Model): void {
    if (card.pricingOverride || !this.priceFeed || !card.providerType) return;
    const quote = this.priceFeed.lookup(card.providerType, card.vendorModelId);
    if (!quote) return;
    card.pricing = { inPerMTok: quote.inPerMTok, outPerMTok: quote.outPerMTok, currency: quote.currency ?? 'USD' };
    card.pricingSource = quote.source;
    card.pricingFetchedAt = new Date();
    if (!card.contextLength && quote.contextLength) card.contextLength = quote.contextLength;

    card.metadata = { ...(card.metadata ?? {}), pricingFeedSource: quote.source };
  }

  private audit(card: Model, action: AuditAction, userId: string | undefined, details: Record<string, any>): void {
    if (!this.auditLog) return;
    void this.auditLog
      .log({ organizationId: card.organizationId, userId, action, resourceType: AuditResource.MODEL, resourceId: card.id, resourceName: card.name, details })
      .catch((err) => this.logger.warn(`catalog audit failed: ${err?.message ?? err}`));
  }
}
