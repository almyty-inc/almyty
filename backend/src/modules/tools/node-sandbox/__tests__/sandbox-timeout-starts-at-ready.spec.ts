import { NodeSandboxService } from '../node-sandbox.service';
import { DependencyManagerService } from '../dependency-manager.service';

/**
 * A tool's timeout is its own run time, not the platform's start-up.
 *
 * The timer used to start when the Worker was constructed, so everything a
 * worker does before the tool's first line -- isolate, permission model,
 * net guard, require hooks, env scrub -- was charged to the tool. Under
 * load that start-up is a good part of a short budget, and a tool that
 * finishes in a millisecond timed out. The budget now starts when the
 * worker reports it is ready; a worker that never gets that far is still
 * stopped, by its own boot cap.
 *
 * Real worker threads. In this (ts-jest) setup a worker boots through
 * ts-node, which takes far longer than the budgets below, so the first
 * case is exactly the "boot costs more than the budget" condition.
 */
jest.setTimeout(60_000);

const depManager = {
  ensureInstalled: jest.fn(),
  listCached: jest.fn().mockReturnValue([]),
  clearCache: jest.fn(),
} as unknown as DependencyManagerService;

describe('the sandbox timeout starts when the worker is ready', () => {
  const saved = process.env.SANDBOX_BOOT_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SANDBOX_BOOT_TIMEOUT_MS;
    else process.env.SANDBOX_BOOT_TIMEOUT_MS = saved;
  });

  it('does not charge worker start-up to the tool', async () => {
    const service = new NodeSandboxService(depManager);
    const result = await service.execute({ code: 'return parameters.x * 2', parameters: { x: 21 }, timeoutMs: 25 });
    expect(result).toMatchObject({ success: true, data: 42 });
    // It did take longer than the budget, end to end: the boot is real.
    expect(result.executionTimeMs).toBeGreaterThan(25);
  });

  it('still holds the tool to its own budget once it runs', async () => {
    const service = new NodeSandboxService(depManager);
    const started = Date.now();
    const result = await service.execute({
      code: 'await new Promise((r) => setTimeout(r, 20_000)); return 1;',
      parameters: {},
      timeoutMs: 300,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Execution timed out after 300ms');
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('fails a worker that never finishes booting, on the boot cap', async () => {
    process.env.SANDBOX_BOOT_TIMEOUT_MS = '1';
    const service = new NodeSandboxService(depManager);
    const result = await service.execute({ code: 'return 1', parameters: {}, timeoutMs: 60_000 });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Sandbox worker did not start within 1ms');
  });
});
