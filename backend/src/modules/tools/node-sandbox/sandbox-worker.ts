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
]);

async function run() {
  const input = workerData as WorkerInput;
  const { code, parameters, credentials, modulePaths } = input;

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
