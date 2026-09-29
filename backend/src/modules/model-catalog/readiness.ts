import { LlmProvider, keyCheckPassed } from '../../entities/llm-provider.entity';

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
