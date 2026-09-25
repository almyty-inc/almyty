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
import { isUniqueViolation } from '../../common/utils/unique-violation';
import { providerUsableBy } from '../llm-providers/private-provider';
import { providerChecked } from './readiness';
import { isKeyRejection } from '../llm-providers/model-errors';

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
 * The catalog is data: a card exists because a connected provider lists
 * the model (or someone registered it by hand, or a model started on the
 * customer's cloud made one), and it is selectable once a real call has
 * gone through: for a provider's models, the provider's key check; for an
 * endpoint with no provider, a check of its own. There is no code list of
 * supported models anywhere; this service is where "supported" is decided,
 * per org, by evidence.
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
  ) {}

  /**
   * The org's cards. With `viewerId` (a person asking; null for nobody),
   * cards served by another user's private provider are left out: the
   * provider is not theirs to see, and neither is what it serves.
   */
  async list(
    organizationId: string,
    filter: { status?: Model['status']; privacyTier?: ModelPrivacyTier; providerId?: string; selectable?: boolean } = {},
    viewerId?: string | null,
  ): Promise<Model[]> {
    const where: Record<string, any> = { organizationId };
    if (filter.status) where.status = filter.status;
    if (filter.privacyTier) where.privacyTier = filter.privacyTier;
    if (filter.providerId) where.providerId = filter.providerId;
    const rows = await this.models.find({ where, order: { createdAt: 'ASC' } });
    const hidden = viewerId === undefined ? new Set<string>() : await this.hiddenProviderIds(organizationId, viewerId);
    return rows
      .filter((r) => !r.providerId || !hidden.has(r.providerId))
      .filter((r) => (filter.selectable ? r.isSelectable() : true));
  }

  async get(organizationId: string, id: string, viewerId?: string | null): Promise<Model> {
    const card = await this.models.findOne({ where: { id, organizationId } });
    if (!card) throw new NotFoundException('Model not found');
    if (viewerId !== undefined && card.providerId && (await this.hiddenProviderIds(organizationId, viewerId)).has(card.providerId)) {
      throw new NotFoundException('Model not found');
    }
    return card;
  }

  /** Ids of the org's private providers that `viewerId` may not see. */
  private async hiddenProviderIds(organizationId: string, viewerId: string | null): Promise<Set<string>> {
    const rows = await this.providers.find({
      where: { organizationId, visibility: 'private' },
      select: { id: true, visibility: true, ownerUserId: true },
    });
    return new Set(rows.filter((p) => !providerUsableBy(p, viewerId)).map((p) => p.id));
  }

  async register(organizationId: string, input: RegisterModelInput, userId?: string): Promise<Model> {
    if (!input.providerId && !input.endpointRef?.url) {
      throw new BadRequestException({ code: 'MODEL_NOT_CALLABLE', message: 'A model needs a providerId or an endpointRef.url to be called through' });
    }
    let providerType: string | null = null;
    let checkedProvider = false;
    if (input.providerId) {
      const provider = await this.providers.findOne({ where: { id: input.providerId, organizationId } });
      if (!provider) throw new NotFoundException('Provider not found');
      providerType = provider.type;
      checkedProvider = providerChecked(provider);
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
      throw new BadRequestException({ code: 'MODEL_EXISTS', message: `A model for ${input.vendorModelId} already exists (${duplicate.id})` });
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
      // Usable at once when its provider's key check has passed: the
      // readiness rule is the provider's, not a step per model. A card
      // for an endpoint (no provider) waits for its own check.
      validationStatus: checkedProvider ? 'passed' : 'never',
      lastValidatedAt: checkedProvider ? new Date() : null,
      metadata: checkedProvider ? { ...(input.metadata ?? {}), checkedBy: 'provider_check' } : input.metadata ?? null,
    });
    this.applyFeedPrice(card);
    let saved: Model;
    try {
      saved = await this.models.save(card);
    } catch (err: any) {
      // The duplicate check above is a read; a second POST for the same
      // card can land between it and this insert. The unique indexes
      // (models_org_provider_vendor_uq for a provider-backed card,
      // models_org_name_endpoint_uq for an endpoint-only one) catch it,
      // and the caller gets the same MODEL_EXISTS it would have got had
      // its read seen the other row.
      if (!isUniqueViolation(err)) throw err;
      throw new BadRequestException({
        code: 'MODEL_EXISTS',
        message: `A model for ${input.vendorModelId} already exists`,
      });
    }
    this.audit(saved, AuditAction.MODEL_REGISTERED, userId, { providerId: saved.providerId, endpoint: Boolean(saved.endpointRef?.url) });
    return saved;
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
    // A person asking (userId given) is told another user's private
    // provider does not exist; lifecycle syncs run with no user.
    if (!provider || (userId && !providerUsableBy(provider, userId))) throw new NotFoundException('Provider not found');
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
      try {
        created.push(await this.models.save(card));
      } catch (err: any) {
        // Another sync inserted this card between our snapshot and this
        // write -- the user pressing "Sync models" while the background
        // sweep covers the same provider is the common case, and the
        // in-process dedup guard does not span the two call sites (or
        // two pods). The row exists, which is all we wanted.
        if (!isUniqueViolation(err)) throw err;
        skipped++;
      }
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
    // A key check that finished while this sync was listing only marked
    // the cards that existed then; the ones just created missed it.
    if (created.some((c) => c.validationStatus === 'never')) {
      const now = await this.providers.findOne({ where: { id: providerId, organizationId } });
      if (now && providerChecked(now)) await this.applyProviderCheck(organizationId, providerId, { passed: true });
    }
    return { created, skipped, retired, reinstated };
  }

  /** Every active provider of the org, one after the other. A provider that fails to list is reported in the summary, not thrown. */
  async syncAll(organizationId: string, userId?: string): Promise<CatalogSyncSummary> {
    const providers = await this.providers.find({ where: { organizationId, status: LlmProviderStatus.ACTIVE }, order: { createdAt: 'ASC' } });
    const summary: CatalogSyncSummary = { created: [], skipped: 0, retired: [], reinstated: [], providers: [] };
    for (const provider of providers) {
      // A person syncing the org's catalog never reaches another user's
      // private provider (its key is not theirs to spend).
      if (userId && !providerUsableBy(provider, userId)) continue;
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
   * The periodic sweep (CatalogSyncProcessor, MODEL_CATALOG_SYNC_CRON):
   * every active provider of every organization lists its models again,
   * so a model a vendor adds appears and one it retires is marked
   * unavailable without anyone opening a page. Listing costs nothing at
   * the vendor, unlike the health check's chat call, which is why this and
   * not that runs by default. A listing the vendor refuses for the key
   * takes that provider's models out of the lists, the same as a failed
   * key check would; any other failure is logged and left for next time.
   */
  async syncEveryProvider(): Promise<{ providers: number; synced: number; failed: number; keyRejected: number }> {
    const providers = await this.providers.find({ where: { status: LlmProviderStatus.ACTIVE }, order: { createdAt: 'ASC' } });
    const result = { providers: providers.length, synced: 0, failed: 0, keyRejected: 0 };
    for (const provider of providers) {
      try {
        await this.syncFromProvider(provider.organizationId, provider.id);
        this.syncedAt.set(provider.id, Date.now());
        result.synced++;
      } catch (error: any) {
        result.failed++;
        if (isKeyRejection(error)) {
          result.keyRejected++;
          await this.applyProviderCheck(provider.organizationId, provider.id, {
            passed: false,
            keyRejected: true,
            error: String(error?.message ?? error).slice(0, 500),
          });
        }
        this.logger.warn(`scheduled catalog sync for provider ${provider.id} failed: ${error?.message ?? error}`);
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

  /**
   * A card for a vendor model as the provider lists it, priced from the
   * feed. It is usable at once when the provider's key check has passed
   * (see providerChecked); otherwise it waits for that check.
   */
  private newProviderCard(provider: LlmProvider, listed: { id: string; name?: string }, metadata: Record<string, any>): Model {
    const checked = providerChecked(provider);
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
      validationStatus: checked ? 'passed' : 'never',
      lastValidatedAt: checked ? provider.lastHealthCheckAt ?? new Date() : null,
      metadata: checked ? { ...metadata, checkedBy: 'provider_check' } : metadata,
    });
    this.applyFeedPrice(card);
    return card;
  }

  /**
   * The readiness rule. A provider's models become usable when the
   * provider's key check passes, all of them at once: the check is a real
   * call with that key, and the list the models came from is the vendor's
   * own statement that it serves them. There is no per-model step.
   *
   * Passed: every card of this provider still waiting on the check is
   * marked checked. A card that failed on its own (the vendor answered
   * MODEL_NOT_FOUND for it) keeps its failure; a retired card stays
   * retired, since `status` is what takes it out.
   *
   * Key rejected: the provider's checked cards go back to waiting, with
   * the reason, so nothing served by a key the vendor refuses is offered.
   * Any other failure (an outage, a timeout) changes nothing here: the
   * router already skips an unhealthy provider, and a blip must not make
   * every model look unavailable.
   */
  async applyProviderCheck(
    organizationId: string,
    providerId: string,
    outcome: { passed: boolean; keyRejected?: boolean; error?: string },
  ): Promise<number> {
    if (!outcome.passed && !outcome.keyRejected) return 0;
    const cards = await this.models.find({ where: { organizationId, providerId } });
    const now = new Date();
    const changed: Model[] = [];
    for (const card of cards) {
      if (outcome.passed && card.validationStatus === 'never') {
        card.validationStatus = 'passed';
        card.lastValidatedAt = now;
        card.lastValidationError = null;
        card.metadata = { ...(card.metadata ?? {}), checkedBy: 'provider_check' };
      } else if (!outcome.passed && card.validationStatus === 'passed' && card.metadata?.checkedBy === 'provider_check') {
        card.validationStatus = 'never';
        card.lastValidatedAt = now;
        card.lastValidationError = (outcome.error ?? 'The provider rejected its key').slice(0, 1000);
      } else {
        continue;
      }
      changed.push(await this.models.save(card));
    }
    if (changed.length) {
      this.audit(changed[0], AuditAction.MODEL_VALIDATED, undefined, {
        providerId,
        passed: outcome.passed,
        count: changed.length,
        source: 'provider_check',
        ...(outcome.passed ? {} : { error: outcome.error }),
      });
    }
    return changed.length;
  }

  /**
   * Connect-time sync: import what the provider lists and hand back its
   * cards, for the page that just checked the key to show. Unlike the
   * lifecycle hook this waits and throws, because the person is looking.
   */
  async syncAndListProvider(organizationId: string, providerId: string): Promise<Model[]> {
    const inFlight = this.syncInFlight.get(providerId);
    if (inFlight) await inFlight;
    await this.syncFromProvider(organizationId, providerId);
    this.syncedAt.set(providerId, Date.now());
    return this.models.find({ where: { organizationId, providerId }, order: { createdAt: 'ASC' } });
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
   * failure records why. Nothing else marks a card validated. `source`
   * says in the audit row who asked, when it was not a person.
   */
  async validate(organizationId: string, id: string, userId?: string, source?: string): Promise<ValidationOutcome> {
    const card = await this.get(organizationId, id);
    const provider = await this.router.providerFor(card);
    if (!provider) {
      return this.recordValidation(card, false, 'This model has no callable provider', userId, undefined, source);
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
      return this.recordValidation(card, true, undefined, userId, latencyMs, source);
    } catch (error: any) {
      const message = error?.message ?? String(error);
      return this.recordValidation(card, false, message.slice(0, 1000), userId, Date.now() - started, source);
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
