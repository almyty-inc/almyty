import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Credential, CredentialType } from '../../entities/credential.entity';
import { decryptField, isEncrypted } from '../../common/security/field-crypto';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';

/**
 * The one way a consumer reads a secret out of the credential store.
 *
 * LLM providers, MCP sources, channel installations, API auth and
 * deployment adapters hold a `credentialId` and nothing else; when they
 * need the secret they call `resolve()` here. The resolver checks the
 * row belongs to the organization and is active, asks the use policy
 * (the gate 2 seam, see `CONNECTION_USE_POLICY`), warms the org's KMS
 * envelope and hands back the decrypted config. Nothing is cached: the
 * store is the source of truth and a rotation is visible on the next
 * call.
 *
 * Writes for consumer-managed rows (the credential a provider form
 * creates from a pasted key) go through `createManaged` / `rotateManaged`
 * / `releaseManaged` so every secret write has the same shape and the
 * same encryption path.
 */

/**
 * Injection token for the use policy. Gate 2 (grants) plugs in here:
 * provide `{ provide: CONNECTION_USE_POLICY, useClass: GrantsUsePolicy }`
 * in a module that is imported after CredentialRefModule, or call
 * `CredentialRefResolver.usePolicy(policy)` from `onModuleInit`. The
 * default policy allows every in-org use.
 */
export const CONNECTION_USE_POLICY = 'CONNECTION_USE_POLICY';

export interface ConnectionUsePrincipal {
  id: string;
  /** Organizations the principal is a member of, when known. */
  organizationIds?: string[];
}

export interface ConnectionUseContext {
  /** What the secret is for: 'llm_call', 'mcp_call', 'channel_inbound', 'api_call', 'deploy', 'backfill', ... */
  purpose: string;
  resourceType?: string;
  resourceId?: string;
}

export interface ConnectionUseInput {
  organizationId: string;
  /** The loaded row, config still encrypted. */
  credential: Credential;
  principal?: ConnectionUsePrincipal;
  context?: ConnectionUseContext;
}

/**
 * Decides whether a consumer may use a credential. Throw to deny (a
 * ForbiddenException with a `code` is what callers expect). The default
 * implementation allows every use inside the owning organization; gate 2
 * replaces it with one that consults connection grants.
 */
export interface ConnectionUsePolicy {
  assertCanUse(input: ConnectionUseInput): Promise<void>;
}

export class AllowAllConnectionUsePolicy implements ConnectionUsePolicy {
  async assertCanUse(): Promise<void> {
    /* every in-org use is allowed until grants (gate 2) plug in */
  }
}

export interface ResolveOptions {
  principal?: ConnectionUsePrincipal;
  context?: ConnectionUseContext;
}

export interface ResolvedCredential {
  credential: Credential;
  /** Decrypted config, nested values included. Never serialize it. */
  config: Record<string, any>;
  /** The well-known secret fields of `config` only. */
  secrets: Record<string, string>;
}

/** Who created a managed row; stored in `metadata.managedBy` so it can be rotated and released by the same consumer only. */
export interface ManagedBy {
  kind: 'llm_provider' | 'llm_provider_usage' | 'mcp_source' | 'channel_installation' | 'api' | 'gateway_channel';
  id?: string;
  label?: string;
}

export interface CreateManagedInput {
  name: string;
  type: CredentialType;
  config: Record<string, any>;
  /**
   * Keys of `config` that carry secrets. Values are encrypted before the
   * row is saved even when the key is not one the Credential entity
   * encrypts on its own (nested header maps, snake_case token keys).
   */
  secretKeys?: string[];
  connectorKey?: string | null;
  keyName?: string | null;
  keyLocation?: string | null;
  apiId?: string | null;
  description?: string | null;
  metadata?: Record<string, any>;
  managedBy: ManagedBy;
}

/**
 * Config fields that carry a secret across every consumer. Mirrors the
 * Credential entity's own list and adds the consumer spellings
 * (snake_case channel tokens, the MCP bearer field).
 */
export const WELL_KNOWN_SECRET_FIELDS: readonly string[] = [
  'password', 'secret', 'token', 'key', 'client_secret', 'apiKey',
  'accessToken', 'refreshToken', 'headerValue', 'clientSecret', 'bearer',
  'serviceAccountJson', 'certificate', 'privateKey', 'certificatePassword',
  'secretAccessKey', 'accessKeyId', 'sessionToken', 'tokenSecret', 'tokenId',
  'usageApiKey', 'bearerToken', 'bot_token', 'access_token', 'refresh_token',
  'signing_secret', 'app_secret', 'auth_token', 'verify_token',
];

@Injectable()
export class CredentialRefResolver {
  private readonly logger = new Logger(CredentialRefResolver.name);
  private policy: ConnectionUsePolicy;

  constructor(
    @InjectRepository(Credential)
    private readonly credentials: Repository<Credential>,
    private readonly envelopeCrypto: EnvelopeCryptoService,
    @Optional() @Inject(CONNECTION_USE_POLICY) policy?: ConnectionUsePolicy,
  ) {
    this.policy = policy ?? new AllowAllConnectionUsePolicy();
  }

  /** Replace the use policy at runtime (gate 2 calls this from its module init). */
  usePolicy(policy: ConnectionUsePolicy): void {
    this.policy = policy;
  }

  /**
   * Load, authorize and decrypt one credential of `organizationId`.
   * Throws CREDENTIAL_NOT_FOUND (also for a row of another org),
   * CREDENTIAL_INACTIVE, CREDENTIAL_EXPIRED, or whatever the use policy
   * throws.
   */
  async resolve(
    organizationId: string,
    credentialId: string,
    opts: ResolveOptions = {},
  ): Promise<ResolvedCredential> {
    const credential = await this.load(organizationId, credentialId);
    if (!credential.isActive) {
      throw new ForbiddenException({ code: 'CREDENTIAL_INACTIVE', message: 'credential is inactive' });
    }
    if (credential.isExpired()) {
      throw new ForbiddenException({ code: 'CREDENTIAL_EXPIRED', message: 'credential has expired' });
    }
    await this.policy.assertCanUse({ organizationId, credential, principal: opts.principal, context: opts.context });
    await this.envelopeCrypto.warmOrg(organizationId);
    const config = this.decryptDeep(credential.getDecryptedConfig(), organizationId);
    return { credential, config, secrets: CredentialRefResolver.secretsOf(config) };
  }

  /** Same as resolve() but returns null for a missing/inactive row instead of throwing. Used by read-through shims. */
  async tryResolve(
    organizationId: string,
    credentialId: string | null | undefined,
    opts: ResolveOptions = {},
  ): Promise<ResolvedCredential | null> {
    if (!credentialId) return null;
    try {
      return await this.resolve(organizationId, credentialId, opts);
    } catch (err: any) {
      const code = err?.response?.code ?? err?.code;
      if (code === 'CREDENTIAL_NOT_FOUND' || code === 'CREDENTIAL_INACTIVE' || code === 'CREDENTIAL_EXPIRED') {
        this.logger.warn(`credential ${credentialId} for org ${organizationId} is ${code}`);
        return null;
      }
      throw err;
    }
  }

  /** The well-known secret fields of a decrypted config. */
  static secretsOf(config: Record<string, any>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const field of WELL_KNOWN_SECRET_FIELDS) {
      const value = config?.[field];
      if (typeof value === 'string' && value.length > 0) out[field] = value;
    }
    return out;
  }

  secretsOf(config: Record<string, any>): Record<string, string> {
    return CredentialRefResolver.secretsOf(config);
  }

  /** Whether `credential` was created by `managedBy` (same kind, and same id when one is given). */
  static isManagedBy(credential: Pick<Credential, 'metadata'> | null | undefined, managedBy: Pick<ManagedBy, 'kind' | 'id'>): boolean {
    const by = credential?.metadata?.managedBy;
    if (!by || by.kind !== managedBy.kind) return false;
    return managedBy.id === undefined || by.id === managedBy.id;
  }

  /**
   * Create a row the consumer owns. The plaintext arrives here once and
   * leaves encrypted; it is never logged.
   */
  async createManaged(organizationId: string, input: CreateManagedInput): Promise<Credential> {
    const credential = this.credentials.create({
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      config: await this.encryptKeys(organizationId, { ...input.config }, input.secretKeys),
      keyName: input.keyName ?? null,
      keyLocation: input.keyLocation ?? null,
      apiId: input.apiId ?? null,
      organizationId,
      connectorKey: input.connectorKey ?? null,
      metadata: { ...(input.metadata ?? {}), managedBy: input.managedBy },
      isActive: true,
      visibility: 'org',
      teamId: null,
    } as Partial<Credential>) as Credential;
    await credential.encryptSensitiveDataForOrg(this.envelopeCrypto);
    const saved = await this.credentials.save(credential);
    this.logger.log(`credential ${saved.id} created for ${input.managedBy.kind}${input.managedBy.id ? ` ${input.managedBy.id}` : ''} in org ${organizationId}`);
    return saved;
  }

  /**
   * Replace secret fields on a row in place; other config keys are kept.
   * Only rows managed by the caller may be rotated this way, a shared
   * connection is rotated through the connections API.
   */
  async rotateManaged(
    organizationId: string,
    credentialId: string,
    patch: { config: Record<string, any>; secretKeys?: string[]; managedBy: Pick<ManagedBy, 'kind' | 'id'> },
  ): Promise<Credential> {
    const credential = await this.load(organizationId, credentialId);
    if (!CredentialRefResolver.isManagedBy(credential, patch.managedBy)) {
      throw new ForbiddenException({
        code: 'CREDENTIAL_NOT_MANAGED',
        message: 'this credential is a shared connection; rotate it through /connections',
      });
    }
    const merged = { ...(credential.config ?? {}), ...patch.config };
    credential.config = await this.encryptKeys(organizationId, merged, patch.secretKeys);
    await credential.encryptSensitiveDataForOrg(this.envelopeCrypto);
    credential.isActive = true;
    credential.healthStatus = 'unknown';
    credential.healthError = null;
    const saved = await this.credentials.save(credential);
    this.logger.log(`credential ${saved.id} rotated by ${patch.managedBy.kind}`);
    return saved;
  }

  /**
   * Delete a managed row when its consumer goes away (provider deleted,
   * installation revoked). A shared connection is left alone; the FK on
   * the consumer is SET NULL either way.
   */
  async releaseManaged(organizationId: string, credentialId: string | null | undefined, managedBy: Pick<ManagedBy, 'kind' | 'id'>): Promise<boolean> {
    if (!credentialId) return false;
    const credential = await this.credentials.findOne({ where: { id: credentialId, organizationId } });
    if (!credential || !CredentialRefResolver.isManagedBy(credential, managedBy)) return false;
    await this.credentials.remove(credential);
    this.logger.log(`credential ${credentialId} released by ${managedBy.kind}`);
    return true;
  }

  /**
   * Mirror a consumer's own health probe onto the credential so the
   * connections list shows what the provider health check found.
   * Best-effort: a missing row is ignored.
   */
  async recordHealth(
    organizationId: string,
    credentialId: string | null | undefined,
    status: Credential['healthStatus'],
    error?: string | null,
  ): Promise<void> {
    if (!credentialId) return;
    const credential = await this.credentials.findOne({ where: { id: credentialId, organizationId } });
    if (!credential) return;
    credential.healthStatus = status;
    credential.healthCheckedAt = new Date();
    credential.healthError = error ?? null;
    credential.lastUsedAt = new Date();
    await this.credentials.save(credential);
  }

  /** Load a row of this org or throw CREDENTIAL_NOT_FOUND. */
  async load(organizationId: string, credentialId: string): Promise<Credential> {
    const credential = await this.credentials.findOne({ where: { id: credentialId, organizationId } });
    if (!credential) {
      throw new NotFoundException({ code: 'CREDENTIAL_NOT_FOUND', message: 'credential not found' });
    }
    return credential;
  }

  private async encryptKeys(
    organizationId: string,
    config: Record<string, any>,
    secretKeys: string[] | undefined,
  ): Promise<Record<string, any>> {
    for (const key of secretKeys ?? []) {
      const value = config[key];
      if (typeof value === 'string') {
        if (value.length > 0 && !isEncrypted(value)) {
          config[key] = await this.envelopeCrypto.encryptForOrg(organizationId, value);
        }
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested: Record<string, any> = { ...value };
        for (const [k, v] of Object.entries(nested)) {
          if (typeof v === 'string' && v.length > 0 && !isEncrypted(v)) {
            nested[k] = await this.envelopeCrypto.encryptForOrg(organizationId, v);
          }
        }
        config[key] = nested;
      }
    }
    return config;
  }

  /**
   * The entity decrypts top-level strings; consumer rows also carry
   * nested maps (MCP custom headers). Decrypt one level down as well.
   */
  private decryptDeep(config: Record<string, any>, organizationId: string): Record<string, any> {
    const out: Record<string, any> = { ...config };
    for (const [key, value] of Object.entries(out)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested: Record<string, any> = { ...value };
        for (const [k, v] of Object.entries(nested)) {
          if (typeof v === 'string' && isEncrypted(v)) nested[k] = decryptField(v, organizationId);
        }
        out[key] = nested;
      }
    }
    return out;
  }
}
