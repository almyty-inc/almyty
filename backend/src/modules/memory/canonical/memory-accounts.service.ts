import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';

import { CanonicalMemoryService } from './canonical-memory.service';
import { CanonicalMemoryWorkspaceConfig } from './canonical-memory-config.entity';
import { CanonicalMemory } from './canonical-memory.entity';
import { MemoryExpiry } from './memory-expiry.entity';
import { MemoryRouter } from './memory-router.service';
import { PutInput } from './dto/canonical-memory.dto';
import { MemoryItem, RankedItem, ScopeRef, SearchQuery } from './canonical.types';

/** almyty's own store: always there, needs no account. */
export const NATIVE_MEMORY_ACCOUNT = 'almyty-native';

/** What people call each memory service. */
const ACCOUNT_NAMES: Record<string, string> = {
  'almyty-native': "almyty's own memory",
  mem0: 'Mem0',
  supermemory: 'Supermemory',
  zep: 'Zep',
  'vertex-memory-bank': 'Vertex AI Memory Bank',
  'anthropic-memory-tool': 'Claude memory tool',
};

export function memoryAccountName(id: string): string {
  return ACCOUNT_NAMES[id] ?? id;
}

/**
 * A memory account an agent can keep its memories in: almyty's own store,
 * or an outside memory service the organization has connected an account
 * for on the Memory page (memory_workspace_config.overrides.routing.credentials).
 */
export interface MemoryAccount {
  id: string;
  name: string;
  /**
   * Whether memories saved here can be given a time limit: almyty's own
   * store expires them itself (ttl_seconds); an outside service by almyty
   * deleting each one through its API when it is due (memory_expiries).
   */
  canExpire: boolean;
  /** Whether the service expires memories itself; false means almyty deletes them on a schedule. */
  expiresItself: boolean;
}

/**
 * The memory accounts of an organization, and an agent's reads and writes
 * through the one it chose.
 *
 * almyty's own store goes through CanonicalMemoryService (the 17-step
 * write pipeline, embeddings, hybrid search). An outside account goes to
 * that backend through the router, signed in with the credential the
 * organization's memory settings name for it. A memory saved outside with
 * a time limit gets a memory_expiries row, and sweepExpired deletes it
 * through the service's API once it is due.
 */
@Injectable()
export class MemoryAccountsService {
  private readonly logger = new Logger(MemoryAccountsService.name);

  constructor(
    private readonly memory: CanonicalMemoryService,
    private readonly router: MemoryRouter,
    @InjectRepository(CanonicalMemoryWorkspaceConfig)
    private readonly configRepo: Repository<CanonicalMemoryWorkspaceConfig>,
    @InjectRepository(MemoryExpiry)
    private readonly expiryRepo: Repository<MemoryExpiry>,
    @InjectRepository(CanonicalMemory)
    private readonly memoryRepo: Repository<CanonicalMemory>,
  ) {}

  /** almyty's own store, then every outside service the organization has an account for. */
  async accounts(organizationId: string): Promise<MemoryAccount[]> {
    const out: MemoryAccount[] = [
      { id: NATIVE_MEMORY_ACCOUNT, name: memoryAccountName(NATIVE_MEMORY_ACCOUNT), canExpire: true, expiresItself: true },
    ];
    const cfg = await this.configRepo.findOne({ where: { scopeType: 'workspace', scopeId: organizationId } });
    const credentials: Record<string, unknown> = ((cfg?.overrides as any)?.routing?.credentials ?? {}) as Record<string, unknown>;
    for (const [backendId, credentialId] of Object.entries(credentials)) {
      if (backendId === NATIVE_MEMORY_ACCOUNT || typeof credentialId !== 'string' || !credentialId) continue;
      const backend = this.router.backend(backendId);
      if (!backend || !backend.supported_modes.has('memory')) continue;
      const expiresItself = backend.capabilities.has('ttl');
      out.push({
        id: backendId,
        name: memoryAccountName(backendId),
        canExpire: expiresItself || typeof backend.nativeId === 'function',
        expiresItself,
      });
    }
    return out;
  }

  /**
   * Save one memory through `accountId`. `expiresInSeconds` is the agent's
   * retention: a ttl in almyty's own store, a memory_expiries row outside.
   */
  async put(
    organizationId: string,
    accountId: string,
    input: PutInput,
    actor: { user_id?: string },
    opts: { agentId?: string | null; expiresInSeconds?: number | null } = {},
  ): Promise<MemoryItem> {
    const ttl = opts.expiresInSeconds ?? null;
    if (!accountId || accountId === NATIVE_MEMORY_ACCOUNT) {
      return this.memory.put({ ...input, ttl_seconds: ttl }, actor);
    }
    const backend = this.router.backend(accountId);
    if (!backend) throw new Error(`The memory account "${accountId}" does not exist`);
    const item = this.memory.draftItem({ ...input, ttl_seconds: null });
    const saved = await this.router.putOn(accountId, item, orgScope(organizationId));
    const nativeId = backend.nativeId?.(saved) ?? null;
    // Kept even without a time limit, so a retention set later still
    // reaches what the agent saved before it.
    if (nativeId) {
      await this.expiryRepo.save(
        this.expiryRepo.create({
          organizationId,
          agentId: opts.agentId ?? null,
          backendId: accountId,
          scopeType: item.scope_type,
          scopeId: item.scope_id,
          nativeId,
          memoryId: item.id,
          expiresAt: ttl ? new Date(Date.now() + ttl * 1000) : null,
        }),
      );
    }
    return saved;
  }

  /** Search one scope through `accountId`. */
  async search(organizationId: string, accountId: string, query: SearchQuery): Promise<RankedItem[]> {
    if (!accountId || accountId === NATIVE_MEMORY_ACCOUNT) return this.memory.search(query);
    return this.router.searchOn(accountId, query, orgScope(organizationId));
  }

  /**
   * Apply an agent's retention to what it has already saved: the ttl of
   * its memories in almyty's own store, and the due date of its memories
   * in outside accounts. `seconds` null keeps them until deleted.
   */
  async setAgentRetention(organizationId: string, agentId: string, seconds: number | null): Promise<void> {
    await this.memoryRepo.query(
      `UPDATE memories SET ttl_seconds = $1, updated_at = now()
        WHERE provenance->>'agent_id' = $2
          AND (scope_id = $3 OR scope_id LIKE $4)
          AND mode = 'memory' AND valid_until IS NULL AND deleted_at IS NULL`,
      [seconds, agentId, organizationId, `${organizationId}:%`],
    );
    await this.expiryRepo.query(
      `UPDATE memory_expiries
          SET expires_at = CASE WHEN $1::int IS NULL THEN NULL ELSE created_at + ($1::int * INTERVAL '1 second') END
        WHERE organization_id = $2 AND agent_id = $3`,
      [seconds, organizationId, agentId],
    );
  }

  /**
   * Delete every outside memory whose time is up, through its service's
   * API. A delete that fails is left for the next pass; one the service
   * no longer knows (already deleted there) is done.
   */
  async sweepExpired(now = new Date(), batch = 500): Promise<{ deleted: number; failed: number }> {
    const due = await this.expiryRepo.find({
      where: { expiresAt: LessThan(now) },
      order: { expiresAt: 'ASC' },
      take: batch,
    });
    let deleted = 0;
    let failed = 0;
    const done: string[] = [];
    for (const row of due) {
      try {
        await this.router.deleteOn(row.backendId, row.nativeId, orgScope(row.organizationId));
        done.push(row.id);
        deleted++;
      } catch (e: any) {
        failed++;
        this.logger.warn(`could not delete memory ${row.memoryId} from ${row.backendId}: ${e?.message ?? e}`);
      }
    }
    if (done.length) await this.expiryRepo.delete({ id: In(done) });
    return { deleted, failed };
  }
}

/** Outside accounts are the organization's: their credentials sit on its workspace memory settings. */
function orgScope(organizationId: string): ScopeRef {
  return { scope_type: 'workspace', scope_id: organizationId };
}
