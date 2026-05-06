import * as pgvector from 'pgvector';
import { CanonicalMemory } from './canonical-memory.entity';
import { MemoryItem, Provenance, ScopeType } from './canonical.types';

// Helpers
// ════════════════════════════════════════════════════════════════════════

/**
 * Detect content that is almost certainly a binary blob the caller
 * meant to upload as a file, not a memory. Heuristic — false
 * positives are acceptable because the caller can either re-route
 * to the file API or pass `--force` (TBD).
 */
export function detectBlob(content: string):
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

export function overrideOrDefault(
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

export function uriSchemeAllowList(overrides: Record<string, unknown> | null): Set<string> {
  if (overrides && Array.isArray((overrides as any).allowed_uri_schemes)) {
    const list = (overrides as any).allowed_uri_schemes as unknown[];
    return new Set(list.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase()));
  }
  return new Set(DEFAULT_URI_SCHEMES);
}

export function parseScheme(uri: string): string | null {
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
export function scopeToOrganizationId(scopeType: ScopeType, scopeId: string): string {
  return scopeId;
}

export function itemToEntity(item: MemoryItem): CanonicalMemory {
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
