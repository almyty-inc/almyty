import { NodeSandboxService } from '../node-sandbox.service';
import { DependencyManagerService } from '../dependency-manager.service';
import { SandboxExecutionRequest } from '../types';

/**
 * Integration tests for NodeSandboxService.
 *
 * These tests use REAL worker threads — actual code execution happens in
 * a separate V8 isolate. Only the DependencyManagerService is mocked
 * (returns a fake module path since we don't need real npm packages here).
 */

let service: NodeSandboxService;
let depManager: DependencyManagerService;

beforeAll(() => {
  depManager = {
    ensureInstalled: jest.fn().mockResolvedValue({
      installDir: '/tmp/fake-deps',
      cached: true,
      installTimeMs: 0,
    }),
    listCached: jest.fn().mockReturnValue([]),
    clearCache: jest.fn(),
  } as any;

  service = new NodeSandboxService(depManager);
});

function exec(
  code: string,
  opts?: Partial<SandboxExecutionRequest>,
): ReturnType<NodeSandboxService['execute']> {
  return service.execute({
    code,
    parameters: opts?.parameters ?? {},
    credentials: opts?.credentials,
    timeoutMs: opts?.timeoutMs ?? 5000,
    memoryLimitMb: opts?.memoryLimitMb ?? 64,
    ...opts,
  });
}

describe('NodeSandboxService', () => {
  it('should execute simple code and return the result', async () => {
    const result = await exec('return parameters.a + parameters.b', {
      parameters: { a: 1, b: 2 },
    });

    expect(result.success).toBe(true);
    expect(result.data).toBe(3);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  }, 10_000);

  it('should execute async code', async () => {
    const result = await exec('return await Promise.resolve(42)');

    expect(result.success).toBe(true);
    expect(result.data).toBe(42);
  }, 10_000);

  it('should provide access to credentials', async () => {
    const result = await exec('return credentials.token', {
      credentials: { token: 'secret' },
    });

    expect(result.success).toBe(true);
    expect(result.data).toBe('secret');
  }, 10_000);

  it('should block child_process', async () => {
    const result = await exec("require('child_process')");

    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  }, 10_000);

  it('should block worker_threads', async () => {
    const result = await exec("require('worker_threads')");

    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  }, 10_000);

  // ── Regression: expanded module denylist ─────────────────────────────
  describe('expanded module denylist (regression)', () => {
    it.each([
      ['fs'],
      ['fs/promises'],
      ['node:fs'],
      ['node:fs/promises'],
      ['http'],
      ['https'],
      ['http2'],
      ['node:http'],
      ['node:https'],
      ['net'],
      ['tls'],
      ['dgram'],
      ['dns'],
      ['os'],
      ['module'],
      ['node:module'],
    ])('refuses require(%s)', async (mod) => {
      const result = await exec(`require(${JSON.stringify(mod)})`);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not allowed');
    }, 10_000);
  });

  // ── Regression: process.env scrub ────────────────────────────────────
  describe('process.env scrub (regression)', () => {
    it('strips all env vars before user code runs', async () => {
      // Seed a sentinel in the parent's env so we can prove the
      // worker did NOT see it. Cleanup immediately after.
      const sentinelKey = 'SANDBOX_TEST_SENTINEL';
      const sentinelValue = 'supposed-to-be-invisible-to-sandbox';
      process.env[sentinelKey] = sentinelValue;
      try {
        const result = await exec(
          // Return both the sentinel we planted and the overall env
          // key count. Both must be absent from the worker's view.
          'return { sentinel: process.env.SANDBOX_TEST_SENTINEL ?? null, envSize: Object.keys(process.env).length };',
        );
        expect(result.success).toBe(true);
        expect(result.data.sentinel).toBeNull();
        expect(result.data.envSize).toBe(0);
      } finally {
        delete process.env[sentinelKey];
      }
    }, 10_000);

    it('still allows legitimate parameters and credentials to flow through', async () => {
      // Sanity check that scrubbing env doesn't accidentally break
      // the documented parameter / credential channels.
      const result = await exec(
        'return { p: parameters.x, c: credentials.token }',
        { parameters: { x: 42 }, credentials: { token: 'abc' } },
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ p: 42, c: 'abc' });
    }, 10_000);
  });

  it('should enforce timeout on infinite loops', async () => {
    const result = await exec('while(true){}', { timeoutMs: 1000 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  }, 10_000);

  it('should catch runtime errors', async () => {
    const result = await exec("throw new Error('boom')");

    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  }, 10_000);

  it('should return complex objects', async () => {
    const result = await exec(
      "return { nested: { key: 'value' }, arr: [1, 2, 3] }",
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ nested: { key: 'value' }, arr: [1, 2, 3] });
  }, 10_000);

  it('should catch syntax errors', async () => {
    const result = await exec('const x = {');

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // The error message varies by Node version but should indicate a syntax issue
    expect(result.error!.toLowerCase()).toMatch(/unexpected|syntax|token/);
  }, 10_000);
});
