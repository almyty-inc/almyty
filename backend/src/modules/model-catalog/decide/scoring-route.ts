import { Model } from '../../../entities/model.entity';
import { LlmProviderType } from '../../../entities/llm-provider-type';
import {
  ScoringBinding,
  preferredBinding,
  providerProfile,
} from '../../llm-providers/provider-profile';

/**
 * Deciding whether a card can score, and where the scoring call goes.
 *
 * `decide`'s logits path needs a provider that will score a continuation
 * the caller supplies, rather than one that will write its own. Almost
 * nothing does. This file is where that is established, once, for the
 * whole mode, and it refuses rather than degrades.
 *
 * WHY IT REFUSES INSTEAD OF FALLING BACK
 *
 * The contract has a ladder: native, then logits, then a constrained path
 * that makes the model emit schema-shaped JSON and say a number in words.
 * The ladder is right for a caller who asked for an answer and does not
 * care how it was obtained. It is wrong for a caller who pinned the logits
 * path, because a verbalized number and a scored one are the same shape,
 * the same field and the same range, and nothing in the response tells
 * them apart except `execution_path` — which a caller who trusted the pin
 * has no reason to be reading. So a pinned path that cannot be served is a
 * refusal that names the provider, and the name is in it because "cannot
 * score" is otherwise the least actionable error a platform can emit: the
 * operator's next question is always which of their providers to go fix.
 *
 * WHY THERE IS NO LIST OF PROVIDERS IN THIS FILE
 *
 * Because it would be wrong for at least one card whichever way it was
 * written. The same provider type fronts a hosted API that cannot score
 * and a serving engine on the customer's own hardware that can, and the
 * difference is the base URL rather than the vendor. So the fact lives on
 * the card, where the rest of what a card can do already lives, and it is
 * put there by a validation run rather than by a developer's belief about
 * a vendor's documentation.
 *
 * See docs/models.md, "Support is data, not a list".
 */

export type ScoringRefusalCode =
  | 'CARD_NOT_VALIDATED_FOR_SCORING'
  | 'NO_SCORING_ROUTE'
  | 'NO_BASE_URL';

/**
 * A card cannot serve the logits path.
 *
 * Always names the provider, and says which of the two halves is missing:
 * a card that never proved it can score is an operator action (run the
 * validation), a surface with no scoring route is a fact about the vendor
 * (use a different one).
 */
export class ScoringUnavailableError extends Error {
  constructor(
    message: string,
    readonly code: ScoringRefusalCode,
    readonly providerType: string,
    readonly modelId: string,
  ) {
    super(message);
    this.name = 'ScoringUnavailableError';
  }
}

/** Where a scoring call goes, once both halves have been resolved. */
export interface ResolvedScoringRoute {
  protocol: ScoringBinding['protocol'];
  /** Absolute URL of the scoring endpoint. */
  url: string;
  /** The id to send on the wire. */
  vendorModelId: string;
}

/** What this resolver needs from a provider row, and nothing more. */
export interface ScoringProviderLike {
  type: LlmProviderType | string;
  getApiUrl?: () => string | null | undefined;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * The scoring route a card declares for itself.
 *
 * This is the half that carries real weight today. A card pointed at a
 * serving engine the customer runs is registered with its own base URL,
 * and the scoring route is recorded beside it at registration, because
 * whether that particular box exposes a scoring endpoint is a fact about
 * the box and nobody else can know it.
 */
function cardScoringBinding(card: Model): ScoringBinding | null {
  const declared = (card.endpointRef as Record<string, any> | null)?.scoring;
  if (declared && typeof declared.protocol === 'string' && typeof declared.path === 'string') {
    return { protocol: declared.protocol, path: declared.path };
  }
  return null;
}

/**
 * Resolve where this card's scoring call goes, or refuse naming the
 * provider.
 *
 * The two halves are checked in the order an operator would want to hear
 * about them. A card that has not passed a scoring validation run is
 * refused first even when the surface would support it, because a route
 * that has never been exercised is a belief rather than a capability, and
 * the support rule this platform runs on says a passed run is what turns
 * one into the other.
 */
export function resolveScoringRoute(
  provider: ScoringProviderLike,
  card: Model,
): ResolvedScoringRoute {
  const providerType = String(provider.type);

  if (card.capabilities?.scoring !== true) {
    throw new ScoringUnavailableError(
      `Provider ${providerType} cannot score for model "${card.vendorModelId}": ` +
        `the card has no passed scoring validation run. Run one, or route to a card that has.`,
      'CARD_NOT_VALIDATED_FOR_SCORING',
      providerType,
      card.id,
    );
  }

  // The card's own declaration wins. A profile says what a vendor's
  // surface does in general; a card says what the endpoint behind this
  // particular row actually is, and for a box the customer runs that is
  // the only one of the two that can be right.
  const profile = providerProfile(provider.type as LlmProviderType);
  const profileBinding =
    profile && profile.protocols.length > 0 ? preferredBinding(profile).scoring ?? null : null;
  const binding = cardScoringBinding(card) ?? profileBinding;

  if (!binding) {
    throw new ScoringUnavailableError(
      `Provider ${providerType} declares no scoring route for model "${card.vendorModelId}": ` +
        `its surface serves chat completions only, which reports the logprobs of tokens the ` +
        `model chose and cannot score one it did not.`,
      'NO_SCORING_ROUTE',
      providerType,
      card.id,
    );
  }

  const base =
    (card.endpointRef as Record<string, any> | null)?.url ?? provider.getApiUrl?.() ?? null;

  if (!base) {
    throw new ScoringUnavailableError(
      `Provider ${providerType} has no base URL to score model "${card.vendorModelId}" against.`,
      'NO_BASE_URL',
      providerType,
      card.id,
    );
  }

  return {
    protocol: binding.protocol,
    url: joinUrl(base, binding.path),
    vendorModelId: card.vendorModelId,
  };
}

/**
 * Whether this card can serve the logits path, without throwing.
 *
 * The ladder uses this to step down to the constrained path; a pinned
 * request uses `resolveScoringRoute` so the refusal carries its reason.
 */
export function canScore(provider: ScoringProviderLike, card: Model): boolean {
  try {
    resolveScoringRoute(provider, card);
    return true;
  } catch {
    return false;
  }
}
