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
  /**
   * The workspace's root directory, as the backend recorded it when the
   * workspace was created. Sent alongside workspaceId once the backend
   * has checked the workspace is live on this runner; shell.exec runs
   * there and resolves a relative `cwd` against it.
   */
  workspaceCwd?: string;
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

/**
 * Payload of the `heartbeat` envelope the backend pushes back down the
 * command stream, correlated to the heartbeat's own envelope id.
 *
 * `workspaces.active` is the complete set of workspaces the backend
 * still considers ACTIVE for this runner. Anything this machine is
 * hosting outside that set has been released, expired or stranded, and
 * its processes are reclaimed.
 *
 * The field is optional, and absent is NOT the same as empty:
 *
 *   - absent  -> "no answer". An older backend never acks at all, and a
 *                newer one that could not compute the set omits the key.
 *                Either way the runner reclaims nothing.
 *   - present -> authoritative. An empty `active` means every workspace
 *                on this runner is gone and everything should be
 *                reclaimed.
 *
 * `v` stays 1 deliberately: this is an added payload field on an
 * existing envelope type, not a frame change, and `isWorkerEnvelope`
 * hard-rejects any other version — a bump would cut off every runner
 * already in the field.
 */
export interface HeartbeatAckPayload {
  ts: number;
  workspaces?: {
    active: string[];
  };
}

/**
 * Result of reading a heartbeat ack. Deliberately three-valued: a
 * usable set, "the backend did not answer", and "the answer did not
 * parse". The last two both reclaim nothing, but they are logged
 * differently because only one of them is a bug.
 */
export type HeartbeatAckParse =
  | { ok: true; activeWorkspaceIds: string[] }
  | { ok: false; reason: 'absent' | 'malformed' };

/**
 * Read the active-workspace set out of a heartbeat ack payload.
 *
 * Fails safe in every ambiguous case. This decides whether processes on
 * someone's own machine get killed, so anything that is not an
 * unambiguous list of workspace id strings returns `malformed` and
 * reclaims nothing.
 */
export function parseHeartbeatAck(payload: unknown): HeartbeatAckParse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'malformed' };
  }
  const workspaces = (payload as { workspaces?: unknown }).workspaces;
  if (workspaces === undefined || workspaces === null) {
    return { ok: false, reason: 'absent' };
  }
  if (typeof workspaces !== 'object' || Array.isArray(workspaces)) {
    return { ok: false, reason: 'malformed' };
  }
  const active = (workspaces as { active?: unknown }).active;
  if (!Array.isArray(active)) return { ok: false, reason: 'malformed' };
  for (const id of active) {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, reason: 'malformed' };
    }
  }
  return { ok: true, activeWorkspaceIds: active as string[] };
}
