import { Injectable } from '@nestjs/common';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';

import { codeWorkerDone } from './node-sandbox.service';
import { CodeCallError, CodeSandboxRequest, CodeSandboxResult } from './types';
import type { QuickJsWorkerInput } from './quickjs-sandbox-worker';

/** The interpreter's packages: the only files the worker may read besides its own. */
const QUICKJS_PACKAGES = ['quickjs-emscripten', 'quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync', '@jitl/quickjs-ffi-types'];

const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_MAX_QUEUE_SIZE = 50;
const DEFAULT_BOOT_TIMEOUT_MS = 30_000;
/** The worker's own JavaScript heap. The script's memory is the WebAssembly memory, capped separately. */
const WORKER_HEAP_MB = 64;

export interface QuickJsSandboxRequest extends CodeSandboxRequest {
  /** Time the script may spend computing inside the interpreter (CODE_MODE_CPU_MS). */
  cpuBudgetMs: number;
}

export interface QuickJsSandboxResult extends CodeSandboxResult {
  cpuExceeded?: boolean;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Model-written code from outside clients (gateway `run_code`), run in
 * QuickJS compiled to WebAssembly (docs/design/code-mode.md, "P3 gate",
 * decision 1 as taken). Agents and workflows inside almyty keep the Node
 * `code` profile (NodeSandboxService.executeCode).
 *
 * Each script gets a fresh worker of its own, terminated when the script
 * ends, so the interpreter never runs on the server's event loop and its
 * memory is always given back. The worker starts with the permission
 * model on, read access to its own files and the interpreter's packages
 * only, no network, no child processes and an empty environment.
 *
 * Limits: the WebAssembly memory cannot grow past `memoryLimitMb`, and an
 * out-of-memory ends the worker; the interpreter stops a script past
 * `cpuBudgetMs` of computing; the host terminates the worker at
 * `timeoutMs` of wall time, whatever the script is doing.
 *
 * The pool is its own (SANDBOX_QUICKJS_*), apart from JavaScript tools and
 * from the Node code profile:
 *   SANDBOX_QUICKJS_MAX_WORKERS        4        running at once
 *   SANDBOX_QUICKJS_MAX_WORKERS_PER_ORG  half   for one organization
 *   SANDBOX_QUICKJS_MAX_QUEUE_SIZE     50       waiting; past it, refused
 *   SANDBOX_QUICKJS_MAX_QUEUE_PER_ORG  a quarter  waiting for one organization
 */
@Injectable()
export class QuickJsSandboxService {
  private active = 0;
  private readonly activeByOrg = new Map<string, number>();
  private readonly queue: Array<{ resolve: (result: QuickJsSandboxResult) => void; request: QuickJsSandboxRequest; orgKey: string }> = [];

  async executeCode(request: QuickJsSandboxRequest): Promise<QuickJsSandboxResult> {
    const refused = (message: string): QuickJsSandboxResult => ({ success: false, logs: '', error: { message }, durationMs: 0, cpuMs: 0 });
    if (request.signal?.aborted) return refused('Cancelled');
    const limits = this.limits();
    const orgKey = request.organizationId || '';
    if (this.active < limits.maxWorkers && (this.activeByOrg.get(orgKey) ?? 0) < limits.maxWorkersPerOrg) {
      return this.runWorker(request, orgKey);
    }
    if (this.queue.length >= limits.maxQueueSize) return refused(`Too many scripts are waiting to run (${limits.maxQueueSize}). Try again shortly.`);
    if (this.queue.filter((q) => q.orgKey === orgKey).length >= limits.maxQueuePerOrg) {
      return refused(`Too many scripts of this organization are waiting to run (${limits.maxQueuePerOrg}). Try again shortly.`);
    }
    return new Promise<QuickJsSandboxResult>((resolve) => this.queue.push({ resolve, request, orgKey }));
  }

  private async runWorker(request: QuickJsSandboxRequest, orgKey: string): Promise<QuickJsSandboxResult> {
    this.active++;
    this.activeByOrg.set(orgKey, (this.activeByOrg.get(orgKey) ?? 0) + 1);
    const start = Date.now();
    try {
      let workerPath = path.join(__dirname, 'quickjs-sandbox-worker.js');
      const compiled = fs.existsSync(workerPath);
      if (!compiled) workerPath = path.join(__dirname, 'quickjs-sandbox-worker.ts');
      const workerData: QuickJsWorkerInput = {
        code: request.code,
        namespaces: request.namespaces,
        logCapChars: request.logCapChars,
        resultCapChars: request.resultCapChars,
        memoryLimitMb: request.memoryLimitMb,
        cpuBudgetMs: request.cpuBudgetMs,
        ...(request.context !== undefined ? { context: request.context } : {}),
      };
      return await new Promise<QuickJsSandboxResult>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const worker = new Worker(workerPath, {
          workerData,
          env: {},
          resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB, maxYoungGenerationSizeMb: 16 },
          execArgv: this.execArgv(workerPath, compiled, request.extraAllowReads),
        } as any);
        let cpuFrom: ReturnType<typeof worker.performance.eventLoopUtilization> | undefined;
        const cpuMs = () => {
          try {
            return Math.round(worker.performance.eventLoopUtilization(cpuFrom).active);
          } catch {
            return 0;
          }
        };
        const settle = (r: Omit<QuickJsSandboxResult, 'durationMs' | 'cpuMs'>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener?.('abort', onAbort);
          const used = cpuMs();
          // Always: the worker's memory, the WebAssembly memory included, goes back.
          void worker.terminate();
          resolve({ ...r, durationMs: Date.now() - start, cpuMs: used });
        };
        const failed = (message: string, extra: Partial<QuickJsSandboxResult> = {}) => settle({ success: false, logs: '', error: { message }, ...extra });
        timer = setTimeout(() => failed(`The sandbox did not start within ${DEFAULT_BOOT_TIMEOUT_MS}ms`), positiveIntFromEnv('SANDBOX_BOOT_TIMEOUT_MS', DEFAULT_BOOT_TIMEOUT_MS));
        const onAbort = () => failed('Cancelled');
        if (request.signal) {
          if (request.signal.aborted) onAbort();
          else request.signal.addEventListener('abort', onAbort);
        }
        worker.on('message', async (msg: any) => {
          if (msg?.type === 'ready') {
            try {
              cpuFrom = worker.performance.eventLoopUtilization();
            } catch {
              /* counted from the start */
            }
            clearTimeout(timer);
            timer = setTimeout(() => failed(`The script timed out after ${request.timeoutMs}ms`, { timedOut: true }), request.timeoutMs);
            return;
          }
          if (msg?.type === 'code-call') {
            const reply = (message: Record<string, unknown>) => {
              if (settled) return;
              try {
                worker.postMessage({ type: 'code-call-response', id: msg.id, ...message });
              } catch {
                /* worker gone */
              }
            };
            try {
              reply({ ok: true, result: await request.onCall(msg.call) });
            } catch (err: any) {
              reply({ ok: false, error: err?.message ?? String(err), ...(err instanceof CodeCallError && err.tool ? { tool: err.tool } : {}) });
            }
            return;
          }
          if (msg?.type === 'done') {
            settle({
              ...codeWorkerDone(msg, request),
              ...(msg.oom === true ? { oom: true, error: { message: `The script ran out of memory (${request.memoryLimitMb} MB)` }, success: false } : {}),
              ...(msg.cpuExceeded === true ? { cpuExceeded: true } : {}),
            });
          }
        });
        worker.on('error', (err: Error) => {
          const oom = /out of memory|allocation failed|heap|memory/i.test(err?.message ?? '');
          failed(oom ? `The script ran out of memory (${request.memoryLimitMb} MB)` : (err?.message ?? String(err)), oom ? { oom: true } : {});
        });
        worker.on('exit', (code: number) => failed(`The sandbox stopped (exit code ${code})`));
      });
    } catch (err: any) {
      return { success: false, logs: '', error: { message: err?.message ?? String(err) }, durationMs: Date.now() - start, cpuMs: 0 };
    } finally {
      this.active--;
      const n = (this.activeByOrg.get(orgKey) ?? 1) - 1;
      if (n > 0) this.activeByOrg.set(orgKey, n);
      else this.activeByOrg.delete(orgKey);
      this.drain();
    }
  }

  private drain(): void {
    const limits = this.limits();
    let i = 0;
    while (i < this.queue.length && this.active < limits.maxWorkers) {
      const next = this.queue[i];
      if ((this.activeByOrg.get(next.orgKey) ?? 0) >= limits.maxWorkersPerOrg) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.runWorker(next.request, next.orgKey).then(next.resolve, (err: any) =>
        next.resolve({ success: false, logs: '', error: { message: err?.message ?? String(err) }, durationMs: 0, cpuMs: 0 }),
      );
    }
  }

  /**
   * The permission model, read access to the worker's own files and the
   * interpreter's packages only, and never --allow-net, --allow-child-process
   * or --allow-worker.
   */
  execArgv(workerPath: string, compiled: boolean, extraAllowReads: string[] = []): string[] {
    const argv: string[] = [];
    if (!compiled) argv.push('-r', 'ts-node/register/transpile-only');
    argv.push('--permission');
    if (compiled) {
      argv.push(`--allow-fs-read=${path.dirname(workerPath)}`);
      for (const dir of quickJsPackageDirs()) argv.push(`--allow-fs-read=${dir}`);
    } else {
      // ts-node (tests, local dev) reads the project's sources and modules.
      const root = backendRoot(workerPath);
      argv.push(`--allow-fs-read=${root}`, `--allow-fs-read=${path.join(root, 'node_modules')}`, `--allow-fs-read=${path.dirname(process.execPath)}`);
    }
    for (const extra of extraAllowReads) argv.push(`--allow-fs-read=${extra}`);
    return argv;
  }

  private limits() {
    const maxWorkers = positiveIntFromEnv('SANDBOX_QUICKJS_MAX_WORKERS', DEFAULT_MAX_WORKERS);
    const maxQueueSize = positiveIntFromEnv('SANDBOX_QUICKJS_MAX_QUEUE_SIZE', DEFAULT_MAX_QUEUE_SIZE);
    return {
      maxWorkers,
      maxWorkersPerOrg: Math.min(maxWorkers, positiveIntFromEnv('SANDBOX_QUICKJS_MAX_WORKERS_PER_ORG', Math.max(1, Math.ceil(maxWorkers / 2)))),
      maxQueueSize,
      maxQueuePerOrg: Math.min(maxQueueSize, positiveIntFromEnv('SANDBOX_QUICKJS_MAX_QUEUE_PER_ORG', Math.max(1, Math.ceil(maxQueueSize / 4)))),
    };
  }
}

/** The installed directories of the interpreter's packages. */
export function quickJsPackageDirs(): string[] {
  const dirs: string[] = [];
  for (const name of QUICKJS_PACKAGES) {
    try {
      dirs.push(path.dirname(require.resolve(`${name}/package.json`)));
    } catch {
      /* not installed separately: covered by its parent */
    }
  }
  return dirs;
}

function backendRoot(workerPath: string): string {
  let dir = path.dirname(workerPath);
  while (dir !== path.parse(dir).root) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(workerPath);
}
