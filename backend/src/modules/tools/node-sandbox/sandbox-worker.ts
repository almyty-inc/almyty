/**
 * Worker thread script — executed inside a Node.js Worker.
 *
 * Reads `workerData` for code, parameters, credentials, and module paths.
 * Blocks dangerous built-in modules and runs the user code as an AsyncFunction.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
import { parentPort, workerData } from 'worker_threads';
import { createRequire } from 'module';
import * as path from 'path';
import { WorkerInput, WorkerOutput } from './types';

/**
 * Modules that user sandbox code is NOT allowed to require(). This is
 * a denylist rather than an allowlist because tools legitimately need
 * 'crypto', 'buffer', 'url', 'util', etc. for common HTTP/data work,
 * but a handful of modules are either outright code-exec primitives
 * (child_process, vm, worker_threads) or trivially defeat every other
 * protection in this worker:
 *
 *   - fs / fs/promises: read arbitrary files on the host, including
 *     /etc/passwd, the backend's .env, stored credentials, and any
 *     mounted volume. Tools can do file transport via the platform
 *     Files API, they don't need raw fs.
 *   - http / https / http2 / net / tls / dgram / dns: raw networking
 *     sockets bypass every SSRF gate and egress restriction; tools
 *     that need HTTP should use the global `fetch` which runs through
 *     the rest of the stack.
 *   - os: leaks hostname, CPU model, user, network interfaces — a
 *     fingerprinting primitive for the host.
 *   - module: createRequire / _load can be used to reach anything
 *     the worker process can reach, defeating this allowlist.
 *   - path: by itself path is harmless, but allowing it while
 *     blocking fs leaves a papertrail that suggests fs is accessible,
 *     which is confusing. Left allowed for now — see fallthrough.
 *   - process: reachable globally anyway, scrubbed separately below.
 */
const BLOCKED_MODULES = new Set([
  'child_process',
  'cluster',
  'dgram',
  'dns',
  'net',
  'tls',
  'vm',
  'worker_threads',
  'v8',
  'perf_hooks',
  'trace_events',
  'inspector',
  'repl',
  'fs',
  'fs/promises',
  'node:fs',
  'node:fs/promises',
  'http',
  'https',
  'http2',
  'node:http',
  'node:https',
  'node:http2',
  'node:net',
  'node:tls',
  'node:dgram',
  'node:dns',
  'node:child_process',
  'node:cluster',
  'node:worker_threads',
  'node:vm',
  'node:v8',
  'node:perf_hooks',
  'node:trace_events',
  'node:inspector',
  'os',
  'node:os',
  'module',
  'node:module',
]);

async function run() {
  const input = workerData as WorkerInput;
  const { code, parameters, credentials, modulePaths } = input;

  // Scrub process.env before user code runs. The worker thread
  // inherits the backend's environment by default, which means every
  // secret the backend loaded at startup — DATABASE_PASSWORD,
  // JWT_SECRET, RESEND_API_KEY, LLM provider keys, OAuth secrets —
  // is visible to user code via a trivial `process.env.DATABASE_PASSWORD`
  // read. Worker resourceLimits don't touch this; it's a separate
  // data-exposure problem from CPU/memory.
  //
  // Replace the entire env map with an empty object. Anything the
  // tool legitimately needs should be passed in via `parameters` or
  // `credentials` from the caller — that's already the contract.
  try {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
  } catch {
    // process.env is frozen on some platforms — fall back to
    // overwriting the property. Worst-case the scrub is partial
    // on that one platform rather than throwing.
    try {
      (process as any).env = {};
    } catch {
      /* give up; denylist above is still in place */
    }
  }

  // Build a custom require that:
  // 1) blocks dangerous built-in modules
  // 2) resolves packages from the installed module paths
  const originalRequire = createRequire(__filename);

  const sandboxRequire = (id: string) => {
    // Block dangerous modules
    if (BLOCKED_MODULES.has(id)) {
      throw new Error(`Module "${id}" is not allowed in the sandbox`);
    }

    // First, try resolving from each module path (installed dependencies)
    for (const mp of modulePaths) {
      try {
        const depRequire = createRequire(
          path.join(mp, 'node_modules', '_placeholder.js'),
        );
        const resolved = depRequire.resolve(id);
        return require(resolved);
      } catch {
        // not found in this path — try next
      }
    }

    // Fall back to the worker's own require (built-in modules like 'fs', 'path', 'crypto', etc.)
    return originalRequire(id);
  };

  try {
    // Create an AsyncFunction from the user code.
    // The function receives `parameters`, `credentials`, and `require` as arguments.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('parameters', 'credentials', 'require', code);

    const result = await fn(parameters, credentials, sandboxRequire);

    const output: WorkerOutput = { success: true, data: result };
    parentPort!.postMessage(output);
  } catch (err: any) {
    const output: WorkerOutput = {
      success: false,
      error: err?.message ?? String(err),
    };
    parentPort!.postMessage(output);
  }
}

run();
