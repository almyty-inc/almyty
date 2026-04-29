/**
 * MemoryBackend — the adapter contract every memory store implements.
 *
 * The canonical schema (`MemoryItem`, `Capability`, `MemoryError`)
 * is the wire format between the router and any backend. Adapters
 * translate canonical shapes to/from a backend's native API in
 * `toCanonical` / `fromCanonical`.
 *
 * Capability declarations let the router route operations only to
 * backends that support them — `bi_temporal` ops to Almyty Native,
 * `vector_search` to anything that ships an embedding-driven store,
 * `change_feed` only to backends that emit a stream.
 *
 * Backends that can't honour a capability degrade gracefully (with
 * a logged warning that surfaces in audit logs and transfer reports)
 * rather than silently corrupting data.
 */
import {
  BatchResult,
  Capability,
  ListQuery,
  MemoryChangeEvent,
  MemoryItem,
  Mode,
  Page,
  RankedItem,
  ScopeRef,
  SearchQuery,
} from '../canonical.types';

export interface BackendHealth {
  ok: boolean;
  latency_ms: number;
  details?: Record<string, unknown>;
}

export interface MemoryBackend {
  /** Stable id used by the router and audit log to reference this backend. */
  readonly id: string;

  /** Capabilities this backend supports — drives router decisions. */
  readonly capabilities: ReadonlySet<Capability>;

  /** Modes this backend serves — set of {'memory','document'}. */
  readonly supported_modes: ReadonlySet<Mode>;

  /**
   * Called once on module init. Backends that need ahead-of-time
   * setup (cache warmup, schema check, oauth refresh) do it here.
   * Failures are surfaced via the next health check.
   */
  init(): Promise<void>;

  /** Liveness probe; non-blocking. */
  healthCheck(): Promise<BackendHealth>;

  // ── CRUD ──────────────────────────────────────────────────────

  get(id: string): Promise<MemoryItem | null>;
  put(item: MemoryItem): Promise<MemoryItem>;
  delete(id: string, mode?: 'soft' | 'hard'): Promise<boolean>;

  // ── listing & search ──────────────────────────────────────────

  list(query: ListQuery): Promise<Page<MemoryItem>>;
  search(query: SearchQuery): Promise<RankedItem[]>;

  // ── bi-temporal (memory mode only; backends without `bi_temporal`
  //    capability implement these as best-effort with documented loss) ──

  supersede(
    oldId: string,
    newItem: MemoryItem,
  ): Promise<{ old: MemoryItem; new: MemoryItem }>;
  asOf(time: Date, query: ListQuery): Promise<Page<MemoryItem>>;

  // ── batch (transfer / sync) ───────────────────────────────────

  batchPut(items: MemoryItem[]): Promise<BatchResult>;
  batchDelete(ids: string[]): Promise<BatchResult>;

  // ── change feed (only if `change_feed` capability) ────────────

  subscribeChanges?(
    scope: ScopeRef,
    since: Date,
  ): AsyncIterable<MemoryChangeEvent>;

  // ── canonical translation ─────────────────────────────────────

  /** Native backend payload → canonical MemoryItem. */
  toCanonical(raw: unknown): MemoryItem;
  /** Canonical MemoryItem → native backend payload. */
  fromCanonical(item: MemoryItem): unknown;
}

/**
 * Per-scope routing decision recorded in `memory_workspace_config`.
 * Router maps `(scope_type, scope_id) → backend_id` per mode. The
 * default for every scope is `almyty-native`.
 */
export interface BackendRoutingConfig {
  /** Backend id to use for memory-mode rows. Defaults to almyty-native. */
  memory_backend?: string;
  /** Backend id to use for document-mode rows. Defaults to almyty-native. */
  document_backend?: string;
  /** Optional mirror — every write also lands on this backend (best-effort). */
  mirror_backend?: string;
}

/**
 * Reasons a transfer can degrade content. Surfaced to the caller
 * (and audit log) so operators see exactly what was lost in flight.
 */
export interface TransferWarning {
  /** Capability the source had that the target doesn't. */
  capability: Capability;
  /** Field on `MemoryItem` that won't survive the transfer. */
  field: keyof MemoryItem;
  /** Number of source items that carry this field non-trivially. */
  count: number;
}

export interface TransferReport {
  source: string;
  target: string;
  scope: ScopeRef;
  total_source: number;
  succeeded: number;
  failed: number;
  warnings: TransferWarning[];
  errors: Array<{ id: string; error: string }>;
}
