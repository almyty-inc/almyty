import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';

import { Agent } from '../../../entities/agent.entity';
import { CredentialRefResolver, ResolveOptions, SystemActor } from '../../credentials/credential-ref.resolver';
import { ConnectionsService } from '../../connections/connections.service';
import { CanonicalMemoryService } from './canonical-memory.service';
import { CanonicalMemoryWorkspaceConfig } from './canonical-memory-config.entity';
import { CanonicalMemory } from './canonical-memory.entity';
import { MemoryExpiry } from './memory-expiry.entity';
import { MemoryRouter } from './memory-router.service';
import { PutInput } from './dto/canonical-memory.dto';
import { MemoryItem, RankedItem, ScopeRef, SearchQuery } from './canonical.types';
import { BackendCredentials } from './backends/memory-backend.interface';
import { pickKnownFields } from './backend-credentials.resolver';
import { plainServiceError } from './plain-service-error';

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
 * An agent that keeps its memories in an account of its own (a connection
 * added from the agent's page) rather than the organization's: which
 * connection, and who the use is for.
 */
export interface AgentAccountUse {
  credentialId?: string | null;
  agentId?: string | null;
  /** The run's principal; null for the sweep, which acts for the agent (systemFor). */
  principal?: ResolveOptions['principal'];
  systemFor?: SystemActor;
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
    // An agent's own memory account is a connection of its own, read
    // through the one seam every consumer uses.
    @Optional() private readonly credentialRefs?: CredentialRefResolver,
    // The Memory page's account list reads the caller's memory connections
    // through the Connections service (visibility, health), found at run time.
    @Optional() private readonly moduleRef?: ModuleRef,
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
    opts: { agentId?: string | null; expiresInSeconds?: number | null } & AgentAccountUse = {},
  ): Promise<MemoryItem> {
    const ttl = opts.expiresInSeconds ?? null;
    if (!accountId || accountId === NATIVE_MEMORY_ACCOUNT) {
      return this.memory.put({ ...input, ttl_seconds: ttl }, actor);
    }
    const backend = this.router.backend(accountId);
    if (!backend) throw new Error(`The memory account "${accountId}" does not exist`);
    const item = this.memory.draftItem({ ...input, ttl_seconds: null });
    const creds = await this.ownCredentials(organizationId, opts);
    const saved = await this.router.putOn(accountId, item, orgScope(organizationId), creds);
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
          credentialId: opts.credentialId ?? null,
          expiresAt: ttl ? new Date(Date.now() + ttl * 1000) : null,
        }),
      );
    }
    return saved;
  }

  /** Search one scope through `accountId` (with the agent's own account when it has one). */
  async search(organizationId: string, accountId: string, query: SearchQuery, opts: AgentAccountUse = {}): Promise<RankedItem[]> {
    if (!accountId || accountId === NATIVE_MEMORY_ACCOUNT) return this.memory.search(query);
    const creds = await this.ownCredentials(organizationId, opts);
    return this.router.searchOn(accountId, query, orgScope(organizationId), creds);
  }

  /** What a memory service can do about retention, for an account an agent names itself. */
  describe(backendId: string): MemoryAccount | null {
    const backend = this.router.backend(backendId);
    if (!backend || backendId === NATIVE_MEMORY_ACCOUNT || !backend.supported_modes.has('memory')) return null;
    const expiresItself = backend.capabilities.has('ttl');
    return { id: backendId, name: memoryAccountName(backendId), canExpire: expiresItself || typeof backend.nativeId === 'function', expiresItself };
  }

  /**
   * The agent's own account's credentials, for a run: resolved as the run's
   * principal, so the usual who-can-use rules of that connection apply.
   * undefined when the agent uses the organization's account.
   */
  private async ownCredentials(organizationId: string, opts: AgentAccountUse): Promise<BackendCredentials | undefined> {
    if (!opts.credentialId) return undefined;
    if (!this.credentialRefs) throw new Error("The agent's memory account cannot be reached here");
    const resolved = await this.credentialRefs.resolve(organizationId, opts.credentialId, {
      principal: opts.principal ?? null,
      ...(opts.systemFor ? { systemFor: opts.systemFor } : {}),
      context: { purpose: 'memory_backend', resourceType: 'agent', resourceId: opts.agentId ?? undefined },
    });
    return pickKnownFields(resolved.config ?? {});
  }

  /** For the sweep: the agent's own account, as the system acting for that agent. */
  private async agentCredentials(row: MemoryExpiry): Promise<BackendCredentials | undefined> {
    const agent = row.agentId
      ? await this.expiryRepo.manager.getRepository(Agent).findOne({
          where: { id: row.agentId, organizationId: row.organizationId },
          select: { id: true, organizationId: true, visibility: true, teamId: true, createdBy: true },
        })
      : null;
    return this.ownCredentials(row.organizationId, {
      credentialId: row.credentialId,
      agentId: row.agentId,
      principal: null,
      systemFor: agent
        ? { organizationId: row.organizationId, visibility: agent.visibility, teamId: agent.teamId, ownerUserId: agent.createdBy }
        : undefined,
    });
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
        const creds = row.credentialId ? await this.agentCredentials(row) : undefined;
        await this.router.deleteOn(row.backendId, row.nativeId, orgScope(row.organizationId), creds);
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

  // ── the Memory page's account list ────────────────────────────

  /**
   * Every memory account the caller can see, with its health, and every
   * memory service with how many accounts it has.
   *
   * An account is almyty's own memory, or a connection (a credential) of
   * a memory service: several per service, each named. The health of a
   * connection is its last check (the connector's probe, run by the
   * Credentials page's "Check" and on connect), never a probe without a
   * key: a service nobody has an account for says so ("not set up")
   * instead of reading as unreachable.
   */
  async overview(organizationId: string, user: { id: string }): Promise<MemoryAccountsOverview> {
    const cfg = await this.configRepo.findOne({ where: { scopeType: 'workspace', scopeId: organizationId } });
    const routing = ((cfg?.overrides as any)?.routing ?? {}) as { memory_backend?: string; credentials?: Record<string, string> };
    const defaultService = routing.memory_backend || NATIVE_MEMORY_ACCOUNT;
    const orgCredentials = routing.credentials ?? {};

    const native = this.router.backend(NATIVE_MEMORY_ACCOUNT);
    const nativeHealth = native ? await native.healthCheck().catch((e: any) => ({ ok: false, latency_ms: 0, details: { error: e?.message } })) : null;
    const accounts: MemoryAccountRow[] = [
      {
        id: NATIVE_MEMORY_ACCOUNT,
        service: NATIVE_MEMORY_ACCOUNT,
        serviceName: 'almyty',
        name: memoryAccountName(NATIVE_MEMORY_ACCOUNT),
        accountLabel: null,
        owner: 'org',
        health: {
          status: nativeHealth?.ok ? 'valid' : 'failed',
          checkedAt: new Date(),
          error: nativeHealth?.ok ? null : 'almyty could not reach its own memory store. Try again in a few minutes.',
        },
        isDefault: defaultService === NATIVE_MEMORY_ACCOUNT,
        canMoveFrom: true,
        canMoveTo: true,
      },
    ];

    const services = this.outsideServices();
    const connections = await this.memoryConnections(organizationId, user);
    for (const c of connections) {
      const backend = this.router.backend(c.connectorKey)!;
      accounts.push({
        id: c.id,
        service: c.connectorKey,
        serviceName: memoryAccountName(c.connectorKey),
        name: c.name,
        accountLabel: c.accountLabel ?? null,
        owner: c.owner,
        // In plain words: the service's raw answer stays on the credential, never on this page.
        health: { status: c.health?.status ?? 'unknown', checkedAt: c.health?.checkedAt ?? null, error: c.health?.error ? plainServiceError(c.connectorKey, c.health.error) : null },
        isDefault: defaultService === c.connectorKey && orgCredentials[c.connectorKey] === c.id,
        canMoveFrom: typeof backend.nativeId === 'function',
        canMoveTo: true,
      });
    }
    return {
      accounts,
      services: services.map((s) => ({
        id: s.id,
        name: memoryAccountName(s.id),
        accounts: connections.filter((c) => c.connectorKey === s.id).length,
      })),
    };
  }

  /**
   * The account an id names, for a move: almyty's own memory, or a memory
   * connection the caller can see. Anything else is not found.
   */
  async describeAccount(organizationId: string, user: { id: string }, accountId: string): Promise<{ service: string; credentialId: string | null; name: string }> {
    if (!accountId || accountId === NATIVE_MEMORY_ACCOUNT) {
      return { service: NATIVE_MEMORY_ACCOUNT, credentialId: null, name: memoryAccountName(NATIVE_MEMORY_ACCOUNT) };
    }
    const found = (await this.memoryConnections(organizationId, user)).find((c) => c.id === accountId);
    if (!found) throw new NotFoundException({ code: 'MEMORY_ACCOUNT_NOT_FOUND', message: 'That memory account was not found' });
    return { service: found.connectorKey, credentialId: found.id, name: found.name };
  }

  /** The memory services almyty can keep memories in besides its own. */
  private outsideServices() {
    return this.router
      .list_backends()
      .filter((b) => b.id !== NATIVE_MEMORY_ACCOUNT && b.modes.includes('memory'));
  }

  /** The caller's visible connections of a memory service almyty has an adapter for. */
  private async memoryConnections(organizationId: string, user: { id: string }): Promise<MemoryConnectionLike[]> {
    const connections = this.connections();
    if (!connections) return [];
    const services = new Set(this.outsideServices().map((s) => s.id));
    const all = (await connections.list(user as any, organizationId)) as MemoryConnectionLike[];
    return all.filter((c) => c.kind === 'memory' && services.has(c.connectorKey));
  }

  /** The Connections seam, looked up lazily: MemoryModule does not import ConnectionsModule. */
  private connections(): { list(principal: unknown, organizationId: string): Promise<unknown[]> } | null {
    if (!this.moduleRef) return null;
    try {
      return this.moduleRef.get(ConnectionsService, { strict: false });
    } catch {
      return null;
    }
  }
}

/** A memory connection as the Connections service lists it (the fields read here). */
interface MemoryConnectionLike {
  id: string;
  name: string;
  kind: string | null;
  connectorKey: string;
  accountLabel: string | null;
  owner: string;
  health?: { status: string; checkedAt: Date | null; error: string | null };
}

/** One row of the Memory page's account list. */
export interface MemoryAccountRow {
  /** almyty-native, or the connection's (credential's) id. */
  id: string;
  /** The memory service (backend id). */
  service: string;
  serviceName: string;
  name: string;
  accountLabel: string | null;
  owner: string;
  /** The connection's last check: valid, failed, expired, revoked, quota or unknown (never checked). */
  health: { status: string; checkedAt: Date | null; error: string | null };
  /** Where the organization's memories go by default. */
  isDefault: boolean;
  /** Whether memories can be moved out of it: the service can delete one memory at a time. */
  canMoveFrom: boolean;
  canMoveTo: boolean;
}

export interface MemoryAccountsOverview {
  accounts: MemoryAccountRow[];
  /** Every outside memory service, with how many accounts the caller can see; 0 means not set up. */
  services: Array<{ id: string; name: string; accounts: number }>;
}

/** Outside accounts are the organization's: their credentials sit on its workspace memory settings. */
function orgScope(organizationId: string): ScopeRef {
  return { scope_type: 'workspace', scope_id: organizationId };
}
