import { NodeSandboxService } from '../node-sandbox.service';
import { DependencyManagerService } from '../dependency-manager.service';

/**
 * A sandbox execution holds one of the pool's few slots (SANDBOX_MAX_WORKERS,
 * default 4) from the moment it starts until it settles, and everything it
 * does in that time counts: installing its declared dependencies, booting
 * the worker, running the tool.
 *
 * The slot used to be bounded only piecewise. Booting had its own cap (30s)
 * and the tool's timeout (up to 300s) started after it, so one execution
 * could sit on a slot for 330s; and installing dependencies had no bound at
 * all, so a registry that never answered held the slot for good while every
 * other execution queued behind it. There is now one overall deadline,
 * SANDBOX_MAX_SLOT_MS (default: the 300s timeout ceiling), counted from the
 * moment the slot is taken, that none of the three phases can outlive.
 *
 * Real worker threads (booted through ts-node here, which is slow, so the
 * budgets below leave it room).
 */
jest.setTimeout(90_000);

const ENV = ['SANDBOX_MAX_SLOT_MS', 'SANDBOX_MAX_WORKERS', 'SANDBOX_BOOT_TIMEOUT_MS'] as const;

describe('a sandbox execution holds its pool slot for a bounded time', () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const depManager = (ensureInstalled: jest.Mock) =>
    ({ ensureInstalled, listCached: jest.fn().mockReturnValue([]), clearCache: jest.fn() }) as unknown as DependencyManagerService;

  it('stops a run at the slot deadline, whatever the tool asked for', async () => {
    process.env.SANDBOX_MAX_SLOT_MS = '10000';
    const service = new NodeSandboxService(depManager(jest.fn()));
    const started = Date.now();
    const result = await service.execute({
      code: 'await new Promise((r) => setTimeout(r, 60_000)); return 1;',
      parameters: {},
      // Within the per-execution ceiling, beyond the slot.
      timeoutMs: 50_000,
    });
    const elapsed = Date.now() - started;
    expect(result.success).toBe(false);
    expect(result.error).toBe('Sandbox execution exceeded its 10000ms slot');
    expect(elapsed).toBeGreaterThanOrEqual(10_000);
    expect(elapsed).toBeLessThan(20_000);
    expect((service as any).activeWorkers).toBe(0);
  });

  it('frees the slot when installing dependencies never finishes, so the next execution runs', async () => {
    process.env.SANDBOX_MAX_SLOT_MS = '1500';
    process.env.SANDBOX_MAX_WORKERS = '1';
    // A registry that never answers.
    const ensureInstalled = jest.fn(() => new Promise<never>(() => undefined));
    const service = new NodeSandboxService(depManager(ensureInstalled));

    const stuck = service.execute({ code: 'return 1', parameters: {}, dependencies: { 'left-pad': '1.3.0' }, organizationId: 'org-a' });
    // Queued behind it: the pool has one slot.
    const next = service.execute({ code: 'return parameters.x + 1', parameters: { x: 41 }, organizationId: 'org-b' });

    const started = Date.now();
    await expect(stuck).resolves.toMatchObject({ success: false, error: 'Sandbox execution exceeded its 1500ms slot' });
    expect(Date.now() - started).toBeLessThan(5_000);
    // The slot it held went to the waiting execution, which ran on a real worker.
    await expect(next).resolves.toMatchObject({ success: true, data: 42 });
    expect((service as any).activeWorkers).toBe(0);
  });

  it('a worker stuck booting gives its slot back on the boot cap', async () => {
    process.env.SANDBOX_BOOT_TIMEOUT_MS = '1';
    process.env.SANDBOX_MAX_WORKERS = '1';
    const service = new NodeSandboxService(depManager(jest.fn()));
    const first = service.execute({ code: 'return 1', parameters: {}, timeoutMs: 60_000, organizationId: 'org-a' });
    const second = service.execute({ code: 'return 2', parameters: {}, timeoutMs: 60_000, organizationId: 'org-b' });
    const started = Date.now();
    await expect(first).resolves.toMatchObject({ success: false, error: 'Sandbox worker did not start within 1ms' });
    await expect(second).resolves.toMatchObject({ success: false, error: 'Sandbox worker did not start within 1ms' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((service as any).activeWorkers).toBe(0);
  });
});
