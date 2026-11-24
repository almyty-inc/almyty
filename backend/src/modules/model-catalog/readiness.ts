import { LlmProvider, keyCheckPassed } from '../../entities/llm-provider.entity';
import type { Model } from '../../entities/model.entity';
import { withNoCreditsReason } from '../llm-providers/model-errors';

/**
 * Whether a provider's key check has passed, which is what makes its
 * models usable (docs/models.md, "Readiness").
 *
 * The rule lives on the entity (keyCheckPassed) because the provider API
 * sends it as `keyChecked`, which is what the Models page shows as "Key
 * works": the page and the catalog read one rule, not two.
 */
export function providerChecked(provider: Pick<LlmProvider, 'status' | 'isHealthy' | 'lastHealthCheckAt'>): boolean {
  return keyCheckPassed(provider);
}

/** Why a provider's checked models were taken back out: its key was refused, or its account has no credits. */
export type WithdrawnReason = 'key_rejected' | 'no_credits';

/**
 * Take a card the provider check made usable back to waiting, with the
 * reason. Only a card the provider check passed (`checkedBy:
 * provider_check`) is touched: a card that failed on its own keeps its
 * failure. Returns whether the card changed; the caller saves it. The
 * next passing provider check restores it (applyProviderCheck).
 */
export function withdrawCheckedCard(card: Model, reason: WithdrawnReason, error: string, now: Date): boolean {
  if (card.validationStatus !== 'passed' || card.metadata?.checkedBy !== 'provider_check') return false;
  card.validationStatus = 'never';
  card.lastValidatedAt = now;
  card.lastValidationError = error.slice(0, 1000);
  card.metadata = { ...(card.metadata ?? {}), unavailableReason: reason };
  return true;
}
/** What a card withdrawn for an account out of credits says: the plain reason first, then the vendor's words. */
export function noCreditsError(vendorWords?: string): string {
  return withNoCreditsReason(vendorWords);
}