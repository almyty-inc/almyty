/**
 * The worker of the `code` sandbox profile: runs model-written code
 * (docs/design/code-mode.md, parts C and D).
 *
 * Unlike the JavaScript-tool worker (sandbox-worker.ts) this one gives the
 * script nothing to reach the outside with:
 *
 *   - no network: the host starts it without --allow-net, so Node 26
 *     refuses every socket, and the net guard is installed in deny-all
 *     mode (and sealed) underneath, for a runtime that would not;
 *   - no modules: every resolution from the script is refused, built-in
 *     or not (`import()`, `process.mainModule.require`, `createRequire`);
 *     there is no `require`, no installed dependency and no credentials;
 *   - no environment: process.env is emptied before the script runs.
 *
 * What the script does get are stubs. Each namespace function, `tools.*`
 * and `extract` post a `code-call` message to the host and wait for the
 * answer; the host's broker decides every call (code-mode/code-broker.ts).
 * `log()` collects lines here, up to a cap.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
import { parentPort, workerData } from 'worker_threads';
import { registerHooks } from 'module';
import { randomUUID } from 'crypto';
import { CODE_GLOBAL_NAMES } from './types';
import type { CodeCall, CodeWorkerDone, CodeWorkerInput } from './types';
import { installSandboxNetGuard, lockSandboxNetGuard } from './sandbox-net-guard';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Text of one log() argument. */
function logText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** A plain JSON copy of what the script passes to a call: no functions, no prototypes, no cycles. */
function plain(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * The script's line where an error was thrown. The script is compiled with
 * the Function constructor, whose source starts two lines before the body.
 */
function scriptLine(err: unknown): number | undefined {
  const stack = typeof (err as any)?.stack === 'string' ? (err as any).stack : '';
  const match = /<anonymous>:(\d+):\d+/.exec(stack);
  if (!match) return undefined;
  const line = Number(match[1]) - 2;
  return line > 0 ? line : undefined;
}

async function run(): Promise<void> {
  const input = workerData as CodeWorkerInput;
  const port = parentPort!;

  // 1. No network, sealed before anything else runs.
  installSandboxNetGuard({ denyAll: true });
  lockSandboxNetGuard();

  // 2. No environment.
  for (const key of Object.keys(process.env)) {
    try {
      delete process.env[key];
    } catch {
      /* frozen on some platform: the permission model still holds */
    }
  }

  // 3. No modules. Everything this worker needs is loaded above; from here
  // on, any resolution (import(), process.mainModule.require,
  // createRequire, a built-in or a path) is refused.
  registerHooks({
    resolve(specifier: string) {
      throw new Error(`Module "${specifier}" is not available in code mode.`);
    },
  });
  for (const name of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'mainModule']) {
    try {
      delete (process as any)[name];
    } catch {
      /* non-configurable: the hook and the permission model still hold */
    }
  }
  const offline = () => {
    throw new Error('Network access is off in code mode. Call the tools instead.');
  };
  for (const name of ['fetch', 'WebSocket', 'EventSource']) {
    try {
      Object.defineProperty(globalThis, name, { value: offline, configurable: false, writable: false });
    } catch {
      /* already non-configurable: the net guard and the runtime refuse anyway */
    }
  }

  // 4. log(): kept up to the cap, counted beyond it.
  let logs = '';
  let logChars = 0;
  const log = (...args: unknown[]): void => {
    const line = args.map(logText).join(' ');
    logChars += (logChars ? 1 : 0) + line.length;
    if (logs.length < input.logCapChars) {
      logs += (logs ? '\n' : '') + line;
      if (logs.length > input.logCapChars) logs = logs.slice(0, input.logCapChars);
    }
  };

  // 5. The bridge to the host.
  class ToolError extends Error {
    constructor(
      message: string,
      readonly tool?: string,
    ) {
      super(message);
      this.name = 'ToolError';
    }
  }
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  port.on('message', (msg: any) => {
    if (msg?.type !== 'code-call-response') return;
    const waiting = pending.get(msg.id);
    if (!waiting) return;
    pending.delete(msg.id);
    if (msg.ok) waiting.resolve(msg.result);
    else waiting.reject(new ToolError(String(msg.error ?? 'The call failed'), msg.tool));
  });
  const call = (payload: CodeCall): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      try {
        port.postMessage({ type: 'code-call', id, call: payload });
      } catch (err: any) {
        pending.delete(id);
        reject(new ToolError(`Arguments could not be sent: ${err?.message ?? err}`));
      }
    });
  const safely = (fn: () => CodeCall): Promise<unknown> => {
    try {
      return call(fn());
    } catch (err: any) {
      return Promise.reject(new ToolError(`Arguments must be plain JSON: ${err?.message ?? err}`));
    }
  };

  const names: string[] = [];
  const values: unknown[] = [];
  for (const [namespace, fns] of Object.entries(input.namespaces)) {
    if (!IDENTIFIER.test(namespace) || (CODE_GLOBAL_NAMES as readonly string[]).includes(namespace)) continue;
    const api: Record<string, (args?: unknown) => Promise<unknown>> = {};
    for (const fn of fns) {
      if (!IDENTIFIER.test(fn)) continue;
      api[fn] = (args?: unknown) => safely(() => ({ op: 'tool', namespace, fn, args: plain(args ?? {}) }));
    }
    names.push(namespace);
    values.push(Object.freeze(api));
  }
  const tools = Object.freeze({
    search: (query: unknown, limit?: unknown) => safely(() => ({ op: 'search', query: plain(query), limit: plain(limit) })),
    get: (name: unknown, detail?: unknown) => safely(() => ({ op: 'get', name: plain(name), detail: plain(detail) })),
    call: (name: unknown, args?: unknown) => safely(() => ({ op: 'call', name: plain(name), args: plain(args ?? {}) })),
  });
  const extract = (value: unknown, schema: unknown) => safely(() => ({ op: 'extract', value: plain(value), schema: plain(schema) }));
  const consoleLike = Object.freeze({ log, info: log, warn: log, error: log, debug: log });

  const finish = (done: Omit<CodeWorkerDone, 'type' | 'logs' | 'logChars'>): void => {
    const message: CodeWorkerDone = { type: 'done', ...done, logs, logChars };
    port.postMessage(message);
  };

  port.postMessage({ type: 'ready' });

  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(...names, 'tools', 'log', 'extract', 'console', 'ToolError', `"use strict"; ${input.code}`);
    const value = await fn(...values, tools, log, extract, consoleLike, ToolError);
    let json: string;
    try {
      json = JSON.stringify(value === undefined ? null : value) ?? 'null';
    } catch (err: any) {
      finish({ success: false, error: { message: `The return value is not JSON: ${err?.message ?? err}` } });
      return;
    }
    finish({
      success: true,
      resultJson: json.length > input.resultCapChars ? json.slice(0, input.resultCapChars) : json,
      ...(json.length > input.resultCapChars ? { resultChars: json.length } : {}),
    });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : logText(err);
    finish({
      success: false,
      error: {
        message: String(message).slice(0, 2000),
        ...(scriptLine(err) ? { line: scriptLine(err) } : {}),
        ...(err instanceof ToolError && err.tool ? { tool: err.tool } : {}),
      },
    });
  }
}

run().catch((err) => {
  parentPort?.postMessage({ type: 'done', success: false, logs: '', logChars: 0, error: { message: String(err?.message ?? err) } });
});
