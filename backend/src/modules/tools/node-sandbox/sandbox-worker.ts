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
 * ALLOWLIST of Node built-ins that user sandbox code may require().
 *
 * We previously ran a denylist (block fs, http, net, child_process,
 * worker_threads, ...) but that's a losing game: every new Node
 * release adds builtins, and forgetting to add one to the denylist
 * is a silent regression. Flip to an explicit allowlist — if a
 * module isn't in this set, the sandbox refuses to load it.
 *
 * The allowed set covers what legitimate tool code needs for data
 * manipulation, text processing, cryptography, URL/query parsing,
 * and compression. Everything else — filesystem, raw networking,
 * process spawning, module loading, introspection, etc. — stays
 * out of reach of user code (subject to the caveats below).
 *
 * Caveats:
 *   - `process` is a global, so `process.env` / `process.exit` /
 *     etc. don't go through require() at all. We scrub process.env
 *     separately at worker boot; process.exit is left alone because
 *     the worker terminating kills only its own thread, not the
 *     parent process.
 *   - Transitive requires from INSTALLED dependencies (tools with
 *     an npm package dependency) use the worker's native require,
 *     not this sandboxRequire. So a dependency that requires `http`
 *     internally will still load `http`. The allowlist only gates
 *     direct user-written `require('foo')` calls — this is deliberate,
 *     because installed deps are trusted by the tool author and
 *     most legitimate HTTP tools need their SDK to reach the network.
 *   - Globals like `fetch` (Node 18+) and `URL` / `Buffer` are
 *     always reachable without require(). The allowlist does not
 *     stop them, and doesn't try to.
 */
const ALLOWED_MODULES = new Set([
  'crypto',
  'node:crypto',
  'buffer',
  'node:buffer',
  'util',
  'node:util',
  'url',
  'node:url',
  'querystring',
  'node:querystring',
  'string_decoder',
  'node:string_decoder',
  'punycode',
  'node:punycode',
  'events',
  'node:events',
  'stream',
  'node:stream',
  'stream/web',
  'node:stream/web',
  'stream/promises',
  'node:stream/promises',
  'timers',
  'node:timers',
  'timers/promises',
  'node:timers/promises',
  'zlib',
  'node:zlib',
  'assert',
  'node:assert',
  'path',
  'node:path',
  'async_hooks',
  'node:async_hooks',
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
  //   1) prefers installed dependencies (from the provided module
  //      paths) so a tool's declared npm deps resolve correctly
  //   2) falls back to the allowlist of built-ins for everything
  //      that didn't resolve as a dep
  //   3) refuses any built-in that isn't on the allowlist
  const originalRequire = createRequire(__filename);

  const sandboxRequire = (id: string) => {
    // First, try resolving from each module path (installed
    // dependencies). These are trusted by the tool author and may
    // legitimately include libraries that transitively require
    // builtins we'd otherwise block.
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

    // Not an installed dep — must be a Node built-in. Refuse if
    // it's not on the allowlist. This is the core of the
    // denylist → allowlist flip: a built-in we didn't remember
    // to add to the old blocklist now fails closed instead of
    // falling through to originalRequire().
    if (!ALLOWED_MODULES.has(id)) {
      throw new Error(
        `Module "${id}" is not allowed in the sandbox. Allowed built-ins: ${Array.from(
          ALLOWED_MODULES,
        )
          .filter((m) => !m.startsWith('node:'))
          .join(', ')}.`,
      );
    }
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
