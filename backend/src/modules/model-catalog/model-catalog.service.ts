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
import { EndpointProviderHelper } from '../llm-providers/endpoint-provider.helper';
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


export interface ProviderSyncResult {
  created: Model[];
  skipped: number;
  /** Cards whose vendor id the provider no longer lists; kept, marked inactive. */
  retired: Model[];
  /** Cards an earlier sync had retired that the provider lists again. */
  reinstated: Model[];
}

export interface CatalogSyncSummary extends ProviderSyncResult {
  providers: Array<{ providerId: string; name: string; created: number; skipped: number; retired: number; reinstated: number; error?: string }>;
}

/** What an outside caller (the provider health check) learned from a real call. */
export interface ExternalValidationInput {
  passed: boolean;
  latencyMs?: number;
  error?: string;
  /** Where the call came from, kept on the audit row (e.g. `health_check`). */
  source?: string;
}

/** A provider synced this recently is not synced again by a lifecycle hook. */
const SYNC_COOLDOWN_MS = 30_000;

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
  /** Per provider id: the sync currently running, and when the last one finished (see syncInBackground). */
  private readonly syncInFlight = new Map<string, Promise<ProviderSyncResult | null>>();
  private readonly syncedAt = new Map<string, number>();

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
    @Optional() @Inject(forwardRef(() => EndpointProviderHelper)) private readonly endpointProviders?: EndpointProviderHelper,
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
    if (!this.endpointProviders) {
      throw new BadRequestException({ code: 'ENDPOINT_REGISTRATION_UNAVAILABLE', message: 'Endpoint registration is not available in this deployment' });
    }
    // A registered endpoint is a real provider row on the OpenAI-compatible
    // path (chat at <base>/chat/completions), and its key lives in the
    // credential store like every other provider's, never inline.
    const provider = await this.endpointProviders.upsert({
      organizationId,
      name: input.name,
      apiUrl: input.url,
      model: input.vendorModelId,
      apiKey: input.apiKey,
      managedById: `endpoint:${organizationId}:${input.name}`,
      region: input.region,
    });
    return this.register(
      organizationId,
      {
        name: input.name,
        vendorModelId: input.vendorModelId,
        providerId: provider.id,
        capabilities: input.capabilities,
        contextLength: input.contextLength,
        privacyTier: input.privacyTier ?? 'private_cloud',
        region: input.region,
        pricingOverride: input.pricingOverride,
        metadata: { endpoint: input.url },
      },
      userId,
    );
  }

  /**
   * Import the models a stored provider currently lists as unvalidated
   * cards. Cards already present are left alone, with one exception: a
   * card whose vendor id has vanished from the list goes inactive with
   * metadata.retiredAt (never deleted: runs, audit rows and nodeResults
   * point at card ids), and comes back the next time the provider lists
   * it. An empty list means the vendor could not be asked (unsupported
   * type, listing failed), so nothing is retired from it.
   */
  async syncFromProvider(organizationId: string, providerId: string, userId?: string): Promise<ProviderSyncResult> {
    const provider = await this.providers.findOne({ where: { id: providerId, organizationId } });
    if (!provider) throw new NotFoundException('LLM provider not found');
    const listed = await this.modelsHelper.fetchModelsFromProvider(provider);
    const existing = await this.models.find({ where: { organizationId, providerId } });
    const byVendorId = new Map(existing.map((m) => [m.vendorModelId, m]));
    const now = new Date().toISOString();
    const created: Model[] = [];
    const reinstated: Model[] = [];
    let skipped = 0;
    for (const m of listed) {
      const known = byVendorId.get(m.id);
      if (known) {
        if (known.status === 'inactive' && known.metadata?.retiredAt) {
          const { retiredAt, retiredReason, ...rest } = known.metadata;
          known.status = 'active';
          known.metadata = { ...rest, reinstatedAt: now, previouslyRetiredAt: retiredAt };
          reinstated.push(await this.models.save(known));
        } else {
          skipped++;
        }
        continue;
      }
      const card = this.newProviderCard(provider, m, { syncedFrom: 'provider_list', ownedBy: m.owned_by ?? null });
      created.push(await this.models.save(card));
    }
    const retired: Model[] = [];
    if (listed.length > 0) {
      const listedIds = new Set(listed.map((m) => m.id));
      for (const card of existing) {
        if (card.status === 'inactive' || listedIds.has(card.vendorModelId)) continue;
        card.status = 'inactive';
        card.metadata = { ...(card.metadata ?? {}), retiredAt: now, retiredReason: 'not listed by provider' };
        retired.push(await this.models.save(card));
      }
    }
    if (created.length) this.audit(created[0], AuditAction.MODEL_REGISTERED, userId, { providerId, count: created.length, source: 'provider_list' });
    if (retired.length) this.audit(retired[0], AuditAction.UPDATE, userId, { providerId, retired: retired.map((c) => c.vendorModelId), reason: 'not listed by provider' });
    if (reinstated.length) this.audit(reinstated[0], AuditAction.UPDATE, userId, { providerId, reinstated: reinstated.map((c) => c.vendorModelId) });
    return { created, skipped, retired, reinstated };
  }

  /** Every active provider of the org, one after the other. A provider that fails to list is reported in the summary, not thrown. */
  async syncAll(organizationId: string, userId?: string): Promise<CatalogSyncSummary> {
    const providers = await this.providers.find({ where: { organizationId, status: LlmProviderStatus.ACTIVE }, order: { createdAt: 'ASC' } });
    const summary: CatalogSyncSummary = { created: [], skipped: 0, retired: [], reinstated: [], providers: [] };
    for (const provider of providers) {
      try {
        const r = await this.syncFromProvider(organizationId, provider.id, userId);
        summary.created.push(...r.created);
        summary.retired.push(...r.retired);
        summary.reinstated.push(...r.reinstated);
        summary.skipped += r.skipped;
        summary.providers.push({ providerId: provider.id, name: provider.name, created: r.created.length, skipped: r.skipped, retired: r.retired.length, reinstated: r.reinstated.length });
      } catch (error: any) {
        summary.providers.push({ providerId: provider.id, name: provider.name, created: 0, skipped: 0, retired: 0, reinstated: 0, error: String(error?.message ?? error).slice(0, 500) });
      }
    }
    return summary;
  }

  /**
   * Provider lifecycle hook (created, configuration changed, health check
   * passed): sync without holding up the request. A burst on one provider
   * (create, then its health check a second later) collapses into one
   * listing call: an in-flight sync is shared, and a sync that finished
   * within the cooldown is not repeated. Never rejects; failures are logged.
   */
  syncInBackground(organizationId: string, providerId: string, reason: string, cooldownMs = SYNC_COOLDOWN_MS): Promise<ProviderSyncResult | null> {
    const inFlight = this.syncInFlight.get(providerId);
    if (inFlight) return inFlight;
    const last = this.syncedAt.get(providerId);
    if (last != null && Date.now() - last < cooldownMs) return Promise.resolve(null);
    const run = this.syncFromProvider(organizationId, providerId)
      .then((r) => {
        if (r.created.length || r.retired.length || r.reinstated.length) {
          this.logger.log(`catalog sync (${reason}) for provider ${providerId}: ${r.created.length} created, ${r.retired.length} retired, ${r.reinstated.length} reinstated`);
        }
        return r;
      })
      .catch((err) => {
        this.logger.warn(`catalog sync (${reason}) for provider ${providerId} failed: ${err?.message ?? err}`);
        return null;
      })
      .finally(() => {
        this.syncInFlight.delete(providerId);
        this.syncedAt.set(providerId, Date.now());
      });
    this.syncInFlight.set(providerId, run);
    return run;
  }

  /**
   * One-shot on boot (see CatalogSyncProcessor): every active provider
   * that has no cards yet gets its list imported, so an org set up before
   * the catalog existed can route without anyone syncing by hand.
   * Idempotent, so replicas racing on it do no harm.
   */
  async backfill(): Promise<{ providers: number; synced: number; created: number; failed: number }> {
    const providers = await this.providers.find({ where: { status: LlmProviderStatus.ACTIVE } });
    const result = { providers: providers.length, synced: 0, created: 0, failed: 0 };
    for (const provider of providers) {
      const any = await this.models.findOne({ where: { organizationId: provider.organizationId, providerId: provider.id } });
      if (any) continue;
      try {
        const r = await this.syncFromProvider(provider.organizationId, provider.id);
        result.synced++;
        result.created += r.created.length;
      } catch (error: any) {
        result.failed++;
        this.logger.warn(`catalog backfill for provider ${provider.id} failed: ${error?.message ?? error}`);
      }
    }
    return result;
  }

  /**
   * A real call made elsewhere (the provider health check) is a validation
   * run for the card it went through, so the catalog records it the same
   * way. Passing creates the card when the org has none for that vendor
   * id yet and brings back a card this service had retired; a failure
   * only marks an existing card, since there is nothing else to mark.
   */
  async recordExternalValidation(organizationId: string, providerId: string, vendorModelId: string, outcome: ExternalValidationInput): Promise<Model | null> {
    let card = await this.models.findOne({ where: { organizationId, providerId, vendorModelId } });
    if (!card) {
      if (!outcome.passed) return null;
      const provider = await this.providers.findOne({ where: { id: providerId, organizationId } });
      if (!provider) return null;
      card = this.newProviderCard(provider, { id: vendorModelId, name: vendorModelId }, { syncedFrom: outcome.source ?? 'external_validation' });
    }
    if (outcome.passed && card.status === 'inactive' && card.metadata?.retiredAt) {
      const { retiredAt, retiredReason, ...rest } = card.metadata;
      card.status = 'active';
      card.metadata = { ...rest, reinstatedAt: new Date().toISOString(), previouslyRetiredAt: retiredAt };
    }
    if (outcome.passed && typeof outcome.latencyMs === 'number' && outcome.latencyMs >= 0) {
      card.measuredLatencyMs = { p50: outcome.latencyMs, p95: outcome.latencyMs, updatedAt: new Date().toISOString() };
    }
    const result = await this.recordValidation(card, outcome.passed, outcome.error, undefined, outcome.latencyMs, outcome.source);
    return result.model;
  }

  /**
   * The provider is going away. Its cards go inactive rather than away:
   * runs, audit rows and nodeResults reference card ids, and the FK nulls
   * providerId on delete, so what is left is an honest record of what
   * served past calls and never a selectable route (no provider, no
   * endpoint). Must run before the provider row is removed, while the
   * cards can still be found by providerId.
   */
  async retireProviderCards(organizationId: string, providerId: string, reason = 'provider deleted'): Promise<number> {
    const cards = await this.models.find({ where: { organizationId, providerId } });
    let retired = 0;
    for (const card of cards) {
      if (card.status === 'inactive') continue;
      card.status = 'inactive';
      card.metadata = { ...(card.metadata ?? {}), retiredAt: new Date().toISOString(), retiredReason: reason };
      await this.models.save(card);
      retired++;
    }
    if (retired) this.audit(cards[0], AuditAction.UPDATE, undefined, { providerId, retired, reason });
    return retired;
  }

  /** A card for a vendor model as the provider lists it: unvalidated, priced from the feed. */
  private newProviderCard(provider: LlmProvider, listed: { id: string; name?: string }, metadata: Record<string, any>): Model {
    const card = this.models.create({
      organizationId: provider.organizationId,
      name: listed.name || listed.id,
      vendorModelId: listed.id,
      providerId: provider.id,
      providerType: provider.type,
      capabilities: {},
      privacyTier: provider.type === LlmProviderType.OLLAMA ? 'local' : 'public',
      pricingSource: 'unpriced',
      status: 'active',
      validationStatus: 'never',
      metadata,
    });
    this.applyFeedPrice(card);
    return card;
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

  private async recordValidation(card: Model, passed: boolean, error: string | undefined, userId?: string, latencyMs?: number, source?: string): Promise<ValidationOutcome> {
    card.validationStatus = passed ? 'passed' : 'failed';
    card.lastValidatedAt = new Date();
    card.lastValidationError = passed ? null : (error ?? 'unknown');
    if (!passed && card.status === 'active') card.status = 'error';
    if (passed && card.status === 'error') card.status = 'active';
    const saved = await this.models.save(card);
    this.audit(saved, AuditAction.MODEL_VALIDATED, userId, { passed, error: saved.lastValidationError, latencyMs, ...(source ? { source } : {}) });
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
