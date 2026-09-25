import { Injectable, Logger } from '@nestjs/common';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import {
  SandboxExecutionRequest,
  SandboxExecutionResult,
  WorkerInput,
  WorkerOutput,
  WorkerReadyMessage,
} from './types';
import { DependencyManagerService } from './dependency-manager.service';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MEMORY_LIMIT_MB = 128;
const DEFAULT_MAX_WORKERS = 4;
/**
 * Hard cap on the queued-but-not-yet-running execution backlog. Without
 * a cap, a flood of requests would grow the in-memory queue indefinitely
 * and eventually OOM the backend process.
 */
const DEFAULT_MAX_QUEUE_SIZE = 100;
/**
 * Ceiling on the timeout any single execution gets, whatever it asks
 * for. A worker keeps its pool slot until its timer fires, so an
 * uncapped tenant-supplied timeout is a way to hold a slot indefinitely.
 * Matches the 300s ceiling on ExecuteToolDto.timeout and on a tool's
 * `configuration.timeout`.
 */
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
/**
 * How long a worker may take to boot (spawn, permission model, net guard,
 * require hooks) before the tool's own timeout starts. Generous, because
 * it is only reached when the host is badly overloaded or the worker is
 * wedged; either way the execution fails rather than hanging.
 */
const DEFAULT_BOOT_TIMEOUT_MS = 30_000;

/**
 * Compiled files outside the worker's directory that the worker's net
 * guard requires, resolved relative to the compiled worker script the
 * same way the guard's own relative imports are (worker in
 * modules/tools/node-sandbox, these in common/security). Each must stay
 * free of imports beyond Node built-ins; `sandbox-guard-imports.spec.ts`
 * holds them to that.
 */
export const SANDBOX_GUARD_SHARED_MODULES = ['ip-classification', 'gateway-tool-policy'] as const;

export function sandboxGuardDependencyPaths(workerPath: string): string[] {
  return SANDBOX_GUARD_SHARED_MODULES.map((name) =>
    path.resolve(path.dirname(workerPath), '..', '..', '..', 'common', 'security', `${name}.js`),
  );
}
/**
 * Tool-invocation message types used by the worker's `tools.invoke`
 * shim. Kept deliberately tiny — the host and worker both only need
 * `id` to correlate request/response.
 */
interface InvokeToolRequestMessage {
  type: 'invoke-tool';
  id: string;
  toolId: string;
  params: Record<string, any>;
}
interface InvokeToolResponseMessage {
  type: 'invoke-tool-response';
  id: string;
  ok: boolean;
  result?: any;
  error?: string;
}

@Injectable()
export class NodeSandboxService {
  private readonly logger = new Logger(NodeSandboxService.name);

  /** Pool workers currently running -- used to enforce concurrency limits */
  private activeWorkers = 0;

  /** Pool workers currently running, per organization bucket */
  private readonly activeByOrg = new Map<string, number>();

  /** Nested `tools.invoke` workers currently running (outside the pool) */
  private activeNestedWorkers = 0;

  /** Queue of pending executions waiting for a worker slot */
  private readonly queue: Array<{
    resolve: (result: SandboxExecutionResult) => void;
    request: SandboxExecutionRequest;
    orgKey: string;
  }> = [];

  constructor(private readonly depManager: DependencyManagerService) {}

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  /**
   * Execute user code inside a Worker thread with resource limits.
   *
   * The pool is process-wide and shared by every organization, so it is
   * rationed per organization as well as in total:
   *
   *   - at most SANDBOX_MAX_WORKERS run at once (default 4), and at most
   *     SANDBOX_MAX_WORKERS_PER_ORG of them for one organization (default
   *     half the pool);
   *   - at most SANDBOX_MAX_QUEUE_SIZE wait (default 100), and at most
   *     SANDBOX_MAX_QUEUE_PER_ORG of them for one organization (default a
   *     quarter of the queue). Past either, the request is refused rather
   *     than parked in front of everyone else.
   *
   * A nested `tools.invoke` execution (`request.nested`) skips the pool:
   * its caller is holding a slot and waiting on it, so queueing it would
   * deadlock as soon as the pool is full. It is bounded by the caller's
   * invocation budget and by SANDBOX_MAX_NESTED_WORKERS, past which it is
   * refused -- never queued.
   */
  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    const limits = this.limits();

    // Pre-flight cancellation check. Saves the queue + worker spawn.
    if (request.signal?.aborted) {
      return { success: false, error: 'Sandbox execution cancelled', executionTimeMs: 0 };
    }

    if (request.nested) {
      if (this.activeNestedWorkers >= limits.maxNestedWorkers) {
        return {
          success: false,
          error: `Too many nested sandbox executions in flight (${limits.maxNestedWorkers}). Try again shortly.`,
          executionTimeMs: 0,
        };
      }
      return this.runWorker(request, null);
    }

    const orgKey = request.organizationId || '';

    if (
      this.activeWorkers < limits.maxWorkers &&
      this.orgActive(orgKey) < limits.maxWorkersPerOrg
    ) {
      return this.runWorker(request, orgKey);
    }

    // At capacity (overall or for this organization): wait in the queue --
    // but refuse immediately when the queue, or this organization's share
    // of it, is already full, so a flood of requests neither OOMs the
    // backend nor pushes every other tenant out.
    if (this.queue.length >= limits.maxQueueSize) {
      return {
        success: false,
        error: `Sandbox queue full (${limits.maxQueueSize} pending). Try again shortly.`,
        executionTimeMs: 0,
      };
    }
    if (this.orgQueued(orgKey) >= limits.maxQueuePerOrg) {
      return {
        success: false,
        error: `Sandbox queue full for this organization (${limits.maxQueuePerOrg} pending). Try again shortly.`,
        executionTimeMs: 0,
      };
    }
    return new Promise<SandboxExecutionResult>((resolve) => {
      this.queue.push({ resolve, request, orgKey });
    });
  }

  // ──────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────

  /**
   * Run one worker. `orgKey` is the pool bucket the worker counts
   * against, or null for a nested execution, which counts only against
   * the nested ceiling (see `execute`).
   */
  private async runWorker(
    request: SandboxExecutionRequest,
    orgKey: string | null,
  ): Promise<SandboxExecutionResult> {
    if (orgKey === null) {
      this.activeNestedWorkers++;
    } else {
      this.activeWorkers++;
      this.activeByOrg.set(orgKey, this.orgActive(orgKey) + 1);
    }
    const start = Date.now();
    // Clamped whatever the tool asked for: `configuration.timeout` and an
    // API's `timeoutMs` are tenant-supplied, and a worker holds its pool
    // slot for as long as its timer allows.
    const limits = this.limits();
    const timeoutMs = effectiveSandboxTimeoutMs(request.timeoutMs, limits.maxTimeoutMs);
    // How long a worker may take to boot before its budget starts. Not
    // charged to the tool, and not clamped by it either.
    const bootTimeoutMs = limits.bootTimeoutMs;
    const memoryLimitMb = request.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
    // Handed to nested `tools.invoke` calls instead of the outer request's
    // signal: aborted when this worker ends for any reason, and also when
    // the outer request is cancelled (that path settles the worker too).
    const nestedAbort = new AbortController();

    try {
      // Resolve dependencies if any
      const modulePaths: string[] = [];
      if (request.dependencies && Object.keys(request.dependencies).length > 0) {
        const depResult = await this.depManager.ensureInstalled(
          request.dependencies,
          request.npmRegistry,
        );
        modulePaths.push(depResult.installDir);
      }

      const workerInput: WorkerInput = {
        code: request.code,
        parameters: request.parameters,
        credentials: request.credentials ?? {},
        modulePaths,
        toolInvokeEnabled: typeof request.invokeTool === 'function',
        testNetAllow: request.testNetAllow,
        hostPolicy: request.hostPolicy ?? null,
      };

      // Resolve the worker script — prefer compiled .js, fall back to .ts for tests
      let workerPath = path.join(__dirname, 'sandbox-worker.js');
      const isCompiledPath = fs.existsSync(workerPath);
      if (!isCompiledPath) {
        const tsPath = path.join(__dirname, 'sandbox-worker.ts');
        if (fs.existsSync(tsPath)) {
          workerPath = tsPath;
        }
      }

      const workerOpts: any = {
        workerData: workerInput,
        resourceLimits: {
          maxOldGenerationSizeMb: memoryLimitMb,
          maxYoungGenerationSizeMb: Math.ceil(memoryLimitMb / 4),
        },
        execArgv: this.buildWorkerExecArgv(
          workerPath,
          modulePaths,
          isCompiledPath,
          request.extraAllowReads,
        ),
      };

      const result = await new Promise<SandboxExecutionResult>((resolve) => {
        let settled = false;
        // One timer at a time: the boot cap until the worker says it is
        // ready, then the tool's own budget.
        let timer: ReturnType<typeof setTimeout> | undefined;
        let ready = false;

        const worker = new Worker(workerPath, workerOpts);

        const settle = (r: SandboxExecutionResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanupSignal();
          // Worker threads can linger past their last 'message' if their
          // script's event loop has unsettled microtasks (open timers,
          // dangling promises). Force-terminate so jest --detectOpenHandles
          // stays clean and prod processes don't accumulate zombie workers.
          worker.terminate();
          nestedAbort.abort();
          resolve(r);
        };

        // The tool's timeout starts when the worker has booted, not when
        // it was spawned: under load, starting a worker (isolate, permission
        // model, net guard, require hooks) can take a good part of a short
        // budget, and that time is the platform's, not the tool's. A worker
        // that never gets that far is still stopped, by its own cap.
        timer = setTimeout(() => {
          settle({
            success: false,
            error: `Sandbox worker did not start within ${bootTimeoutMs}ms`,
            executionTimeMs: Date.now() - start,
          });
        }, bootTimeoutMs);
        const onReady = () => {
          // Only the first one counts: the budget is never restarted.
          if (ready || settled) return;
          ready = true;
          clearTimeout(timer);
          timer = setTimeout(() => {
            settle({
              success: false,
              error: `Execution timed out after ${timeoutMs}ms`,
              executionTimeMs: Date.now() - start,
            });
          }, timeoutMs);
        };

        // Wire up the caller's AbortSignal. If it fires mid-flight,
        // terminate the worker and resolve as cancelled.
        const onAbort = () => {
          settle({
            success: false,
            error: 'Sandbox execution cancelled',
            executionTimeMs: Date.now() - start,
          });
        };
        const cleanupSignal = () => {
          request.signal?.removeEventListener?.('abort', onAbort);
        };
        if (request.signal) {
          if (request.signal.aborted) {
            onAbort();
          } else {
            request.signal.addEventListener('abort', onAbort);
          }
        }

        // Host-side tool invocation pump. When user code inside the
        // sandbox calls `tools.invoke(id, params)`, the worker posts
        // an `invoke-tool` message; we run ToolExecutorService via
        // the callback the caller supplied and post the response
        // back keyed by the same `id`.
        worker.on('message', async (msg: WorkerOutput | InvokeToolRequestMessage | WorkerReadyMessage) => {
          if ((msg as any)?.type === 'ready') {
            onReady();
            return;
          }
          if ((msg as any)?.type === 'invoke-tool') {
            const invokeMsg = msg as InvokeToolRequestMessage;
            if (!request.invokeTool) {
              worker.postMessage({
                type: 'invoke-tool-response',
                id: invokeMsg.id,
                ok: false,
                error: 'tools.invoke is not available in this sandbox',
              } as InvokeToolResponseMessage);
              return;
            }
            // The nested call gets THIS worker's signal, not the outer
            // request's: it fires when this worker ends for any reason,
            // including its own timeout, so nested work never outlives it.
            const reply = (message: InvokeToolResponseMessage) => {
              if (settled) return;
              try {
                worker.postMessage(message);
              } catch {
                /* worker already gone */
              }
            };
            try {
              const nested = await request.invokeTool(
                invokeMsg.toolId,
                invokeMsg.params,
                nestedAbort.signal,
              );
              reply({
                type: 'invoke-tool-response',
                id: invokeMsg.id,
                ok: true,
                result: nested,
              });
            } catch (err: any) {
              reply({
                type: 'invoke-tool-response',
                id: invokeMsg.id,
                ok: false,
                error: err?.message ?? String(err),
              });
            }
            return;
          }

          // Otherwise it's the single-shot result from the user code.
          const out = msg as WorkerOutput;
          settle({
            success: out.success,
            data: out.data,
            error: out.error,
            executionTimeMs: Date.now() - start,
          });
        });

        worker.on('error', (err: Error) => {
          const isOom =
            err.message?.includes('out of memory') ||
            err.message?.includes('allocation failed') ||
            err.message?.includes('heap') ||
            err.message?.includes('JavaScript heap');
          settle({
            success: false,
            error: err.message,
            executionTimeMs: Date.now() - start,
            oom: isOom || undefined,
          });
        });

        worker.on('exit', (code: number) => {
          settle({
            success: false,
            error: `Worker exited with code ${code}`,
            executionTimeMs: Date.now() - start,
          });
        });
      });

      return result;
    } catch (err: any) {
      return {
        success: false,
        error: err.message ?? String(err),
        executionTimeMs: Date.now() - start,
      };
    } finally {
      // Whatever ended this worker, nested work it started ends with it.
      nestedAbort.abort();
      if (orgKey === null) {
        this.activeNestedWorkers--;
      } else {
        this.activeWorkers--;
        const n = this.orgActive(orgKey) - 1;
        if (n > 0) this.activeByOrg.set(orgKey, n);
        else this.activeByOrg.delete(orgKey);
      }
      this.drainQueue();
    }
  }

  /**
   * Build the worker's execArgv for Node's permission model.
   *
   * We use Node 24's `--permission` flag (which graduated from
   * experimental in 24.0) to get kernel-adjacent isolation of the
   * filesystem, child_process, worker_threads, and native addon
   * loading. The permission scope is PER-WORKER — each sandbox
   * worker has its own enforcement scope, and the backend host
   * process runs completely unaffected.
   *
   * What's granted:
   *   --allow-fs-read=<installDir>     (so the worker can require
   *                                     the tool's declared npm deps)
   *   --allow-fs-read=<workerScriptDir>(so the worker can load its
   *                                     own bootstrap script + the
   *                                     net-guard co-located with it)
   *
   * What's implicitly denied (by omission):
   *   - fs.write on any path → ERR_ACCESS_DENIED
   *   - child_process.spawn / exec / fork → ERR_ACCESS_DENIED
   *   - nested worker_threads → ERR_ACCESS_DENIED
   *   - native addon loading (.node files) → ERR_ACCESS_DENIED
   *   - process.binding, v8 introspection, inspector attach
   *
   * What's NOT touched by the permission model (handled separately):
   *   - Network I/O (caught by sandbox-net-guard's net.connect /
   *     dns.lookup monkey-patches)
   *   - process.env reads (scrubbed at worker boot in sandbox-worker)
   *
   * Dev / test fallback: when the sandbox is running via ts-node
   * (the .ts path fallback used in Jest and local dev), --permission
   * with a tight fs-read scope would block ts-node from reading
   * its own sources and our co-located source files. In that
   * mode we widen the fs-read allowlist to the project root so
   * the worker script and its transitive TypeScript imports can
   * load. fs.write, child_process, and worker_threads remain
   * denied — the security layers that matter most for the worker
   * are still intact in dev. The tighter compiled-path scope is
   * exercised by the dedicated integration tests that transpile
   * the worker into a tmp .js file and point the sandbox at it.
   */
  private buildWorkerExecArgv(
    workerPath: string,
    modulePaths: string[],
    isCompiledPath: boolean,
    extraAllowReads: string[] = [],
  ): string[] {
    const argv: string[] = [];

    if (!isCompiledPath) {
      // ts-node dev/test path — load the TypeScript transpiler hook
      // before the worker script runs.
      argv.push('-r', 'ts-node/register/transpile-only');
    }

    argv.push('--permission');

    // Node 26 brought network under the permission model. Node 24's
    // `--permission` gated the filesystem, child processes and worker
    // threads but NOT sockets, so a sandboxed tool's fetch simply worked
    // and `installSandboxNetGuard` in the worker was the only thing
    // deciding where it could reach. From Node 26 the runtime denies every
    // outbound connection with ERR_ACCESS_DENIED unless --allow-net is
    // given -- which silently breaks every JavaScript tool that makes an
    // HTTP request, reported to the person as a bare "fetch failed".
    //
    // The flag is ALL-OR-NOTHING, verified against Node 26.9.0 rather than
    // assumed: `--allow-net=127.0.0.1:1` still permits a connection to an
    // unrelated port, and every other form tried (bare host, host:port, a
    // private address) behaves identically. Only presence matters. So there
    // is no scoped variant to reach for, and nothing is gained by passing a
    // value -- a host list here would read like a policy while enforcing
    // nothing, which is worse than an honest blanket flag.
    //
    // Egress policy therefore lives entirely in the in-worker guard, which
    // patches dns.lookup, net.Socket.prototype.connect and dgram before any
    // user code runs and refuses private, loopback, link-local, CGNAT,
    // multicast and metadata destinations. That is the same arrangement
    // Node 24 had; this flag restores it rather than loosening it.
    argv.push('--allow-net');

    if (isCompiledPath) {
      // Tight prod scope: only the worker script's own directory
      // and any installed-dependency directories. Nothing else on
      // the filesystem is readable.
      argv.push(`--allow-fs-read=${path.dirname(workerPath)}`);
      // The net guard classifies addresses and matches gateway domain
      // policy with the same code the host-side gates use, so the two
      // cannot drift. Those modules live outside the worker's directory:
      // grant each file, not its directory.
      for (const shared of sandboxGuardDependencyPaths(workerPath)) {
        argv.push(`--allow-fs-read=${shared}`);
      }
      for (const mp of modulePaths) {
        argv.push(`--allow-fs-read=${mp}`);
      }
      for (const extra of extraAllowReads) {
        argv.push(`--allow-fs-read=${extra}`);
      }
    } else {
      // Relaxed dev scope: ts-node needs to read its own package,
      // the project's TypeScript sources, and any transitively-
      // imported files. Scope it to the backend package root
      // (the directory that contains sandbox-worker.ts's package.json)
      // plus node_modules, so the worker can still execute its
      // imports but the permission model keeps denying fs.write,
      // child_process, and worker_threads.
      const backendRoot = this.findBackendRoot(workerPath);
      argv.push(`--allow-fs-read=${backendRoot}`);
      argv.push(`--allow-fs-read=${path.join(backendRoot, 'node_modules')}`);
      // Node itself lives under the runtime directory and ts-node
      // may need to read from it for the register hook; allow Node's
      // own module cache dir.
      const nodeDir = path.dirname(process.execPath);
      argv.push(`--allow-fs-read=${nodeDir}`);
      for (const mp of modulePaths) {
        argv.push(`--allow-fs-read=${mp}`);
      }
      for (const extra of extraAllowReads) {
        argv.push(`--allow-fs-read=${extra}`);
      }
    }

    return argv;
  }

  /**
   * Walk up from the worker script path until we find a package.json
   * (that's the backend package root) or hit `/`. Used for the
   * dev/test fs-read allowlist.
   */
  private findBackendRoot(workerPath: string): string {
    let dir = path.dirname(workerPath);
    while (dir !== path.parse(dir).root) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        return dir;
      }
      dir = path.dirname(dir);
    }
    return path.dirname(workerPath);
  }

  /**
   * Start queued requests while there is capacity. Walks the queue in
   * order but skips an entry whose organization is already at its
   * per-organization cap, so one tenant's backlog at the head of the
   * queue does not hold up another tenant's request behind it.
   */
  private drainQueue(): void {
    const limits = this.limits();

    let i = 0;
    while (i < this.queue.length && this.activeWorkers < limits.maxWorkers) {
      const next = this.queue[i];
      if (this.orgActive(next.orgKey) >= limits.maxWorkersPerOrg) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      // runWorker has its own try/catch and should always resolve, but
      // attach a .catch as a safety net so a queued caller never hangs
      // forever if a future refactor introduces a rejection path.
      this.runWorker(next.request, next.orgKey).then(next.resolve, (err: any) => {
        next.resolve({
          success: false,
          error: err?.message ?? String(err),
          executionTimeMs: 0,
        });
      });
    }
  }

  private orgActive(orgKey: string): number {
    return this.activeByOrg.get(orgKey) ?? 0;
  }

  private orgQueued(orgKey: string): number {
    let n = 0;
    for (const entry of this.queue) if (entry.orgKey === orgKey) n++;
    return n;
  }

  /** Pool limits, read from the environment on every call. */
  private limits(): {
    maxWorkers: number;
    maxQueueSize: number;
    maxWorkersPerOrg: number;
    maxQueuePerOrg: number;
    maxNestedWorkers: number;
    maxTimeoutMs: number;
    bootTimeoutMs: number;
  } {
    const maxWorkers = positiveIntFromEnv('SANDBOX_MAX_WORKERS', DEFAULT_MAX_WORKERS);
    const maxQueueSize = positiveIntFromEnv('SANDBOX_MAX_QUEUE_SIZE', DEFAULT_MAX_QUEUE_SIZE);
    return {
      maxWorkers,
      maxQueueSize,
      // Half the pool by default: a single tenant can use a lot of it,
      // never all of it.
      maxWorkersPerOrg: Math.min(
        maxWorkers,
        positiveIntFromEnv('SANDBOX_MAX_WORKERS_PER_ORG', Math.max(1, Math.ceil(maxWorkers / 2))),
      ),
      maxQueuePerOrg: Math.min(
        maxQueueSize,
        positiveIntFromEnv('SANDBOX_MAX_QUEUE_PER_ORG', Math.max(1, Math.ceil(maxQueueSize / 4))),
      ),
      maxNestedWorkers: positiveIntFromEnv('SANDBOX_MAX_NESTED_WORKERS', maxWorkers * 4),
      maxTimeoutMs: positiveIntFromEnv('SANDBOX_MAX_TIMEOUT_MS', DEFAULT_MAX_TIMEOUT_MS),
      bootTimeoutMs: positiveIntFromEnv('SANDBOX_BOOT_TIMEOUT_MS', DEFAULT_BOOT_TIMEOUT_MS),
    };
  }
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The timeout a worker actually gets: what was asked for, clamped to
 * (0, max]. Anything that is not a positive finite number gets the
 * default, itself clamped.
 */
export function effectiveSandboxTimeoutMs(requested: unknown, maxTimeoutMs: number): number {
  const wanted =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? requested
      : DEFAULT_TIMEOUT_MS;
  return Math.min(wanted, maxTimeoutMs);
}
