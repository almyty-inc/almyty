import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { StreamableHttpTransport } from '../mcp/transports/streamable-http.transport';
import {
  WorkerEnvelope,
  WorkerErrorPayload,
} from '../mcp/types/worker-protocol.types';
import { RunnerService } from './runner.service';
import { RunnerState } from '../../entities/runner.entity';

export interface RunnerRequestPayload {
  method: string;
  params: unknown;
  workspaceId?: string;
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
}

interface PendingCall {
  resolve: (payload: RunnerResponsePayload) => void;
  reject: (err: RunnerCallError) => void;
  timer: NodeJS.Timeout;
  abortHandler?: () => void;
  signal?: AbortSignal;
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
}

@Injectable()
export class RunnerCallService implements OnModuleDestroy {
  private readonly logger = new Logger(RunnerCallService.name);
  private readonly pending = new Map<string, PendingCall>();
  private readonly envelopeListener: (env: WorkerEnvelope, session?: EnvelopeSession) => void;
  /** Fast local cache: streamable session id -> runner id (from runner.hello). */
  private readonly sessionRunners = new Map<string, string>();

  private static readonly DEFAULT_TIMEOUT_MS = 30_000;

  constructor(
    private readonly runners: RunnerService,
    private readonly transport: StreamableHttpTransport,
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
    const runner = await this.runners.resolveForDispatch(runnerId).catch((err) => {
      if (err?.status === 404) {
        throw new RunnerCallError(RUNNER_CALL_ERRORS.RUNNER_NOT_FOUND, err.message);
      }
      throw new RunnerCallError(RUNNER_CALL_ERRORS.RUNNER_UNAVAILABLE, err?.message ?? String(err));
    });

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
    const payload: RunnerRequestPayload = workspaceId
      ? { method, params, workspaceId }
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

      const entry: PendingCall = { resolve, reject, timer, signal: options.signal };
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
   * lastHeartbeatAt + recompute state) envelopes.
   */
  private async onLivenessEnvelope(env: WorkerEnvelope, session?: EnvelopeSession): Promise<void> {
    if (!session) return;

    if (env.type === 'event') {
      const payload = env.payload as { kind?: string; runnerId?: string } | undefined;
      if (payload?.kind === 'runner.hello' && payload.runnerId) {
        this.sessionRunners.set(session.id, payload.runnerId);
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
      this.sessionRunners.set(session.id, runnerId);
      await this.runners.heartbeat(runnerId);
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
    const call = this.pending.get(env.id);
    if (!call) {
      this.logger.debug(`unmatched ${env.type} envelope id=${env.id}`);
      return;
    }
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
