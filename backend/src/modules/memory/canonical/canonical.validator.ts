/**
 * Canonical schema validator. The `MemoryItem` shape is a plain TS
 * interface (not Zod) so the same object can be passed through the
 * embedding worker, sync engine, and backend adapters without
 * round-tripping through a parser. This validator runs the same
 * cross-field rules the Zod refinement in the spec describes.
 *
 * The HTTP boundary uses class-validator DTOs (project convention);
 * the DTO is mapped into a `MemoryItem`-shaped object and then this
 * validator runs the mode invariants, bi-temporal sanity, embedding
 * consistency, and chunk consistency.
 */

import {
  MemoryItem,
  ValidationIssue,
  MODE_VALUES,
  TIER_VALUES,
  SCOPE_TYPE_VALUES,
  CONTENT_FORMAT_VALUES,
  CREATED_BY_VALUES,
  EMBEDDING_STATUS_VALUES,
} from './canonical.types';
import { LIMITS } from './canonical.constants';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function isInt(n: unknown): n is number {
  return isFiniteNumber(n) && Number.isInteger(n);
}

function isDate(d: unknown): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/**
 * Run the full canonical validation. Returns an array of issues —
 * empty means valid. Mirrors the spec's Zod refinement order.
 */
export function validateMemoryItem(item: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (item === null || typeof item !== 'object') {
    issues.push({ path: '', message: 'memory item must be an object' });
    return issues;
  }
  const m = item as Partial<MemoryItem>;

  // ── identity ────────────────────────────────────────────────────────
  if (!isUuid(m.id)) {
    issues.push({ path: 'id', message: 'id must be a UUID' });
  }
  if (typeof m.mode !== 'string' || !(MODE_VALUES as readonly string[]).includes(m.mode)) {
    issues.push({ path: 'mode', message: `mode must be one of ${MODE_VALUES.join('|')}` });
  }

  // ── scoping ─────────────────────────────────────────────────────────
  if (
    typeof m.scope_type !== 'string' ||
    !(SCOPE_TYPE_VALUES as readonly string[]).includes(m.scope_type)
  ) {
    issues.push({ path: 'scope_type', message: `scope_type must be one of ${SCOPE_TYPE_VALUES.join('|')}` });
  }
  if (typeof m.scope_id !== 'string' || m.scope_id.length === 0) {
    issues.push({ path: 'scope_id', message: 'scope_id must be a non-empty string' });
  }

  // ── content ─────────────────────────────────────────────────────────
  if (typeof m.content !== 'string' || m.content.length === 0) {
    issues.push({ path: 'content', message: 'content must be a non-empty string' });
  }
  if (
    typeof m.content_format !== 'string' ||
    !(CONTENT_FORMAT_VALUES as readonly string[]).includes(m.content_format)
  ) {
    issues.push({
      path: 'content_format',
      message: `content_format must be one of ${CONTENT_FORMAT_VALUES.join('|')}`,
    });
  }
  if (!isInt(m.content_bytes) || (m.content_bytes as number) < 0) {
    issues.push({ path: 'content_bytes', message: 'content_bytes must be a non-negative integer' });
  }

  // ── embedding ───────────────────────────────────────────────────────
  if (m.embedding !== null && m.embedding !== undefined) {
    if (!Array.isArray(m.embedding)) {
      issues.push({ path: 'embedding', message: 'embedding must be an array of numbers or null' });
    } else if (!m.embedding.every((n) => isFiniteNumber(n))) {
      issues.push({ path: 'embedding', message: 'embedding must contain only finite numbers' });
    }
  }
  if (m.embedding_dim !== null && m.embedding_dim !== undefined) {
    if (!isInt(m.embedding_dim) || (m.embedding_dim as number) <= 0) {
      issues.push({ path: 'embedding_dim', message: 'embedding_dim must be a positive integer or null' });
    } else if (
      (m.embedding_dim as number) < LIMITS.EMBEDDING_MIN_DIM ||
      (m.embedding_dim as number) > LIMITS.EMBEDDING_MAX_DIM
    ) {
      issues.push({
        path: 'embedding_dim',
        message: `embedding_dim must be in [${LIMITS.EMBEDDING_MIN_DIM}, ${LIMITS.EMBEDDING_MAX_DIM}]`,
      });
    }
  }
  if (
    typeof m.embedding_status !== 'string' ||
    !(EMBEDDING_STATUS_VALUES as readonly string[]).includes(m.embedding_status)
  ) {
    issues.push({
      path: 'embedding_status',
      message: `embedding_status must be one of ${EMBEDDING_STATUS_VALUES.join('|')}`,
    });
  }

  // ── tags / metadata / file_refs ─────────────────────────────────────
  if (!Array.isArray(m.tags) || !m.tags.every((t) => typeof t === 'string')) {
    issues.push({ path: 'tags', message: 'tags must be a string[]' });
  }
  if (m.metadata === null || typeof m.metadata !== 'object' || Array.isArray(m.metadata)) {
    issues.push({ path: 'metadata', message: 'metadata must be an object' });
  }
  if (!Array.isArray(m.file_refs) || !m.file_refs.every((u) => typeof u === 'string')) {
    issues.push({ path: 'file_refs', message: 'file_refs must be a string[]' });
  }

  // ── memory-mode-only fields ─────────────────────────────────────────
  if (m.tier !== null && m.tier !== undefined) {
    if (!(TIER_VALUES as readonly string[]).includes(m.tier as string)) {
      issues.push({ path: 'tier', message: `tier must be one of ${TIER_VALUES.join('|')} or null` });
    }
  }
  if (m.valid_from !== null && m.valid_from !== undefined && !isDate(m.valid_from)) {
    issues.push({ path: 'valid_from', message: 'valid_from must be a Date or null' });
  }
  if (m.valid_until !== null && m.valid_until !== undefined && !isDate(m.valid_until)) {
    issues.push({ path: 'valid_until', message: 'valid_until must be a Date or null' });
  }
  if (m.superseded_by !== null && m.superseded_by !== undefined && !isUuid(m.superseded_by)) {
    issues.push({ path: 'superseded_by', message: 'superseded_by must be a UUID or null' });
  }
  if (m.ttl_seconds !== null && m.ttl_seconds !== undefined) {
    if (!isInt(m.ttl_seconds) || (m.ttl_seconds as number) <= 0) {
      issues.push({ path: 'ttl_seconds', message: 'ttl_seconds must be a positive integer or null' });
    }
  }

  // ── document-mode-only fields ───────────────────────────────────────
  if (m.source_uri !== null && m.source_uri !== undefined && typeof m.source_uri !== 'string') {
    issues.push({ path: 'source_uri', message: 'source_uri must be a string or null' });
  }
  if (m.source_version !== null && m.source_version !== undefined) {
    if (!isInt(m.source_version) || (m.source_version as number) < 0) {
      issues.push({ path: 'source_version', message: 'source_version must be a non-negative integer or null' });
    }
  }
  if (m.source_checksum !== null && m.source_checksum !== undefined && typeof m.source_checksum !== 'string') {
    issues.push({ path: 'source_checksum', message: 'source_checksum must be a string or null' });
  }
  if (m.chunk_index !== null && m.chunk_index !== undefined) {
    if (!isInt(m.chunk_index) || (m.chunk_index as number) < 0) {
      issues.push({ path: 'chunk_index', message: 'chunk_index must be a non-negative integer or null' });
    }
  }
  if (m.chunk_total !== null && m.chunk_total !== undefined) {
    if (!isInt(m.chunk_total) || (m.chunk_total as number) <= 0) {
      issues.push({ path: 'chunk_total', message: 'chunk_total must be a positive integer or null' });
    }
  }
  if (m.chunk_of !== null && m.chunk_of !== undefined && !isUuid(m.chunk_of)) {
    issues.push({ path: 'chunk_of', message: 'chunk_of must be a UUID or null' });
  }

  // ── confidence ──────────────────────────────────────────────────────
  if (!isFiniteNumber(m.confidence) || (m.confidence as number) < 0 || (m.confidence as number) > 1) {
    issues.push({ path: 'confidence', message: 'confidence must be in [0,1]' });
  }

  // ── provenance ──────────────────────────────────────────────────────
  if (m.provenance === null || typeof m.provenance !== 'object' || Array.isArray(m.provenance)) {
    issues.push({ path: 'provenance', message: 'provenance is required' });
  } else {
    const p = m.provenance as MemoryItem['provenance'];
    if (p.agent_id !== null && typeof p.agent_id !== 'string') {
      issues.push({ path: 'provenance.agent_id', message: 'must be string or null' });
    }
    if (p.session_id !== null && typeof p.session_id !== 'string') {
      issues.push({ path: 'provenance.session_id', message: 'must be string or null' });
    }
    if (p.collab_id !== null && typeof p.collab_id !== 'string') {
      issues.push({ path: 'provenance.collab_id', message: 'must be string or null' });
    }
    if (p.model !== null && typeof p.model !== 'string') {
      issues.push({ path: 'provenance.model', message: 'must be string or null' });
    }
    if (p.provider !== null && typeof p.provider !== 'string') {
      issues.push({ path: 'provenance.provider', message: 'must be string or null' });
    }
    if (!Array.isArray(p.tool_chain) || !p.tool_chain.every((t) => typeof t === 'string')) {
      issues.push({ path: 'provenance.tool_chain', message: 'must be a string[]' });
    }
    if (
      typeof p.created_by !== 'string' ||
      !(CREATED_BY_VALUES as readonly string[]).includes(p.created_by)
    ) {
      issues.push({
        path: 'provenance.created_by',
        message: `must be one of ${CREATED_BY_VALUES.join('|')}`,
      });
    }
    if (p.source_backend !== null && typeof p.source_backend !== 'string') {
      issues.push({ path: 'provenance.source_backend', message: 'must be string or null' });
    }
  }

  // ── timestamps ──────────────────────────────────────────────────────
  if (!isDate(m.created_at)) {
    issues.push({ path: 'created_at', message: 'created_at must be a Date' });
  }
  if (!isDate(m.updated_at)) {
    issues.push({ path: 'updated_at', message: 'updated_at must be a Date' });
  }
  if (m.accessed_at !== null && m.accessed_at !== undefined && !isDate(m.accessed_at)) {
    issues.push({ path: 'accessed_at', message: 'accessed_at must be a Date or null' });
  }
  if (!isInt(m.access_count) || (m.access_count as number) < 0) {
    issues.push({ path: 'access_count', message: 'access_count must be a non-negative integer' });
  }
  if (m.deleted_at !== null && m.deleted_at !== undefined && !isDate(m.deleted_at)) {
    issues.push({ path: 'deleted_at', message: 'deleted_at must be a Date or null' });
  }
  if (m.deleted_by !== null && m.deleted_by !== undefined && typeof m.deleted_by !== 'string') {
    issues.push({ path: 'deleted_by', message: 'deleted_by must be a string or null' });
  }

  // Bail out before cross-field rules if the basic shape is wrong —
  // those rules dereference fields that may be undefined and would
  // emit confusing duplicate issues.
  if (issues.length > 0) return issues;

  // ── mode invariants ─────────────────────────────────────────────────
  if (m.mode === 'memory') {
    if (m.tier === null) issues.push({ path: 'tier', message: 'memory mode requires tier' });
    if (m.valid_from === null) issues.push({ path: 'valid_from', message: 'memory mode requires valid_from' });
    if (m.source_uri !== null) issues.push({ path: 'source_uri', message: 'memory mode forbids source_uri' });
    if (m.chunk_index !== null) issues.push({ path: 'chunk_index', message: 'memory mode forbids chunk_index' });
    if (m.chunk_of !== null) issues.push({ path: 'chunk_of', message: 'memory mode forbids chunk_of' });
  }

  if (m.mode === 'document') {
    if (m.source_uri === null) issues.push({ path: 'source_uri', message: 'document mode requires source_uri' });
    if (m.source_version === null) issues.push({ path: 'source_version', message: 'document mode requires source_version' });
    if (m.tier !== null) issues.push({ path: 'tier', message: 'document mode forbids tier' });
    if (m.valid_until !== null)
      issues.push({ path: 'valid_until', message: 'document mode uses source_version, not bi-temporal' });
    if (m.superseded_by !== null)
      issues.push({ path: 'superseded_by', message: 'document mode uses source_version, not supersession' });
    if (m.ttl_seconds !== null) issues.push({ path: 'ttl_seconds', message: 'document mode forbids ttl_seconds' });
  }

  // ── bi-temporal sanity ──────────────────────────────────────────────
  if (m.valid_until !== null && m.valid_from !== null && m.valid_until < m.valid_from) {
    issues.push({ path: 'valid_until', message: 'valid_until must be >= valid_from' });
  }
  if (m.superseded_by !== null && m.valid_until === null) {
    issues.push({ path: 'superseded_by', message: 'superseded_by requires valid_until' });
  }

  // ── embedding consistency ───────────────────────────────────────────
  if (m.embedding !== null && m.embedding_dim === null) {
    issues.push({ path: 'embedding_dim', message: 'embedding requires embedding_dim' });
  }
  if (m.embedding !== null && (m.embedding as number[]).length !== m.embedding_dim) {
    issues.push({
      path: 'embedding',
      message: `embedding length (${(m.embedding as number[]).length}) must equal embedding_dim (${m.embedding_dim})`,
    });
  }
  if (m.embedding !== null && m.embedding_status !== 'ready') {
    issues.push({
      path: 'embedding_status',
      message: 'non-null embedding must have embedding_status=ready',
    });
  }
  if (m.embedding_status === 'failed' && m.embedding_error === null) {
    issues.push({
      path: 'embedding_error',
      message: 'failed embedding must have embedding_error',
    });
  }

  // ── chunk consistency ───────────────────────────────────────────────
  if (m.chunk_index !== null) {
    if (m.chunk_total === null) {
      issues.push({ path: 'chunk_total', message: 'chunk_index requires chunk_total' });
    } else if ((m.chunk_index as number) >= (m.chunk_total as number)) {
      issues.push({ path: 'chunk_index', message: 'chunk_index must be < chunk_total' });
    }
  }

  return issues;
}

/**
 * Convenience wrapper: throw a MemoryError(`validation`) when the
 * item is not valid; return the typed item otherwise.
 */
export function assertValidMemoryItem(item: unknown): MemoryItem {
  const issues = validateMemoryItem(item);
  if (issues.length > 0) {
    // Caller catches and translates to HTTP error or service-level
    // MemoryError tag — the validator stays domain-pure.
    const err = new Error(`canonical memory validation failed: ${JSON.stringify(issues)}`);
    (err as any).validationIssues = issues;
    throw err;
  }
  return item as MemoryItem;
}
