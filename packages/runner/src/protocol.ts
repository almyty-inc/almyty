/**
 * Worker-protocol envelope, mirroring backend/src/modules/mcp/types/
 * worker-protocol.types.ts. Duplicated rather than imported because
 * the runner can't depend on the backend package; we keep the two
 * files structurally identical and bump the version constant in
 * lockstep when the shape changes.
 */

export const WORKER_PROTOCOL_VERSION = 1 as const;

export type WorkerEnvelopeType = 'request' | 'response' | 'event' | 'heartbeat' | 'error';

export interface WorkerEnvelope<T = unknown> {
  v: typeof WORKER_PROTOCOL_VERSION;
  type: WorkerEnvelopeType;
  id: string;
  seq?: number;
  ts: number;
  payload: T;
}

export interface WorkerErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export const WORKER_ERROR_CODES = {
  MALFORMED_ENVELOPE: -32700,
  UNKNOWN_SESSION: -32001,
  REPLAY_UNAVAILABLE: -32002,
  INTERNAL: -32603,
} as const;

export function isWorkerEnvelope(value: unknown): value is WorkerEnvelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  if (e.v !== WORKER_PROTOCOL_VERSION) return false;
  if (typeof e.id !== 'string' || e.id.length === 0) return false;
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return false;
  if (e.seq !== undefined && (typeof e.seq !== 'number' || !Number.isFinite(e.seq))) return false;
  switch (e.type) {
    case 'request': case 'response': case 'event': case 'heartbeat': case 'error': break;
    default: return false;
  }
  if (!('payload' in e)) return false;
  return true;
}

/**
 * Request payload shape: a method name + arbitrary params, just like
 * JSON-RPC. The backend dispatches by method to one of the runner's
 * registered handlers (process.spawn, runner.info, etc.).
 */
export interface RequestPayload {
  method: string;
  params: unknown;
  /**
   * Optional workspace scope. Most calls require it; runner.info()
   * is the exception (returns global metadata, not workspace-scoped).
   */
  workspaceId?: string;
}

export interface ResponsePayload {
  ok: boolean;
  result?: unknown;
  error?: WorkerErrorPayload;
}

export interface HeartbeatPayload {
  ts: number;
  /** Number of running processes the runner is currently hosting. */
  inUse?: number;
}
