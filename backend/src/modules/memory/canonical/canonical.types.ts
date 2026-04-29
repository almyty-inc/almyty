/**
 * Canonical memory schema — v1.
 *
 * The lingua franca every memory backend translates to and from.
 * See `canonical-schema.md` for the full spec; this file holds the
 * machine-checked surface: enums, the `MemoryItem` interface, the
 * provenance shape, capability set, and the `MemoryError` union.
 *
 * Validation lives in `canonical.validator.ts` (mode invariants,
 * bi-temporal sanity, embedding/chunk consistency). HTTP DTOs in
 * `canonical-memory.dto.ts` use class-validator decorators because
 * that's the project-wide convention; the canonical shape itself
 * is a plain TypeScript interface so backends and the worker can
 * pass it around without ValidationPipe round-trips.
 */

// ── enums ───────────────────────────────────────────────────────────────

export type Mode = 'memory' | 'document';
export const MODE_VALUES: readonly Mode[] = ['memory', 'document'] as const;

export type Tier = 'short' | 'project' | 'long' | 'shared';
export const TIER_VALUES: readonly Tier[] = ['short', 'project', 'long', 'shared'] as const;

export type ScopeType = 'user' | 'workspace' | 'project' | 'collab';
export const SCOPE_TYPE_VALUES: readonly ScopeType[] = ['user', 'workspace', 'project', 'collab'] as const;

export type ContentFormat = 'text' | 'markdown' | 'json';
export const CONTENT_FORMAT_VALUES: readonly ContentFormat[] = ['text', 'markdown', 'json'] as const;

export type CreatedBy =
  | 'user'
  | 'agent'
  | 'consolidation'
  | 'transfer'
  | 'sync'
  | 'import';
export const CREATED_BY_VALUES: readonly CreatedBy[] = [
  'user', 'agent', 'consolidation', 'transfer', 'sync', 'import',
] as const;

export type EmbeddingStatus = 'pending' | 'ready' | 'failed' | 'skipped';
export const EMBEDDING_STATUS_VALUES: readonly EmbeddingStatus[] = [
  'pending', 'ready', 'failed', 'skipped',
] as const;

// ── provenance ──────────────────────────────────────────────────────────

export interface Provenance {
  agent_id: string | null;
  session_id: string | null;
  collab_id: string | null;
  /** Model that produced or wrote the memory, e.g. 'claude-opus-4-7' */
  model: string | null;
  /** Provider id, e.g. 'anthropic' / 'openai' */
  provider: string | null;
  /** Tool chain that led to this write, oldest → newest */
  tool_chain: string[];
  created_by: CreatedBy;
  /** Backend id that captured this item (set by the router on ingest) */
  source_backend: string | null;
}

// ── canonical Memory item ───────────────────────────────────────────────

export interface MemoryItem {
  // identity
  id: string;            // UUID v7, time-sortable
  mode: Mode;

  // scoping
  scope_type: ScopeType;
  scope_id: string;      // non-empty

  // content
  content: string;       // soft-cap enforced at write
  content_format: ContentFormat;
  content_bytes: number; // computed UTF-8 byte length

  // embedding (async-populated)
  // Stored as a pgvector column. Plain number[] is the JS shape:
  // pgvector serializes to/from `[1,2,3]` text via the entity's
  // transformer, so the application code stays array-typed.
  embedding: number[] | null;
  embedding_dim: number | null;
  embedding_model: string | null;
  embedding_status: EmbeddingStatus;
  embedding_error: string | null;

  // tags & arbitrary metadata
  tags: string[];
  metadata: Record<string, unknown>;

  // file references (Almyty Files URIs that this memory points at)
  file_refs: string[];

  // memory-mode-only fields (NULL for document mode)
  tier: Tier | null;
  valid_from: Date | null;
  valid_until: Date | null;
  superseded_by: string | null; // UUID
  ttl_seconds: number | null;

  // document-mode-only fields (NULL for memory mode)
  source_uri: string | null;
  source_version: number | null;
  source_checksum: string | null;
  chunk_index: number | null;
  chunk_total: number | null;
  chunk_of: string | null;      // UUID

  // quality / lifecycle
  confidence: number;            // [0,1]
  provenance: Provenance;
  created_at: Date;
  updated_at: Date;
  accessed_at: Date | null;
  access_count: number;

  // soft-delete (separate from supersession)
  deleted_at: Date | null;
  deleted_by: string | null;
}

// ── capabilities ────────────────────────────────────────────────────────

export type Capability =
  // modes
  | 'mode_memory'
  | 'mode_document'
  // retrieval
  | 'vector_search'
  | 'fts'
  | 'hybrid_search'
  | 'graph_search'
  // semantics
  | 'bi_temporal'
  | 'ttl'
  | 'soft_delete'
  | 'as_of_queries'
  | 'transactional_writes'
  // scoping
  | 'shared_scope'
  | 'multi_tenant'
  // operational
  | 'streaming_writes'
  | 'batch_writes'
  | 'change_feed'
  | 'export';

export const CAPABILITY_VALUES: readonly Capability[] = [
  'mode_memory', 'mode_document',
  'vector_search', 'fts', 'hybrid_search', 'graph_search',
  'bi_temporal', 'ttl', 'soft_delete', 'as_of_queries', 'transactional_writes',
  'shared_scope', 'multi_tenant',
  'streaming_writes', 'batch_writes', 'change_feed', 'export',
] as const;

// ── error taxonomy ──────────────────────────────────────────────────────

export type MemoryErrorTag =
  | { kind: 'not_found'; id: string }
  | { kind: 'permission_denied'; reason: string; policy_id?: string }
  | { kind: 'backend_unavailable'; backend: string; cause: string }
  | { kind: 'validation'; issues: ValidationIssue[] }
  | { kind: 'conflict'; existing_id: string; incoming_id: string; field: string }
  | { kind: 'rate_limited'; backend: string; retry_after_ms: number }
  | { kind: 'transfer_aborted'; reason: string; checkpoint?: string }
  | { kind: 'unsupported_capability'; backend: string; capability: Capability }
  | {
      kind: 'too_large';
      size: number;
      soft_cap?: number;
      hard_cap: number;
      suggest?: 'document' | 'file';
    }
  | {
      kind: 'looks_like_blob';
      detected: 'pdf' | 'image' | 'archive' | 'binary' | 'base64' | 'hex';
      suggest: 'file';
    }
  | {
      kind: 'soft_cap_exceeded';
      size: number;
      soft_cap: number;
      behavior: 'warn_log';
    }
  | { kind: 'embedding_failed'; backend: string; cause: string };

export interface ValidationIssue {
  /** Dot-path to the field, e.g. `tier`, `valid_from`, `provenance.created_by` */
  path: string;
  message: string;
}

export class MemoryError extends Error {
  constructor(public readonly tag: MemoryErrorTag) {
    super(`${tag.kind}: ${JSON.stringify(tag)}`);
    this.name = 'MemoryError';
  }
}

// ── canonical schema version ────────────────────────────────────────────

/**
 * Bumped when the on-disk shape changes. Backends declare the schema
 * version they support; the router refuses to mount one declaring an
 * older version than the current canonical.
 */
export const CANONICAL_SCHEMA_VERSION = 1 as const;

// ── reference shapes for adapter contracts ──────────────────────────────

export interface ScopeRef {
  scope_type: ScopeType;
  scope_id: string;
}

export interface ListQuery {
  scope: ScopeRef;
  mode?: Mode;
  tier?: Tier;
  tags?: string[];
  /** ISO timestamp lower bound (inclusive) on created_at */
  since?: Date;
  /** ISO timestamp upper bound (inclusive) on created_at */
  until?: Date;
  /** Show superseded rows. Default: false */
  include_superseded?: boolean;
  /** Show soft-deleted rows. Default: false */
  include_deleted?: boolean;
  limit?: number;
  cursor?: string | null;
}

export interface SearchQuery {
  scope: ScopeRef;
  query: string;
  mode?: Mode;
  tier?: Tier;
  tags?: string[];
  top_k?: number;
  /** Default: false. When true, run FTS-only and skip embedding lookup */
  fts_only?: boolean;
}

export interface RankedItem {
  item: MemoryItem;
  score: number;
  /** Which retrieval signal produced the score: 'vector' | 'fts' | 'hybrid' */
  signal: 'vector' | 'fts' | 'hybrid';
}

export interface Page<T> {
  items: T[];
  total: number;
  cursor: string | null;
}

export interface BatchResult {
  succeeded: number;
  failed: number;
  errors: Array<{ id: string; error: MemoryErrorTag }>;
}

export interface MemoryChangeEvent {
  op: 'put' | 'delete' | 'supersede';
  item: MemoryItem;
  at: Date;
}
