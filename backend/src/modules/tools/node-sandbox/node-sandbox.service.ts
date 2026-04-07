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
      };

      // Resolve the worker script — prefer compiled .js, fall back to .ts for tests
      let workerPath = path.join(__dirname, 'sandbox-worker.js');
      const workerOpts: any = {
        workerData: workerInput,
        resourceLimits: {
          maxOldGenerationSizeMb: memoryLimitMb,
          maxYoungGenerationSizeMb: Math.ceil(memoryLimitMb / 4),
        },
      };

      if (!fs.existsSync(workerPath)) {
        const tsPath = path.join(__dirname, 'sandbox-worker.ts');
        if (fs.existsSync(tsPath)) {
          workerPath = tsPath;
          workerOpts.execArgv = ['-r', 'ts-node/register/transpile-only'];
        }
      }

      const result = await new Promise<SandboxExecutionResult>((resolve) => {
        let settled = false;

        const worker = new Worker(workerPath, workerOpts);

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            worker.terminate();
            resolve({
              success: false,
              error: `Execution timed out after ${timeoutMs}ms`,
              executionTimeMs: Date.now() - start,
            });
          }
        }, timeoutMs);

        worker.on('message', (msg: WorkerOutput) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({
              success: msg.success,
              data: msg.data,
              error: msg.error,
              executionTimeMs: Date.now() - start,
            });
          }
        });

        worker.on('error', (err: Error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            const isOom =
              err.message?.includes('out of memory') ||
              err.message?.includes('allocation failed') ||
              err.message?.includes('heap') ||
              err.message?.includes('JavaScript heap');
            resolve({
              success: false,
              error: err.message,
              executionTimeMs: Date.now() - start,
              oom: isOom || undefined,
            });
          }
        });

        worker.on('exit', (code: number) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({
              success: false,
              error: `Worker exited with code ${code}`,
              executionTimeMs: Date.now() - start,
            });
          }
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
