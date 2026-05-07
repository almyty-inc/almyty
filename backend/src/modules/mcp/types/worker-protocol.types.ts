/**
 * Worker-protocol framing.
 *
 * Sits inside Streamable HTTP. Streamable HTTP is the wire (HTTP POST
 * for client->server, GET-then-SSE for server->client, Last-Event-ID
 * for replay). The envelope below is what flows inside the SSE data
 * field and inside POST bodies, giving us correlation, sequencing,
 * and a stable place to graft typed worker payloads onto in later
 * clusters (runner registration, job dispatch, etc).
 *
 * MCP itself uses raw JSON-RPC 2.0 over Streamable HTTP. The runner
 * subsystem uses these envelopes. The same transport class hosts
 * both: the message parser dispatches by shape (envelope vs JSON-RPC).
 */

export const WORKER_PROTOCOL_VERSION = 1 as const;

export type WorkerEnvelopeType =
  | 'request'   // client -> server, expects matching `response` with same id
  | 'response'  // server -> client, correlates to a `request` id
  | 'event'     // unidirectional notification
  | 'heartbeat' // liveness ping; no payload semantics
  | 'error';    // transport- or protocol-level error tied to a request id

export interface WorkerEnvelope<T = unknown> {
  /** Protocol version. Bump when envelope shape changes. */
  v: typeof WORKER_PROTOCOL_VERSION;
  /** Envelope kind; the parser dispatches on this. */
  type: WorkerEnvelopeType;
  /**
   * Correlation id. For `request` types, the client mints it (uuid v7 is
   * recommended so server can sort by issue order). For `response` and
   * `error` types, it echoes the originating request's id. For `event`
   * and `heartbeat` it identifies the message itself.
   */
  id: string;
  /**
   * Monotonic sequence number per session, server-assigned. Used by the
   * replay buffer to honor Last-Event-ID on reconnect; not present on
   * client-originated POST bodies because the client doesn't see the
   * server's per-session counter.
   */
  seq?: number;
  /** Unix milliseconds at envelope creation. */
  ts: number;
  /** Typed payload. Validated downstream by per-type schemas. */
  payload: T;
}

/**
 * Type guard: is the value a structurally-valid worker envelope?
 *
 * Intentionally narrow. Validates the envelope frame only; payload
 * shape validation is the responsibility of the caller (which knows
 * what type the correlation id maps to). Returning `false` here means
 * the message should be rejected with an `error` envelope on the wire.
 */
export function isWorkerEnvelope(value: unknown): value is WorkerEnvelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  if (e.v !== WORKER_PROTOCOL_VERSION) return false;
  if (typeof e.id !== 'string' || e.id.length === 0) return false;
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return false;
  if (e.seq !== undefined && (typeof e.seq !== 'number' || !Number.isFinite(e.seq))) return false;
  switch (e.type) {
    case 'request':
    case 'response':
    case 'event':
    case 'heartbeat':
    case 'error':
      break;
    default:
      return false;
  }
  if (!('payload' in e)) return false;
  return true;
}

/**
 * Standard error payload shape carried inside an `error` envelope.
 * Mirrors JSON-RPC error shape (code/message/data) so callers that
 * already speak JSON-RPC can map errors trivially.
 */
export interface WorkerErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

/** Reserved error codes. Negative numbers are protocol-defined. */
export const WORKER_ERROR_CODES = {
  /** Envelope failed structural validation. */
  MALFORMED_ENVELOPE: -32700,
  /** Session header missing or unknown. */
  UNKNOWN_SESSION: -32001,
  /** Replay requested for an event id that has already aged out. */
  REPLAY_UNAVAILABLE: -32002,
  /** Internal error in the transport or downstream handler. */
  INTERNAL: -32603,
} as const;
