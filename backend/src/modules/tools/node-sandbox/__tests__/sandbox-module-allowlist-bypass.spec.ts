import { NodeSandboxService } from '../node-sandbox.service';
import { DependencyManagerService } from '../dependency-manager.service';

/**
 * Real worker threads, permission model on.
 *
 * The module allowlist is a runtime hook on the `require` that is
 * injected as an AsyncFunction parameter — so it never saw the routes
 * below, which reach a built-in without touching that parameter at
 * all. Each one was confirmed to work before the resolution hook was
 * added; `node:net` and `node:module` in particular made the allowlist
 * decorative, and `node:module` handed user code the require cache,
 * which is where the net guard itself lives.
 */
describe('sandbox module allowlist - routes that bypass the injected require', () => {
  let service: NodeSandboxService;

  beforeAll(() => {
    const depManager = {
      ensureInstalled: jest.fn().mockResolvedValue({
        installDir: '/tmp/fake-deps',
        cached: true,
        installTimeMs: 0,
      }),
      listCached: jest.fn().mockReturnValue([]),
      clearCache: jest.fn(),
    } as unknown as DependencyManagerService;
    service = new NodeSandboxService(depManager);
  });

  jest.setTimeout(60_000);

  const exec = (code: string) =>
    service.execute({
      code,
      parameters: {},
      timeoutMs: 15000,
      memoryLimitMb: 64,
    });

  const bypasses: Array<[string, string]> = [
    ['dynamic import of node:net', "return typeof (await import('node:net')).connect"],
    ['dynamic import of bare net', "return typeof (await import('net')).connect"],
    ['dynamic import of node:fs', "return typeof (await import('node:fs')).readFileSync"],
    [
      'dynamic import of node:child_process',
      "return typeof (await import('node:child_process')).execSync",
    ],
    ['dynamic import of node:dns', "return typeof (await import('node:dns')).Resolver"],
    [
      'dynamic import of node:worker_threads',
      "return typeof (await import('node:worker_threads')).workerData",
    ],
    ['dynamic import of node:inspector', "return typeof (await import('node:inspector')).open"],
    ['dynamic import of node:vm', "return typeof (await import('node:vm')).runInNewContext"],
    [
      'process.mainModule.require',
      "return typeof process.mainModule.require('net').connect",
    ],
    [
      'module.createRequire',
      "const m = await import('node:module');" +
        "return typeof m.createRequire('/x.js')('net').connect",
    ],
    [
      'process.getBuiltinModule',
      "return typeof process.getBuiltinModule('fs').readFileSync",
    ],
  ];

  it.each(bypasses)('refuses %s', async (_name, code) => {
    const result = await exec(code);
    expect(result.success).toBe(false);
  });

  it('refuses to hand user code the net guard from the require cache', async () => {
    // The confirmed SSRF: reach the guard's own module exports, reset
    // it, then re-install with a blanket allow.
    const result = await exec(`
      const m = await import('node:module');
      const r = m.createRequire('/x.js');
      const key = Object.keys(r.cache).find(k => k.includes('sandbox-net-guard'));
      const guard = r.cache[key].exports;
      guard.resetSandboxNetGuardForTesting();
      guard.installSandboxNetGuard({ testAllow: '127.0.0.1:*' });
      return 'guard disabled';
    `);
    expect(result.success).toBe(false);
    expect(result.data).not.toBe('guard disabled');
  });

  it('still allows the modules on the allowlist', async () => {
    const viaRequire = await exec(
      "const c = require('crypto'); return typeof c.randomUUID();",
    );
    expect(viaRequire.success).toBe(true);
    expect(viaRequire.data).toBe('string');

    const viaImport = await exec(
      "const c = await import('node:crypto'); return typeof c.randomUUID();",
    );
    expect(viaImport.success).toBe(true);
    expect(viaImport.data).toBe('string');
  });

  it('still runs ordinary tool code', async () => {
    const result = await exec('return 6 * 7');
    expect(result.success).toBe(true);
    expect(result.data).toBe(42);
  });
});
