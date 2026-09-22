import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { Credential, CredentialType } from '../../entities/credential.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import {
  ConnectionUseContext,
  ConnectionUsePrincipal,
  CredentialRefResolver,
  ManagedBy,
} from '../credentials/credential-ref.resolver';

/** The marker maskSensitiveData() puts in place of a key; a client that round-trips it is not rotating. */
export const MASKED_PROVIDER_KEY = '***masked***';

export type ProviderKeyKind = 'inference' | 'usage';

export interface ProviderKeyInput {
  /** A pasted plaintext key; undefined when the request carries none. */
  plaintext?: string;
  /** An existing credential to point at instead; null clears the reference. */
  credentialId?: string | null;
}

/**
 * Where an LLM provider's keys live. Each provider row references up to
 * two Credential rows (inference key, usage/admin key). A pasted key
 * becomes a row this helper manages on the provider's behalf (rotated in
 * place on the next paste, deleted with the provider); a credentialId
 * chosen in the form points the provider at a shared connection instead.
 *
 * Why an async pre-resolve step exists: getDecryptedApiKey() is sync and
 * is called deep inside the provider implementations, which are pure
 * request builders and should stay that way. The `credential` relation
 * is eager, so a provider loaded through a repository already carries the
 * row and the sync getter works. `withResolvedSecrets()` is the explicit
 * step the call choke points (chat runner, model listing) run before the
 * sync reads: it runs the use policy (the grants seam) and reloads the
 * row so a rotation is visible immediately, even for a provider that
 * arrived without its relation (query builder, a probe object).
 */
@Injectable()
export class LlmProviderSecretsHelper {
  private readonly logger = new Logger(LlmProviderSecretsHelper.name);

  constructor(private readonly credentialRefs: CredentialRefResolver) {}

  /**
   * Resolve the provider's credential rows through the policy seam and
   * attach them, so the sync getters read the freshest secret. A provider
   * without references (inline shim, probe object) is returned as is.
   */
  async withResolvedSecrets(
    provider: LlmProvider,
    opts: { principal?: ConnectionUsePrincipal; context?: ConnectionUseContext } = {},
  ): Promise<LlmProvider> {
    const context = opts.context ?? { purpose: 'llm_call', resourceType: 'llm_provider', resourceId: provider.id };
    if (provider.credentialId) {
      const resolved = await this.credentialRefs.resolve(provider.organizationId, provider.credentialId, { ...opts, context });
      provider.credential = resolved.credential;
    }
    if (provider.usageCredentialId) {
      const resolved = await this.credentialRefs.resolve(provider.organizationId, provider.usageCredentialId, { ...opts, context: { ...context, purpose: 'llm_usage' } });
      provider.usageCredential = resolved.credential;
    }
    return provider;
  }

  /**
   * Apply a key change to a saved provider: paste -> managed row (rotate
   * in place when the provider already manages one), credentialId ->
   * shared connection (the previously managed row is released), null ->
   * no key. The inline configuration field is cleared in every case.
   */
  async applyKey(provider: LlmProvider, kind: ProviderKeyKind, input: ProviderKeyInput): Promise<void> {
    const field = kind === 'inference' ? 'credentialId' : 'usageCredentialId';
    const relation = kind === 'inference' ? 'credential' : 'usageCredential';
    const inlineField = kind === 'inference' ? 'apiKey' : 'usageApiKey';
    const managedBy = this.managedBy(provider, kind);

    if (input.credentialId !== undefined) {
      const previous = provider[field];
      if (input.credentialId === null) {
        provider[field] = null;
        provider[relation] = null;
      } else {
        const row = await this.credentialRefs.load(provider.organizationId, input.credentialId);
        provider[field] = row.id;
        provider[relation] = row;
      }
      if (previous && previous !== provider[field]) {
        await this.credentialRefs.releaseManaged(provider.organizationId, previous, managedBy);
      }
    }

    const pasted = typeof input.plaintext === 'string' && input.plaintext.length > 0 && input.plaintext !== MASKED_PROVIDER_KEY
      ? input.plaintext
      : undefined;

    // A key still inline on the row (the read-through shim) moves into a
    // managed row the first time the provider is written again, so the
    // shim empties itself without a second code path.
    const inline = !pasted && input.credentialId === undefined && !provider[field]
      ? (kind === 'inference' ? provider.getDecryptedApiKey() : provider.getDecryptedUsageApiKey())
      : undefined;

    const plaintext = pasted ?? inline;
    if (plaintext) {
      const current = provider[field] ? await this.credentialRefs.load(provider.organizationId, provider[field]!).catch(() => null) : null;
      let row: Credential;
      if (current && CredentialRefResolver.isManagedBy(current, managedBy)) {
        row = await this.credentialRefs.rotateManaged(provider.organizationId, current.id, {
          config: { apiKey: plaintext },
          managedBy,
        });
      } else {
        row = await this.credentialRefs.createManaged(provider.organizationId, {
          name: kind === 'inference' ? `${provider.name} API key` : `${provider.name} usage API key`,
          description: kind === 'inference'
            ? `Inference key for the ${provider.type} provider "${provider.name}"`
            : `Usage/admin key for the ${provider.type} provider "${provider.name}"`,
          type: CredentialType.API_KEY,
          config: { apiKey: plaintext },
          connectorKey: provider.type,
          keyLocation: 'header',
          managedBy,
        });
      }
      provider[field] = row.id;
      provider[relation] = row;
    }

    // Once a reference exists the inline field is gone for good.
    if (provider[field] && provider.configuration && inlineField in provider.configuration) {
      delete (provider.configuration as any)[inlineField];
    }
  }

  /** Delete the rows this provider manages (shared connections are left alone). */
  async release(provider: LlmProvider): Promise<void> {
    await this.credentialRefs.releaseManaged(provider.organizationId, provider.credentialId, this.managedBy(provider, 'inference'));
    await this.credentialRefs.releaseManaged(provider.organizationId, provider.usageCredentialId, this.managedBy(provider, 'usage'));
  }

  /** Mirror the provider health check onto its inference credential. */
  async recordHealth(provider: Pick<LlmProvider, 'organizationId' | 'credentialId'>, healthy: boolean, error?: string | null): Promise<void> {
    try {
      await this.credentialRefs.recordHealth(provider.organizationId, provider.credentialId, healthy ? 'valid' : 'failed', healthy ? null : error);
    } catch (err: any) {
      this.logger.warn(`credential health record failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Split the keys out of an incoming configuration. The plaintext never
   * reaches the provider row; the returned configuration is what gets
   * merged and persisted.
   */
  static splitKeys<T extends Record<string, any>>(configuration: T | undefined): { configuration: T; apiKey?: string; usageApiKey?: string } {
    const { apiKey, usageApiKey, ...rest } = (configuration ?? {}) as any;
    for (const [name, value] of [['apiKey', apiKey], ['usageApiKey', usageApiKey]] as const) {
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new BadRequestException(`configuration.${name} must be a string`);
      }
    }
    return { configuration: rest as T, apiKey: apiKey ?? undefined, usageApiKey: usageApiKey ?? undefined };
  }

  private managedBy(provider: LlmProvider, kind: ProviderKeyKind): ManagedBy {
    return { kind: kind === 'inference' ? 'llm_provider' : 'llm_provider_usage', id: provider.id };
  }
}
