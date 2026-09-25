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
import { CONNECTIONS_GOVERNANCE_HOOK, ConnectionsGovernanceHook } from '../../common/ee-hooks/ee-hooks';
import { decryptField, isEncrypted } from '../../common/security/field-crypto';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import type { ResourceVisibility } from '../../common/authorization/access-policy.service';
import {
  ExecutionAccessService,
  type ExecutionPrincipal,
  actingUserId,
  isExecutionPrincipal,
} from '../../common/authorization/execution-access.service';

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
  /**
   * Who the secret is used for, named at every call site
   * (credential-resolve-principal-guard.spec.ts holds new ones to it):
   * a user (`{ id }`), a run's ExecutionPrincipal -- so a gateway run is
   * judged by its gateway's scope -- or null for a path with nobody
   * behind it. null reaches organization rows only: a private or team
   * row is refused unless `systemFor` covers it.
   */
  principal: ConnectionUsePrincipal | ExecutionPrincipal | null;
  /**
   * Explicitly the system acting for the resource that owns this use (a
   * provider's health check, a deployment's reconcile). Read only when
   * `principal` is null. A team row passes when that resource is scoped
   * to the same team, a private row when it is private to the same owner;
   * nothing else is opened by it.
   */
  systemFor?: SystemActor;
  context?: ConnectionUseContext;
}

/** The scope of the resource the system acts for (see ResolveOptions.systemFor). */
export interface SystemActor {
  organizationId: string;
  visibility?: ResourceVisibility | null;
  teamId?: string | null;
  ownerUserId?: string | null;
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
  kind: 'llm_provider' | 'llm_provider_usage' | 'mcp_source' | 'channel_installation' | 'api' | 'gateway_channel' | 'app_distribution' | 'hosted_chat_oauth';
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
    @Optional() @Inject(CONNECTIONS_GOVERNANCE_HOOK) private readonly governance?: ConnectionsGovernanceHook,
    // The team rule at resolve time. Optional only for specs that build the
    // resolver by hand; without it a team row is refused (fail closed).
    @Optional() private readonly executionAccess?: ExecutionAccessService,
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
    opts: ResolveOptions,
  ): Promise<ResolvedCredential> {
    const credential = await this.load(organizationId, credentialId);
    if (!credential.isActive) {
      throw new ForbiddenException({ code: 'CREDENTIAL_INACTIVE', message: 'credential is inactive' });
    }
    if (credential.isExpired()) {
      throw new ForbiddenException({ code: 'CREDENTIAL_EXPIRED', message: 'credential has expired' });
    }
    const execution = CredentialRefResolver.executionPrincipalOf(opts.principal);
    await this.assertScopedUse(credential, execution, opts);
    // The grants policy and org governance judge a user. A gateway private
    // to its owner is that owner; any other gateway, and nobody, is none.
    const actingId = execution ? actingUserId(execution) : null;
    const principal: ConnectionUsePrincipal | undefined = isExecutionPrincipal(opts.principal)
      ? (actingId ? { id: actingId } : undefined)
      : (opts.principal ?? undefined);
    await this.policy.assertCanUse({ organizationId, credential, principal, context: opts.context });
    // Org policy (EE) has the last word, on every consumer path and not
    // just the connections API: a connector the organization forbade, or
    // a scope rule about who may use what, applies here too.
    if (credential.connectorKey && this.governance) {
      await this.governance.beforeUse(
        organizationId,
        credential as unknown as { id: string; organizationId: string; connectorKey?: string | null; ownerUserId?: string | null },
        { userId: principal?.id, ...(opts.context?.resourceType === 'agent' ? { agentId: opts.context.resourceId } : {}), ...(opts.context?.resourceType === 'workspace' ? { workspaceId: opts.context.resourceId } : {}) },
        { purpose: opts.context?.purpose, resourceType: opts.context?.resourceType, resourceId: opts.context?.resourceId },
      );
    }
    await this.envelopeCrypto.warmOrg(organizationId);
    const config = this.decryptDeep(credential.getDecryptedConfig(), organizationId);
    return { credential, config, secrets: CredentialRefResolver.secretsOf(config) };
  }

  /** Same as resolve() but returns null for a missing/inactive row instead of throwing. Used by read-through shims. */
  async tryResolve(
    organizationId: string,
    credentialId: string | null | undefined,
    opts: ResolveOptions,
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

  /** The principal a resolve acts as: a run's own, a `{ id }` user, or nobody. */
  static executionPrincipalOf(principal: ResolveOptions['principal'] | undefined): ExecutionPrincipal | null {
    if (!principal) return null;
    if (isExecutionPrincipal(principal)) return principal;
    return principal.id ? { kind: 'user', userId: principal.id, source: 'session' } : null;
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

  /**
   * The scope half of resolve(), for a row the caller loaded and applies
   * itself (an API's bound credential, refreshed in place when its OAuth2
   * token has expired): the private and team rules below, nothing else.
   * Throws CREDENTIAL_NOT_FOUND when `opts.principal` may not use it.
   */
  async assertScope(credential: Credential, opts: ResolveOptions): Promise<void> {
    await this.assertScopedUse(credential, CredentialRefResolver.executionPrincipalOf(opts.principal), opts);
  }

  /**
   * Private and team scope, applied at resolve time for every credential,
   * plain rows included (the grants policy only ever sees rows that carry
   * a connectorKey). Organization rows pass; the use policy decides them.
   *
   * - private ("just me"): its owner only -- not another member, not an
   *   org admin, not a path that acts for nobody. A gateway private to the
   *   owner acts as the owner.
   * - team: team only is team only. Whoever the call acts as must be able
   *   to use the row by the rule every executor applies
   *   (ExecutionAccessService.canExecute): a member of the team, an org
   *   owner or admin, or a gateway scoped to that team. A call that acts
   *   for nobody is refused, however the credential is attached.
   * - A null principal passes a scoped row only when the caller says it is
   *   the system acting for a resource (`systemFor`) whose own scope covers
   *   the row: a team resource for its team's rows, a private resource for
   *   its owner's.
   *
   * Everyone refused is told the row does not exist. A row a consumer
   * manages for itself (an LLM provider's pasted key) follows its consumer
   * instead: the consumer's own scope decides who reaches it, and
   * syncManagedScope keeps the two in step.
   */
  private async assertScopedUse(
    credential: Credential,
    principal: ExecutionPrincipal | null,
    opts: Pick<ResolveOptions, 'systemFor' | 'context'>,
  ): Promise<void> {
    const visibility = credential.visibility ?? 'org';
    if (visibility === 'org') return;
    // Its own consumer, and only its own consumer, reaches a managed row
    // without naming a user (a health check, a background sync).
    const managedBy = (credential.metadata as Record<string, any> | null | undefined)?.managedBy;
    if (managedBy?.id && opts.context?.resourceId === managedBy.id) return;
    if (principal) {
      if (visibility === 'private') {
        const userId = actingUserId(principal);
        if (credential.ownerUserId && userId && userId === credential.ownerUserId) return;
      } else if (this.executionAccess && (await this.executionAccess.canExecute(principal, credential)).allowed) {
        return;
      }
    } else if (opts.systemFor && (await this.systemScopeCovers(opts.systemFor, credential))) {
      return;
    }
    throw new NotFoundException({ code: 'CREDENTIAL_NOT_FOUND', message: 'credential not found' });
  }

  /** Does the scope of the resource the system acts for cover `credential`? */
  private async systemScopeCovers(actor: SystemActor, credential: Credential): Promise<boolean> {
    if (actor.organizationId !== credential.organizationId) return false;
    const actorVisibility = actor.visibility ?? 'org';
    if (credential.visibility === 'private') {
      return actorVisibility === 'private' && !!actor.ownerUserId && actor.ownerUserId === credential.ownerUserId;
    }
    if (!credential.teamId) return false;
    if (actorVisibility === 'team') return actor.teamId === credential.teamId;
    if (actorVisibility === 'private' && actor.ownerUserId && this.executionAccess) {
      const owner: ExecutionPrincipal = { kind: 'user', userId: actor.ownerUserId, source: 'session' };
      return (await this.executionAccess.canExecute(owner, credential)).allowed;
    }
    return false;
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
    patch: {
      config: Record<string, any>;
      secretKeys?: string[];
      managedBy: Pick<ManagedBy, 'kind' | 'id'>;
      keyName?: string | null;
      keyLocation?: string | null;
    },
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
    // Where an API key is sent is part of the same write: a header renamed
    // together with the key must not keep the old name on the row.
    if (patch.keyName !== undefined) credential.keyName = patch.keyName as string;
    if (patch.keyLocation !== undefined) credential.keyLocation = patch.keyLocation as string;
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
   * Stamp the outcome of a health probe on a credential.
   *
   * A partial UPDATE of the four health columns, never a save() of the
   * loaded row. The row is read at the top of the probe and written at
   * the bottom, and `config` holds the encrypted secret in between: a
   * key rotated inside that window was committed by the user and then
   * overwritten by this write, because save() diffs its stale copy
   * against the row and writes every differing column back. The entity
   * does no @AfterLoad decryption, so the stale value is valid
   * ciphertext and the revert is silent — a key rotated because it
   * leaked would be quietly reinstated by a background health check.
   * Same reason the provider row one layer up is written with a scoped
   * update.
   *
   * Org-scoped in the WHERE so a probe can never touch another org's
   * credential, and the row-missing case is a no-op rather than an
   * error (the credential may have been deleted mid-probe).
   */
  async recordHealth(
    organizationId: string,
    credentialId: string | null | undefined,
    status: Credential['healthStatus'],
    error?: string | null,
  ): Promise<void> {
    if (!credentialId) return;
    const now = new Date();
    await this.credentials.update(
      { id: credentialId, organizationId },
      {
        healthStatus: status,
        healthCheckedAt: now,
        healthError: error ?? null,
        lastUsedAt: now,
      },
    );
  }

  /**
   * Give a row a consumer manages the consumer's scope (a private LLM
   * provider's pasted key becomes private to the same owner). Rows the
   * consumer does not manage -- shared connections -- are left alone.
   */
  async setManagedScope(
    organizationId: string,
    credentialId: string | null | undefined,
    managedBy: Pick<ManagedBy, 'kind' | 'id'>,
    scope: Pick<Credential, 'visibility' | 'teamId' | 'ownerUserId'>,
  ): Promise<void> {
    if (!credentialId) return;
    const credential = await this.credentials.findOne({ where: { id: credentialId, organizationId } });
    if (!credential || !CredentialRefResolver.isManagedBy(credential, managedBy)) return;
    if (
      credential.visibility === scope.visibility &&
      (credential.teamId ?? null) === (scope.teamId ?? null) &&
      (credential.ownerUserId ?? null) === (scope.ownerUserId ?? null)
    ) return;
    await this.credentials.update({ id: credential.id, organizationId }, scope);
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
