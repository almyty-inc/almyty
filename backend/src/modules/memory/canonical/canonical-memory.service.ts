import { Inject, forwardRef } from '@nestjs/common';
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
import {
  detectBlob,
  overrideOrDefault,
  uriSchemeAllowList,
  parseScheme,
  scopeToOrganizationId,
  itemToEntity,
  entityToItem,
} from './canonical-memory.helpers';
import { EmbeddingService } from '../embedding.service';
import { CanonicalSearchHelper } from './canonical-search.helper';
import { CanonicalMemoryOpsHelper } from './canonical-ops.helper';
import { CanonicalPutValidators } from './canonical-put-validators.helper';

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
    @Inject(forwardRef(() => CanonicalMemoryOpsHelper))
    @Inject(forwardRef(() => CanonicalMemoryOpsHelper))
    private readonly opsHelper: CanonicalMemoryOpsHelper,
    private readonly putValidators: CanonicalPutValidators,
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

    // ── 4-10b. Validation pipeline (blob, caps, soft cap, URI) ───────
    const config = await this.getOrCreateConfig(item.scope_type, item.scope_id);
    await this.putValidators.run(item, input, contentBytes, actor, config);
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

  // ── Delegations to CanonicalMemoryOpsHelper ──
  enqueueEmbeddingFor(...args: Parameters<CanonicalMemoryOpsHelper['enqueueEmbeddingFor']>) { return this.opsHelper.enqueueEmbeddingFor(...args); }
  fillEmbedding(...args: Parameters<CanonicalMemoryOpsHelper['fillEmbedding']>) { return this.opsHelper.fillEmbedding(...args); }
  getOrCreateConfig(...args: Parameters<CanonicalMemoryOpsHelper['getOrCreateConfig']>) { return this.opsHelper.getOrCreateConfig(...args); }
  updateConfig(...args: Parameters<CanonicalMemoryOpsHelper['updateConfig']>) { return this.opsHelper.updateConfig(...args); }
  listSoftcapWarnings(...args: Parameters<CanonicalMemoryOpsHelper['listSoftcapWarnings']>) { return this.opsHelper.listSoftcapWarnings(...args); }
}

// ════════════════════════════════════════════════════════════════════════
export { detectBlob, overrideOrDefault, uriSchemeAllowList, parseScheme, scopeToOrganizationId, entityToItem, rowToEntity, itemToEntity } from './canonical-memory.helpers';