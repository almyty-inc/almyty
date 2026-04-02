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
