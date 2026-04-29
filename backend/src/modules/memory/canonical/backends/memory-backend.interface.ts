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

/**
 * Resolved credentials for a single backend dispatch. The router
 * builds this from the org's Credential row (decrypted on read by
 * CredentialsService) and the workspace's routing config. Backends
 * never read process.env — every secret arrives here.
 *
 * Per-org isolation is the whole point: tenant A's Mem0 key never
 * touches tenant B's traffic.
 */
export interface BackendCredentials {
  /** Bearer-token style backends (Mem0, Anthropic, Supermemory). */
  apiKey?: string;
  /** Override base URL — useful for self-hosted Zep or Mem0 dev. */
  baseUrl?: string;
  /** Vertex Memory Bank: GCP project id. */
  project?: string;
  /** Vertex Memory Bank: GCP region. */
  location?: string;
  /** Vertex Memory Bank: full reasoning-engine resource path. */
  engine?: string;
  /** Vertex Memory Bank: short-lived OAuth bearer (router refreshes). */
  bearer?: string;
  /** Allow backend-specific extras without changing the interface. */
  [extra: string]: unknown;
}

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
   * Canonical schema version this backend speaks. Backends bump this
   * in lockstep with `CANONICAL_SCHEMA_VERSION`; the router refuses
   * to mount a backend that declares an older version, since the
   * adapter's `toCanonical` / `fromCanonical` won't know how to
   * round-trip fields the new schema added. Spec §15.
   */
  readonly schema_version: number;

  /**
   * Called once on module init for any cache warmup. External
   * backends do per-call client construction now (see `creds`
   * arg below) — init exists for the native backend's TypeORM /
   * BullMQ wiring and is a no-op everywhere else.
   */
  init(): Promise<void>;

  /** Liveness probe with the given credentials; non-blocking. */
  healthCheck(creds?: BackendCredentials): Promise<BackendHealth>;

  // ── CRUD ──────────────────────────────────────────────────────

  get(id: string, creds?: BackendCredentials): Promise<MemoryItem | null>;
  put(item: MemoryItem, creds?: BackendCredentials): Promise<MemoryItem>;
  delete(
    id: string,
    mode?: 'soft' | 'hard',
    creds?: BackendCredentials,
  ): Promise<boolean>;

  // ── listing & search ──────────────────────────────────────────

  list(query: ListQuery, creds?: BackendCredentials): Promise<Page<MemoryItem>>;
  search(query: SearchQuery, creds?: BackendCredentials): Promise<RankedItem[]>;

  // ── bi-temporal (memory mode only; backends without `bi_temporal`
  //    capability implement these as best-effort with documented loss) ──

  supersede(
    oldId: string,
    newItem: MemoryItem,
    creds?: BackendCredentials,
  ): Promise<{ old: MemoryItem; new: MemoryItem }>;
  asOf(
    time: Date,
    query: ListQuery,
    creds?: BackendCredentials,
  ): Promise<Page<MemoryItem>>;

  // ── batch (transfer / sync) ───────────────────────────────────

  batchPut(
    items: MemoryItem[],
    creds?: BackendCredentials,
  ): Promise<BatchResult>;
  batchDelete(
    ids: string[],
    creds?: BackendCredentials,
  ): Promise<BatchResult>;

  // ── change feed (only if `change_feed` capability) ────────────

  subscribeChanges?(
    scope: ScopeRef,
    since: Date,
    creds?: BackendCredentials,
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
