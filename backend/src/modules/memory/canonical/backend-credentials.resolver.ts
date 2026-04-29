import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Credential } from '../../../entities/credential.entity';
import { CredentialsService } from '../../credentials/credentials.service';
import { CanonicalMemoryWorkspaceConfig } from './canonical-memory-config.entity';
import { BackendCredentials } from './backends/memory-backend.interface';
import { ScopeRef } from './canonical.types';

/**
 * Resolve a backend's credentials for a given (scope, backend_id)
 * pair from the org's encrypted credential store.
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
 * The Credential row's `config` JSON (decrypted on read by
 * CredentialsService) maps onto BackendCredentials fields. Field
 * names are the same — `apiKey`, `baseUrl`, `engine`, `bearer`,
 * `project`, `location` — so a typical credential row stores:
 *
 *   { apiKey: '<token>', baseUrl: 'https://api.mem0.ai' }
 *
 * Vertex needs more keys (project, location, engine, bearer); the
 * resolver simply forwards everything in the decrypted config that
 * lands on the BackendCredentials interface.
 *
 * Cache: per (scope_type, scope_id, backend_id), bounded — refreshes
 * every TTL_MS so credential rotations propagate without bouncing
 * the service.
 */
@Injectable()
export class BackendCredentialsResolver {
  private readonly logger = new Logger(BackendCredentialsResolver.name);
  private readonly cache = new Map<string, { creds: BackendCredentials | null; at: number }>();
  private static readonly TTL_MS = 60_000;
  private static readonly MAX_ENTRIES = 256;

  constructor(
    @InjectRepository(CanonicalMemoryWorkspaceConfig)
    private readonly configRepo: Repository<CanonicalMemoryWorkspaceConfig>,
    private readonly credentialsService: CredentialsService,
  ) {}

  /**
   * Resolve credentials for `(scope, backendId)`. Returns `null` when
   * the scope hasn't pinned a credential id for the backend — backends
   * that need creds throw on their next call so the caller sees a
   * clear error rather than a silent unauth request.
   */
  async resolve(scope: ScopeRef, backendId: string): Promise<BackendCredentials | null> {
    const key = `${scope.scope_type}|${scope.scope_id}|${backendId}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < BackendCredentialsResolver.TTL_MS) {
      return cached.creds;
    }

    const cfg = await this.configRepo.findOne({
      where: { scopeType: scope.scope_type, scopeId: scope.scope_id },
    });
    const credentialId = ((cfg?.overrides as any)?.routing?.credentials ?? {})[backendId];
    if (!credentialId) {
      this.set(key, null);
      return null;
    }

    let row: Credential;
    try {
      row = await this.credentialsService.findById(credentialId, scope.scope_id);
    } catch (e: any) {
      // findById throws NotFoundException when the row doesn't
      // belong to this org — same as missing.
      this.logger.warn(`credential ${credentialId} not found for scope ${scope.scope_id}: ${e.message}`);
      this.set(key, null);
      return null;
    }

    const decrypted = decryptedConfig(row);
    const creds = pickKnownFields(decrypted);
    this.set(key, creds);
    return creds;
  }

  private set(key: string, creds: BackendCredentials | null): void {
    if (this.cache.size >= BackendCredentialsResolver.MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { creds, at: Date.now() });
  }

  /**
   * Invalidate the cache entry for a credential rotation. Called by
   * the credentials controller when a row is updated, so the next
   * memory dispatch picks up the rotated key.
   */
  invalidate(scope: ScopeRef, backendId?: string): void {
    if (backendId) {
      this.cache.delete(`${scope.scope_type}|${scope.scope_id}|${backendId}`);
      return;
    }
    const prefix = `${scope.scope_type}|${scope.scope_id}|`;
    for (const k of Array.from(this.cache.keys())) {
      if (k.startsWith(prefix)) this.cache.delete(k);
    }
  }
}

/**
 * The Credential entity's `config` JSON is decrypted by
 * CredentialsService.findById on read. The fields we expect to see
 * on a memory-backend credential row map 1:1 to BackendCredentials.
 */
function decryptedConfig(row: Credential): Record<string, unknown> {
  return (row.config ?? {}) as Record<string, unknown>;
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
