import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { CanonicalMemoryWorkspaceConfig } from './canonical-memory-config.entity';
import { BackendCredentials } from './backends/memory-backend.interface';
import { ScopeRef } from './canonical.types';
import { scopeToOrganizationId, scopeToUserId } from './canonical-memory.helpers';

/**
 * Resolve a backend's credentials for a given (scope, backend_id)
 * pair from the org's credential store.
 *
 * Routing config in `memory_workspace_config.overrides.routing`
 * carries one credential id per backend the scope is allowed to
 * use. Example shape:
 *
 *   {
 *     routing: {
 *       memory_backend: 'mem0',
 *       credentials: {
 *         mem0: 'cred-uuid-A',
 *         zep:  'cred-uuid-B',
 *         vertex-memory-bank: 'cred-uuid-C'
 *       }
 *     }
 *   }
 *
 * The secret is read through CredentialRefResolver, the one seam every
 * consumer uses (docs/connections.md): it checks the row belongs to the
 * organization and is active, keeps a private row to its owner, asks the
 * use policy (grants) and org governance, and decrypts. This used to call
 * CredentialsService.findById -- the dashboard read, which masks every
 * secret -- so a backend was handed `mem0****-key` and could never
 * authenticate, and none of those checks ran.
 *
 * The decrypted config maps onto BackendCredentials fields of the same
 * name (`apiKey`, `baseUrl`, `engine`, `bearer`, `project`, `location`);
 * backend-specific string fields are forwarded as well.
 *
 * Nothing is cached: a rotation or a revoked grant applies on the next
 * call, as it does for every other consumer.
 */
@Injectable()
export class BackendCredentialsResolver {
  private readonly logger = new Logger(BackendCredentialsResolver.name);

  constructor(
    @InjectRepository(CanonicalMemoryWorkspaceConfig)
    private readonly configRepo: Repository<CanonicalMemoryWorkspaceConfig>,
    private readonly credentialRefs: CredentialRefResolver,
  ) {}

  /**
   * Resolve credentials for `(scope, backendId)`. Returns `null` when
   * the scope hasn't pinned a usable credential for the backend --
   * backends that need creds throw on their next call so the caller sees
   * a clear error rather than a silent unauth request.
   */
  async resolve(scope: ScopeRef, backendId: string): Promise<BackendCredentials | null> {
    const cfg = await this.configRepo.findOne({
      where: { scopeType: scope.scope_type, scopeId: scope.scope_id },
    });
    const credentialId = ((cfg?.overrides as any)?.routing?.credentials ?? {})[backendId];
    if (!credentialId) return null;

    const organizationId = scopeToOrganizationId(scope.scope_type, scope.scope_id);
    // Used as the scope's own member for a `user` scope, and as nobody
    // for every shared scope: a team or private credential pinned to a
    // scope the whole organization writes through is refused.
    const userId = scopeToUserId(scope.scope_type, scope.scope_id);
    try {
      const resolved = await this.credentialRefs.resolve(organizationId, credentialId, {
        principal: userId ? { id: userId } : null,
        context: { purpose: 'memory_backend', resourceType: 'memory_backend', resourceId: backendId },
      });
      return pickKnownFields(resolved.config ?? {});
    } catch (e: any) {
      // Not found (including another org's row), inactive, expired, a
      // private row, or refused by policy: the backend gets nothing.
      this.logger.warn(`credential ${credentialId} not usable for memory backend ${backendId}: ${e?.message ?? e}`);
      return null;
    }
  }
}

function pickKnownFields(config: Record<string, unknown>): BackendCredentials {
  const allowed: Array<keyof BackendCredentials> = [
    'apiKey', 'baseUrl', 'project', 'location', 'engine', 'bearer',
  ];
  const out: BackendCredentials = {};
  for (const k of allowed) {
    const v = config[k as string];
    if (typeof v === 'string') (out as any)[k] = v;
  }
  // Forward any extra string fields the credential row carries —
  // backend-specific knobs end up here (e.g. vertex `serviceAccountJson`).
  for (const k of Object.keys(config)) {
    if (!allowed.includes(k as any) && typeof config[k] === 'string') {
      (out as any)[k] = config[k];
    }
  }
  return out;
}
