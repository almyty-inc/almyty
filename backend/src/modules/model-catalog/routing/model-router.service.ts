import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Model } from '../../../entities/model.entity';
import { ModelDeployment } from '../../../entities/model-deployment.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../../entities/llm-provider.entity';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { RouteCandidate, RoutingPolicy, selectCandidates } from './model-router';

/** Weight of a new sample in the p50 average. */
const LATENCY_P50_ALPHA = 0.2;
/** How fast p95 follows a faster sample (a slower one is taken at once). */
const LATENCY_P95_DECAY = 0.1;
/** At most one latency write per card per minute. */
const LATENCY_WRITE_INTERVAL_MS = 60_000;
/** In-memory state is pruned past this many cards, dropping those idle for an hour. */
const LATENCY_STATE_CAP = 5000;
const LATENCY_STATE_TTL_MS = 3_600_000;

interface LatencyState {
  p50: number;
  p95: number;
  lastWriteAt: number;
}
/** What a run records about the card that answered, and the ones it walked past. */
export interface RouteAttribution {
  modelId: string;
  modelVersionId: string | null;
  vendorModelId: string;
  providerId: string | null;
  rationale: string;
  /** 1-based position of the answering candidate in the plan. */
  attempt: number;
  /** Candidates tried before this one, with why each was skipped. */
  tried: Array<{ modelId: string; reason: string }>;
  /** Cards the policy filtered out before any call was made. */
  rejected: Array<{ modelId: string; reason: string }>;
}

export interface ResolvedCandidate extends RouteCandidate {
  card: Model;
  /** A stored provider row (secrets included) or a transient one built from the card's endpoint. */
  provider: LlmProvider;
}

export interface RoutePlan {
  candidates: ResolvedCandidate[];
  rejected: Array<{ modelId: string; reason: string }>;
}

/** The same blended figure the cheapest objective ranks on, or null when unpriced. */
function blendedPrice(card: Model): number | null {
  const p = card.effectivePricing();
  if (!p) return null;
  return p.inPerMTok * 0.75 + p.outPerMTok * 0.25;
}

export class NoRouteError extends Error {
  readonly code = 'NO_ROUTE';
  constructor(readonly rejected: Array<{ modelId: string; reason: string }>) {
    super(
      rejected.length === 0
        ? 'No models are registered for this organization'
        : `No registered model satisfies the routing policy (${rejected.length} rejected)`,
    );
    this.name = 'NoRouteError';
  }
}

/**
 * Turns an org's catalog plus a policy into an ordered list of callable
 * providers. Selection itself is pure (model-router.ts); this service adds
 * the data access, provider resolution and the audit trail.
 */
@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name);
  /** Per card id: the running latency estimate and when it last reached the database. */
  private readonly latency = new Map<string, LatencyState>();

  constructor(
    @InjectRepository(Model) private readonly models: Repository<Model>,
    @InjectRepository(LlmProvider) private readonly providers: Repository<LlmProvider>,
    @InjectRepository(ModelDeployment) private readonly deployments: Repository<ModelDeployment>,
    @Optional() private readonly auditLog?: AuditLogService,
    @Optional() private readonly credentialRefs?: CredentialRefResolver,
  ) {}

  async plan(organizationId: string, policy: RoutingPolicy = {}, principal?: { id: string }): Promise<RoutePlan> {
    const cards = await this.models.find({ where: { organizationId }, order: { createdAt: 'ASC' } });
    const { candidates, rejected } = selectCandidates(cards, policy);
    const resolved: ResolvedCandidate[] = [];
    for (const c of candidates) {
      const card = cards.find((k) => k.id === c.modelId)!;
      const provider = await this.providerFor(card, principal);
      if (!provider) {
        rejected.push({ modelId: card.id, reason: 'no callable provider' });
        continue;
      }
      if (!provider.isHealthy || provider.status !== LlmProviderStatus.ACTIVE) {
        rejected.push({ modelId: card.id, reason: `provider ${provider.name} is ${provider.isHealthy ? provider.status : 'unhealthy'}` });
        continue;
      }
      resolved.push({ ...c, card, provider });
    }
    return { candidates: resolved, rejected };
  }
  /**
   * The same plan, shaped for a human and carrying no secrets.
   *
   * `plan()` returns resolved providers because the runner needs them to
   * make a call. A preview must never hand a provider row to an HTTP
   * response: those carry credentials. This returns only what a person
   * needs to understand the decision, which is also all the policy editor
   * renders.
   */
  async preview(
    organizationId: string,
    policy: RoutingPolicy = {},
    principal?: { id: string },
  ): Promise<{
    candidates: Array<{ modelId: string; name: string; vendorModelId: string; providerType: string | null; rationale: string; blendedPricePerMTok: number | null; privacyTier: string; region: string | null }>;
    rejected: Array<{ modelId: string; reason: string }>;
  }> {
    const plan = await this.plan(organizationId, policy, principal);
    return {
      candidates: plan.candidates.map((c) => ({
        modelId: c.modelId,
        name: c.card.name,
        vendorModelId: c.vendorModelId,
        providerType: c.card.providerType ?? null,
        rationale: c.rationale,
        blendedPricePerMTok: blendedPrice(c.card),
        privacyTier: c.card.privacyTier,
        region: c.card.region ?? null,
      })),
      rejected: plan.rejected,
    };
  }

  /**
   * The stored provider a card is called through. Endpoint-backed cards
   * carry one too (written when the deployment reached ready, or when the
   * endpoint was registered), so there is no transient provider: a card
   * without a usable row is simply not a candidate. Failing closed is
   * deliberate, an endpoint whose credential no longer resolves must not
   * be called unauthenticated.
   */
  async providerFor(card: Model, principal?: { id: string }): Promise<LlmProvider | null> {
    if (!card.providerId) return null;
    const provider = await this.providers.findOne({ where: { id: card.providerId, organizationId: card.organizationId } });
    if (!provider) return null;
    if (this.credentialRefs && provider.credentialId) {
      // The row references a connection: it must still resolve for this
      // caller, or the candidate drops out of the plan.
      const resolved = await this.credentialRefs.tryResolve(provider.organizationId, provider.credentialId, {
        principal,
        context: { purpose: 'llm_call', resourceType: 'model', resourceId: card.id },
      });
      if (!resolved) return null;
      provider.credential = resolved.credential;
    }
    return provider;
  }

  /**
   * Learn latency from real traffic. p50 is an exponential moving average
   * of response times; p95 jumps to a slower sample at once and decays
   * toward faster ones slowly. State lives in memory per card, seeded
   * from the stored value after a restart, and is written to the card at
   * most once a minute. Never rejects; a failed write is logged.
   */
  async recordLatency(card: Pick<Model, 'id' | 'measuredLatencyMs'>, responseTimeMs: number, now = Date.now()): Promise<void> {
    if (!Number.isFinite(responseTimeMs) || responseTimeMs <= 0) return;
    let state = this.latency.get(card.id);
    if (!state) {
      const seed = card.measuredLatencyMs;
      const seeded = !!seed && Number.isFinite(seed.p50);
      state = seeded
        ? { p50: seed!.p50, p95: Number.isFinite(seed!.p95) ? seed!.p95 : seed!.p50, lastWriteAt: 0 }
        : { p50: responseTimeMs, p95: responseTimeMs, lastWriteAt: 0 };
      this.latency.set(card.id, state);
      if (!seeded) return this.flushLatency(card, state, now);
    }
    state.p50 += (responseTimeMs - state.p50) * LATENCY_P50_ALPHA;
    state.p95 = responseTimeMs >= state.p95 ? responseTimeMs : state.p95 + (responseTimeMs - state.p95) * LATENCY_P95_DECAY;
    if (now - state.lastWriteAt < LATENCY_WRITE_INTERVAL_MS) return;
    return this.flushLatency(card, state, now);
  }

  private async flushLatency(card: Pick<Model, 'id' | 'measuredLatencyMs'>, state: LatencyState, now: number): Promise<void> {
    state.lastWriteAt = now;
    if (this.latency.size > LATENCY_STATE_CAP) {
      for (const [id, s] of this.latency) if (now - s.lastWriteAt > LATENCY_STATE_TTL_MS) this.latency.delete(id);
    }
    const measuredLatencyMs = { p50: Math.round(state.p50), p95: Math.round(state.p95), updatedAt: new Date(now).toISOString() };
    card.measuredLatencyMs = measuredLatencyMs;
    try {
      await this.models.update({ id: card.id }, { measuredLatencyMs });
    } catch (err: any) {
      this.logger.warn(`latency write for card ${card.id} failed: ${err?.message ?? err}`);
    }
  }

  /** Fire-and-forget audit row: which card answered and why. */
  recordRoute(organizationId: string, attribution: RouteAttribution, context?: { userId?: string; conversationId?: string }): void {
    if (!this.auditLog) return;
    void this.auditLog
      .log({
        organizationId,
        userId: context?.userId,
        action: AuditAction.MODEL_ROUTED,
        resourceType: AuditResource.MODEL,
        resourceId: attribution.modelId,
        resourceName: attribution.vendorModelId,
        details: {
          modelVersionId: attribution.modelVersionId,
          providerId: attribution.providerId,
          rationale: attribution.rationale,
          attempt: attribution.attempt,
          tried: attribution.tried,
          rejected: attribution.rejected.length,
          conversationId: context?.conversationId,
        },
      })
      .catch((err) => this.logger.warn(`route audit failed: ${err?.message ?? err}`));
  }
}
