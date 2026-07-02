import { spawn as cpSpawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  ProcessHandle,
  ProcessSignal,
  ProcessStatus,
  ReadResult,
  RunnerError,
  RUNNER_ERROR_CODES,
  ShellExecResult,
  SpawnOptions,
  WaitForIdleOptions,
  WaitForIdleResult,
  WaitResult,
} from './types.js';
import { lastFrameResetIndex } from './coding-agents/index.js';

const execFileAsync = promisify(execFile);

/**
 * Adapter interface around the actual PTY/pipe implementation.
 *
 * The runtime uses node-pty for PTY mode (the default) and node's
 * built-in child_process for raw pipe mode. Both behind one interface
 * so tests can swap in a synthetic child without spinning subprocesses.
 *
 * node-pty isn't loaded at module-init time; it's a native dep that
 * we don't want to require for unit tests. The default factory below
 * lazy-loads it on first PTY spawn, so non-PTY tests never touch it.
 */
export interface ProcessAdapter extends EventEmitter {
  readonly pid: number | undefined;
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  kill(signal?: string): void;
  /**
   * Best-effort EOF on stdin. PTY mode sends ^D; pipe mode closes
   * the writable side of the child's stdin stream.
   */
  closeInput(): void;
}

export interface AdapterFactory {
  spawnPty(opts: SpawnOptions): Promise<ProcessAdapter>;
  spawnPipe(opts: SpawnOptions): Promise<ProcessAdapter>;
}

interface RunningProcess {
  handle: ProcessHandle;
  adapter: ProcessAdapter;
  /** Output buffer; bytes accumulate here between read() calls. */
  buffer: string;
  /**
   * Rolling tail of recent output, capped and NOT drained by read(). Used for
   * non-destructive status snapshots (coding-agent status classification needs
   * to see the current screen even after the agent has drained `buffer`).
   */
  recentTail: string;
  /** Last time we observed any output activity from the child. */
  lastOutputAt: number;
  /** Resolved when the child exits, with the final exit info. */
  exitPromise: Promise<WaitResult>;
  exitInfo: WaitResult | null;
}

/** Cap on the retained status tail (~ a couple of screenfuls). */
const RECENT_TAIL_CAP = 8192;

/**
 * Per-runner process orchestrator.
 *
 * Bookkeeping: every process is namespaced by workspaceId. Cross-
 * workspace lookups error loudly (process_cross_workspace) — this is
 * cheap insurance against an agent in workspace A handing a stale
 * process_id to a tool that runs in workspace B.
 *
 * Buffering: stdout/stderr accumulate in a per-process string buffer.
 * read() drains it; wait_for_idle() reads with idle-detection. We
 * don't try to interpret encodings or framing; the runner's job is
 * to deliver bytes faithfully, not to reason about what they mean.
 */
export class ProcessManager {
  private readonly processes = new Map<string, RunningProcess>();

  constructor(
    private readonly adapter: AdapterFactory,
    private readonly maxConcurrent: number,
  ) {}

  // ── snapshots ───────────────────────────────────────────────────────

  inUse(): number {
    let n = 0;
    for (const p of this.processes.values()) if (p.handle.status === 'running') n++;
    return n;
  }

  list(workspaceId?: string): ProcessHandle[] {
    const handles: ProcessHandle[] = [];
    for (const p of this.processes.values()) {
      if (workspaceId && p.handle.workspaceId !== workspaceId) continue;
      handles.push(p.handle);
    }
    return handles;
  }

  // ── lifecycle ───────────────────────────────────────────────────────

  async spawn(workspaceId: string, opts: SpawnOptions): Promise<ProcessHandle> {
    if (this.inUse() >= this.maxConcurrent) {
      throw new RunnerError(
        `runner at capacity (${this.maxConcurrent} concurrent processes)`,
        RUNNER_ERROR_CODES.CAPACITY_EXCEEDED,
      );
    }

    const usePty = opts.pty !== false;
    const adapter = usePty
      ? await this.adapter.spawnPty(opts)
      : await this.adapter.spawnPipe(opts);

    const processId = `proc_${randomUUID()}`;
    const handle: ProcessHandle = {
      processId,
      binary: opts.binary,
      startedAt: new Date(),
      status: 'running',
      workspaceId,
    };

    let resolveExit!: (value: WaitResult) => void;
    const exitPromise = new Promise<WaitResult>(r => { resolveExit = r; });
    const running: RunningProcess = {
      handle,
      adapter,
      buffer: '',
      recentTail: '',
      lastOutputAt: Date.now(),
      exitPromise,
      exitInfo: null,
    };

    adapter.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      running.buffer += text;
      // Maintain the status tail as the latest repaint frame. If this chunk
      // contains a frame-reset (erase-display / cursor-home), the prior frame
      // is stale — keep only from the last reset so a since-cleared status line
      // can't falsely read as busy.
      const reset = lastFrameResetIndex(text);
      running.recentTail =
        reset >= 0
          ? text.slice(reset).slice(-RECENT_TAIL_CAP)
          : (running.recentTail + text).slice(-RECENT_TAIL_CAP);
      running.lastOutputAt = Date.now();
    });
    adapter.on('exit', (info: { exitCode: number | null; signal: string | null }) => {
      running.handle.status = info.signal ? 'killed' : 'exited';
      const exit: WaitResult = {
        exitCode: info.exitCode,
        signal: info.signal,
      };
      running.exitInfo = exit;
      resolveExit(exit);
    });

    this.processes.set(processId, running);
    return handle;
  }

  /** Look up a process; enforces workspace ownership. */
  getOrThrow(workspaceId: string, processId: string): RunningProcess {
    const proc = this.processes.get(processId);
    if (!proc) {
      throw new RunnerError(
        `unknown process ${processId}`,
        RUNNER_ERROR_CODES.PROCESS_NOT_FOUND,
      );
    }
    if (proc.handle.workspaceId !== workspaceId) {
      // Match the spec: "Calls referencing a resource from a
      // different workspace error loudly with a clear message."
      throw new RunnerError(
        `process ${processId} is not in workspace ${workspaceId}`,
        RUNNER_ERROR_CODES.PROCESS_CROSS_WORKSPACE,
      );
    }
    return proc;
  }

  // ── I/O ─────────────────────────────────────────────────────────────

  write(workspaceId: string, processId: string, data: string): void {
    const proc = this.getOrThrow(workspaceId, processId);
    if (proc.handle.status !== 'running') {
      throw new RunnerError(
        `process ${processId} has already exited`,
        RUNNER_ERROR_CODES.PROCESS_ALREADY_EXITED,
      );
    }
    proc.adapter.write(data);
  }

  /**
   * Drain the output buffer. Returns whatever has accumulated since
   * the last call; future calls return only what's new.
   */
  read(workspaceId: string, processId: string): ReadResult {
    const proc = this.getOrThrow(workspaceId, processId);
    const data = proc.buffer;
    proc.buffer = '';
    return { data, moreAvailable: false };
  }

  /**
   * Non-destructive peek at the recent output tail. Unlike read(), this does
   * NOT drain anything — it's for status classification, which must work even
   * after the agent has drained `buffer` via read(). Returns the rolling tail
   * (capped at RECENT_TAIL_CAP) plus the process status and idle interval.
   */
  snapshot(
    workspaceId: string,
    processId: string,
  ): { tail: string; binary: string; status: ProcessStatus; idleMs: number } {
    const proc = this.getOrThrow(workspaceId, processId);
    return {
      tail: proc.recentTail,
      binary: proc.handle.binary,
      status: proc.handle.status,
      idleMs: Date.now() - proc.lastOutputAt,
    };
  }

  /**
   * Subscribe to a process's live output and exit. Push-based counterpart to
   * read(): the coding-session layer streams chunks to the backend as they
   * arrive instead of polling. Does NOT drain the pull buffer — a caller can
   * observe and read() the same process without losing bytes in either place.
   * Returns an unsubscribe function.
   */
  observe(
    workspaceId: string,
    processId: string,
    handlers: { onData?: (chunk: string) => void; onExit?: (info: WaitResult) => void },
  ): () => void {
    const proc = this.getOrThrow(workspaceId, processId);
    const onData = (chunk: string | Buffer) => {
      handlers.onData?.(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    };
    const onExit = (info: { exitCode: number | null; signal: string | null }) => {
      handlers.onExit?.({ exitCode: info.exitCode, signal: info.signal });
    };
    if (handlers.onData) proc.adapter.on('data', onData);
    if (handlers.onExit) proc.adapter.on('exit', onExit);
    return () => {
      proc.adapter.off('data', onData);
      proc.adapter.off('exit', onExit);
    };
  }

  async waitForIdle(
    workspaceId: string,
    processId: string,
    opts: WaitForIdleOptions,
  ): Promise<WaitForIdleResult> {
    const proc = this.getOrThrow(workspaceId, processId);
    const start = Date.now();
    let captured = '';

    return new Promise<WaitForIdleResult>(resolve => {
      const drain = () => {
        captured += proc.buffer;
        proc.buffer = '';
      };
      const tick = () => {
        const now = Date.now();
        const sinceLast = now - proc.lastOutputAt;
        const sinceStart = now - start;
        drain();
        if (sinceLast >= opts.idleMs) {
          clearInterval(timer);
          resolve({ data: captured, idle: true });
          return;
        }
        if (sinceStart >= opts.maxWaitMs) {
          clearInterval(timer);
          resolve({ data: captured, idle: false });
          return;
        }
        if (proc.handle.status !== 'running') {
          // Drain whatever's queued, then return idle: true since
          // the process is done producing.
          clearInterval(timer);
          resolve({ data: captured, idle: true });
          return;
        }
      };
      // Poll cadence: 1/4 of idleMs, capped at 250ms. Polling instead
      // of subscribing because we want to wake up at the deadline
      // even if no output is arriving.
      const intervalMs = Math.max(20, Math.min(250, Math.floor(opts.idleMs / 4)));
      const timer = setInterval(tick, intervalMs);
      timer.unref?.();
    });
  }

  closeInput(workspaceId: string, processId: string): void {
    const proc = this.getOrThrow(workspaceId, processId);
    if (proc.handle.status === 'running') proc.adapter.closeInput();
  }

  signal(workspaceId: string, processId: string, sig: ProcessSignal): void {
    const proc = this.getOrThrow(workspaceId, processId);
    if (proc.handle.status !== 'running') return;
    const mapped = `SIG${sig}`;
    proc.adapter.kill(mapped);
  }

  async wait(
    workspaceId: string,
    processId: string,
    timeoutMs?: number,
  ): Promise<WaitResult> {
    const proc = this.getOrThrow(workspaceId, processId);
    if (proc.exitInfo) return proc.exitInfo;
    if (timeoutMs === undefined) return proc.exitPromise;
    return Promise.race([
      proc.exitPromise,
      new Promise<WaitResult>((_, reject) => {
        const t = setTimeout(() => reject(new RunnerError(
          `wait timed out after ${timeoutMs}ms`,
          RUNNER_ERROR_CODES.TIMEOUT,
        )), timeoutMs);
        t.unref?.();
      }),
    ]);
  }

  /** Kill all processes for a workspace and forget them. Used on workspace release. */
  async killWorkspace(workspaceId: string): Promise<number> {
    let killed = 0;
    for (const [id, proc] of this.processes) {
      if (proc.handle.workspaceId !== workspaceId) continue;
      if (proc.handle.status === 'running') {
        try { proc.adapter.kill('SIGKILL'); } catch { /* */ }
      }
      this.processes.delete(id);
      killed++;
    }
    return killed;
  }
}

// ── Default adapter (real subprocess via node-pty / child_process) ──

export function createDefaultAdapterFactory(): AdapterFactory {
  let nodePtyMod: typeof import('node-pty') | null = null;

  return {
    async spawnPty(opts: SpawnOptions): Promise<ProcessAdapter> {
      if (!nodePtyMod) {
        // Native dep: load on first use so tests that never request
        // a PTY don't pay the cost or hit the build-toolchain
        // requirement.
        nodePtyMod = await import('node-pty');
      }
      const pty = nodePtyMod.spawn(opts.binary, opts.args, {
        name: 'xterm-color',
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
        cols: 120,
        rows: 30,
      });
      const emitter = new EventEmitter() as ProcessAdapter & EventEmitter;
      Object.defineProperty(emitter, 'pid', { get: () => pty.pid });
      emitter.write = (data: string) => pty.write(data);
      emitter.resize = (cols: number, rows: number) => pty.resize(cols, rows);
      emitter.kill = (signal?: string) => pty.kill(signal as any);
      emitter.closeInput = () => {
        // Send EOT (^D); cleanest cross-platform "close stdin" for a PTY.
        pty.write('\x04');
      };
      pty.onData((d: string) => emitter.emit('data', d));
      pty.onExit(({ exitCode, signal }: { exitCode: number; signal?: number | string }) => {
        emitter.emit('exit', {
          exitCode: exitCode ?? null,
          signal: signal !== undefined && signal !== 0 ? String(signal) : null,
        });
      });
      return emitter;
    },

    async spawnPipe(opts: SpawnOptions): Promise<ProcessAdapter> {
      const child: ChildProcess = cpSpawn(opts.binary, opts.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
      });
      const emitter = new EventEmitter() as ProcessAdapter & EventEmitter;
      Object.defineProperty(emitter, 'pid', { get: () => child.pid });
      emitter.write = (data: string) => { child.stdin?.write(data); };
      emitter.kill = (signal?: string) => { child.kill(signal as any); };
      emitter.closeInput = () => { child.stdin?.end(); };
      child.stdout?.on('data', d => emitter.emit('data', d.toString('utf8')));
      child.stderr?.on('data', d => emitter.emit('data', d.toString('utf8')));
      child.on('exit', (code, signal) => {
        emitter.emit('exit', { exitCode: code, signal: signal ?? null });
      });
      child.on('error', () => {
        emitter.emit('exit', { exitCode: 127, signal: null });
      });
      return emitter;
    },
  };
}

// ── Standalone shell.exec (no PTY, no buffer; one-shot) ─────────────

export async function shellExec(
  cmd: string,
  env?: Record<string, string>,
  timeoutMs = 60_000,
): Promise<ShellExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', cmd], {
      env: { ...process.env, ...(env ?? {}) } as NodeJS.ProcessEnv,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString?.() ?? '',
      stderr: err.stderr?.toString?.() ?? '',
      exitCode: err.code ?? null,
    };
  }
}
