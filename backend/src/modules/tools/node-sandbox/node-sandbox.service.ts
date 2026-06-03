import { Injectable, Logger } from '@nestjs/common';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import {
  SandboxExecutionRequest,
  SandboxExecutionResult,
  WorkerInput,
  WorkerOutput,
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

  /** Currently running workers — used to enforce concurrency limits */
  private activeWorkers = 0;

  /** Queue of pending executions waiting for a worker slot */
  private readonly queue: Array<{
    resolve: (result: SandboxExecutionResult) => void;
    request: SandboxExecutionRequest;
  }> = [];

  constructor(private readonly depManager: DependencyManagerService) {}

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  /**
   * Execute user code inside a Worker thread with resource limits.
   */
  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    const maxWorkers = parseInt(process.env.SANDBOX_MAX_WORKERS || '', 10) || DEFAULT_MAX_WORKERS;
    const maxQueueSize =
      parseInt(process.env.SANDBOX_MAX_QUEUE_SIZE || '', 10) || DEFAULT_MAX_QUEUE_SIZE;

    // Pre-flight cancellation check. Saves the queue + worker spawn.
    if (request.signal?.aborted) {
      return { success: false, error: 'Sandbox execution cancelled', executionTimeMs: 0 };
    }

    // If we're at capacity, wait in the queue — but reject immediately
    // when the queue is already full so a flood of requests doesn't
    // OOM the backend.
    if (this.activeWorkers >= maxWorkers) {
      if (this.queue.length >= maxQueueSize) {
        return {
          success: false,
          error: `Sandbox queue full (${maxQueueSize} pending). Try again shortly.`,
          executionTimeMs: 0,
        };
      }
      return new Promise<SandboxExecutionResult>((resolve) => {
        this.queue.push({ resolve, request });
      });
    }

    return this.runWorker(request);
  }

  // ──────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────

  private async runWorker(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    this.activeWorkers++;
    const start = Date.now();
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const memoryLimitMb = request.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;

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
          resolve(r);
        };

        const timer = setTimeout(() => {
          settle({
            success: false,
            error: `Execution timed out after ${timeoutMs}ms`,
            executionTimeMs: Date.now() - start,
          });
        }, timeoutMs);

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
        worker.on('message', async (msg: WorkerOutput | InvokeToolRequestMessage) => {
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
            try {
              const nested = await request.invokeTool(
                invokeMsg.toolId,
                invokeMsg.params,
                request.signal,
              );
              worker.postMessage({
                type: 'invoke-tool-response',
                id: invokeMsg.id,
                ok: true,
                result: nested,
              } as InvokeToolResponseMessage);
            } catch (err: any) {
              worker.postMessage({
                type: 'invoke-tool-response',
                id: invokeMsg.id,
                ok: false,
                error: err?.message ?? String(err),
              } as InvokeToolResponseMessage);
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
      this.activeWorkers--;
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

    if (isCompiledPath) {
      // Tight prod scope: only the worker script's own directory
      // and any installed-dependency directories. Nothing else on
      // the filesystem is readable.
      argv.push(`--allow-fs-read=${path.dirname(workerPath)}`);
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

  /** Process the next queued request if we have capacity */
  private drainQueue(): void {
    const maxWorkers = parseInt(process.env.SANDBOX_MAX_WORKERS || '', 10) || DEFAULT_MAX_WORKERS;

    while (this.queue.length > 0 && this.activeWorkers < maxWorkers) {
      const next = this.queue.shift()!;
      // runWorker has its own try/catch and should always resolve, but
      // attach a .catch as a safety net so a queued caller never hangs
      // forever if a future refactor introduces a rejection path.
      this.runWorker(next.request).then(next.resolve, (err: any) => {
        next.resolve({
          success: false,
          error: err?.message ?? String(err),
          executionTimeMs: 0,
        });
      });
    }
  }
}
