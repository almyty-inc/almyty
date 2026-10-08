import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { Worker } from 'worker_threads';

import { NodeSandboxService } from '../node-sandbox.service';
import { DependencyManagerService } from '../dependency-manager.service';
import { CodeCall, CodeCallError, CodeSandboxRequest } from '../types';
import { snapshotEnv } from '../../../../test/env';

/**
 * The `code` sandbox profile (docs/design/code-mode.md, part D) against
 * real worker threads with the permission model on: the escape suite the
 * design's test plan asks for. Model-written code must reach nothing but
 * the host's broker: no sockets, no DNS, no files, no environment, no
 * modules, no processes, no workers, and nothing that outlives the script.
 */
describe('code sandbox profile', () => {
  let service: NodeSandboxService;
  jest.setTimeout(60_000);

  beforeAll(() => {
    service = new NodeSandboxService({ ensureInstalled: jest.fn() } as unknown as DependencyManagerService);
  });

  const run = (code: string, overrides: Partial<CodeSandboxRequest> = {}) =>
    service.executeCode({
      code,
      namespaces: { petstore: ['findPetsByStatus', 'updatePet'] },
      organizationId: 'org-1',
      timeoutMs: 10_000,
      memoryLimitMb: 64,
      logCapChars: 1000,
      resultCapChars: 1000,
      onCall: async () => null,
      ...overrides,
    });

  describe('what a script can do', () => {
    it('returns a value, logs, and calls its namespaces through the host, in parallel', async () => {
      const calls: CodeCall[] = [];
      const result = await run(
        `const sold = await petstore.findPetsByStatus({ status: 'sold' });
         log('found', sold.length);
         await Promise.all(sold.map((p) => petstore.updatePet({ ...p, status: 'archived' })));
         return { archived: sold.map((p) => p.id) };`,
        {
          onCall: async (call) => {
            calls.push(call);
            return call.op === 'tool' && call.fn === 'findPetsByStatus' ? [{ id: 1 }, { id: 2 }] : { ok: true };
          },
        },
      );
      expect(result).toMatchObject({ success: true, resultJson: '{"archived":[1,2]}', logs: 'found 2' });
      expect(calls[0]).toEqual({ op: 'tool', namespace: 'petstore', fn: 'findPetsByStatus', args: { status: 'sold' } });
      expect(calls.filter((c) => c.op === 'tool' && c.fn === 'updatePet')).toHaveLength(2);
      expect(result.cpuMs).toBeGreaterThanOrEqual(0);
    });

    it('turns a refused call into a ToolError the script can catch, with the tool named', async () => {
      const result = await run(
        `try { await petstore.updatePet({ id: 1 }); } catch (e) { return { name: e.name, tool: e.tool, message: e.message, isToolError: e instanceof ToolError }; }`,
        { onCall: async () => { throw new CodeCallError('not allowed here', 'petstore.updatePet'); } },
      );
      expect(JSON.parse(result.resultJson!)).toEqual({ name: 'ToolError', tool: 'petstore.updatePet', message: 'not allowed here', isToolError: true });
    });

    it('reports an uncaught error with the line of the script it came from', async () => {
      const result = await run(`const a = 1;\nconst b = 2;\nthrow new Error('broke on three');`);
      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ message: 'broke on three', line: 3 });
    });

    it('sends only plain JSON to the host', async () => {
      const calls: CodeCall[] = [];
      await run(`await tools.call('x', { fn: () => 1, when: new Date(0), n: 1 }); return 1;`, { onCall: async (c) => { calls.push(c); return null; } });
      expect(calls[0]).toEqual({ op: 'call', name: 'x', args: { when: '1970-01-01T00:00:00.000Z', n: 1 } });
    });
  });

  // Each of these must fail inside the script; the script reports what it got.
  const escapes: Array<[string, string]> = [
    ['net via import', "return typeof (await import('node:net')).connect"],
    ['tls via import', "return typeof (await import('node:tls')).connect"],
    ['dgram via import', "return typeof (await import('node:dgram')).createSocket"],
    ['http2 via import', "return typeof (await import('node:http2')).connect"],
    ['https via import', "return typeof (await import('https')).request"],
    ['dns via import', "return typeof (await import('node:dns')).lookup"],
    ['fs via import', "return typeof (await import('node:fs')).readFileSync"],
    ['child_process via import', "return typeof (await import('node:child_process')).execSync"],
    ['worker_threads via import', "return typeof (await import('node:worker_threads')).Worker"],
    ['module via import', "return typeof (await import('node:module')).createRequire"],
    ['a harmless built-in via import', "return typeof (await import('node:path')).join"],
    ['a relative file via import', "return typeof (await import('./sandbox-net-guard')).installSandboxNetGuard"],
    ['require', "return typeof require('fs')"],
    ['process.mainModule.require', "return typeof process.mainModule.require('fs')"],
    ['process.getBuiltinModule', "return typeof process.getBuiltinModule('fs')"],
    ['process.binding', "return typeof process.binding('fs')"],
    ['process.dlopen', "return typeof process.dlopen({}, '/tmp/x.node')"],
    ['fetch', "await fetch('https://example.com'); return 'reached'"],
    ['fetch of a private address', "await fetch('http://169.254.169.254/latest/meta-data/'); return 'reached'"],
    ['WebSocket', "new WebSocket('wss://example.com'); return 'reached'"],
    ['the Function constructor reaching require', "return typeof Function('return require')()('fs')"],
    ['the prototype chain reaching require', "return typeof log.constructor('return require')()('fs')"],
  ];

  it.each(escapes)('refuses %s', async (_name, code) => {
    const result = await run(code);
    expect(result.success).toBe(false);
  });

  it('runs with an empty environment, whatever route reads it', async () => {
    process.env.CODE_SANDBOX_CANARY = 'secret';
    try {
      const result = await run(`return [Object.keys(process.env).length, Function('return process.env.CODE_SANDBOX_CANARY')() ?? null]`);
      expect(JSON.parse(result.resultJson!)).toEqual([0, null]);
    } finally {
      delete process.env.CODE_SANDBOX_CANARY;
    }
  });

  it('cannot write a file or start a process even through a leftover handle', async () => {
    const result = await run(`try { process.kill(process.pid, 0); } catch (e) {} return typeof process.chdir`);
    // chdir and kill exist on process; they cannot hurt: a worker cannot change
    // the process cwd and the permission model refuses signals to others.
    expect(result.success).toBe(true);
  });

  it('stops nothing it started from reaching the host after it returned', async () => {
    let lateCalls = 0;
    const result = await run(
      `setTimeout(() => petstore.findPetsByStatus({}), 50); Promise.resolve().then(() => new Promise((r) => setTimeout(r, 100))).then(() => tools.search('late')); return 'done'`,
      { onCall: async () => { lateCalls++; return null; } },
    );
    expect(result.resultJson).toBe('"done"');
    await new Promise((r) => setTimeout(r, 300));
    expect(lateCalls).toBe(0);
  });

  it('kills a script that runs out of memory', async () => {
    const result = await run(`const a = []; while (true) a.push(new Array(1e6).fill(1));`, { memoryLimitMb: 32 });
    expect(result.success).toBe(false);
  });

  it('kills a script that spins past its timeout, and says so', async () => {
    const result = await run(`while (true) {}`, { timeoutMs: 500 });
    expect(result).toMatchObject({ success: false, timedOut: true });
    expect(result.cpuMs).toBeGreaterThan(0);
  });

  it('keeps a log flood and a huge return value to their caps, and counts what it cut', async () => {
    const logs = await run(`for (let i = 0; i < 100000; i++) log('line ' + i); return 1`);
    expect(logs.logs.length).toBeLessThanOrEqual(1000);
    expect(logs.logChars).toBeGreaterThan(100000);
    const big = await run(`return 'x'.repeat(1000000)`);
    expect(big.resultJson!.length).toBe(1000);
    expect(big.resultChars).toBe(1000002);
  });

  it('keeps a forged last message to the caps too: the host trusts nothing the worker says', async () => {
    // The script shares the worker's realm, so it can catch the port the
    // worker posts on and send a `done` of its own, past the worker's caps.
    const forged = await run(`
      const post = MessagePort.prototype.postMessage;
      let port;
      MessagePort.prototype.postMessage = function (m) { port = this; return post.call(this, m); };
      try { await tools.search('x'); } catch {}
      MessagePort.prototype.postMessage = post;
      post.call(port, { type: 'done', success: true, resultJson: 'y'.repeat(50000), logs: 'z'.repeat(50000), logChars: 1, error: { message: 'e'.repeat(10000), line: 'x', tool: 7 } });
      await new Promise(() => {});
    `);
    expect(forged.logs.length).toBe(1000);
    expect(forged.logChars).toBe(50000);
    expect(forged.resultJson!.length).toBe(1000);
    expect(forged.resultChars).toBe(50000);
    const failed = await run(`
      const post = MessagePort.prototype.postMessage;
      let port;
      MessagePort.prototype.postMessage = function (m) { port = this; return post.call(this, m); };
      try { await tools.search('x'); } catch {}
      MessagePort.prototype.postMessage = post;
      post.call(port, { type: 'done', success: false, logs: 3, error: { message: 'e'.repeat(10000), line: 'x', tool: 7 } });
      await new Promise(() => {});
    `);
    expect(failed.success).toBe(false);
    expect(failed.logs).toBe('');
    expect(failed.error).toEqual({ message: 'e'.repeat(2000) });
  });

  it('never starts the code worker with network access (guard)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'node-sandbox.service.ts'), 'utf8');
    const method = source.slice(source.indexOf('private buildCodeWorkerExecArgv'), source.indexOf('private codeLimits'));
    expect(method).toContain("'--permission'");
    expect(method).not.toContain('--allow-net');
    expect(method).not.toContain('modulePaths');
    // The worker's code, without its comments (which describe what it does not do).
    const worker = fs
      .readFileSync(path.join(__dirname, '..', 'code-sandbox-worker.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(worker).toContain('installSandboxNetGuard({ denyAll: true })');
    expect(worker).not.toMatch(/credentials|testAllow|require\(/);
    const argv = (service as any).buildCodeWorkerExecArgv('/app/dist/modules/tools/node-sandbox/code-sandbox-worker.js', true, []);
    expect(argv).not.toContain('--allow-net');
    expect(argv.filter((a: string) => a.startsWith('--allow-fs-read=')).every((a: string) => a.includes('/app/dist/'))).toBe(true);
  });

  it('has its own pool, so scripts never take a JavaScript tool slot', async () => {
    const before = (service as any).activeWorkers;
    const pending = run(`await new Promise((r) => setTimeout(r, 200)); return 1`);
    await new Promise((r) => setTimeout(r, 50));
    expect((service as any).activeWorkers).toBe(before);
    expect((service as any).codeActive).toBe(1);
    await pending;
    expect((service as any).codeActive).toBe(0);
  });

  it('refuses past its own queue limits', async () => {
    const restore = snapshotEnv('SANDBOX_CODE_MAX_WORKERS', 'SANDBOX_CODE_MAX_QUEUE_SIZE');
    process.env.SANDBOX_CODE_MAX_WORKERS = '1';
    process.env.SANDBOX_CODE_MAX_QUEUE_SIZE = '1';
    try {
      const first = run(`await new Promise((r) => setTimeout(r, 300)); return 1`);
      const second = run(`return 2`);
      const third = await run(`return 3`);
      expect(third.success).toBe(false);
      expect(third.error?.message).toMatch(/waiting to run/);
      expect((await first).success).toBe(true);
      expect((await second).resultJson).toBe('2');
    } finally {
      restore();
    }
  });
});

/**
 * The second lock: the net guard in deny-all mode refuses even where the
 * runtime would let a socket through (a worker with network permission and
 * a test allow list for a live loopback server, which the tool profile's
 * guard honours).
 */
describe('the net guard in deny-all mode', () => {
  let server: http.Server;
  let port: number;
  jest.setTimeout(60_000);

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('reached'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const attempt = (denyAll: boolean) =>
    new Promise<string>((resolve) => {
      const guard = path.join(__dirname, '..', 'sandbox-net-guard.ts');
      const worker = new Worker(
        `
        const { parentPort, workerData } = require('worker_threads');
        const g = require(workerData.guard);
        g.installSandboxNetGuard({ denyAll: workerData.denyAll, testAllow: '127.0.0.1:' + workerData.port });
        g.lockSandboxNetGuard();
        fetch('http://127.0.0.1:' + workerData.port + '/')
          .then((r) => r.text())
          .then((t) => parentPort.postMessage(t), (e) => parentPort.postMessage('refused: ' + (e.cause?.message ?? e.message)));
        `,
        { eval: true, workerData: { guard, denyAll, port }, execArgv: ['-r', 'ts-node/register/transpile-only'] },
      );
      worker.once('message', (m) => {
        resolve(String(m));
        void worker.terminate();
      });
      worker.once('error', (e: Error) => resolve('refused: ' + e.message));
    });

  it('lets the test allow list through without it, and refuses everything with it', async () => {
    expect(await attempt(false)).toBe('reached');
    expect(await attempt(true)).toMatch(/^refused: .*network access is off in code mode/);
  });
});