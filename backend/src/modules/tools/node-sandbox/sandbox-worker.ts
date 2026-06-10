/**
 * Worker thread script — executed inside a Node.js Worker.
 *
 * Reads `workerData` for code, parameters, credentials, and module paths.
 * Installs the sandbox net-guard, scrubs process.env, and runs the
 * user code as an AsyncFunction with an allowlisted require and an
 * injected `tools` global for nested tool invocation.
 *
 * Execution order is deliberate:
 *
 *   1. installSandboxNetGuard() — monkey-patches `dns.lookup`,
 *      `net.Socket.prototype.connect`, and `dgram.Socket.send` so
 *      that ANY subsequent require of `net`/`http`/`https`/`dgram`/
 *      npm packages that use them inherits the patched behaviour.
 *      MUST run before the require allowlist is built, because
 *      `createRequire` itself does not trigger these requires but
 *      user code, npm deps, and ts-node will.
 *   2. process.env scrub — removes every inherited secret. Must
 *      happen before user code can read `process.env`, which means
 *      before the AsyncFunction is invoked.
 *   3. Allowlisted require + dep-path resolution — the user's
 *      `require('foo')` calls go through this.
 *   4. `tools` shim — posted-message bridge back to the host so
 *      user code can invoke other tools by id without having to
 *      open its own HTTP connection to the backend (which would
 *      be refused by the net-guard anyway).
 *   5. AsyncFunction invocation — the one and only place the
 *      user-controlled string becomes live code.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
import { parentPort, workerData } from 'worker_threads';
import { createRequire, builtinModules } from 'module';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { WorkerInput, WorkerOutput } from './types';
import { installSandboxNetGuard } from './sandbox-net-guard';

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
 *     The net-guard still intercepts every connection attempt those
 *     deps make, so the SSRF boundary holds regardless.
 *   - Globals like `fetch` (Node 18+) and `URL` / `Buffer` are
 *     always reachable without require(). The allowlist does not
 *     stop them, and doesn't try to. `fetch` is built on undici
 *     which uses `net.Socket.prototype.connect` under the hood, so
 *     the net-guard catches it too.
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

// ── Tool-invocation bridge types ────────────────────────────────

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

async function run() {
  const input = workerData as WorkerInput;
  const { code, parameters, credentials, modulePaths, toolInvokeEnabled, testNetAllow } =
    input;

  // Step 1 — install network guard BEFORE anything else can require
  // net/http/https/dgram. This patches the prototypes in place so
  // every subsequent require sees the patched version.
  installSandboxNetGuard({ testAllow: testNetAllow });

  // Step 2 — scrub process.env before user code runs. The worker thread
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

  // Step 3 — build the allowlisted require. First try resolving
  // from each module path (installed dependencies). These are
  // trusted by the tool author and may legitimately include
  // libraries that transitively require builtins we'd otherwise
  // block. Fall back to the builtin allowlist for everything else.
  const originalRequire = createRequire(__filename);

  const sandboxRequire = (id: string) => {
    // Node built-ins must clear the allowlist BEFORE we try the
    // dependency module paths. createRequire(depPath).resolve('net')
    // resolves a built-in to its bare specifier and returns the real
    // module, so without this guard any tool that ships a dependency
    // (non-empty modulePaths) could require('child_process') /
    // require('net') / require('fs') and bypass the entire allowlist.
    // Strip a node: prefix for the built-in test.
    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    if (builtinModules.includes(bareId)) {
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
    }
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

  // Step 4 — build the `tools` shim, if the host wired up a
  // tools.invoke callback. When user code calls `tools.invoke(id, params)`
  // we post an `invoke-tool` message to the host, the host runs
  // the nested tool in its own fresh sandbox, and posts back
  // the result correlated by the same `id`. This lets a tool
  // compose other tools without having to open an HTTP connection
  // to the backend (which would be refused by the net-guard
  // anyway since the backend is on 127.0.0.1).
  //
  // Design notes on failure modes:
  //   - If the host side never responds, the promise hangs forever.
  //     That's fine — the outer worker timeout eventually fires and
  //     the whole worker is terminated.
  //   - Errors from the nested tool are surfaced as a rejected
  //     promise with the host's error string, so `try/catch` in
  //     user code works the way they'd expect.
  //   - We use randomUUID for correlation ids so concurrent
  //     invocations don't collide if user code kicks off multiple
  //     Promise.all'd invocations.
  const pendingInvocations = new Map<
    string,
    { resolve: (value: any) => void; reject: (err: Error) => void }
  >();

  let tools: { invoke: (toolId: string, params: Record<string, any>) => Promise<any> } | undefined;
  if (toolInvokeEnabled) {
    parentPort!.on('message', (msg: InvokeToolResponseMessage) => {
      if (msg?.type !== 'invoke-tool-response') return;
      const pending = pendingInvocations.get(msg.id);
      if (!pending) return;
      pendingInvocations.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error ?? 'tools.invoke failed'));
      }
    });

    tools = {
      invoke(toolId: string, params: Record<string, any> = {}): Promise<any> {
        if (typeof toolId !== 'string' || !toolId) {
          return Promise.reject(new Error('tools.invoke: toolId must be a non-empty string'));
        }
        const id = randomUUID();
        const request: InvokeToolRequestMessage = {
          type: 'invoke-tool',
          id,
          toolId,
          params: params ?? {},
        };
        return new Promise<any>((resolve, reject) => {
          pendingInvocations.set(id, { resolve, reject });
          try {
            parentPort!.postMessage(request);
          } catch (err: any) {
            pendingInvocations.delete(id);
            reject(err);
          }
        });
      },
    };
  }

  try {
    // Step 5 — create an AsyncFunction from the user code. The
    // function receives `parameters`, `credentials`, `require`,
    // and (conditionally) `tools` as arguments. We pass them as
    // positional args to the generated function so user code
    // can reference them as if they were free identifiers.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('parameters', 'credentials', 'require', 'tools', code);

    const result = await fn(parameters, credentials, sandboxRequire, tools);

    const output: WorkerOutput = { success: true, data: result };
    parentPort!.postMessage(output);
  } catch (err: any) {
    const output: WorkerOutput = {
      success: false,
      error: err?.message ?? String(err),
    };
    parentPort!.postMessage(output);
  } finally {
    // Tear down the tool-invocation listener so the worker can
    // exit cleanly. A live `parentPort.on('message')` subscription
    // is a keep-alive — without this, a worker that used
    // tools.invoke would sit idle forever after user code returns
    // and the host-side `worker.terminate()` timeout would be the
    // only thing that ever shuts it down.
    if (toolInvokeEnabled) {
      parentPort!.removeAllListeners('message');
    }
  }
}

run();
