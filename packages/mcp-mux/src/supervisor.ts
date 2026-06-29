/**
 * Supervisor — owns the downstream child's lifecycle and the respawn/teardown
 * state machine, and enforces the error-path resource-ownership invariant that
 * pre-empts the reference's FD leak.
 *
 *   idle ──start()ok──► running ──exit/error──► failed ──reap+sweep──► respawning ──backoff──► (start again)
 *     ▲                    │
 *     └──── stop() ────────┴──────────────────────────────────────────► stopped (terminal)
 *
 * THE INVARIANT (their bug class): every resource acquired in start() is pushed
 * onto an `acquired` ledger BEFORE the next acquisition. If anything throws
 * before ownership is transferred (registerForStop), the ledger is unwound in
 * reverse — so a half-built start can never leak a log fd / socket / child.
 * Their leak: Start() opened a log fd, then errored before registering for
 * Stop(); the fd was never closed; repeated failing attaches drained the budget.
 */
import type { Downstream, DownstreamFactory, MuxOptions } from './types.js';
import type { McpStdioMux } from './mux.js';

export interface Closable {
  close(): void;
}

export type SupervisorState = 'idle' | 'running' | 'failed' | 'respawning' | 'stopped';

export interface SupervisorOptions extends MuxOptions {
  /** Acquire the leak-prone pre-spawn resource (e.g. a log fd). Optional. */
  openLog?: () => Closable;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** A run lasting at least this long resets the backoff. */
  backoffResetAfterMs?: number;
}

export class Supervisor {
  private state: SupervisorState = 'idle';
  private downstream: Downstream | null = null;
  private log: Closable | null = null;
  private childExited = false;
  private reaped = false;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs: number;
  private runStartedAt = 0;

  private readonly warn: (m: string) => void;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly backoffResetAfterMs: number;

  constructor(
    private readonly factory: DownstreamFactory,
    private readonly mux: McpStdioMux,
    private readonly opts: SupervisorOptions = {},
  ) {
    this.warn = opts.warn ?? ((m) => process.stderr.write(`[mcp-mux:sup] ${m}\n`));
    this.backoffBaseMs = opts.backoffBaseMs ?? 3_000;
    this.backoffCapMs = opts.backoffCapMs ?? 30_000;
    this.backoffResetAfterMs = opts.backoffResetAfterMs ?? 30_000;
    this.backoffMs = this.backoffBaseMs;
  }

  get current(): SupervisorState {
    return this.state;
  }

  /**
   * Acquire resources + spawn the downstream. The ledger guarantees that any
   * failure before ownership transfer releases everything acquired so far.
   */
  async start(): Promise<void> {
    if (this.state === 'stopped') throw new Error('supervisor stopped');
    const acquired: Array<() => void> = [];
    const unwind = () => {
      while (acquired.length) {
        try {
          acquired.pop()!();
        } catch (e) {
          this.warn(`cleanup error: ${(e as Error)?.message ?? e}`);
        }
      }
    };

    try {
      // (1) leak-prone pre-spawn resource
      if (this.opts.openLog) {
        const log = this.opts.openLog();
        acquired.push(() => log.close());
        this.log = log;
      }
      // (2) the child + its pipes
      const ds = await this.factory.spawn();
      acquired.push(() => {
        try {
          ds.kill('SIGKILL');
        } catch {
          /* */
        }
      });

      // (3) wire it up — still inside the guarded region
      this.childExited = false;
      this.reaped = false;
      ds.once('exit', () => this.onChildExit());
      this.mux.setDownstream(ds);

      // ── ownership transfer point ──
      // Past here the Supervisor (via stop()) owns these; do NOT unwind them.
      this.downstream = ds;
      acquired.length = 0;
      this.state = 'running';
      this.runStartedAt = Date.now();
    } catch (e) {
      unwind(); // releases log + child if acquired
      this.log = null;
      this.downstream = null;
      this.state = 'failed';
      throw e;
    }
  }

  /** Child exited unexpectedly (or via our kill during reap). */
  private onChildExit(): void {
    this.childExited = true;
    if (this.state === 'stopped') return; // intentional shutdown; nothing to do
    // Reset backoff if the run was healthy for long enough.
    if (Date.now() - this.runStartedAt >= this.backoffResetAfterMs) {
      this.backoffMs = this.backoffBaseMs;
    }
    this.state = 'failed';
    this.reap();
    // NOTE: we do NOT call mux.onDownstreamGone() here. The mux self-subscribes
    // to its downstream's 'exit' in setDownstream() and clears its own in-flight
    // state. Single ownership: the mux owns its id-map; the supervisor owns the
    // process (reap) and the respawn FSM. Calling it here would double-fire.
    this.releaseLog();
    this.scheduleRespawn();
  }

  /** Kill (if alive) + mark reaped EXACTLY once — pre-empts double-kill/zombie. */
  private reap(): void {
    if (this.reaped) return;
    this.reaped = true;
    const ds = this.downstream;
    this.downstream = null;
    if (ds && !this.childExited) {
      try {
        ds.kill('SIGKILL');
      } catch {
        /* */
      }
    }
  }

  private releaseLog(): void {
    if (this.log) {
      try {
        this.log.close();
      } catch {
        /* */
      }
      this.log = null;
    }
  }

  private scheduleRespawn(): void {
    if (this.respawnTimer || this.state === 'stopped') return; // never two in flight
    this.state = 'respawning';
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffCapMs, this.backoffMs * 2);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.state === 'stopped') return;
      this.start().catch((e) => {
        this.warn(`respawn failed: ${(e as Error)?.message ?? e}`);
        this.scheduleRespawn(); // start() already set state=failed; back off again
      });
    }, delay);
    this.respawnTimer.unref?.();
  }

  /** Terminal shutdown. Idempotent. Cancels respawn, reaps, releases resources. */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    this.reap();
    this.releaseLog();
  }
}
