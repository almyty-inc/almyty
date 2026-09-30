import { ConflictException, Injectable, Logger, NotFoundException, Optional, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { In, IsNull, Not, Repository } from 'typeorm';

import { AuditLogService } from '../../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { pickKnownFields } from './backend-credentials.resolver';
import { BackendCredentials, MemoryBackend, TransferWarning } from './backends/memory-backend.interface';
import { CanonicalMemoryService } from './canonical-memory.service';
import { MemoryItem, Mode, ScopeRef } from './canonical.types';
import { MemoryExpiry } from './memory-expiry.entity';
import { MemoryMove, MemoryMoveItem } from './memory-move.entity';
import { computeTransferWarnings, MemoryRouter } from './memory-router.service';
import { Agent } from '../../../entities/agent.entity';
import { AccessPolicyService } from '../../../common/authorization/access-policy.service';
import { assertManageable } from '../../../common/authorization/read-rule';
import { CanonicalMemoryWorkspaceConfig } from './canonical-memory-config.entity';
import { memoryAccountName } from './memory-accounts.service';
import { plainServiceError } from './plain-service-error';

export const MOVE_QUEUE_NAME = 'canonical-memory-move';

/** almyty's own store: the account with no credential. */
const NATIVE = 'almyty-native';

/** How many memories a run lists at a time. */
const PAGE = 100;

/** A running move that has not reported for this long has stopped (its process went away); it may be resumed. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/** A memory account: almyty's own store, or a memory service signed in with one connection. */
export interface MemoryAccountRef {
  service: string;
  credentialId: string | null;
}

export interface StartMove {
  source: MemoryAccountRef;
  target: MemoryAccountRef;
  scope: ScopeRef;
  mode?: Mode;
  /** Once every memory has moved, point the agents that used the source at the target. */
  switchAgents?: boolean;
}

/** An agent that keeps its memories in an account, and whether the member may switch it. */
export interface AgentUse {
  id: string;
  name: string;
  canSwitch: boolean;
  reason?: string;
}

export interface MovePreview {
  total: number;
  /** Whether the count stopped at the preview's limit. */
  more: boolean;
  warnings: TransferWarning[];
}

/**
 * Moves memories from one memory account to another: each memory is
 * copied to the target, then deleted from the source.
 *
 * - Idempotent and resumable: each memory's step is a memory_move_items
 *   row (unique per move and source id). A memory already copied is not
 *   copied again; a resume only deletes it from the source. A memory the
 *   copy failed for is tried again on resume.
 * - Embeddings: a vector travels only when the target is almyty's own
 *   store and embeds with the same model and dimension; otherwise the
 *   target embeds the memory again (an outside service is never sent one).
 * - Retention travels with it: a memory with a time limit keeps its due
 *   date on the target (ttl_seconds in almyty's own store, a
 *   memory_expiries row outside).
 * - Agents follow, when asked: once every memory has moved, the agents
 *   that used the source and that the member may edit point at the target.
 * - Errors reach the page as one plain sentence (plainServiceError); the
 *   service's own answer goes to the log and the audit row.
 * - Audited: MEMORY_MOVE when a move starts, resumes, finishes and switches agents.
 *
 * The run itself is a job on MOVE_QUEUE_NAME, acting as the member who
 * started (or resumed) it: the accounts' connections are resolved as that
 * member, so a connection they may not use is refused.
 */
@Injectable()
export class MemoryMoveService {
  private readonly logger = new Logger(MemoryMoveService.name);

  constructor(
    @InjectRepository(MemoryMove) private readonly moves: Repository<MemoryMove>,
    @InjectRepository(MemoryMoveItem) private readonly items: Repository<MemoryMoveItem>,
    @InjectRepository(MemoryExpiry) private readonly expiries: Repository<MemoryExpiry>,
    private readonly router: MemoryRouter,
    private readonly memory: CanonicalMemoryService,
    private readonly auditLog: AuditLogService,
    @InjectQueue(MOVE_QUEUE_NAME) private readonly queue: Queue,
    @Optional() private readonly credentialRefs?: CredentialRefResolver,
    // Which agents use an account, and who may switch them.
    @Optional() @InjectRepository(Agent) private readonly agents?: Repository<Agent>,
    @Optional() private readonly accessPolicy?: AccessPolicyService,
    @Optional() @InjectRepository(CanonicalMemoryWorkspaceConfig) private readonly configRepo?: Repository<CanonicalMemoryWorkspaceConfig>,
  ) {}

  /** What a move would cover: how many memories, and what the target cannot keep. */
  async preview(organizationId: string, userId: string, input: StartMove): Promise<MovePreview> {
    const { source, target, mode } = this.check(input);
    const creds = await this.credentials(organizationId, input.source, userId, null);
    const seen: MemoryItem[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    const LIMIT = 5000;
    while (seen.length < LIMIT) {
      const page = await source.list({ scope: input.scope, mode, limit: 200, cursor }, creds);
      seen.push(...page.items);
      if (!page.cursor || cursors.has(page.cursor)) break;
      cursors.add(page.cursor);
      cursor = page.cursor;
    }
    return { total: Math.min(seen.length, LIMIT), more: seen.length >= LIMIT, warnings: computeTransferWarnings(source, target, seen) };
  }

  /**
   * Start a move. The same move (same accounts, scope and mode) already
   * queued or running is returned rather than started twice.
   */
  async start(organizationId: string, userId: string, input: StartMove): Promise<MemoryMove> {
    const { mode } = this.check(input);
    const same = await this.moves.findOne({
      where: {
        organizationId,
        sourceService: input.source.service,
        sourceCredentialId: input.source.credentialId ?? IsNull(),
        targetService: input.target.service,
        targetCredentialId: input.target.credentialId ?? IsNull(),
        scopeType: input.scope.scope_type,
        scopeId: input.scope.scope_id,
        mode,
        status: In(['queued', 'running']),
      },
    });
    if (same) return same;
    // Both accounts must be usable by whoever starts it, before anything is queued.
    await this.credentials(organizationId, input.source, userId, null);
    await this.credentials(organizationId, input.target, userId, null);
    const move = await this.moves.save(
      this.moves.create({
        organizationId,
        sourceService: input.source.service,
        sourceCredentialId: input.source.credentialId,
        targetService: input.target.service,
        targetCredentialId: input.target.credentialId,
        scopeType: input.scope.scope_type,
        scopeId: input.scope.scope_id,
        mode,
        status: 'queued',
        moved: 0,
        failed: 0,
        total: null,
        lastError: null,
        warnings: [],
        createdBy: userId,
        switchAgents: !!input.switchAgents,
        agentsSwitched: null,
        agentsNotSwitched: null,
        finishedAt: null,
      }),
    );
    this.audit(move, userId, 'started');
    await this.enqueue(move, userId);
    return move;
  }

  /** Run a move again from where it stopped: after a failure, with memories left over, or once it went quiet. */
  async resume(organizationId: string, userId: string, id: string): Promise<MemoryMove> {
    const move = await this.get(organizationId, id);
    const stale = move.status === 'running' && Date.now() - new Date(move.updatedAt).getTime() > STALE_AFTER_MS;
    const leftOver = move.status === 'completed' && move.failed > 0;
    if (!(move.status === 'failed' || leftOver || stale)) {
      throw new ConflictException({ code: 'MOVE_NOT_RESUMABLE', message: move.status === 'completed' ? 'This move is done.' : 'This move is still running.' });
    }
    await this.credentials(organizationId, this.sourceOf(move), userId, move.id);
    await this.credentials(organizationId, this.targetOf(move), userId, move.id);
    move.status = 'queued';
    move.lastError = null;
    move.finishedAt = null;
    await this.moves.save(move);
    this.audit(move, userId, 'resumed');
    await this.enqueue(move, userId);
    return move;
  }

  async get(organizationId: string, id: string): Promise<MemoryMove> {
    const move = await this.moves.findOne({ where: { id, organizationId } });
    if (!move) throw new NotFoundException({ code: 'MOVE_NOT_FOUND', message: 'That move was not found' });
    return move;
  }

  /** The organization's moves, newest first, limited to the scopes the caller may see. */
  async list(organizationId: string, visibleScopeIds: string[], limit = 50): Promise<MemoryMove[]> {
    const rows = await this.moves.find({ where: { organizationId }, order: { createdAt: 'DESC' }, take: limit });
    return rows.filter((m) => m.scopeType !== 'agent' && m.scopeType !== 'user' ? true : visibleScopeIds.includes(m.scopeId));
  }

  /**
   * One run of a move (the queue job). Lists the source page by page; each
   * memory not yet moved is copied (unless it already was) and deleted
   * from the source. A page is listed again from the same place while it
   * still yields memories this run has not handled (the ones handled were
   * deleted, so an offset source shows the next ones there), and the run
   * moves to the next page once it yields none.
   */
  async run(moveId: string, userId: string): Promise<MemoryMove> {
    const move = await this.moves.findOne({ where: { id: moveId } });
    if (!move) throw new Error(`memory move ${moveId} not found`);
    if (move.status === 'completed') return move;
    move.status = 'running';
    await this.moves.save(move);
    const source = this.router.backend(move.sourceService)!;
    const target = this.router.backend(move.targetService)!;
    const scope: ScopeRef = { scope_type: move.scopeType, scope_id: move.scopeId };
    // Which side a failure came from, so the page can name the service.
    let stage: 'source' | 'target' = 'source';
    let errorDetail: string | null = null;
    try {
      const sourceCreds = await this.credentials(move.organizationId, this.sourceOf(move), userId, move.id);
      stage = 'target';
      const targetCreds = await this.credentials(move.organizationId, this.targetOf(move), userId, move.id);
      const targetEmbedding = await this.targetEmbedding(target, scope);
      stage = 'source';
      const handled = new Set<string>();
      const cursors = new Set<string>();
      const warnings = new Map<string, TransferWarning>();
      let cursor: string | null = null;
      for (;;) {
        const page = await source.list({ scope, mode: move.mode, limit: PAGE, cursor }, sourceCreds);
        if (move.total === null && typeof page.total === 'number' && cursor === null) move.total = page.total + move.moved;
        const fresh: Array<{ item: MemoryItem; sourceId: string | null }> = [];
        for (const item of page.items) {
          const sourceId = this.sourceIdOf(source, item);
          const key = sourceId ?? `item:${item.id}`;
          if (handled.has(key)) continue;
          handled.add(key);
          fresh.push({ item, sourceId });
        }
        if (fresh.length === 0) {
          if (!page.cursor || cursors.has(page.cursor)) break;
          cursors.add(page.cursor);
          cursor = page.cursor;
          continue;
        }
        for (const w of computeTransferWarnings(source, target, fresh.map((f) => f.item))) {
          const k = `${w.capability}:${String(w.field)}`;
          const prev = warnings.get(k);
          warnings.set(k, { ...w, count: (prev?.count ?? 0) + w.count });
        }
        const keyOf = (f: { item: MemoryItem; sourceId: string | null }) => f.sourceId ?? `item:${f.item.id}`;
        const done = await this.items.find({ where: { moveId: move.id, sourceId: In(fresh.map(keyOf)) } });
        const byId = new Map(done.map((d) => [d.sourceId, d] as const));
        for (const f of fresh) await this.moveOne(move, source, target, f.item, f.sourceId, byId.get(keyOf(f)), sourceCreds, targetCreds, targetEmbedding);
        await this.tally(move, [...warnings.values()]);
      }
      await this.tally(move, [...warnings.values()]);
      // Why memories were left behind, in plain words; the service's own answer goes to the log and audit.
      if (move.failed > 0) {
        const last = await this.items.findOne({ where: { moveId: move.id, error: Not(IsNull()) }, order: { updatedAt: 'DESC' } });
        const { side, raw } = splitItemError(last?.error ?? '');
        errorDetail = raw || null;
        move.lastError = side === 'unmovable'
          ? `${serviceName(move.sourceService)} cannot delete these memories one at a time, so they were left where they are.`
          : plainServiceError(side === 'source' ? move.sourceService : move.targetService, raw);
        this.logger.warn(`memory move ${move.id}: ${move.failed} not moved: ${raw}`);
      } else {
        move.lastError = null;
      }
      move.status = 'completed';
      move.finishedAt = new Date();
      await this.moves.save(move);
    } catch (e: any) {
      errorDetail = String(e?.message ?? e).slice(0, 1000);
      move.status = 'failed';
      move.lastError = plainRunError(e, stage === 'source' ? move.sourceService : move.targetService);
      move.finishedAt = new Date();
      await this.tally(move).catch(() => undefined);
      await this.moves.save(move);
      this.logger.warn(`memory move ${move.id} stopped: ${errorDetail}`);
    }
    this.audit(move, userId, 'finished', errorDetail);
    // Agents move with their memories only once every memory has moved:
    // an agent switched earlier would lose the ones left behind.
    if (move.status === 'completed' && move.failed === 0 && move.switchAgents) await this.switchAgents(move, userId);
    return move;
  }

  // ── one memory ────────────────────────────────────────────────

  private async moveOne(
    move: MemoryMove,
    source: MemoryBackend,
    target: MemoryBackend,
    item: MemoryItem,
    sourceId: string | null,
    step: MemoryMoveItem | undefined,
    sourceCreds: BackendCredentials | undefined,
    targetCreds: BackendCredentials | undefined,
    targetEmbedding: { model: string; dim: number } | null = null,
  ): Promise<void> {
    if (step?.state === 'moved') return;
    if (!sourceId) {
      // Nothing to delete it by: copying it would leave it in both accounts.
      if (step) return;
      await this.items.save(this.items.create({ moveId: move.id, sourceId: `item:${item.id}`, targetId: null, state: 'failed', error: 'unmovable:no id to delete it by' }));
      return;
    }
    const row = step ?? this.items.create({ moveId: move.id, sourceId, targetId: null, state: 'failed', error: null });
    try {
      if (row.state !== 'copied') {
        const expiry = await this.sourceExpiry(move, sourceId, item);
        const copy = this.copyFor(move, item, target, expiry, targetEmbedding);
        const saved = await target.put(copy, targetCreds);
        const targetId = target.id === NATIVE ? saved.id : target.nativeId?.(saved) ?? null;
        row.targetId = targetId ?? saved.id;
        row.state = 'copied';
        row.error = null;
        await this.items.save(row);
        if (target.id !== NATIVE && targetId) {
          await this.expiries.save(
            this.expiries.create({
              organizationId: move.organizationId,
              agentId: item.provenance?.agent_id ?? null,
              backendId: target.id,
              scopeType: move.scopeType,
              scopeId: move.scopeId,
              nativeId: targetId,
              memoryId: copy.id,
              credentialId: move.targetCredentialId,
              expiresAt: expiry,
            }),
          );
        }
      }
      await source.delete(sourceId, 'hard', sourceCreds);
      await this.expiries.delete({ organizationId: move.organizationId, backendId: source.id, nativeId: sourceId });
      row.state = 'moved';
      row.error = null;
      await this.items.save(row);
    } catch (e: any) {
      // A copy that landed stays `copied`: the resume only deletes it from the source.
      // Which side refused, then the service's own answer (never shown; the page gets plainServiceError).
      row.error = `${row.state === 'copied' ? 'source' : 'target'}:${String(e?.message ?? e)}`.slice(0, 1000);
      await this.items.save(row);
    }
  }

  /**
   * The memory as the target gets it: same content, tags, provenance and
   * dates, in the move's scope, and its due date, if it has one, carried
   * over. `targetEmbedding` is the model and dimension almyty's own store
   * embeds with for this scope; null for an outside service.
   */
  private copyFor(move: MemoryMove, item: MemoryItem, target: MemoryBackend, expiresAt: Date | null, targetEmbedding: { model: string; dim: number } | null = null): MemoryItem {
    const createdAt = item.created_at ? new Date(item.created_at) : new Date();
    const ttl = expiresAt ? Math.max(1, Math.ceil((expiresAt.getTime() - createdAt.getTime()) / 1000)) : null;
    const draft = this.memory.draftItem({
      id: isUuid(item.id) ? item.id : undefined,
      mode: move.mode,
      scope: { scope_type: move.scopeType, scope_id: move.scopeId },
      content: item.content,
      content_format: item.content_format,
      tags: item.tags ?? [],
      metadata: withoutServiceIds(item.metadata ?? {}),
      file_refs: item.file_refs ?? [],
      tier: item.tier ?? undefined,
      // almyty's own store expires by ttl; outside, the memory_expiries row does.
      ttl_seconds: target.id === NATIVE ? ttl : null,
      source_uri: item.source_uri ?? undefined,
      source_version: item.source_version ?? undefined,
      source_checksum: item.source_checksum ?? undefined,
      chunk_index: item.chunk_index ?? undefined,
      chunk_total: item.chunk_total ?? undefined,
      chunk_of: item.chunk_of ?? undefined,
      confidence: item.confidence,
      provenance: { ...item.provenance, source_backend: move.sourceService },
    });
    // The vector travels only when the target would make the same one: its
    // embedding model and dimension match the memory's. Otherwise the
    // target embeds it again (almyty's own store queues it; an outside
    // service embeds what it is given and never receives a vector).
    const keepVector =
      !!targetEmbedding &&
      Array.isArray(item.embedding) &&
      item.embedding.length > 0 &&
      item.embedding_model === targetEmbedding.model &&
      item.embedding_dim === targetEmbedding.dim &&
      item.embedding.length === targetEmbedding.dim;
    return {
      ...draft,
      created_at: createdAt,
      valid_from: item.valid_from ?? draft.valid_from,
      embedding: keepVector ? item.embedding : null,
      embedding_dim: keepVector ? item.embedding_dim : null,
      embedding_model: keepVector ? item.embedding_model : null,
      embedding_status: keepVector ? 'ready' : target.id === NATIVE ? 'pending' : draft.embedding_status,
    };
  }

  /** When the memory is due to be deleted at the source, if ever. */
  private async sourceExpiry(move: MemoryMove, sourceId: string, item: MemoryItem): Promise<Date | null> {
    if (move.sourceService === NATIVE) {
      if (!item.ttl_seconds) return null;
      return new Date(new Date(item.created_at).getTime() + item.ttl_seconds * 1000);
    }
    const row = await this.expiries.findOne({ where: { organizationId: move.organizationId, backendId: move.sourceService, nativeId: sourceId } });
    return row?.expiresAt ?? null;
  }

  private sourceIdOf(source: MemoryBackend, item: MemoryItem): string | null {
    if (source.id === NATIVE) return item.id;
    return source.nativeId?.(item) ?? null;
  }

  /** The embedding almyty's own store makes for this scope; null for an outside service. */
  private async targetEmbedding(target: MemoryBackend, scope: ScopeRef): Promise<{ model: string; dim: number } | null> {
    if (target.id !== NATIVE) return null;
    const cfg = await this.memory.getOrCreateConfig(scope.scope_type, scope.scope_id);
    return cfg?.embeddingModel && cfg?.embeddingDim ? { model: cfg.embeddingModel, dim: cfg.embeddingDim } : null;
  }

  // ── the agents that keep their memories in an account ─────────

  /**
   * The agents the member can see that keep their memories in `account`,
   * and whether they may switch each one: whoever may edit the agent may.
   * A move of one agent's own memory concerns that agent only.
   *
   * An agent uses almyty's own memory when its memory is on and names no
   * other account; a connection when it names that connection, or names
   * its service with no connection of its own while the organization's
   * account for that service is this connection.
   */
  async agentsUsing(organizationId: string, userId: string, account: MemoryAccountRef, scope?: ScopeRef): Promise<AgentUse[]> {
    if (!this.agents || !this.accessPolicy) return [];
    const policy = this.accessPolicy;
    const rows = await this.agents.find({
      where: { organizationId, isTemporary: false },
      select: { id: true, name: true, organizationId: true, visibility: true, teamId: true, createdBy: true, memoryConfig: true },
    });
    const visible = await policy.filterVisible({ id: userId }, organizationId, rows);
    const orgAccounts = await this.orgAccounts(organizationId);
    const onlyAgent = scope?.scope_type === 'agent' ? scope.scope_id.split(':agent:')[1] : null;
    const using = visible.filter((a) => (!onlyAgent || a.id === onlyAgent) && agentUses(a.memoryConfig, account, orgAccounts));
    const out: AgentUse[] = [];
    for (const a of using) {
      try {
        await assertManageable(policy, userId, a, 'Agent', { ownerManages: true });
        out.push({ id: a.id, name: a.name, canSwitch: true });
      } catch {
        out.push({ id: a.id, name: a.name, canSwitch: false, reason: 'You cannot edit this agent.' });
      }
    }
    return out;
  }

  /**
   * Point every agent the member may edit that used the source account at
   * the target, once the move is done. Each switch is audited; an agent
   * they may not edit is listed as not switched, with why.
   */
  private async switchAgents(move: MemoryMove, userId: string): Promise<void> {
    if (!this.agents) return;
    const scope: ScopeRef = { scope_type: move.scopeType, scope_id: move.scopeId };
    const uses = await this.agentsUsing(move.organizationId, userId, this.sourceOf(move), scope);
    const target = this.router.backend(move.targetService);
    const targetCanExpire = !!target && (target.id === NATIVE || target.capabilities.has('ttl') || typeof target.nativeId === 'function');
    const switched: Array<{ id: string; name: string }> = [];
    const notSwitched: Array<{ id: string; name: string; reason: string }> = [];
    for (const use of uses) {
      if (!use.canSwitch) {
        notSwitched.push({ id: use.id, name: use.name, reason: use.reason ?? 'You cannot edit this agent.' });
        continue;
      }
      const agent = await this.agents.findOne({ where: { id: use.id, organizationId: move.organizationId } });
      if (!agent) continue;
      const before = { account: agent.memoryConfig?.account ?? NATIVE, credentialId: agent.memoryConfig?.credentialId ?? null };
      const next = {
        ...(agent.memoryConfig ?? {}),
        account: move.targetService,
        credentialId: move.targetService === NATIVE ? null : move.targetCredentialId,
        // A time limit the new account cannot keep is not carried over, as on the agent's page.
        ...(targetCanExpire ? {} : { retentionDays: null }),
      };
      await this.agents.update({ id: agent.id, organizationId: move.organizationId }, { memoryConfig: next });
      switched.push({ id: agent.id, name: agent.name });
      void this.auditLog.log({
        organizationId: move.organizationId,
        userId,
        action: AuditAction.UPDATE,
        resourceType: AuditResource.AGENT,
        resourceId: agent.id,
        details: {
          change: 'memory_account',
          reason: 'memory_move',
          move_id: move.id,
          from: before,
          to: { account: next.account, credentialId: next.credentialId },
        },
      });
    }
    move.agentsSwitched = switched;
    move.agentsNotSwitched = notSwitched;
    await this.moves.save(move);
    this.audit(move, userId, 'agents_switched', null, { agents_switched: switched.map((a) => a.id), agents_not_switched: notSwitched.map((a) => a.id) });
  }

  /** The organization's account for each service (its memory settings). */
  private async orgAccounts(organizationId: string): Promise<Record<string, string>> {
    if (!this.configRepo) return {};
    const cfg = await this.configRepo.findOne({ where: { scopeType: 'workspace', scopeId: organizationId } });
    return ((cfg?.overrides as any)?.routing?.credentials ?? {}) as Record<string, string>;
  }

  /** Counts from the item rows, so a resumed move adds up across its runs. */
  private async tally(move: MemoryMove, warnings?: TransferWarning[]): Promise<void> {
    const [moved, failedCopies, undeleted] = await Promise.all([
      this.items.count({ where: { moveId: move.id, state: 'moved' } }),
      this.items.count({ where: { moveId: move.id, state: 'failed' } }),
      // Copied, but the delete from the source failed.
      this.items.count({ where: { moveId: move.id, state: 'copied', error: Not(IsNull()) } }),
    ]);
    const failed = failedCopies + undeleted;
    move.moved = moved;
    move.failed = failed;
    if (warnings) move.warnings = warnings.map((w) => ({ capability: w.capability, field: String(w.field), count: w.count }));
    await this.moves.save(move);
  }

  // ── accounts ──────────────────────────────────────────────────

  private check(input: StartMove): { source: MemoryBackend; target: MemoryBackend; mode: Mode } {
    const mode = input.mode ?? 'memory';
    const source = this.router.backend(input.source.service);
    const target = this.router.backend(input.target.service);
    if (!source || !target) throw new BadRequestException({ code: 'UNKNOWN_ACCOUNT', message: 'Pick a memory account to move from and one to move to' });
    const same = input.source.service === input.target.service && (input.source.credentialId ?? null) === (input.target.credentialId ?? null);
    if (same) throw new BadRequestException({ code: 'SAME_ACCOUNT', message: 'Pick a different account to move to' });
    if (source.id !== NATIVE && typeof source.nativeId !== 'function') {
      throw new BadRequestException({ code: 'SOURCE_CANNOT_DELETE', message: `${serviceName(source.id)} cannot delete memories one at a time, so almyty cannot move memories out of it. Its memories stay there.` });
    }
    if (!source.supported_modes.has(mode) || !target.supported_modes.has(mode)) {
      throw new BadRequestException({ code: 'MODE_UNSUPPORTED', message: mode === 'document' ? 'One of these accounts cannot keep documents' : 'One of these accounts cannot keep memories' });
    }
    if (source.id !== NATIVE && !input.source.credentialId) throw new BadRequestException({ code: 'NO_ACCOUNT', message: 'Pick which account of that service to move from' });
    if (target.id !== NATIVE && !input.target.credentialId) throw new BadRequestException({ code: 'NO_ACCOUNT', message: 'Pick which account of that service to move to' });
    return { source, target, mode };
  }

  /** An account's credentials, resolved as the member acting; undefined for almyty's own store. */
  private async credentials(organizationId: string, account: MemoryAccountRef, userId: string, moveId: string | null): Promise<BackendCredentials | undefined> {
    if (account.service === NATIVE || !account.credentialId) return undefined;
    if (!this.credentialRefs) throw new Error('Memory accounts cannot be reached here');
    const resolved = await this.credentialRefs.resolve(organizationId, account.credentialId, {
      principal: { id: userId },
      context: { purpose: 'memory_backend', resourceType: 'memory_move', resourceId: moveId ?? undefined },
    });
    return pickKnownFields(resolved.config ?? {});
  }

  private sourceOf(move: MemoryMove): MemoryAccountRef {
    return { service: move.sourceService, credentialId: move.sourceCredentialId };
  }

  private targetOf(move: MemoryMove): MemoryAccountRef {
    return { service: move.targetService, credentialId: move.targetCredentialId };
  }

  private async enqueue(move: MemoryMove, userId: string): Promise<void> {
    await this.queue.add('move', { moveId: move.id, userId }, { jobId: `memory-move:${move.id}:${Date.now()}`, attempts: 1, removeOnComplete: 50, removeOnFail: 50 });
  }

  private audit(move: MemoryMove, userId: string, phase: 'started' | 'resumed' | 'finished' | 'agents_switched', errorDetail?: string | null, extra: Record<string, unknown> = {}): void {
    void this.auditLog.log({
      organizationId: move.organizationId,
      userId,
      action: AuditAction.MEMORY_MOVE,
      resourceType: AuditResource.MEMORY,
      resourceId: move.id,
      details: {
        phase,
        status: move.status,
        source: { service: move.sourceService, credential_id: move.sourceCredentialId },
        target: { service: move.targetService, credential_id: move.targetCredentialId },
        scope_type: move.scopeType,
        scope_id: move.scopeId,
        mode: move.mode,
        moved: move.moved,
        failed: move.failed,
        ...(move.lastError ? { error: move.lastError } : {}),
        // The service's own answer, for whoever investigates; never shown on a page.
        ...(errorDetail ? { error_detail: errorDetail.slice(0, 500) } : {}),
        ...extra,
      },
    });
  }
}

/** A service's name on a page. */
function serviceName(service: string): string {
  return service === NATIVE ? 'almyty' : memoryAccountName(service);
}

/** A step row's error: which side refused (`source:`, `target:`, `unmovable:`) and the service's own answer. */
function splitItemError(error: string): { side: 'source' | 'target' | 'unmovable'; raw: string } {
  const m = /^(source|target|unmovable):([\s\S]*)$/.exec(error);
  return m ? { side: m[1] as 'source' | 'target' | 'unmovable', raw: m[2] } : { side: 'target', raw: error };
}

/** Why a whole run stopped, in plain words. An account the member may no longer use says so. */
function plainRunError(e: any, service: string): string {
  const status = typeof e?.getStatus === 'function' ? e.getStatus() : e?.status;
  if (status === 403 || status === 404) {
    return `The ${serviceName(service)} account can no longer be used by you, or it was removed from Credentials.`;
  }
  return plainServiceError(service, e);
}

/** Whether an agent keeps its memories in `account` (see MemoryMoveService.agentsUsing). */
export function agentUses(
  memoryConfig: Agent['memoryConfig'] | null | undefined,
  account: MemoryAccountRef,
  orgAccounts: Record<string, string>,
): boolean {
  if (!memoryConfig?.enabled) return false;
  const service = memoryConfig.account || NATIVE;
  const own = memoryConfig.credentialId || null;
  if (account.service === NATIVE) return service === NATIVE;
  if (service !== account.service || !account.credentialId) return false;
  return own ? own === account.credentialId : orgAccounts[service] === account.credentialId;
}

function isUuid(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** The ids another service knew the memory by mean nothing on the target. */
function withoutServiceIds(metadata: Record<string, unknown>): Record<string, unknown> {
  const { mem0_id: _m, zep_uuid: _z, supermemory_id: _s, anthropic_file_id: _a, almyty_id: _i, ...rest } = metadata as Record<string, unknown>;
  return rest;
}
