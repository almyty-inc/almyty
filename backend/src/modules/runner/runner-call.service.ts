import { Inject, Injectable, Logger, OnModuleDestroy, forwardRef } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { StreamableHttpTransport } from '../mcp/transports/streamable-http.transport';
import {
  HeartbeatAckPayload,
  WorkerEnvelope,
  WorkerErrorPayload,
} from '../mcp/types/worker-protocol.types';
import { RunnerService } from './runner.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { RunnerState } from '../../entities/runner.entity';
import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';

export interface RunnerRequestPayload {
  method: string;
  params: unknown;
  workspaceId?: string;
  /** The workspace's root directory; sent with workspaceId once it is verified. */
  workspaceCwd?: string;
}

export interface RunnerResponsePayload {
  ok: boolean;
  result?: unknown;
  error?: WorkerErrorPayload;
}

export const RUNNER_CALL_ERRORS = {
  RUNNER_NOT_FOUND: 'runner_not_found',
  RUNNER_OFFLINE: 'runner_offline',
  RUNNER_UNAVAILABLE: 'runner_unavailable',
  WORKSPACE_REQUIRED: 'workspace_required',
  WORKSPACE_NOT_FOUND: 'workspace_not_found',
  TIMEOUT: 'timeout',
  TRANSPORT: 'transport',
  RUNNER_ERROR: 'runner_error',
} as const;

export type RunnerCallErrorCode = (typeof RUNNER_CALL_ERRORS)[keyof typeof RUNNER_CALL_ERRORS];

export class RunnerCallError extends Error {
  constructor(
    public readonly code: RunnerCallErrorCode,
    message: string,
    public readonly cause?: WorkerErrorPayload,
  ) {
    super(message);
    this.name = 'RunnerCallError';
  }
}

export interface DispatchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * The user on whose behalf this dispatch runs. RunnerService.
   * resolveForDispatch checks it against the runner's visibility: a
   * private runner takes work only from its owner, a team runner only
   * from its team, and neither takes work from an unknown caller.
   */
  callerUserId?: string | null;
  /**
   * The principal of the run this dispatch belongs to. When set it decides
   * instead of callerUserId, so a gateway run is judged by its gateway's
   * scope (see resolveForDispatch). The workspace check still reads
   * callerUserId: a workspace belongs to a person.
   */
  principal?: ExecutionPrincipal;
}

interface PendingCall {
  resolve: (payload: RunnerResponsePayload) => void;
  reject: (err: RunnerCallError) => void;
  timer: NodeJS.Timeout;
  abortHandler?: () => void;
  signal?: AbortSignal;
  /** The runner the request went to; only it may answer. */
  runnerId: string;
}

/**
 * Bridge between Tool dispatch and a runner's Streamable HTTP session.
 *
 * `dispatch(runnerId, method, params, workspaceId)`:
 *   1. Resolves the runner row + verifies it can accept work.
 *   2. Looks up the active streamable session.
 *   3. Mints a uuid v7 correlation id, pushes a `request` envelope.
 *   4. Awaits the matching `response`/`error` envelope. The transport
 *      emits all incoming envelopes; this service routes by id.
 *
 * Pending calls always either resolve, time out, or abort — the
 * service does not GC them implicitly. If the runner disconnects
 * mid-call, the call times out (the runner could reconnect inside
 * the timeout window and still deliver).
 */
/** Minimal shape of the transport session passed alongside each envelope. */
interface EnvelopeSession {
  id: string;
  organizationId: string;
  /** The user the session's bearer token proved. */
  userId?: string;
}


/**
 * Entries kept in the session -> runner cache.
 *
 * A miss costs one indexed lookup, so this can be small; it exists only
 * to stop the map growing for the life of the pod.
 */
const SESSION_RUNNER_CACHE_MAX = 10_000;
@Injectable()
export class RunnerCallService implements OnModuleDestroy {
  private readonly logger = new Logger(RunnerCallService.name);
  private readonly pending = new Map<string, PendingCall>();
  private readonly envelopeListener: (env: WorkerEnvelope, session?: EnvelopeSession) => void;
  /**
   * Fast local cache: streamable session id -> runner id (from runner.hello).
   *
   * Bounded, for the same reason as the twin in CodingRelayService: this
   * map is fed a fresh entry on every runner.hello, the daemon re-mints a
   * session on every session-lost (routine against a multi-replica
   * backend), and nothing here is ever told a session ended. The other
   * copy got an LRU and this one was left as a map that only grows for
   * the life of the pod.
   */
  private readonly sessionRunners = new Map<string, string>();

  /** Re-insert on write so the Map's insertion order is a recency order. */
  private rememberSession(sessionId: string, runnerId: string): void {
    this.sessionRunners.delete(sessionId);
    this.sessionRunners.set(sessionId, runnerId);
    while (this.sessionRunners.size > SESSION_RUNNER_CACHE_MAX) {
      const oldest = this.sessionRunners.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.sessionRunners.delete(oldest);
    }
  }

  private static readonly DEFAULT_TIMEOUT_MS = 30_000;

  constructor(
    private readonly runners: RunnerService,
    private readonly transport: StreamableHttpTransport,
    // forwardRef: WorkspaceModule imports RunnerModule for the TTL tick,
    // and this is the return edge.
    @Inject(forwardRef(() => WorkspaceService))
    private readonly workspaces: WorkspaceService,
  ) {
    this.envelopeListener = (env, session) => this.onEnvelope(env, session);
    this.transport.on('envelope', this.envelopeListener);
  }

  onModuleDestroy(): void {
    this.transport.off('envelope', this.envelopeListener);
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      if (call.abortHandler && call.signal) {
        call.signal.removeEventListener('abort', call.abortHandler);
      }
      call.reject(new RunnerCallError(
        RUNNER_CALL_ERRORS.TRANSPORT,
        'runner-call service shutting down',
      ));
      this.pending.delete(id);
    }
  }

  async dispatch(
    runnerId: string,
    method: string,
    params: unknown,
    workspaceId?: string,
    options: DispatchOptions = {},
  ): Promise<RunnerResponsePayload> {
    const runner = await this.runners.resolveForDispatch(runnerId, options.principal ?? options.callerUserId).catch((err) => {
      if (err?.status === 404) {
        throw new RunnerCallError(RUNNER_CALL_ERRORS.RUNNER_NOT_FOUND, err.message);
      }
      throw new RunnerCallError(RUNNER_CALL_ERRORS.RUNNER_UNAVAILABLE, err?.message ?? String(err));
    });

    // A named workspace must be a live one of the caller's on this runner.
    // The id used to ride into the envelope unchecked -- the daemon only
    // tests that it is a non-empty string -- so a released or expired
    // workspace kept taking work and any id at all was accepted.
    let workspace: { id: string; cwd: string } | null = null;
    if (workspaceId !== undefined) {
      workspace = await this.workspaces.findForDispatch(workspaceId, runner.id, options.callerUserId);
      if (!workspace) {
        throw new RunnerCallError(
          RUNNER_CALL_ERRORS.WORKSPACE_NOT_FOUND,
          'workspace not found or no longer active on this runner',
        );
      }
    }

    const session = await this.runners.getActiveSession(runner.id);
    if (!session) {
      throw new RunnerCallError(
        RUNNER_CALL_ERRORS.RUNNER_OFFLINE,
        `runner ${runner.name} has no active session`,
      );
    }
    if (runner.state === RunnerState.OFFLINE || runner.state === RunnerState.STALE) {
      throw new RunnerCallError(
        RUNNER_CALL_ERRORS.RUNNER_OFFLINE,
        `runner ${runner.name} is ${runner.state}`,
      );
    }

    const correlationId = uuidv7();
    // The workspace's root travels with its id so the runner can run a
    // shell.exec there (and resolve a relative cwd against it).
    const payload: RunnerRequestPayload = workspace
      ? { method, params, workspaceId: workspace.id, workspaceCwd: workspace.cwd }
      : { method, params };

    const env = this.transport.push(
      session.streamableSessionId,
      'request',
      payload,
      correlationId,
    );
    if (!env) {
      throw new RunnerCallError(
        RUNNER_CALL_ERRORS.RUNNER_OFFLINE,
        `streamable session ${session.streamableSessionId} not found in transport`,
      );
    }

    const timeoutMs = options.timeoutMs ?? RunnerCallService.DEFAULT_TIMEOUT_MS;
    return new Promise<RunnerResponsePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        const call = this.pending.get(correlationId);
        if (!call) return;
        this.pending.delete(correlationId);
        if (call.abortHandler && call.signal) {
          call.signal.removeEventListener('abort', call.abortHandler);
        }
        reject(new RunnerCallError(
          RUNNER_CALL_ERRORS.TIMEOUT,
          `runner ${runner.name} did not respond within ${timeoutMs}ms`,
        ));
      }, timeoutMs);
      timer.unref?.();

      const entry: PendingCall = { resolve, reject, timer, signal: options.signal, runnerId: runner.id };
      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          reject(new RunnerCallError(
            RUNNER_CALL_ERRORS.TRANSPORT,
            'dispatch aborted by caller',
          ));
          return;
        }
        const onAbort = () => {
          const call = this.pending.get(correlationId);
          if (!call) return;
          this.pending.delete(correlationId);
          clearTimeout(call.timer);
          options.signal!.removeEventListener('abort', onAbort);
          reject(new RunnerCallError(
            RUNNER_CALL_ERRORS.TRANSPORT,
            'dispatch aborted by caller',
          ));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        entry.abortHandler = onAbort;
      }
      this.pending.set(correlationId, entry);
    });
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  /**
   * Handle runner.hello (link session -> runner) and heartbeat (refresh
   * lastHeartbeatAt + recompute state, then ack with the active
   * workspace set) envelopes.
   */
  private async onLivenessEnvelope(env: WorkerEnvelope, session?: EnvelopeSession): Promise<void> {
    if (!session) return;

    if (env.type === 'event') {
      const payload = env.payload as { kind?: string; runnerId?: string } | undefined;
      if (payload?.kind === 'runner.hello' && payload.runnerId) {
        // The runner id is whatever the daemon put in its own hello;
        // the organization and user are what the bearer token on the
        // POST proved. Binding one to the other without comparing them
        // let any authenticated session claim another tenant's runner --
        // and, while only the organization was compared, another
        // member's runner in the same org. getActiveSession takes the
        // newest connected session, so the claim became the route every
        // dispatch for that runner took: agent.spawn, coding.start,
        // shell commands, all delivered to the claimant instead of the
        // machine. Only the runner's owner may attach a session to it.
        const owned = await this.runners.isOwnedBy(
          payload.runnerId,
          session.organizationId,
          session.userId,
        );
        if (!owned) {
          this.logger.warn(
            `runner.hello claiming runner ${payload.runnerId} refused: not owned by the session's user`,
          );
          return;
        }
        this.rememberSession(session.id, payload.runnerId);
        await this.runners.onSessionConnect(payload.runnerId, session.id);
      }
      // runner.draining and other events are observational here.
      return;
    }

    if (env.type === 'heartbeat') {
      const runnerId =
        this.sessionRunners.get(session.id) ??
        (await this.runners.runnerIdForSession(session.id));
      if (!runnerId) {
        this.logger.debug(`heartbeat for unmapped session ${session.id} dropped`);
        return;
      }
      this.rememberSession(session.id, runnerId);
      await this.runners.heartbeat(runnerId);
      await this.ackHeartbeat(session.id, runnerId, env.id);
    }
  }

  /**
   * Answer a heartbeat with the set of workspaces the backend still
   * considers ACTIVE for this runner, correlated to the heartbeat's own
   * envelope id.
   *
   * This is the server half of workspace cleanup. There is deliberately
   * no `workspace.release` RPC: a release/expiry message that gets
   * dropped leaks the user's processes forever, whereas a heartbeat set
   * is re-sent every 30s, so a missed reconciliation self-heals on the
   * next beat.
   *
   * ACTIVE is the only status reported. `released`, `expired` and
   * `stranded` are the three terminal states, and every one of them
   * means the same thing to the machine hosting the processes: nothing
   * should still be running for that workspace. `stranded` in
   * particular is set when the runner went OFFLINE — if that runner
   * comes back (same process, recovered network) its leftover processes
   * are exactly what needs reclaiming, and stranded is one-way, so the
   * workspace is never coming back to justify them.
   *
   * On failure the ack is sent with no `workspaces` key at all rather
   * than an empty one: an ack that omits the set means "no answer" to
   * the runner and reclaims nothing, while an empty `active` array is
   * an authoritative "you should be hosting nothing".
   */
  private async ackHeartbeat(
    sessionId: string,
    runnerId: string,
    correlationId: string,
  ): Promise<void> {
    let payload: HeartbeatAckPayload;
    try {
      const active = await this.workspaces.listActiveForRunner(runnerId);
      payload = { ts: Date.now(), workspaces: { active: active.map((w) => w.id) } };
    } catch (err: any) {
      this.logger.warn(
        `could not list active workspaces for runner ${runnerId}: ${err?.message ?? err}; ` +
          'acking without a workspace set (runner reclaims nothing)',
      );
      payload = { ts: Date.now() };
    }
    const pushed = this.transport.push(sessionId, 'heartbeat', payload, correlationId);
    if (!pushed) {
      this.logger.debug(`heartbeat ack for session ${sessionId} not deliverable`);
    }
  }

  private onEnvelope(env: WorkerEnvelope, session?: EnvelopeSession): void {
    // Liveness/connection envelopes from the runner. These are keyed only by
    // the streamable session, so we map session -> runner and update the
    // runner row. Without this wiring, heartbeats were dropped and a runner
    // could never leave 'registered' (never showed online). Fire-and-forget
    // with logging: the transport listener is synchronous.
    if (env.type === 'event' || env.type === 'heartbeat') {
      void this.onLivenessEnvelope(env, session).catch((err) =>
        this.logger.warn(`liveness envelope handling failed: ${err?.message ?? err}`),
      );
      return;
    }

    if (env.type !== 'response' && env.type !== 'error') return;
    void this.settle(env, session).catch((err) =>
      this.logger.warn(`response envelope handling failed: ${err?.message ?? err}`),
    );
  }

  /**
   * Settle a pending dispatch with a response/error envelope -- but only
   * one that came from the runner the request was sent to.
   *
   * This matched on the correlation id alone. Every authenticated
   * streamable session, of any organization, posts envelopes into the
   * same transport, and responses are fanned out to every pod; so any
   * client holding a correlation id could answer another tenant's runner
   * dispatch with a result of its choosing (agent.spawn output, shell
   * output) and the tool call would take it as the runner's. The session
   * the envelope arrived on now has to be one runner.hello bound to the
   * dispatched runner -- the same session, or the one it reconnected on.
   * An envelope that arrives with no session cannot be attributed and is
   * dropped: the transport carries the origin session across pods.
   */
  private async settle(env: WorkerEnvelope, session?: EnvelopeSession): Promise<void> {
    const call = this.pending.get(env.id);
    if (!call) {
      this.logger.debug(`unmatched ${env.type} envelope id=${env.id}`);
      return;
    }
    if (!session) {
      this.logger.warn(`${env.type} envelope id=${env.id} arrived with no session; not settling`);
      return;
    }
    const sender =
      this.sessionRunners.get(session.id) ?? (await this.runners.runnerIdForSession(session.id));
    if (sender !== call.runnerId) {
      this.logger.warn(
        `${env.type} envelope id=${env.id} from session ${session.id} is not from runner ${call.runnerId}; ignored`,
      );
      return;
    }
    // The lookup above yielded; another delivery of the same envelope (the
    // local emit and its cross-pod echo) may have settled it meanwhile.
    if (this.pending.get(env.id) !== call) return;
    this.pending.delete(env.id);
    clearTimeout(call.timer);
    if (call.abortHandler && call.signal) {
      call.signal.removeEventListener('abort', call.abortHandler);
    }
    if (env.type === 'error') {
      const payload = env.payload as WorkerErrorPayload;
      call.reject(new RunnerCallError(
        RUNNER_CALL_ERRORS.RUNNER_ERROR,
        payload?.message ?? 'runner returned error envelope',
        payload,
      ));
      return;
    }

    const payload = env.payload as RunnerResponsePayload;
    if (!payload || typeof payload.ok !== 'boolean') {
      call.reject(new RunnerCallError(
        RUNNER_CALL_ERRORS.TRANSPORT,
        'malformed response payload (missing ok)',
      ));
      return;
    }
    call.resolve(payload);
  }
}
