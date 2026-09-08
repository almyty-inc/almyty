import type { Model, ModelCapabilities, ModelPrivacyTier } from '../../../entities/model.entity';

/**
 * Router tier 1: choose which cards may answer a request, in order.
 *
 * Pure: takes the org's cards and a policy, returns an ordered list with
 * a rationale per entry. No learned routing, no embeddings, no calls out.
 * The caller (the chat runner) walks the list and moves on when a
 * candidate fails in a way that is not the request's fault.
 */

export type RouteObjective = 'cheapest' | 'fastest' | 'pinned';

export interface VerifyEscalationPolicy {
  /** Re-run with the next candidate in the plan, or keep the rejected answer and stop. */
  onVerifyFail: 'next-candidate' | 'stop';
  /** Upper bound on re-runs per request; absent means walk the rest of the plan. */
  maxEscalations?: number;
}

export interface RoutingPolicy {
  /** Most public tier the request may use. local < private_cloud < public. */
  privacyTier?: ModelPrivacyTier;
  /** Regions allowed; empty or absent means any. */
  regions?: string[];
  /** Capabilities the request needs; each true flag must be present on the card. */
  capabilities?: Partial<ModelCapabilities>;
  objective?: RouteObjective;
  /** Explicit order of card ids or vendor model ids; wins over the objective. */
  fallbackChain?: string[];
  /** For objective 'pinned': the card (or vendor model id) that must come first. */
  pinnedModel?: string;
  /** Cents the caller may still spend this period; cards priced above it per million are skipped. */
  budgetHeadroomCents?: number | null;
  /**
   * Tier 2: what to do when a verifier rejects an answer this plan produced.
   * Only honoured when MODEL_ROUTER_VERIFY_ESCALATION is on (see verify-escalation.ts).
   */
  escalation?: VerifyEscalationPolicy;
  /**
   * Candidates at the head of the plan already tried by an earlier attempt of
   * the same request (set by verify escalation); the plan starts after them.
   */
  skipCandidates?: number;
}

export interface RouteCandidate {
  modelId: string;
  providerId: string | null;
  vendorModelId: string;
  modelVersionId: string | null;
  rationale: string;
}

const TIER_RANK: Record<ModelPrivacyTier, number> = { local: 0, private_cloud: 1, public: 2 };

function priceScore(card: Model): number | null {
  const p = card.effectivePricing();
  if (!p) return null;
  // Rough blended cost per million assuming replies are about a third of the prompt.
  return p.inPerMTok * 0.75 + p.outPerMTok * 0.25;
}

function matches(card: Model, key: string): boolean {
  return card.id === key || card.vendorModelId === key;
}

/** The hard filters: a card either qualifies for this request or it does not. */
export function eligible(card: Model, policy: RoutingPolicy): { ok: true } | { ok: false; reason: string } {
  if (!card.isSelectable()) return { ok: false, reason: 'not selectable' };
  if (policy.privacyTier && TIER_RANK[card.privacyTier] > TIER_RANK[policy.privacyTier]) {
    return { ok: false, reason: `privacy tier ${card.privacyTier} above ceiling ${policy.privacyTier}` };
  }
  if (policy.regions && policy.regions.length > 0 && card.region && !policy.regions.includes(card.region)) {
    return { ok: false, reason: `region ${card.region} not allowed` };
  }
  for (const [cap, needed] of Object.entries(policy.capabilities ?? {})) {
    if (needed && !(card.capabilities as any)?.[cap]) return { ok: false, reason: `lacks ${cap}` };
  }
  if (policy.budgetHeadroomCents != null) {
    const score = priceScore(card);
    // A million tokens at this price must fit in what is left; unpriced cards are allowed (flagged elsewhere).
    if (score != null && score * 100 > policy.budgetHeadroomCents) return { ok: false, reason: 'over budget headroom' };
  }
  return { ok: true };
}

export function selectCandidates(cards: Model[], policy: RoutingPolicy = {}): { candidates: RouteCandidate[]; rejected: Array<{ modelId: string; reason: string }> } {
  const rejected: Array<{ modelId: string; reason: string }> = [];
  const pool = cards.filter((c) => {
    const e = eligible(c, policy);
    if (e.ok === false) rejected.push({ modelId: c.id, reason: e.reason });
    return e.ok;

  });

  const toCandidate = (card: Model, rationale: string): RouteCandidate => ({
    modelId: card.id,
    providerId: card.providerId,
    vendorModelId: card.vendorModelId,
    modelVersionId: card.modelVersionId,
    rationale,
  });

  if (policy.fallbackChain && policy.fallbackChain.length > 0) {
    const ordered: RouteCandidate[] = [];
    policy.fallbackChain.forEach((key, i) => {
      const card = pool.find((c) => matches(c, key));
      if (card) ordered.push(toCandidate(card, `fallback chain position ${i + 1}`));
      else rejected.push({ modelId: key, reason: 'chain entry not eligible or unknown' });
    });
    return applySkip(ordered, rejected, policy);
  }

  const objective: RouteObjective = policy.objective ?? 'cheapest';
  let ranked: Model[];
  if (objective === 'fastest') {
    ranked = [...pool].sort((a, b) => (a.measuredLatencyMs?.p50 ?? Number.POSITIVE_INFINITY) - (b.measuredLatencyMs?.p50 ?? Number.POSITIVE_INFINITY));
  } else {
    ranked = [...pool].sort((a, b) => (priceScore(a) ?? Number.POSITIVE_INFINITY) - (priceScore(b) ?? Number.POSITIVE_INFINITY));
  }
  if (objective === 'pinned' && policy.pinnedModel) {
    const pinned = ranked.find((c) => matches(c, policy.pinnedModel!));
    if (pinned) ranked = [pinned, ...ranked.filter((c) => c !== pinned)];
  }

  const candidates = ranked.map((card, i) => {
    const price = priceScore(card);
    const why =
      objective === 'pinned' && i === 0 && policy.pinnedModel && matches(card, policy.pinnedModel)
        ? 'pinned'
        : objective === 'fastest'
          ? `fastest (p50 ${card.measuredLatencyMs?.p50 ?? 'unknown'} ms), rank ${i + 1}`
          : `cheapest (${price == null ? 'unpriced' : `$${price.toFixed(2)}/M blended`}), rank ${i + 1}`;
    return toCandidate(card, why);
  });
  return applySkip(candidates, rejected, policy);
}

/**
 * Tier 2 escalation re-issues a request with the candidates an earlier
 * attempt already answered from skipped. They stay visible in `rejected`
 * so the audit row explains why the plan did not start at the top.
 */
function applySkip(candidates: RouteCandidate[], rejected: Array<{ modelId: string; reason: string }>, policy: RoutingPolicy) {
  const skip = Math.max(0, Math.floor(policy.skipCandidates ?? 0));
  if (skip === 0) return { candidates, rejected };
  for (const c of candidates.slice(0, skip)) rejected.push({ modelId: c.modelId, reason: 'skipped after verify escalation' });
  return { candidates: candidates.slice(skip), rejected };
}
