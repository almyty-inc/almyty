import * as fs from 'fs';
import * as path from 'path';

import { QuickJsSandboxRequest, QuickJsSandboxService } from '../quickjs-sandbox.service';
import { quickJsPrelude } from '../quickjs-sandbox-worker';
import { CodeCall, CodeCallError } from '../types';
import { snapshotEnv } from '../../../../test/env';

/**
 * The QuickJS runtime for scripts from outside clients
 * (docs/design/code-mode.md, "P3 gate"), against real workers: the escape
 * suite the design asks for, and every limit (memory, CPU, wall time,
 * output) enforced. Runs in CI with the backend unit tests.
 */
describe('QuickJS sandbox', () => {
  jest.setTimeout(120_000);
  const service = new QuickJsSandboxService();

  const run = (code: string, over: Partial<QuickJsSandboxRequest> = {}) =>
    service.executeCode({
      code,
      namespaces: { petstore: ['findPetsByStatus', 'updatePet'] },
      organizationId: 'org-1',
      timeoutMs: 20_000,
      memoryLimitMb: 64,
      cpuBudgetMs: 5_000,
      logCapChars: 1000,
      resultCapChars: 1000,
      onCall: async () => null,
      ...over,
    });

  describe('what a script can do', () => {
    it('returns a value, logs, and calls its namespaces through the host, in parallel', async () => {
      const calls: CodeCall[] = [];
      let inFlight = 0;
      let most = 0;
      const result = await run(
        `const pets = await petstore.findPetsByStatus({ status: 'sold' });
         const done = await Promise.all(pets.map((p) => petstore.updatePet({ id: p.id, status: 'archived' })));
         log('archived', done.length, { ok: true });
         return { ids: pets.map((p) => p.id), input: context.input };`,
        {
          context: { input: { who: 'me' } },
          onCall: async (c) => {
            calls.push(c);
            inFlight++;
            most = Math.max(most, inFlight);
            await new Promise((r) => setTimeout(r, 20));
            inFlight--;
            return c.op === 'tool' && c.fn === 'findPetsByStatus' ? [{ id: 1 }, { id: 2 }, { id: 3 }] : { ok: true };
          },
        },
      );
      expect(result.success).toBe(true);
      expect(JSON.parse(result.resultJson!)).toEqual({ ids: [1, 2, 3], input: { who: 'me' } });
      expect(result.logs).toBe('archived 3 {"ok":true}');
      expect(calls[0]).toEqual({ op: 'tool', namespace: 'petstore', fn: 'findPetsByStatus', args: { status: 'sold' } });
      expect(most).toBe(3);
    });

    it('turns a refused call into a ToolError the script can catch, with the tool named', async () => {
      const result = await run(`try { await petstore.updatePet({}); } catch (e) { return [e.name, e.message, e.tool, e instanceof ToolError]; }`, {
        onCall: async () => {
          throw new CodeCallError('not allowed here', 'petstore.updatePet');
        },
      });
      expect(JSON.parse(result.resultJson!)).toEqual(['ToolError', 'not allowed here', 'petstore.updatePet', true]);
    });

    it('reports an uncaught error with the line of the script it came from', async () => {
      const result = await run(`const a = 1;\nconst b = 2;\nthrow new Error('broke on three');`);
      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ message: 'broke on three', line: 3 });
    });

    it('hands the script a context it cannot change', async () => {
      const result = await run(`try { context.input.who = 'them'; } catch (e) { return ['refused', context.input.who]; } return ['changed'];`, { context: { input: { who: 'me' } } });
      expect(JSON.parse(result.resultJson!)).toEqual(['refused', 'me']);
    });
  });

  // Each must fail inside the script, or find nothing to use.
  const escapes: Array<[string, string]> = [
    ['require', "return typeof require('fs')"],
    ['process', 'return process.env'],
    ['import()', "return typeof (await import('fs'))"],
    ['import() of the interpreter std module', "return typeof (await import('std'))"],
    ['import() of the interpreter os module', "return typeof (await import('os'))"],
    ['fetch', "await fetch('https://example.com'); return 'reached'"],
    ['XMLHttpRequest', "new XMLHttpRequest(); return 'reached'"],
    ['WebSocket', "new WebSocket('wss://example.com'); return 'reached'"],
    ['setTimeout', "await new Promise((r) => setTimeout(r, 10)); return 'timers'"],
    ['WebAssembly', "return typeof WebAssembly.Memory"],
    ['the message port', "postMessage({ type: 'done', success: true, resultJson: '1' }); return 'reached'"],
    ['the host bridge', "return __host('{}')"],
    ['the host log bridge', "return __hostLog('x')"],
    ['the Function constructor reaching the host', "return Function('return typeof process')() === 'undefined' ? Function('return process')() : 'reached'"],
    ['a host function constructor', "return log.constructor('return process')()"],
    ['a namespace function constructor', "return petstore.findPetsByStatus.constructor('return require')()('fs')"],
  ];

  it.each(escapes)('refuses %s', async (_name, code) => {
    const result = await run(code);
    expect(result.success).toBe(false);
  });

  it('cannot reach the host through the bridges after the prelude removed them', async () => {
    const result = await run(`return [typeof __host, typeof __hostLog, Object.getOwnPropertyNames(globalThis).filter((n) => n.startsWith('__'))]`);
    expect(JSON.parse(result.resultJson!)).toEqual(['undefined', 'undefined', []]);
  });

  it('cannot replace its own globals', async () => {
    const result = await run(`try { globalThis.log = () => 1; } catch (e) {} try { delete globalThis.tools; } catch (e) {} return [typeof log, typeof tools.search]`);
    expect(JSON.parse(result.resultJson!)).toEqual(['function', 'function']);
  });

  it('stops a script past its memory, with the WebAssembly memory as the hard cap, and gives the memory back', async () => {
    const before = process.memoryUsage().rss;
    const result = await run(`const a = []; while (true) a.push('x'.repeat(1e6) + Math.random());`, { memoryLimitMb: 32 });
    expect(result.success).toBe(false);
    expect(result.oom).toBe(true);
    expect(result.error?.message).toMatch(/out of memory \(32 MB\)/);
    // The worker is gone, and its memory with it.
    await new Promise((r) => setTimeout(r, 500));
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
  });

  it('stops a script past its CPU budget', async () => {
    const result = await run(`let s = 0; while (true) s++;`, { cpuBudgetMs: 300 });
    expect(result.success).toBe(false);
    expect(result.cpuExceeded).toBe(true);
    expect(result.error?.message).toMatch(/CPU budget \(300 ms\)/);
  });

  it('kills a script past its wall time, even while it waits on a call', async () => {
    const started = Date.now();
    const result = await run(`await petstore.findPetsByStatus({}); return 'never'`, {
      timeoutMs: 800,
      onCall: () => new Promise(() => {}),
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('keeps a log flood and a huge return value to their caps, and counts what it cut', async () => {
    const logs = await run(`for (let i = 0; i < 20000; i++) log('line ' + i); return 1`);
    expect(logs.logs.length).toBeLessThanOrEqual(1000);
    expect(logs.logChars).toBeGreaterThan(20000);
    const big = await run(`return 'x'.repeat(100000)`);
    expect(big.resultJson!.length).toBe(1000);
    expect(big.resultChars).toBe(100002);
  });

  it('refuses past its own queue limits', async () => {
    const restore = snapshotEnv('SANDBOX_QUICKJS_MAX_WORKERS', 'SANDBOX_QUICKJS_MAX_QUEUE_SIZE');
    process.env.SANDBOX_QUICKJS_MAX_WORKERS = '1';
    process.env.SANDBOX_QUICKJS_MAX_QUEUE_SIZE = '1';
    try {
      const first = run(`await petstore.findPetsByStatus({}); return 1`, { onCall: () => new Promise((r) => setTimeout(() => r(null), 300)) });
      const second = run(`return 2`);
      const third = await run(`return 3`);
      expect(third.error?.message).toMatch(/waiting to run/);
      expect((await first).success).toBe(true);
      expect((await second).resultJson).toBe('2');
    } finally {
      restore();
    }
  });

  it('builds the script globals without letting an API name shadow them', () => {
    const prelude = quickJsPrelude({ tools: ['x'], log: ['y'], petstore: ['find'], 'bad-name': ['z'] }, null);
    expect(prelude).toContain('"petstore":["find"]');
    expect(prelude).not.toContain('"tools":["x"]');
    expect(prelude).not.toContain('bad-name');
  });

  it('never starts the worker with network, processes, workers or the server environment (guard)', () => {
    // The code, comments stripped (a comment may name a flag to say it is never passed).
    const source = fs.readFileSync(path.join(__dirname, '..', 'quickjs-sandbox.service.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const argv = service.execArgv('/x/quickjs-sandbox-worker.js', true);
    expect(argv).toContain('--permission');
    expect(argv.join(' ')).not.toMatch(/--allow-(net|child-process|worker|addons|wasi)/);
    expect(source).toMatch(/env: \{\},/);
    expect(source).not.toMatch(/--allow-net/);
  });
});
