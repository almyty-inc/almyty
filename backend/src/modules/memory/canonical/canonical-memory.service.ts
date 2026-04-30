import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { v7 as uuidv7 } from 'uuid';
import { gzipSync } from 'zlib';
import * as pgvector from 'pgvector';

import { CanonicalMemory } from './canonical-memory.entity';
import { CanonicalMemoryWorkspaceConfig } from './canonical-memory-config.entity';
import { CanonicalMemorySoftcapWarning } from './canonical-memory-softcap-warning.entity';
import { LIMITS, softCapForTier, SoftCapBehavior } from './canonical.constants';
import {
  MemoryItem,
  MemoryError,
  Provenance,
  Mode,
  Tier,
  ScopeType,
  ScopeRef,
  SearchQuery,
  ListQuery,
  RankedItem,
  Page,
  BatchResult,
  EmbeddingStatus,
} from './canonical.types';
import { validateMemoryItem } from './canonical.validator';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { EmbeddingService } from '../embedding.service';
import { CanonicalSearchHelper } from './canonical-search.helper';

export const EMBEDDING_QUEUE_NAME = 'canonical-memory-embedding';

import { PutInput } from './dto/canonical-memory.dto';
export type { PutInput };

@Injectable()
export class CanonicalMemoryService {
  private readonly logger = new Logger(CanonicalMemoryService.name);

  constructor(
    @InjectRepository(CanonicalMemory)
    private readonly repo: Repository<CanonicalMemory>,
    @InjectRepository(CanonicalMemoryWorkspaceConfig)
    private readonly configRepo: Repository<CanonicalMemoryWorkspaceConfig>,
    @InjectRepository(CanonicalMemorySoftcapWarning)
    private readonly warningRepo: Repository<CanonicalMemorySoftcapWarning>,
    @InjectQueue(EMBEDDING_QUEUE_NAME)
    private readonly embeddingQueue: Queue,
    private readonly dataSource: DataSource,
    private readonly auditLog: AuditLogService,
    private readonly embedding: EmbeddingService,
    private readonly searchHelper: CanonicalSearchHelper,
  ) {}

  // ════════════════════════════════════════════════════════════════════
  // Write path: 17-step validation pipeline (canonical-schema spec §10).
  // ════════════════════════════════════════════════════════════════════

  async put(input: PutInput, actor: { user_id?: string }): Promise<MemoryItem> {
    const now = new Date();
    const id = input.id ?? uuidv7();

    // Compute UTF-8 byte length once. Used for caps and persisted to
    // the row so the audit dashboard doesn't have to re-encode.
    const contentBytes = Buffer.byteLength(input.content, 'utf8');

    const item: MemoryItem = this.buildItem(input, id, contentBytes, now);

    // ── 1. Schema (Zod-equivalent) + 2. Mode invariants ──────────────
    const issues = validateMemoryItem(item);
    if (issues.length > 0) {
      throw new MemoryError({ kind: 'validation', issues });
    }

    // ── 3. Permission check ──────────────────────────────────────────
    // The router-level policy gate is the place for cross-cutting
    // permission checks (per-agent allow-list, scope-cross). At this
    // layer we trust the caller — the controller and gateway run
    // their own auth guards. If a future PolicyService is added it
    // wraps this method.

    // ── 4 & 5. Anti-dump: blob detection + compression ratio ─────────
    const blobKind = detectBlob(input.content);
    if (blobKind) {
      this.auditLog.log({
        organizationId: scopeToOrganizationId(item.scope_type, item.scope_id),
        userId: actor.user_id,
        action: AuditAction.MEMORY_DENIED,
        resourceType: AuditResource.MEMORY,
        resourceId: item.id,
        details: { reason: 'looks_like_blob', detected: blobKind, size: contentBytes },
      });
      throw new MemoryError({ kind: 'looks_like_blob', detected: blobKind, suggest: 'file' });
    }
    if (contentBytes > 1024) {
      // Only run gzip on non-trivial inputs — very small strings have
      // a low compressed/raw ratio simply because of header overhead,
      // not because the content is repetitive.
      const ratio = gzipSync(input.content).length / contentBytes;
      if (ratio < LIMITS.COMPRESSION_RATIO_REJECT_THRESHOLD) {
        this.auditLog.log({
          organizationId: scopeToOrganizationId(item.scope_type, item.scope_id),
          userId: actor.user_id,
          action: AuditAction.MEMORY_DENIED,
          resourceType: AuditResource.MEMORY,
          resourceId: item.id,
          details: { reason: 'compression_ratio', ratio, size: contentBytes },
        });
        throw new MemoryError({ kind: 'looks_like_blob', detected: 'binary', suggest: 'file' });
      }
    }

    // ── 6 & 7. Per-agent throttle / max single write ─────────────────
    // The throttle is currently bounded only by the per-write byte
    // ceiling — an effective stand-in for rate limiting on the
    // synchronous write path. A BullMQ-backed sliding window can be
    // layered on top later without changing the contract here.
    if (item.mode === 'memory' && contentBytes > LIMITS.AGENT_MAX_SINGLE_WRITE_BYTES_DEFAULT) {
      throw new MemoryError({
        kind: 'too_large',
        size: contentBytes,
        hard_cap: LIMITS.AGENT_MAX_SINGLE_WRITE_BYTES_DEFAULT,
        suggest: 'document',
      });
    }
    if (item.mode === 'document' && contentBytes > LIMITS.AGENT_MAX_IMPORT_BYTES_DEFAULT) {
      throw new MemoryError({
        kind: 'too_large',
        size: contentBytes,
        hard_cap: LIMITS.AGENT_MAX_IMPORT_BYTES_DEFAULT,
        suggest: 'file',
      });
    }

    // ── 8 & 9. Workspace hard cap + system ceiling ───────────────────
    const config = await this.getOrCreateConfig(item.scope_type, item.scope_id);
    const hardCap =
      item.mode === 'memory'
        ? overrideOrDefault(config.overrides, 'hard_cap_memory_bytes', LIMITS.WORKSPACE_DEFAULT_HARD_CAP_MEMORY_BYTES)
        : overrideOrDefault(config.overrides, 'hard_cap_document_bytes', LIMITS.WORKSPACE_DEFAULT_HARD_CAP_DOCUMENT_BYTES);
    if (contentBytes > hardCap) {
      throw new MemoryError({
        kind: 'too_large',
        size: contentBytes,
        hard_cap: hardCap,
        suggest: item.mode === 'memory' ? 'document' : 'file',
      });
    }
    const systemCeiling =
      item.mode === 'memory'
        ? LIMITS.SYSTEM_CEILING_MEMORY_BYTES
        : LIMITS.SYSTEM_CEILING_DOCUMENT_BYTES;
    if (contentBytes > systemCeiling) {
      throw new MemoryError({
        kind: 'too_large',
        size: contentBytes,
        hard_cap: systemCeiling,
        suggest: item.mode === 'memory' ? 'document' : 'file',
      });
    }

    // ── 10. Per-tier soft cap with workspace behavior ────────────────
    if (item.mode === 'memory' && item.tier !== null) {
      const softCap = softCapForTier(item.tier);
      if (contentBytes > softCap) {
        const behavior: SoftCapBehavior = config.softcapBehavior;
        if (behavior === 'reject') {
          throw new MemoryError({
            kind: 'too_large',
            size: contentBytes,
            soft_cap: softCap,
            hard_cap: hardCap,
            suggest: 'document',
          });
        }
        if (behavior === 'warn_log') {
          // Persist a warning row + an audit event. Both are
          // synchronous so the operator always sees the trail; if the
          // process crashes between these and the row insert we'd
          // rather have the audit than a silent oversize write.
          await this.warningRepo.save({
            memoryId: item.id,
            scopeType: item.scope_type,
            scopeId: item.scope_id,
            tier: item.tier,
            mode: item.mode,
            sizeBytes: contentBytes,
            softCap,
          } as CanonicalMemorySoftcapWarning);
          this.auditLog.log({
            organizationId: scopeToOrganizationId(item.scope_type, item.scope_id),
            userId: actor.user_id,
            action: AuditAction.MEMORY_SOFTCAP_WARNING,
            resourceType: AuditResource.MEMORY,
            resourceId: item.id,
            details: { tier: item.tier, size: contentBytes, soft_cap: softCap },
          });
        }
        // 'silent' → fall through.
      }
    }


    // ── 10b. URI scheme allow-list (per spec §4) ─────────────────────
    // Every URI in `file_refs` (memory + document mode) and the
    // `source_uri` (document mode) must use a scheme the workspace
    // permits. The default is permissive (every well-known scheme
    // allowed); admins can restrict to e.g. only `almyty:` and
    // `https:` if external references are unwanted.
    const allowed = uriSchemeAllowList(config.overrides);
    const refs: string[] = [
      ...item.file_refs,
      ...(item.source_uri ? [item.source_uri] : []),
    ];
    for (const ref of refs) {
      const scheme = parseScheme(ref);
      if (!scheme) continue; // bare path; the validator already vetted shape
      if (!allowed.has(scheme)) {
        this.auditLog.log({
          organizationId: scopeToOrganizationId(item.scope_type, item.scope_id),
          userId: actor.user_id,
          action: AuditAction.MEMORY_DENIED,
          resourceType: AuditResource.MEMORY,
          resourceId: item.id,
          details: { reason: 'uri_scheme_blocked', scheme, ref },
        });
        throw new MemoryError({
          kind: 'validation',
          issues: [{
            path: item.source_uri === ref ? 'source_uri' : 'file_refs',
            message: `URI scheme "${scheme}:" is not in this workspace's allow-list`,
          }],
        });
      }
    }
    // ── 11. Backend capability check ─────────────────────────────────
    // The native backend supports every capability declared in v1 —
    // this becomes meaningful when adapters land (Mem0 lacks
    // `bi_temporal`, etc.). For now no capability is gated.

    // ── 12. Persist (synchronous) ────────────────────────────────────
    await this.repo.save(itemToEntity(item));

    // ── 13. Enqueue async embedding job ──────────────────────────────
    // The worker pulls rows by id, calls EmbeddingService, writes the
    // vector + flips embedding_status. Skipped if the input already
    // declares `skipped` status (e.g. transfers preserving upstream
    // intent).
    if (item.embedding_status === 'pending') {
      await this.embeddingQueue.add(
        'embed',
        { memory_id: item.id },
        {
          // De-dup by id — if a row is enqueued twice (retry, sync,
          // etc.) only one job runs.
          jobId: `embed:${item.id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    }

    // ── 14. Mirror sync — handled by sync engine, out of v1 scope ────
    // ── 15. Consolidation trigger — out of v1 scope ──────────────────

    // ── 16. Audit log ────────────────────────────────────────────────
    this.auditLog.log({
      organizationId: scopeToOrganizationId(item.scope_type, item.scope_id),
      userId: actor.user_id,
      action: AuditAction.MEMORY_STORE,
      resourceType: AuditResource.MEMORY,
      resourceId: item.id,
      details: {
        mode: item.mode,
        tier: item.tier,
        scope_type: item.scope_type,
        scope_id: item.scope_id,
        size: contentBytes,
      },
    });

    // ── 17. Return ───────────────────────────────────────────────────
    return item;
  }

  // ────────────────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────────────────
  // Backend-facing entry points: take a pre-built canonical item and
  // persist it directly. Used by the router on transfer/sync where the
  // shape has already been validated upstream. The HTTP / MCP / agent
  // paths go through `put(input, actor)` (above) so the 17-step
  // pipeline runs on agent-supplied input.
  // ────────────────────────────────────────────────────────────────────

  async putCanonical(item: MemoryItem): Promise<MemoryItem> {
    const issues = validateMemoryItem(item);
    if (issues.length > 0) throw new MemoryError({ kind: 'validation', issues });
    await this.repo.save(itemToEntity(item));
    if (item.embedding_status === 'pending') {
      await this.embeddingQueue.add(
        'embed',
        { memory_id: item.id },
        { jobId: `embed:${item.id}`, attempts: 3, removeOnComplete: true },
      );
    }
    return item;
  }

  async supersedeCanonical(
    oldId: string,
    newItem: MemoryItem,
  ): Promise<{ old: MemoryItem; new: MemoryItem }> {
    const issues = validateMemoryItem(newItem);
    if (issues.length > 0) throw new MemoryError({ kind: 'validation', issues });
    const result = await this.dataSource.transaction(async (manager) => {
      const oldRow = await manager.findOne(CanonicalMemory, { where: { id: oldId } });
      if (!oldRow) throw new MemoryError({ kind: 'not_found', id: oldId });
      if (oldRow.mode !== 'memory') {
        throw new MemoryError({
          kind: 'unsupported_capability',
          backend: 'almyty-native',
          capability: 'bi_temporal',
        });
      }
      const now = new Date();
      await manager.save(itemToEntity(newItem));
      oldRow.validUntil = now;
      oldRow.supersededBy = newItem.id;
      await manager.save(oldRow);
      const refreshedOld = await manager.findOne(CanonicalMemory, { where: { id: oldId } });
      return { old: entityToItem(refreshedOld!), new: newItem };
    });
    if (result.new.embedding_status === 'pending') {
      await this.embeddingQueue.add(
        'embed',
        { memory_id: result.new.id },
        { jobId: `embed:${result.new.id}`, attempts: 3, removeOnComplete: true },
      );
    }
    return result;
  }

  async get(id: string): Promise<MemoryItem | null> {
    const row = await this.repo.findOne({ where: { id } });
    return row ? entityToItem(row) : null;
  }

  async delete(id: string, mode: 'soft' | 'hard' = 'soft', actor: { user_id?: string } = {}): Promise<boolean> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) return false;
    if (mode === 'hard') {
      await this.repo.delete({ id });
    } else {
      row.deletedAt = new Date();
      row.deletedBy = actor.user_id ?? null;
      await this.repo.save(row);
    }
    this.auditLog.log({
      organizationId: scopeToOrganizationId(row.scopeType, row.scopeId),
      userId: actor.user_id,
      action: AuditAction.MEMORY_DELETE,
      resourceType: AuditResource.MEMORY,
      resourceId: id,
      details: { mode, scope_type: row.scopeType, scope_id: row.scopeId },
    });
    return true;
  }

  // ────────────────────────────────────────────────────────────────────
  // Bi-temporal supersession.
  //
  // A "put with the same id" doesn't update content. The caller calls
  // supersede(old_id, new_item): the old row gets `valid_until = now`
  // and `superseded_by = new.id`; a new row is inserted with
  // `valid_from = now` and a fresh v7 id. Single transaction.
  // ────────────────────────────────────────────────────────────────────

  async supersede(
    oldId: string,
    newInput: PutInput,
    actor: { user_id?: string } = {},
  ): Promise<{ old: MemoryItem; new: MemoryItem }> {
    const result = await this.dataSource.transaction(async (manager) => {
      const oldRow = await manager.findOne(CanonicalMemory, { where: { id: oldId } });
      if (!oldRow) throw new MemoryError({ kind: 'not_found', id: oldId });
      if (oldRow.mode !== 'memory') {
        throw new MemoryError({
          kind: 'unsupported_capability',
          backend: 'almyty-native',
          capability: 'bi_temporal',
        });
      }
      if (oldRow.validUntil !== null) {
        throw new MemoryError({
          kind: 'conflict',
          existing_id: oldId,
          incoming_id: 'supersede',
          field: 'valid_until',
        });
      }

      const now = new Date();
      const newId = newInput.id ?? uuidv7();
      const newItem = this.buildItem(
        newInput,
        newId,
        Buffer.byteLength(newInput.content, 'utf8'),
        now,
      );
      const issues = validateMemoryItem(newItem);
      if (issues.length > 0) {
        throw new MemoryError({ kind: 'validation', issues });
      }

      // Insert the new row first so the FK reference from old.superseded_by
      // is satisfied without deferring. ON DELETE SET NULL on the FK is
      // the safety net if the new row gets later hard-deleted.
      await manager.save(itemToEntity(newItem));
      oldRow.validUntil = now;
      oldRow.supersededBy = newId;
      await manager.save(oldRow);

      // Re-fetch the (now updated) old row so we can hand back the
      // canonical shape.
      const refreshedOld = await manager.findOne(CanonicalMemory, { where: { id: oldId } });
      return { old: entityToItem(refreshedOld!), new: newItem };
    });

    if (newInput.id === undefined && result.new.embedding_status === 'pending') {
      await this.embeddingQueue.add(
        'embed',
        { memory_id: result.new.id },
        { jobId: `embed:${result.new.id}`, attempts: 3, removeOnComplete: true },
      );
    }

    this.auditLog.log({
      organizationId: scopeToOrganizationId(result.old.scope_type, result.old.scope_id),
      userId: actor.user_id,
      action: AuditAction.MEMORY_SUPERSEDE,
      resourceType: AuditResource.MEMORY,
      resourceId: result.new.id,
      details: { old_id: result.old.id, new_id: result.new.id },
    });

    return result;
  }

  // ────────────────────────────────────────────────────────────────────

  async list(query: ListQuery): Promise<Page<MemoryItem>> {
    const qb = this.repo
      .createQueryBuilder('m')
      .where('m.scope_type = :st', { st: query.scope.scope_type })
      .andWhere('m.scope_id = :sid', { sid: query.scope.scope_id });

    if (query.mode) qb.andWhere('m.mode = :mode', { mode: query.mode });
    if (query.tier) qb.andWhere('m.tier = :tier', { tier: query.tier });
    if (query.tags && query.tags.length > 0) {
      qb.andWhere('m.tags && :tags', { tags: query.tags });
    }
    if (query.since) qb.andWhere('m.created_at >= :since', { since: query.since });
    if (query.until) qb.andWhere('m.created_at <= :until', { until: query.until });
    if (!query.include_superseded) qb.andWhere('m.valid_until IS NULL');
    if (!query.include_deleted) qb.andWhere('m.deleted_at IS NULL');

    qb.orderBy('m.created_at', 'DESC');

    const limit = Math.min(query.limit ?? 50, 200);
    qb.take(limit + 1);
    if (query.cursor) {
      // Cursor is the created_at of the last row from the previous page.
      qb.andWhere('m.created_at < :cursor', { cursor: new Date(query.cursor) });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(entityToItem);
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].created_at.toISOString() : null;

    return { items, total: items.length, cursor: nextCursor };
  }

  // ────────────────────────────────────────────────────────────────────
  // Hybrid search: vector via pgvector cosine + FTS via tsvector,
  // results merged + scored. Falls back to FTS-only when the query
  // can't be embedded.
  // ────────────────────────────────────────────────────────────────────

  async search(query: SearchQuery): Promise<RankedItem[]> {
    const topK = Math.min(query.top_k ?? LIMITS.RECALL_DEFAULT_TOP_K, 100);
    const orgId = scopeToOrganizationId(query.scope.scope_type, query.scope.scope_id);
    const startedAt = Date.now();

    let queryEmbedding: number[] | null = null;
    if (!query.fts_only) {
      queryEmbedding = await this.embedding.generateEmbedding(query.query, orgId);
    }

    const results = queryEmbedding
      ? await this.searchHelper.hybridSearch(query, queryEmbedding, topK)
      : await this.searchHelper.ftsSearch(query, topK);

    // Bump access counters on the matched rows.
    if (results.length > 0) {
      const ids = results.map((r) => r.item.id);
      await this.repo
        .createQueryBuilder()
        .update(CanonicalMemory)
        .set({
          accessedAt: new Date(),
          accessCount: () => '"access_count" + 1',
        })
        .whereInIds(ids)
        .execute();
    }

    this.auditLog.log({
      organizationId: orgId,
      action: AuditAction.MEMORY_SEARCH,
      resourceType: AuditResource.MEMORY,
      // Search isn't tied to a single row; the first match (when one
      // exists) is the most useful pivot for log correlation. Empty
      // string when nothing matched — the audit table accepts it and
      // it's a clear "searched, found nothing" signal.
      resourceId: results[0]?.item.id ?? '',
      details: {
        query: query.query,
        signal: queryEmbedding ? 'hybrid' : 'fts',
        result_count: results.length,
        latency_ms: Date.now() - startedAt,
      },
    });

    return results;
  }


  // ────────────────────────────────────────────────────────────────────
  // As-of queries: fetch the row that was current at `time`.
  // ────────────────────────────────────────────────────────────────────

  async asOf(time: Date, query: ListQuery): Promise<Page<MemoryItem>> {
    const qb = this.repo
      .createQueryBuilder('m')
      .where('m.scope_type = :st', { st: query.scope.scope_type })
      .andWhere('m.scope_id = :sid', { sid: query.scope.scope_id })
      .andWhere('m.valid_from <= :t', { t: time })
      .andWhere('(m.valid_until IS NULL OR m.valid_until > :t)', { t: time })
      .andWhere('m.deleted_at IS NULL');

    if (query.mode) qb.andWhere('m.mode = :mode', { mode: query.mode });
    if (query.tier) qb.andWhere('m.tier = :tier', { tier: query.tier });
    if (query.tags && query.tags.length > 0) qb.andWhere('m.tags && :tags', { tags: query.tags });
    qb.orderBy('m.valid_from', 'DESC');

    const limit = Math.min(query.limit ?? 50, 200);
    qb.take(limit);

    const rows = await qb.getMany();
    return { items: rows.map(entityToItem), total: rows.length, cursor: null };
  }

  // ────────────────────────────────────────────────────────────────────
  // Batch ops (transfer / sync). Uses individual inserts inside a
  // transaction so partial failures roll back cleanly. Every insert
  // still runs the canonical validator — no shortcuts.
  // ────────────────────────────────────────────────────────────────────

  async batchPut(items: MemoryItem[]): Promise<BatchResult> {
    const result: BatchResult = { succeeded: 0, failed: 0, errors: [] };
    await this.dataSource.transaction(async (manager) => {
      for (const item of items) {
        const issues = validateMemoryItem(item);
        if (issues.length > 0) {
          result.failed++;
          result.errors.push({ id: item.id, error: { kind: 'validation', issues } });
          continue;
        }
        try {
          await manager.save(itemToEntity(item));
          result.succeeded++;
        } catch (e: any) {
          result.failed++;
          result.errors.push({
            id: item.id,
            error: { kind: 'backend_unavailable', backend: 'almyty-native', cause: e.message ?? String(e) },
          });
        }
      }
    });
    return result;
  }

  async batchDelete(ids: string[]): Promise<BatchResult> {
    const now = new Date();
    const result: BatchResult = { succeeded: 0, failed: 0, errors: [] };
    if (ids.length === 0) return result;

    const updated = await this.repo
      .createQueryBuilder()
      .update(CanonicalMemory)
      .set({ deletedAt: now })
      .whereInIds(ids)
      .execute();

    result.succeeded = updated.affected ?? 0;
    result.failed = ids.length - result.succeeded;
    return result;
  }

  // ────────────────────────────────────────────────────────────────────
  // Embedding worker callback: fills in vector + flips status. Called
  // by the BullMQ processor — kept here so the service owns the row's
  // lifecycle.
  // ────────────────────────────────────────────────────────────────────

  /**
   * Enqueue an async embedding job for a memory id. The same payload
   * shape `put` produces — pulled out as a method so the document
   * chunker (which inserts rows directly through DataSource and
   * bypasses `put`) can still wire embeddings without re-importing
   * the queue handle.
   */
  async enqueueEmbeddingFor(memoryId: string): Promise<void> {
    await this.embeddingQueue.add(
      'embed',
      { memory_id: memoryId },
      {
        jobId: `embed:${memoryId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  async fillEmbedding(memoryId: string): Promise<void> {
    const row = await this.repo.findOne({ where: { id: memoryId } });
    if (!row) {
      this.logger.warn(`fillEmbedding: memory ${memoryId} no longer exists`);
      return;
    }
    if (row.embeddingStatus === 'ready' || row.embeddingStatus === 'skipped') return;

    const orgId = scopeToOrganizationId(row.scopeType, row.scopeId);
    const config = await this.getOrCreateConfig(row.scopeType, row.scopeId);

    try {
      const raw = await this.embedding.generateEmbedding(row.content, orgId);
      if (!raw) {
        await this.repo.update(
          { id: memoryId },
          {
            embeddingStatus: 'failed' as EmbeddingStatus,
            embeddingError: 'embedding generation returned null',
          },
        );
        return;
      }
      // The DB column is `vector(EMBEDDING_DEFAULT_DIM)`. Normalise
      // truncate or zero-pad incoming vectors to that length so a
      // workspace using a different-dim embedder still produces
      // insertable rows. The recorded `embedding_dim` reflects the
      // raw model output so consumers know what shape to expect on
      // the read side.
      const target = LIMITS.EMBEDDING_DEFAULT_DIM;
      const normalised =
        raw.length === target
          ? raw
          : raw.length > target
            ? raw.slice(0, target)
            : raw.concat(new Array(target - raw.length).fill(0));
      await this.repo.update(
        { id: memoryId },
        {
          embedding: normalised,
          embeddingDim: raw.length,
          embeddingModel: config.embeddingModel,
          embeddingStatus: 'ready' as EmbeddingStatus,
          embeddingError: null,
        },
      );
    } catch (e: any) {
      await this.repo.update(
        { id: memoryId },
        {
          embeddingStatus: 'failed' as EmbeddingStatus,
          embeddingError: e.message ?? String(e),
        },
      );
      throw e;
    }
  }

  // ────────────────────────────────────────────────────────────────────

  async getOrCreateConfig(
    scopeType: ScopeType,
    scopeId: string,
  ): Promise<CanonicalMemoryWorkspaceConfig> {
    const existing = await this.configRepo.findOne({ where: { scopeType, scopeId } });
    if (existing) return existing;
    const created = this.configRepo.create({
      scopeType,
      scopeId,
      embeddingModel: LIMITS.EMBEDDING_DEFAULT_MODEL,
      embeddingDim: LIMITS.EMBEDDING_DEFAULT_DIM,
      embeddingProvider: 'openai',
      softcapBehavior: LIMITS.SOFTCAP_BEHAVIOR_DEFAULT,
      overrides: {},
    });
    return this.configRepo.save(created);
  }

  /**
   * Update a workspace's canonical-memory config. Used by the
   * settings UI to wire backend routing, mirror, credential ids,
   * and softcap behavior. Only the fields the caller passes are
   * touched; `overrides` is shallow-merged so partial edits don't
   * wipe sibling keys (e.g. setting routing.memory_backend leaves
   * routing.credentials in place).
   *
   * Invalidates the credentials resolver's cache so a freshly
   * wired credential id is observed on the next dispatch without
   * waiting for the TTL.
   */
  async updateConfig(
    scopeType: ScopeType,
    scopeId: string,
    patch: {
      embedding_model?: string;
      embedding_dim?: number;
      embedding_provider?: string;
      softcap_behavior?: SoftCapBehavior;
      overrides?: Record<string, unknown>;
    },
    actor: { user_id?: string } = {},
  ): Promise<CanonicalMemoryWorkspaceConfig> {
    const cfg = await this.getOrCreateConfig(scopeType, scopeId);
    if (patch.embedding_model !== undefined) cfg.embeddingModel = patch.embedding_model;
    if (patch.embedding_dim !== undefined) cfg.embeddingDim = patch.embedding_dim;
    if (patch.embedding_provider !== undefined) cfg.embeddingProvider = patch.embedding_provider;
    if (patch.softcap_behavior !== undefined) cfg.softcapBehavior = patch.softcap_behavior;
    if (patch.overrides !== undefined) {
      cfg.overrides = { ...(cfg.overrides ?? {}), ...patch.overrides };
    }
    const saved = await this.configRepo.save(cfg);

    this.auditLog.log({
      organizationId: scopeId,
      userId: actor.user_id,
      action: AuditAction.MEMORY_UPDATE,
      resourceType: AuditResource.MEMORY,
      resourceId: '',
      details: {
        scope_type: scopeType,
        scope_id: scopeId,
        config_keys: Object.keys(patch),
      },
    });
    return saved;
  }

  /**
   * List recent soft-cap warning rows for a scope. Powers the audit
   * dashboard tab — lets operators see agents that consistently
   * over-write into a tier whose soft cap they keep tripping.
   */
  async listSoftcapWarnings(
    scopeType: ScopeType,
    scopeId: string,
    limit: number = 50,
  ): Promise<CanonicalMemorySoftcapWarning[]> {
    return this.warningRepo.find({
      where: { scopeType, scopeId },
      order: { at: 'DESC' },
      take: limit,
    });
  }

  // ────────────────────────────────────────────────────────────────────

  private buildItem(
    input: PutInput,
    id: string,
    contentBytes: number,
    now: Date,
  ): MemoryItem {
    const isMemory = input.mode === 'memory';
    return {
      id,
      mode: input.mode,
      scope_type: input.scope.scope_type,
      scope_id: input.scope.scope_id,
      content: input.content,
      content_format: input.content_format ?? 'text',
      content_bytes: contentBytes,
      embedding: null,
      embedding_dim: null,
      embedding_model: null,
      embedding_status: 'pending',
      embedding_error: null,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
      file_refs: input.file_refs ?? [],
      tier: isMemory ? input.tier ?? 'short' : null,
      valid_from: isMemory ? now : null,
      valid_until: null,
      superseded_by: null,
      ttl_seconds: isMemory ? input.ttl_seconds ?? null : null,
      source_uri: !isMemory ? input.source_uri ?? null : null,
      source_version: !isMemory ? input.source_version ?? 1 : null,
      source_checksum: !isMemory ? input.source_checksum ?? null : null,
      chunk_index: !isMemory ? input.chunk_index ?? null : null,
      chunk_total: !isMemory ? input.chunk_total ?? null : null,
      chunk_of: !isMemory ? input.chunk_of ?? null : null,
      confidence: input.confidence ?? 1,
      provenance: input.provenance,
      created_at: now,
      updated_at: now,
      accessed_at: null,
      access_count: 0,
      deleted_at: null,
      deleted_by: null,
    };
  }
}

// ════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════

/**
 * Detect content that is almost certainly a binary blob the caller
 * meant to upload as a file, not a memory. Heuristic — false
 * positives are acceptable because the caller can either re-route
 * to the file API or pass `--force` (TBD).
 */
function detectBlob(content: string):
  | 'pdf'
  | 'image'
  | 'archive'
  | 'binary'
  | 'base64'
  | 'hex'
  | null {
  if (content.startsWith('%PDF-')) return 'pdf';
  if (content.startsWith('\x89PNG')) return 'image';
  if (content.startsWith('\xff\xd8\xff')) return 'image'; // JPEG SOI
  if (content.startsWith('GIF87a') || content.startsWith('GIF89a')) return 'image';
  if (content.startsWith('PK\x03\x04') || content.startsWith('PK\x05\x06')) return 'archive';
  if (content.startsWith('\x1f\x8b')) return 'archive'; // gzip
  if (content.startsWith('Rar!') || content.startsWith('7z\xbc\xaf')) return 'archive';

  // Long stretches of base64 / hex are almost always encoded blobs.
  // Trim a small slice — checking the entire 256 KB content character
  // by character would be wasteful when the heuristic only needs the
  // tail/head shape.
  const slice = content.length > 4096 ? content.slice(0, 4096) : content;
  if (slice.length >= 2048) {
    const trimmed = slice.replace(/\s+/g, '');
    if (trimmed.length >= 1024) {
      // Real base64 mixes character classes — uppercase, lowercase
      // and digits all show up in any non-trivial encoded blob.
      // A single-class run (e.g. plain lowercase prose) matches the
      // base64 regex too, so we'd false-positive on natural text.
      // Require at least two of {upper, lower, digit} before flagging.
      const isBase64Charset = /^[A-Za-z0-9+/=]+$/.test(trimmed);
      if (isBase64Charset) {
        const classes =
          (/[A-Z]/.test(trimmed) ? 1 : 0) +
          (/[a-z]/.test(trimmed) ? 1 : 0) +
          (/[0-9]/.test(trimmed) ? 1 : 0);
        if (classes >= 2) return 'base64';
      }
      if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        // Same idea for hex — letters AND digits both appear in any
        // real-world hex blob (sha256s, hex-encoded blobs, etc.).
        const classes =
          (/[a-fA-F]/.test(trimmed) ? 1 : 0) + (/[0-9]/.test(trimmed) ? 1 : 0);
        if (classes >= 2) return 'hex';
      }
    }
  }

  // Non-printable byte ratio. >= 5% of non-ASCII-control characters
  // in the first 4 KB → call it binary.
  let nonPrintable = 0;
  for (let i = 0; i < slice.length; i++) {
    const code = slice.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32)) nonPrintable++;
  }
  if (slice.length >= 256 && nonPrintable / slice.length > 0.05) return 'binary';

  return null;
}

function overrideOrDefault(
  overrides: Record<string, unknown> | null,
  key: string,
  fallback: number,
): number {
  if (!overrides) return fallback;
  const v = overrides[key];
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return fallback;
}

/**
 * Default URI schemes a workspace allows. The list is the
 * permissive superset documented in spec §4 (almyty:, file:,
 * https:, gdrive:, notion:, git:, s3:). Admins can override via
 * `overrides.allowed_uri_schemes` — a string[] that, when present,
 * replaces this default entirely (no merge, so an admin who wants
 * only `almyty` and `https` writes ['almyty','https']).
 */
const DEFAULT_URI_SCHEMES: ReadonlyArray<string> = [
  'almyty', 'file', 'https', 'http', 'gdrive', 'notion', 'git', 's3',
];

function uriSchemeAllowList(overrides: Record<string, unknown> | null): Set<string> {
  if (overrides && Array.isArray((overrides as any).allowed_uri_schemes)) {
    const list = (overrides as any).allowed_uri_schemes as unknown[];
    return new Set(list.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase()));
  }
  return new Set(DEFAULT_URI_SCHEMES);
}

function parseScheme(uri: string): string | null {
  const m = /^([a-z][a-z0-9+\-.]*):/i.exec(uri);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Map a (scope_type, scope_id) to the organization id that the
 * audit-log service expects. For `workspace` and `project` scopes
 * the convention is to encode the organization id into scope_id;
 * for `user` and `collab` the audit log doesn't carry a tenant
 * slot and uses the scope id directly. The audit row is non-fatal
 * either way — the service swallows write failures.
 */
function scopeToOrganizationId(scopeType: ScopeType, scopeId: string): string {
  return scopeId;
}

function itemToEntity(item: MemoryItem): CanonicalMemory {
  const e = new CanonicalMemory();
  e.id = item.id;
  e.mode = item.mode;
  e.scopeType = item.scope_type;
  e.scopeId = item.scope_id;
  e.content = item.content;
  e.contentFormat = item.content_format;
  e.contentBytes = item.content_bytes;
  e.embedding = item.embedding;
  e.embeddingDim = item.embedding_dim;
  e.embeddingModel = item.embedding_model;
  e.embeddingStatus = item.embedding_status;
  e.embeddingError = item.embedding_error;
  e.tags = item.tags;
  e.metadata = item.metadata;
  e.fileRefs = item.file_refs;
  e.tier = item.tier;
  e.validFrom = item.valid_from;
  e.validUntil = item.valid_until;
  e.supersededBy = item.superseded_by;
  e.ttlSeconds = item.ttl_seconds;
  e.sourceUri = item.source_uri;
  e.sourceVersion = item.source_version;
  e.sourceChecksum = item.source_checksum;
  e.chunkIndex = item.chunk_index;
  e.chunkTotal = item.chunk_total;
  e.chunkOf = item.chunk_of;
  e.confidence = item.confidence;
  e.provenance = item.provenance;
  e.createdAt = item.created_at;
  e.updatedAt = item.updated_at;
  e.accessedAt = item.accessed_at;
  e.accessCount = item.access_count;
  e.deletedAt = item.deleted_at;
  e.deletedBy = item.deleted_by;
  return e;
}

export function entityToItem(e: CanonicalMemory): MemoryItem {
  return {
    id: e.id,
    mode: e.mode,
    scope_type: e.scopeType,
    scope_id: e.scopeId,
    content: e.content,
    content_format: e.contentFormat,
    content_bytes: e.contentBytes,
    embedding: e.embedding,
    embedding_dim: e.embeddingDim,
    embedding_model: e.embeddingModel,
    embedding_status: e.embeddingStatus,
    embedding_error: e.embeddingError,
    tags: e.tags ?? [],
    metadata: e.metadata ?? {},
    file_refs: e.fileRefs ?? [],
    tier: e.tier,
    valid_from: e.validFrom,
    valid_until: e.validUntil,
    superseded_by: e.supersededBy,
    ttl_seconds: e.ttlSeconds,
    source_uri: e.sourceUri,
    source_version: e.sourceVersion,
    source_checksum: e.sourceChecksum,
    chunk_index: e.chunkIndex,
    chunk_total: e.chunkTotal,
    chunk_of: e.chunkOf,
    confidence: typeof e.confidence === 'string' ? parseFloat(e.confidence) : e.confidence,
    provenance: e.provenance,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    accessed_at: e.accessedAt,
    access_count: e.accessCount,
    deleted_at: e.deletedAt,
    deleted_by: e.deletedBy,
  };
}

/**
 * Translate a raw row from `dataSource.query()` (snake_case columns,
 * embedding as text) into the entity shape so `entityToItem` can
 * normalize it.
 */
export function rowToEntity(row: Record<string, any>): CanonicalMemory {
  const e = new CanonicalMemory();
  e.id = row.id;
  e.mode = row.mode;
  e.scopeType = row.scope_type;
  e.scopeId = row.scope_id;
  e.content = row.content;
  e.contentFormat = row.content_format;
  e.contentBytes = row.content_bytes;
  e.embedding = row.embedding ? pgvector.fromSql(row.embedding) : null;
  e.embeddingDim = row.embedding_dim;
  e.embeddingModel = row.embedding_model;
  e.embeddingStatus = row.embedding_status;
  e.embeddingError = row.embedding_error;
  e.tags = row.tags ?? [];
  e.metadata = row.metadata ?? {};
  e.fileRefs = row.file_refs ?? [];
  e.tier = row.tier;
  e.validFrom = row.valid_from ? new Date(row.valid_from) : null;
  e.validUntil = row.valid_until ? new Date(row.valid_until) : null;
  e.supersededBy = row.superseded_by;
  e.ttlSeconds = row.ttl_seconds;
  e.sourceUri = row.source_uri;
  e.sourceVersion = row.source_version;
  e.sourceChecksum = row.source_checksum;
  e.chunkIndex = row.chunk_index;
  e.chunkTotal = row.chunk_total;
  e.chunkOf = row.chunk_of;
  e.confidence = typeof row.confidence === 'string' ? parseFloat(row.confidence) : row.confidence;
  e.provenance = row.provenance;
  e.createdAt = new Date(row.created_at);
  e.updatedAt = new Date(row.updated_at);
  e.accessedAt = row.accessed_at ? new Date(row.accessed_at) : null;
  e.accessCount = row.access_count ?? 0;
  e.deletedAt = row.deleted_at ? new Date(row.deleted_at) : null;
  e.deletedBy = row.deleted_by;
  return e;
}
