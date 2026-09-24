import { NodeSandboxService } from '../node-sandbox.service';
import { DependencyManagerService } from '../dependency-manager.service';

/**
 * The sandbox pool is process-wide: SANDBOX_MAX_WORKERS threads and one
 * FIFO queue behind them, shared by every organization. Two things let a
 * single tenant take all of it:
 *
 *   - nothing limited how many of the slots, or how much of the queue,
 *     one organization could hold, so a burst from one org starved (or
 *     outright refused, once the queue filled) everyone else;
 *   - the timeout a tool asks for was used as given. `configuration.timeout`
 *     is validated only as "an object", so 10^9 ms was accepted, and a
 *     worker spinning under it held its slot for eleven days.
 *
 * Real worker threads, permission model on.
 */
describe('sandbox pool - per-organization fairness and a hard timeout cap', () => {
  let service: NodeSandboxService;
  const saved: Record<string, string | undefined> = {};
  const env = {
    SANDBOX_MAX_WORKERS: '4',
    SANDBOX_MAX_QUEUE_SIZE: '4',
    SANDBOX_MAX_WORKERS_PER_ORG: '2',
    SANDBOX_MAX_QUEUE_PER_ORG: '2',
  };

  jest.setTimeout(60_000);

  beforeAll(() => {
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const depManager = {
      ensureInstalled: jest.fn(),
      listCached: jest.fn().mockReturnValue([]),
      clearCache: jest.fn(),
    } as unknown as DependencyManagerService;
    service = new NodeSandboxService(depManager);
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const run = (organizationId: string, code: string, timeoutMs = 20_000) =>
    service.execute({
      code,
      parameters: {},
      timeoutMs,
      memoryLimitMb: 64,
      organizationId,
    } as any);

  it('one organization flooding the pool does not starve or refuse another', async () => {
    const finished: string[] = [];
    const slow = "await new Promise(r => setTimeout(r, 3000)); return 'a';";

    const flood = Array.from({ length: 8 }, (_, i) =>
      run('org-a', slow).then((r) => {
        // Only work that actually ran; refusals come back at once.
        if (r.success) finished.push(`a${i}`);
        return r;
      }),
    );
    // Let org A's burst land first.
    await new Promise((r) => setTimeout(r, 200));

    const b = await run('org-b', "return 'b';").then((r) => {
      finished.push('b');
      return r;
    });

    expect(b.error).toBeUndefined();
    expect(b.data).toBe('b');
    // B ran alongside A's work instead of behind it.
    expect(finished[0]).toBe('b');

    const results = await Promise.all(flood);
    // A is held to its share: some of its burst is refused outright
    // rather than parked in front of every other tenant.
    expect(results.some((r) => r.success)).toBe(true);
    expect(results.some((r) => /queue full/i.test(r.error ?? ''))).toBe(true);
  });

  it('caps a huge requested timeout instead of honouring it', async () => {
    // A low ceiling so the test does not wait out the 300s default.
    process.env.SANDBOX_MAX_TIMEOUT_MS = '1500';
    try {
      const started = Date.now();
      const result = await run('org-c', 'while (true) {}', 1_000_000_000);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timed out after 1500ms/);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      delete process.env.SANDBOX_MAX_TIMEOUT_MS;
    }
  }, 20_000);
});
