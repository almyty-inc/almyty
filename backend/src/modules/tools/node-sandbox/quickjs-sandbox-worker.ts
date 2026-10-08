/**
 * The worker of the QuickJS runtime for model-written code from outside
 * clients (docs/design/code-mode.md, "P3 gate", decision 1 as taken): the
 * script runs in QuickJS compiled to WebAssembly, inside a worker of its
 * own that the host terminates after every script, so the server's event
 * loop never runs the script and every byte it allocated is given back.
 *
 * Inside the interpreter there is nothing but the language: no `require`,
 * no `import`, no `process`, no network, no timers, no files, no message
 * port. The script reaches the outside only through one host function,
 * captured by the prelude and removed from the global object; it speaks
 * the same broker protocol as the Node `code` profile (code-sandbox-worker.ts):
 * `code-call` out, `code-call-response` back, one `done` at the end.
 *
 * Limits, each enforced here and again by the host:
 *   - memory: the WebAssembly memory has a hard maximum (it cannot grow
 *     past it), and QuickJS's own allocator is capped a little under it so
 *     the script gets a clean "out of memory";
 *   - CPU: the time spent inside the interpreter is summed, and the
 *     interrupt handler stops the script once it passes the budget;
 *   - wall time: the host terminates the worker at the deadline.
 */
import { parentPort, workerData } from 'worker_threads';
import { randomUUID } from 'crypto';
import { newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC } from 'quickjs-emscripten';
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';

import type { CodeCall, CodeWorkerDone } from './types';
import { CODE_GLOBAL_NAMES } from './types';

export interface QuickJsWorkerInput {
  code: string;
  namespaces: Record<string, string[]>;
  logCapChars: number;
  resultCapChars: number;
  memoryLimitMb: number;
  cpuBudgetMs: number;
  context?: unknown;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The handle of a result whose error was ruled out above. */
const ok = (result: { error?: QuickJSHandle }): QuickJSHandle => (result as { value: QuickJSHandle }).value;
const PAGE = 64 * 1024;

/**
 * The script's own globals, built inside the interpreter. `__host` is the
 * only bridge; the prelude keeps it in a closure and deletes it.
 */
export function quickJsPrelude(namespaces: Record<string, string[]>, context: unknown): string {
  const ns: Record<string, string[]> = {};
  for (const [name, fns] of Object.entries(namespaces)) {
    if (!IDENTIFIER.test(name) || (CODE_GLOBAL_NAMES as readonly string[]).includes(name)) continue;
    ns[name] = fns.filter((f) => IDENTIFIER.test(f));
  }
  return `
(() => {
  "use strict";
  const host = globalThis.__host;
  const hostLog = globalThis.__hostLog;
  delete globalThis.__host;
  delete globalThis.__hostLog;
  class ToolError extends Error {
    constructor(message, tool) { super(message); this.name = 'ToolError'; this.tool = tool; }
  }
  const text = (v) => {
    if (typeof v === 'string') return v;
    if (v === undefined) return 'undefined';
    try { const t = JSON.stringify(v); return t === undefined ? String(v) : t; } catch { return String(v); }
  };
  const call = async (payload) => {
    let body;
    try { body = JSON.stringify(payload); } catch (e) { throw new ToolError('Arguments must be plain JSON: ' + e.message); }
    const answer = JSON.parse(await host(body));
    if (!answer.ok) throw new ToolError(String(answer.error), answer.tool);
    return answer.result;
  };
  const log = (...args) => { hostLog(args.map(text).join(' ')); };
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, writable: false, configurable: false, enumerable: false });
  const freeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) freeze(o[k]); } return o; };
  const ns = ${JSON.stringify(ns)};
  for (const [name, fns] of Object.entries(ns)) {
    const api = {};
    for (const fn of fns) api[fn] = (args) => call({ op: 'tool', namespace: name, fn, args: args === undefined ? {} : args });
    define(name, Object.freeze(api));
  }
  define('tools', Object.freeze({
    search: (query, limit) => call({ op: 'search', query, limit }),
    get: (name, detail) => call({ op: 'get', name, detail }),
    call: (name, args) => call({ op: 'call', name, args: args === undefined ? {} : args }),
  }));
  define('extract', (value, schema) => call({ op: 'extract', value, schema }));
  define('log', log);
  define('console', Object.freeze({ log, info: log, warn: log, error: log, debug: log }));
  define('ToolError', ToolError);
  define('context', freeze(${JSON.stringify(context === undefined ? null : context)}));
})();
`;
}

async function run(): Promise<void> {
  const input = workerData as QuickJsWorkerInput;
  const port = parentPort!;

  let logs = '';
  let logChars = 0;
  let finished = false;
  const finish = (done: Omit<CodeWorkerDone, 'type' | 'logs' | 'logChars'> & { oom?: boolean; cpuExceeded?: boolean }) => {
    if (finished) return;
    finished = true;
    port.postMessage({ type: 'done', ...done, logs, logChars });
  };

  // Memory: a hard maximum on the WebAssembly memory, and QuickJS's own
  // allocator a little under it for a clean "out of memory".
  const maxPages = Math.max(16, Math.ceil((input.memoryLimitMb * 1024 * 1024) / PAGE));
  const memory = new WebAssembly.Memory({ initial: Math.min(maxPages, 256), maximum: maxPages });
  const QuickJS = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmMemory: memory }));
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(Math.floor(maxPages * PAGE * 0.85));
  runtime.setMaxStackSize(1024 * 1024);

  // CPU: time inside the interpreter, summed over every synchronous entry.
  let cpuUsed = 0;
  let segmentStart = 0;
  let cpuExceeded = false;
  runtime.setInterruptHandler(() => {
    if (segmentStart && cpuUsed + (performance.now() - segmentStart) > input.cpuBudgetMs) {
      cpuExceeded = true;
      return true;
    }
    return false;
  });
  const timed = <T>(fn: () => T): T => {
    segmentStart = performance.now();
    try {
      return fn();
    } finally {
      cpuUsed += performance.now() - segmentStart;
      segmentStart = 0;
    }
  };

  const vm: QuickJSContext = runtime.newContext();
  const pending = new Map<string, (answer: string) => void>();
  port.on('message', (msg: any) => {
    if (msg?.type !== 'code-call-response') return;
    const settle = pending.get(msg.id);
    if (!settle) return;
    pending.delete(msg.id);
    settle(JSON.stringify(msg.ok ? { ok: true, result: msg.result ?? null } : { ok: false, error: String(msg.error ?? 'The call failed'), tool: msg.tool }));
  });

  const hostLog = vm.newFunction('__hostLog', (line: QuickJSHandle) => {
    const text = vm.getString(line);
    logChars += (logChars ? 1 : 0) + text.length;
    if (logs.length < input.logCapChars) {
      logs += (logs ? '\n' : '') + text;
      if (logs.length > input.logCapChars) logs = logs.slice(0, input.logCapChars);
    }
  });
  vm.setProp(vm.global, '__hostLog', hostLog);
  hostLog.dispose();

  const host = vm.newFunction('__host', (body: QuickJSHandle) => {
    const deferred = vm.newPromise();
    let call: CodeCall;
    try {
      call = JSON.parse(vm.getString(body));
    } catch {
      const h = vm.newString(JSON.stringify({ ok: false, error: 'Arguments must be plain JSON' }));
      deferred.resolve(h);
      h.dispose();
      return deferred.handle;
    }
    const id = randomUUID();
    pending.set(id, (answer) => {
      if (finished || !deferred.alive) return;
      const h = vm.newString(answer);
      deferred.resolve(h);
      h.dispose();
      try {
        timed(() => runtime.executePendingJobs());
      } catch {
        /* reported through the script's promise */
      }
    });
    port.postMessage({ type: 'code-call', id, call });
    return deferred.handle;
  });
  vm.setProp(vm.global, '__host', host);
  host.dispose();

  const describe = (handle: QuickJSHandle) => {
    const err = vm.dump(handle);
    handle.dispose();
    const message = typeof err === 'object' && err ? String(err.message ?? JSON.stringify(err)) : String(err);
    const line = typeof err?.stack === 'string' ? /script\.js:(\d+)/.exec(err.stack) : null;
    return {
      message: cpuExceeded ? `The script used its CPU budget (${input.cpuBudgetMs} ms)` : message,
      line: line ? Number(line[1]) - 1 : undefined,
      tool: typeof err?.tool === 'string' ? err.tool : undefined,
      oom: /out of memory/i.test(message),
    };
  };

  const prelude = timed(() => vm.evalCode(quickJsPrelude(input.namespaces, input.context), 'prelude.js'));
  if (prelude.error) {
    const e = describe(prelude.error);
    finish({ success: false, error: { message: `The sandbox did not start: ${e.message}` } });
    return;
  }
  ok(prelude).dispose();

  port.postMessage({ type: 'ready' });

  const source = `(async () => { "use strict";\n${input.code}\n})().then((v) => { const t = JSON.stringify(v === undefined ? null : v); if (t === undefined) throw new Error('The return value is not JSON'); return t; })`;
  const started = timed(() => vm.evalCode(source, 'script.js'));
  if (started.error) {
    const e = describe(started.error);
    finish({ success: false, error: { message: e.message, ...(e.line ? { line: e.line } : {}) }, ...(e.oom ? { oom: true } : {}), ...(cpuExceeded ? { cpuExceeded: true } : {}) });
    return;
  }
  const promise = vm.resolvePromise(ok(started));
  ok(started).dispose();
  timed(() => runtime.executePendingJobs());
  const settled = await promise;
  if (settled.error) {
    const e = describe(settled.error);
    finish({
      success: false,
      error: { message: e.message, ...(e.line ? { line: e.line } : {}), ...(e.tool ? { tool: e.tool } : {}) },
      ...(e.oom ? { oom: true } : {}),
      ...(cpuExceeded ? { cpuExceeded: true } : {}),
    });
    return;
  }
  const json = vm.getString(ok(settled));
  ok(settled).dispose();
  finish({
    success: true,
    resultJson: json.length > input.resultCapChars ? json.slice(0, input.resultCapChars) : json,
    ...(json.length > input.resultCapChars ? { resultChars: json.length } : {}),
  });
}

run().catch((err: any) => {
  const message = String(err?.message ?? err);
  parentPort?.postMessage({
    type: 'done',
    success: false,
    logs: '',
    logChars: 0,
    error: { message: /memory|grow/i.test(message) ? 'The script ran out of memory' : message },
    ...(/memory|grow/i.test(message) ? { oom: true } : {}),
  });
});
