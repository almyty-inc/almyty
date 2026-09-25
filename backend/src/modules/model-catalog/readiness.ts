import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';

/**
 * Whether a provider's key check has passed, which is what makes its
 * models usable (docs/models.md, "Readiness").
 *
 * `isHealthy` alone is not enough: the column defaults to true, so a
 * provider nobody has checked yet reads as healthy. The check has run
 * when `lastHealthCheckAt` is set, and passed when it left the provider
 * healthy. `status` is the operator's intent; a provider switched off
 * serves nothing whatever its last check said.
 */
export function providerChecked(provider: Pick<LlmProvider, 'status' | 'isHealthy' | 'lastHealthCheckAt'>): boolean {
  return provider.status === LlmProviderStatus.ACTIVE && provider.isHealthy === true && !!provider.lastHealthCheckAt;
}
