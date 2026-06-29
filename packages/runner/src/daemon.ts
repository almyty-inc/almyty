import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { resolveCredentialsOrExit } from '@almyty/client';

import { ResolvedConfig } from './types.js';
import { loadConfig } from './config.js';
import { detectRuntimeInfo, RUNNER_VERSION } from './runtime-info.js';
import { createDefaultAdapterFactory, ProcessManager } from './process-manager.js';
import { StreamableClient, envelope } from './streamable-client.js';
import { WorkerEnvelope, RequestPayload, ResponsePayload, WORKER_ERROR_CODES } from './protocol.js';
import { dispatchHandler, HandlerContext } from './handlers.js';

const STATE_DIR = join(homedir(), '.almyty', 'runner');
const PID_FILE = join(STATE_DIR, 'daemon.pid');
const STATUS_FILE = join(STATE_DIR, 'status.json');
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Backoff between session re-establish attempts after a 404 session-lost. */
const SESSION_LOST_BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000];
/** Consecutive session-lost failures tolerated before exiting fatal. */
const MAX_SESSION_LOST_STREAK = 8;

export interface DaemonStatus {
  pid: number;
  startedAt: string;
  runnerName: string;
  backendUrl: string;
  runnerId: string | null;
  sessionId: string | null;
  inUseProcesses: number;
  connectionState: 'connecting' | 'online' | 'reconnecting' | 'fatal';
}

/**
 * Runner daemon. Responsibilities, in order:
 *
 *   1. Resolve config (defaults <- files <- env <- flags).
 *   2. Resolve credentials (env <- ~/.almyty/credentials.json).
 *   3. Detect runtime info + probe binaries.
 *   4. POST /runners/register with the snapshot.
 *   5. Open the Streamable HTTP stream and start dispatching incoming
 *      envelopes to handlers.
 *   6. Heartbeat every 30s.
 *   7. On SIGTERM / SIGINT: send a final shutdown envelope, wait
 *      briefly for in-flight responses, then exit.
 *
 * The daemon writes its PID and a status snapshot to ~/.almyty/runner/
 * so `almyty runner status` and `almyty runner stop` can find it.
 */
export class RunnerDaemon {
  private resolved: ResolvedConfig | null = null;
  private client: StreamableClient | null = null;
  private processes: ProcessManager | null = null;
  private runnerId: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private status: DaemonStatus | null = null;
  /** Guards against overlapping re-establish attempts. */
  private reestablishing = false;
  /** Consecutive failed re-establish attempts; bounds the retry loop. */
  private sessionLostStreak = 0;

  /**
   * Bootstraps the daemon. Returns when the runner has registered and
   * the stream is open. Errors here exit the process; caller is the
   * CLI's `start` command, which doesn't try to recover from a failed
   * register/connect — just prints and dies.
   */
  async start(flags: Partial<ResolvedConfig> & { configPath?: string }): Promise<void> {
    const resolved = loadConfig({ flags });
    this.resolved = resolved;

    const credentials = resolveCredentialsOrExit();
    const backendUrl = resolved.backendUrl || credentials.url;

    process.stdout.write(`almyty-runner v${RUNNER_VERSION} starting\n`);
    process.stdout.write(`name=${resolved.name} url=${backendUrl}\n`);

    // Detect runtime info before anything else; if a probe hangs (e.g.
    // a misbehaving node-pty install) we want to fail fast here rather
    // than after registration has succeeded.
    const runtime = await detectRuntimeInfo({ binaries: resolved.binaryProbeList });
    process.stdout.write(`detected ${Object.values(runtime.binaries).filter(v => v).length}/${resolved.binaryProbeList.length} binaries on PATH\n`);

    // Register over the existing REST endpoint (POST /runners/register).
    // Streamable HTTP isn't used for registration itself — registration
    // is a one-shot HTTP exchange that returns the runner row plus the
    // effective config, which we use to confirm what limits the backend
    // applied. After registration we switch to Streamable HTTP for the
    // long-lived connection.
    const regResp = await fetch(`${backendUrl}/runners/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${credentials.token}`,
      },
      body: JSON.stringify({
        name: resolved.name,
        labels: resolved.labels,
        runtimeInfo: runtime,
        config: resolved.config,
      }),
    });
    if (!regResp.ok) {
      const text = await regResp.text();
      throw new Error(`register failed: ${regResp.status} ${text}`);
    }
    const regBody = await regResp.json() as { data: { runner: { id: string }; effectiveConfig: typeof resolved.config } };
    this.runnerId = regBody.data.runner.id;
    process.stdout.write(`registered as ${this.runnerId}\n`);

    // Construct the process manager with the effective config (backend
    // may have constrained max_concurrent below what we requested).
    const effective = regBody.data.effectiveConfig;
    this.processes = new ProcessManager(createDefaultAdapterFactory(), effective.maxConcurrent);

    // Open the Streamable HTTP stream.
    this.client = new StreamableClient({ baseUrl: backendUrl, token: credentials.token });
    this.wireClient();

    // First POST mints the session id; send a hello envelope so the
    // backend's StreamableHttpTransport assigns one.
    await this.client.send(envelope('event', { kind: 'runner.hello', runnerId: this.runnerId }));
    await this.client.openStream();

    // Heartbeat loop. This timer is deliberately REF'd: it is the daemon's
    // keep-alive. The GET command stream can briefly drop (e.g. a reconnect
    // after a wrong-replica 404), and during that gap the fetch handle is
    // gone; if the heartbeat timer were unref'd, the event loop would drain
    // and the process would exit(0) BEFORE the first heartbeat ever fired —
    // so the runner could never report online. Keeping it ref'd holds the
    // process up across stream gaps; SIGINT/SIGTERM clears it for a clean exit.
    this.heartbeatTimer = setInterval(() => this.heartbeat().catch(err => {
      process.stderr.write(`heartbeat failed: ${err.message}\n`);
    }), HEARTBEAT_INTERVAL_MS);
    // Send one immediately so the runner reports online within seconds rather
    // than waiting a full interval for the first beat.
    void this.heartbeat().catch(err => {
      process.stderr.write(`initial heartbeat failed: ${err.message}\n`);
    });

    this.installSignalHandlers();
    this.writeState({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      runnerName: resolved.name,
      backendUrl,
      runnerId: this.runnerId,
      sessionId: this.client.getSessionId(),
      inUseProcesses: 0,
      connectionState: 'online',
    });
    process.stdout.write(`runner online; press ctrl-c to exit\n`);
  }

  /**
   * Exit signal flow. On the first SIGINT/SIGTERM, transition to
   * draining and inform the backend; on the second, hard exit.
   */
  private installSignalHandlers(): void {
    let drainingSent = false;
    const handle = (sig: string) => {
      if (drainingSent) {
        process.stderr.write(`\nsecond ${sig}; force exit\n`);
        process.exit(1);
      }
      drainingSent = true;
      process.stderr.write(`\n${sig} received; draining...\n`);
      this.gracefulShutdown().finally(() => process.exit(0));
    };
    process.on('SIGINT', () => handle('SIGINT'));
    process.on('SIGTERM', () => handle('SIGTERM'));
  }

  private async gracefulShutdown(): Promise<void> {
    try {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.client) {
        await this.client.send(envelope('event', { kind: 'runner.draining' })).catch(() => {});
        this.client.stop();
      }
      this.deleteState();
    } catch (err: any) {
      process.stderr.write(`shutdown error: ${err.message}\n`);
    }
  }

  private wireClient(): void {
    if (!this.client) return;
    this.client.on('envelope', (env: WorkerEnvelope) => {
      if (env.type === 'request') {
        this.handleRequest(env as WorkerEnvelope<RequestPayload>).catch(err => {
          process.stderr.write(`request handling error: ${err.message}\n`);
        });
      }
      // Heartbeat / event envelopes from the server are observational;
      // the runner doesn't react to them in v1.0.
    });
    this.client.on('reconnect', info => {
      process.stderr.write(`reconnecting (attempt ${info.attempt}, delay ${info.delayMs}ms): ${info.reason}\n`);
      this.updateState({ connectionState: 'reconnecting' });
    });
    this.client.on('open', () => {
      this.updateState({ connectionState: 'online', sessionId: this.client?.getSessionId() ?? null });
    });
    this.client.on('session-lost', () => {
      // The backend forgot our session (404 UNKNOWN_SESSION). The common
      // cause is a multi-replica backend with pod-local streamable sessions:
      // our mint-POST landed on one pod and the GET stream load-balanced to
      // another that never saw the session. Exiting here was too fragile —
      // a single wrong-replica hit killed the runner permanently. Instead,
      // re-establish a fresh session (re-mint + reopen the stream). The
      // client already cleared its session id, so the next send mints a new
      // one; with backoff this lands on a consistent pod and stays online.
      void this.reestablishSession();
    });
  }

  private async handleRequest(req: WorkerEnvelope<RequestPayload>): Promise<void> {
    // Trust model: inbound requests are trusted at the CHANNEL level. The
    // runner authenticates itself to the backend at registration, the
    // command stream rides the resulting authenticated session, and the
    // backend URL is required to be https for any non-loopback host (see
    // config.ts), which closes the MITM / stream-injection vectors. We do
    // NOT additionally verify a per-request signature here — that would
    // defend against a *compromised backend* and needs a coordinated
    // backend signing scheme (tracked separately). Each command is still
    // gated by the execution policy (isolation/deny/cwd/env) before it runs.
    if (!this.processes || !this.client || !this.resolved) return;
    const ctx: HandlerContext = {
      processes: this.processes,
      runnerName: this.resolved.name,
      labels: this.resolved.labels,
      maxConcurrent: this.resolved.config.maxConcurrent,
      config: this.resolved.config,
    };
    const response: ResponsePayload = await dispatchHandler(ctx, req.payload);
    await this.client.send(envelope('response', response, req.id));
  }

  private async heartbeat(): Promise<void> {
    if (!this.client || !this.processes) return;
    const inUse = this.processes.inUse();
    await this.client.send(envelope('heartbeat', { ts: Date.now(), inUse }));
    this.updateState({ inUseProcesses: inUse });
  }

  /**
   * Re-establish the command stream after a session-lost (404). Re-mints a
   * session (hello envelope) and reopens the GET stream, with backoff. Only
   * gives up — exiting fatal — after MAX_SESSION_LOST_STREAK consecutive
   * failures, so a transient wrong-replica hit recovers transparently while a
   * genuinely-down backend still terminates rather than spinning forever.
   */
  private async reestablishSession(): Promise<void> {
    if (this.reestablishing || !this.client) return;
    this.reestablishing = true;
    this.updateState({ connectionState: 'reconnecting' });
    try {
      this.sessionLostStreak++;
      if (this.sessionLostStreak > MAX_SESSION_LOST_STREAK) {
        process.stderr.write(
          `backend session lost ${this.sessionLostStreak}x in a row; giving up\n`,
        );
        this.updateState({ connectionState: 'fatal' });
        process.exit(2);
      }
      const delay = SESSION_LOST_BACKOFF_MS[
        Math.min(this.sessionLostStreak - 1, SESSION_LOST_BACKOFF_MS.length - 1)
      ];
      process.stderr.write(
        `backend session lost; re-establishing in ${delay}ms (attempt ${this.sessionLostStreak})\n`,
      );
      await new Promise(r => setTimeout(r, delay));
      // Re-mint a session (client already cleared the stale id) and reopen.
      await this.client.send(envelope('event', { kind: 'runner.hello', runnerId: this.runnerId }));
      await this.client.openStream();
      // openStream's 'open' event resets connectionState to 'online'; a clean
      // reopen means the streak is broken.
      this.sessionLostStreak = 0;
      this.updateState({ connectionState: 'online', sessionId: this.client.getSessionId() });
      process.stdout.write('backend session re-established\n');
    } catch (err: any) {
      process.stderr.write(`re-establish failed: ${err?.message ?? err}\n`);
      // Retry: openStream/send failures schedule the client's own reconnect,
      // and another session-lost will re-enter here; release the guard so it can.
    } finally {
      this.reestablishing = false;
    }
  }

  private writeState(s: DaemonStatus): void {
    // status.json holds the sessionId (bearer-equivalent for the command
    // channel) — keep the dir and file owner-only.
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    try { chmodSync(STATE_DIR, 0o700); } catch { /* best-effort */ }
    writeFileSync(PID_FILE, String(s.pid));
    writeFileSync(STATUS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
    try { chmodSync(STATUS_FILE, 0o600); } catch { /* best-effort */ }
    this.status = s;
  }

  private updateState(patch: Partial<DaemonStatus>): void {
    if (!this.status) return;
    this.status = { ...this.status, ...patch };
    try {
      writeFileSync(STATUS_FILE, JSON.stringify(this.status, null, 2));
    } catch { /* */ }
  }

  private deleteState(): void {
    try { unlinkSync(PID_FILE); } catch { /* */ }
    try { unlinkSync(STATUS_FILE); } catch { /* */ }
  }
}

// ── status / stop helpers (used by CLI subcommands) ─────────────────

export function readStatus(): DaemonStatus | null {
  try {
    if (!existsSync(STATUS_FILE)) return null;
    const raw = readFileSync(STATUS_FILE, 'utf-8');
    const status = JSON.parse(raw) as DaemonStatus;
    if (!isAlive(status.pid)) {
      // Stale state file: PID's gone.
      try { unlinkSync(STATUS_FILE); } catch { /* */ }
      try { unlinkSync(PID_FILE); } catch { /* */ }
      return null;
    }
    return status;
  } catch {
    return null;
  }
}

export function stopDaemon(): boolean {
  const status = readStatus();
  if (!status) return false;
  try {
    process.kill(status.pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
