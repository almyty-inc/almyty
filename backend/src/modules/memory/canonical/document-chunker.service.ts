import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'crypto';

import { CanonicalMemory } from './canonical-memory.entity';
import { LIMITS } from './canonical.constants';
import {
  MemoryError,
  MemoryItem,
  Provenance,
  ScopeRef,
} from './canonical.types';
import { CanonicalMemoryService } from './canonical-memory.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';

export interface ImportSourceInput {
  scope: ScopeRef;
  /** URI the source originated from (`almyty:file/{id}`, `https://...`, etc.) */
  source_uri: string;
  /** Full source text. Chunker splits it. */
  content: string;
  /** Optional `text` / `markdown` / `json` rendering hint. Default `text`. */
  content_format?: 'text' | 'markdown' | 'json';
  /** When true, ignore the unchanged-checksum skip and re-import. */
  force?: boolean;
  /** Provenance carried onto every chunk. */
  provenance: Provenance;
  /** Override default chunk size in tokens (≈ chars / 4). */
  chunk_tokens?: number;
}

export interface ImportSourceResult {
  source_uri: string;
  source_version: number;
  chunks_inserted: number;
  parent_id: string;
  /** When true, the source was unchanged and nothing was rewritten. */
  skipped: boolean;
  /** sha256 of the source text. */
  source_checksum: string;
}

/**
 * Document chunker + atomic re-import.
 *
 * Spec §7 (document mode):
 *   - Source URI is required and immutable. A document chunk
 *     belongs to exactly one source.
 *   - Re-importing a source bumps `source_version`; old chunks are
 *     deleted (or kept if user opts for version retention).
 *   - Chunks are leaves. A `chunk_of` value points to a parent item
 *     with `chunk_index = NULL` and `chunk_total = total`.
 *   - Atomic re-import: either all new chunks land or none do.
 *   - Source checksum stored per chunk; re-import skips unchanged
 *     sources unless `force=true`.
 */
@Injectable()
export class DocumentChunkerService {
  private readonly logger = new Logger(DocumentChunkerService.name);

  constructor(
    @InjectRepository(CanonicalMemory)
    private readonly repo: Repository<CanonicalMemory>,
    private readonly dataSource: DataSource,
    private readonly memoryService: CanonicalMemoryService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Import (or re-import) a document source as a parent + chunk
   * tree. Atomic: the parent + every chunk are written in a single
   * DB transaction, and the previous version's rows are deleted in
   * the same transaction. If anything fails, nothing is persisted.
   */
  async importSource(input: ImportSourceInput): Promise<ImportSourceResult> {
    const checksum = sha256(input.content);
    const chunkTokens = input.chunk_tokens ?? LIMITS.CHUNK_DEFAULT_TOKENS;

    // ── Skip-if-unchanged: locate the existing parent (if any) ──
    const existingParent = await this.repo.findOne({
      where: {
        scopeType: input.scope.scope_type,
        scopeId: input.scope.scope_id,
        sourceUri: input.source_uri,
        chunkOf: IsNull(), // parents have no chunk_of
        mode: 'document',
      },
      order: { sourceVersion: 'DESC' },
    });

    if (
      existingParent &&
      existingParent.sourceChecksum === checksum &&
      !input.force
    ) {
      // Unchanged source — count chunks for the report and return.
      const chunkCount = await this.repo.count({
        where: { chunkOf: existingParent.id, mode: 'document' },
      });
      return {
        source_uri: input.source_uri,
        source_version: existingParent.sourceVersion ?? 1,
        chunks_inserted: chunkCount,
        parent_id: existingParent.id,
        skipped: true,
        source_checksum: checksum,
      };
    }

    const nextVersion = (existingParent?.sourceVersion ?? 0) + 1;
    const chunks = chunkText(input.content, chunkTokens);
    if (chunks.length === 0) {
      throw new MemoryError({
        kind: 'validation',
        issues: [{ path: 'content', message: 'document content is empty' }],
      });
    }

    const now = new Date();
    const parentId = uuidv7();
    const parentItem = this.buildParent(input, parentId, checksum, nextVersion, chunks.length, now);

    const chunkItems: MemoryItem[] = chunks.map((text, idx) =>
      this.buildChunk(input, parentId, text, idx, chunks.length, checksum, nextVersion, now),
    );

    // ── Atomic transaction: delete prior rows + insert new tree ──
    await this.dataSource.transaction(async (manager) => {
      if (existingParent) {
        // chunk_of has ON DELETE CASCADE → deleting the parent
        // sweeps every chunk whose chunk_of points at it.
        await manager.delete(CanonicalMemory, { id: existingParent.id });
      }
      await manager.insert(CanonicalMemory, this.toEntity(parentItem));
      // Chunk a chunk insert into batches of 200 so a 5k-chunk
      // import (a 2 MB markdown file at 400-token chunks) doesn't
      // hit the libpq parameter cap.
      const BATCH = 200;
      for (let i = 0; i < chunkItems.length; i += BATCH) {
        const slice = chunkItems.slice(i, i + BATCH).map((c) => this.toEntity(c));
        await manager.insert(CanonicalMemory, slice);
      }
    });

    // Enqueue embedding jobs (parent + chunks) outside the
    // transaction — BullMQ doesn't share the DB tx.
    for (const item of [parentItem, ...chunkItems]) {
      await this.memoryService.enqueueEmbeddingFor(item.id);
    }

    this.auditLog.log({
      organizationId: input.scope.scope_id,
      action: AuditAction.MEMORY_STORE,
      resourceType: AuditResource.MEMORY,
      resourceId: parentId,
      details: {
        op: 'document_import',
        source_uri: input.source_uri,
        source_version: nextVersion,
        chunks: chunks.length,
        replaced_previous: !!existingParent,
      },
    });

    return {
      source_uri: input.source_uri,
      source_version: nextVersion,
      chunks_inserted: chunks.length,
      parent_id: parentId,
      skipped: false,
      source_checksum: checksum,
    };
  }

  // ────────────────────────────────────────────────────────────

  private buildParent(
    input: ImportSourceInput,
    id: string,
    checksum: string,
    version: number,
    chunkTotal: number,
    now: Date,
  ): MemoryItem {
    const content = `# ${input.source_uri}\n\nDocument with ${chunkTotal} chunks (v${version}).`;
    return {
      id,
      mode: 'document',
      scope_type: input.scope.scope_type,
      scope_id: input.scope.scope_id,
      content,
      content_format: 'markdown',
      content_bytes: Buffer.byteLength(content, 'utf8'),
      embedding: null, embedding_dim: null, embedding_model: null,
      embedding_status: 'pending', embedding_error: null,
      tags: [], metadata: { is_parent: true }, file_refs: [],
      tier: null, valid_from: null, valid_until: null,
      superseded_by: null, ttl_seconds: null,
      source_uri: input.source_uri,
      source_version: version,
      source_checksum: checksum,
      chunk_index: null,
      chunk_total: chunkTotal,
      chunk_of: null,
      confidence: 1,
      provenance: input.provenance,
      created_at: now,
      updated_at: now,
      accessed_at: null,
      access_count: 0,
      deleted_at: null,
      deleted_by: null,
    };
  }

  private buildChunk(
    input: ImportSourceInput,
    parentId: string,
    text: string,
    idx: number,
    total: number,
    checksum: string,
    version: number,
    now: Date,
  ): MemoryItem {
    return {
      id: uuidv7(),
      mode: 'document',
      scope_type: input.scope.scope_type,
      scope_id: input.scope.scope_id,
      content: text,
      content_format: input.content_format ?? 'text',
      content_bytes: Buffer.byteLength(text, 'utf8'),
      embedding: null, embedding_dim: null, embedding_model: null,
      embedding_status: 'pending', embedding_error: null,
      tags: [], metadata: {}, file_refs: [],
      tier: null, valid_from: null, valid_until: null,
      superseded_by: null, ttl_seconds: null,
      source_uri: input.source_uri,
      source_version: version,
      source_checksum: checksum,
      chunk_index: idx,
      chunk_total: total,
      chunk_of: parentId,
      confidence: 1,
      provenance: input.provenance,
      created_at: now,
      updated_at: now,
      accessed_at: null,
      access_count: 0,
      deleted_at: null,
      deleted_by: null,
    };
  }

  private toEntity(item: MemoryItem): CanonicalMemory {
    const e = new CanonicalMemory();
    e.id = item.id;
    e.mode = item.mode;
    e.scopeType = item.scope_type;
    e.scopeId = item.scope_id;
    e.content = item.content;
    e.contentFormat = item.content_format;
    e.contentBytes = item.content_bytes;
    e.embedding = null;
    e.embeddingDim = null;
    e.embeddingModel = null;
    e.embeddingStatus = item.embedding_status;
    e.embeddingError = null;
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
}

// ──────────────────────────────────────────────────────────────

/**
 * Split `content` into chunks of approximately `tokens` tokens
 * each. We use a 4-chars-per-token rule of thumb (close enough for
 * English text + code; the backend doesn't see the exact tokenizer
 * any embedding model uses) plus a hard byte cap so a single chunk
 * never exceeds `LIMITS.CHUNK_HARD_CAP_BYTES`.
 *
 * Strategy:
 *  1. Split on paragraph (`\n\n`) boundaries first — keeps related
 *     sentences together.
 *  2. Greedily pack paragraphs into a chunk until the byte budget
 *     would be exceeded; flush and start a new chunk.
 *  3. A paragraph that on its own exceeds the budget is force-split
 *     on sentence boundaries; if it still exceeds, it's hard-split
 *     by character count.
 *  4. Apply `CHUNK_DEFAULT_OVERLAP_TOKENS` worth of trailing context
 *     from the previous chunk to the next, so retrieval over a
 *     boundary doesn't lose recall.
 */
export function chunkText(content: string, targetTokens: number): string[] {
  const targetBytes = Math.min(targetTokens * 4, LIMITS.CHUNK_HARD_CAP_BYTES);
  const overlapBytes = LIMITS.CHUNK_DEFAULT_OVERLAP_TOKENS * 4;

  if (!content || content.length === 0) return [];

  // First split on blank lines.
  const paragraphs = content.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];
  let buf = '';

  const flush = () => {
    if (buf.length > 0) {
      chunks.push(buf);
      buf = '';
    }
  };

  for (const para of paragraphs) {
    const paraBytes = Buffer.byteLength(para, 'utf8');
    if (paraBytes > targetBytes) {
      // Paragraph alone exceeds the budget — force-split.
      flush();
      const parts = splitOversized(para, targetBytes);
      for (const part of parts) chunks.push(part);
      continue;
    }
    if (Buffer.byteLength(buf, 'utf8') + 2 + paraBytes > targetBytes) {
      flush();
    }
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  flush();

  // Apply overlap: prepend the last `overlapBytes` of chunk i-1 to chunk i.
  if (overlapBytes > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const tail = prev.slice(Math.max(0, prev.length - Math.floor(overlapBytes / 2)));
      // Cut at a whitespace boundary so the overlap is readable.
      const ws = tail.indexOf(' ');
      const overlap = ws > 0 ? tail.slice(ws + 1) : tail;
      if (overlap.length > 0) {
        chunks[i] = `…${overlap}\n\n${chunks[i]}`;
      }
    }
  }

  return chunks;
}

function splitOversized(para: string, maxBytes: number): string[] {
  // Try sentence boundaries first.
  const sentences = para.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (Buffer.byteLength(buf, 'utf8') + 1 + Buffer.byteLength(s, 'utf8') > maxBytes) {
      if (buf.length > 0) out.push(buf);
      // If s alone is still too big, hard-split by chars.
      if (Buffer.byteLength(s, 'utf8') > maxBytes) {
        for (let i = 0; i < s.length; i += maxBytes) {
          out.push(s.slice(i, i + maxBytes));
        }
        buf = '';
      } else {
        buf = s;
      }
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
