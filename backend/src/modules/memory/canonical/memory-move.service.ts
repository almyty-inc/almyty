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
 * - Re-embedded on the target: a memory lands on almyty's own store with
 *   no embedding and is embedded again there by the target's own model
 *   (an outside service embeds what it is given). Vectors from another
 *   provider are never carried over; they may not even be the same size.
 * - Retention travels with it: a memory with a time limit keeps its due
 *   date on the target (ttl_seconds in almyty's own store, a
 *   memory_expiries row outside).
 * - Audited: MEMORY_MOVE when a move starts and when a run finishes.
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
    try {
      const sourceCreds = await this.credentials(move.organizationId, this.sourceOf(move), userId, move.id);
      const targetCreds = await this.credentials(move.organizationId, this.targetOf(move), userId, move.id);
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
        for (const f of fresh) await this.moveOne(move, source, target, f.item, f.sourceId, byId.get(keyOf(f)), sourceCreds, targetCreds);
        await this.tally(move, [...warnings.values()]);
      }
      await this.tally(move, [...warnings.values()]);
      // What the service said about a memory it would not take or give up, so the page can say why.
      if (move.failed > 0) {
        const last = await this.items.findOne({ where: { moveId: move.id, error: Not(IsNull()) }, order: { updatedAt: 'DESC' } });
        move.lastError = last?.error ?? null;
      }
      move.status = 'completed';
      move.finishedAt = new Date();
      await this.moves.save(move);
    } catch (e: any) {
      move.status = 'failed';
      move.lastError = String(e?.message ?? e).slice(0, 1000);
      move.finishedAt = new Date();
      await this.tally(move).catch(() => undefined);
      await this.moves.save(move);
      this.logger.warn(`memory move ${move.id} stopped: ${move.lastError}`);
    }
    this.audit(move, userId, 'finished');
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
  ): Promise<void> {
    if (step?.state === 'moved') return;
    if (!sourceId) {
      // Nothing to delete it by: copying it would leave it in both accounts.
      if (step) return;
      await this.items.save(this.items.create({ moveId: move.id, sourceId: `item:${item.id}`, targetId: null, state: 'failed', error: `${source.id} cannot delete this memory, so it cannot be moved` }));
      return;
    }
    const row = step ?? this.items.create({ moveId: move.id, sourceId, targetId: null, state: 'failed', error: null });
    try {
      if (row.state !== 'copied') {
        const expiry = await this.sourceExpiry(move, sourceId, item);
        const copy = this.copyFor(move, item, target, expiry);
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
      row.error = String(e?.message ?? e).slice(0, 1000);
      await this.items.save(row);
    }
  }

  /**
   * The memory as the target gets it: same content, tags, provenance and
   * dates, in the move's scope, with no embedding (the target makes its
   * own) and its due date, if it has one, carried over.
   */
  private copyFor(move: MemoryMove, item: MemoryItem, target: MemoryBackend, expiresAt: Date | null): MemoryItem {
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
    return {
      ...draft,
      created_at: createdAt,
      valid_from: item.valid_from ?? draft.valid_from,
      // Re-embedded on the target, never carried across.
      embedding: null,
      embedding_dim: null,
      embedding_model: null,
      embedding_status: target.id === NATIVE ? 'pending' : draft.embedding_status,
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
      throw new BadRequestException({ code: 'SOURCE_CANNOT_DELETE', message: `Memories cannot be deleted one by one from ${source.id}, so they cannot be moved out of it` });
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

  private audit(move: MemoryMove, userId: string, phase: 'started' | 'resumed' | 'finished'): void {
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
      },
    });
  }
}

function isUuid(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** The ids another service knew the memory by mean nothing on the target. */
function withoutServiceIds(metadata: Record<string, unknown>): Record<string, unknown> {
  const { mem0_id: _m, zep_uuid: _z, supermemory_id: _s, anthropic_file_id: _a, almyty_id: _i, ...rest } = metadata as Record<string, unknown>;
  return rest;
}
