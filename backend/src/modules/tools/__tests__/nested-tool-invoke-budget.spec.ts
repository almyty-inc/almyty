import axios from 'axios';
import { buildHarness, httpTool, jsTool } from './nested-tool-invoke.harness';
import { restoreEnv } from '../../../test/env';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * `tools.invoke` inside a sandboxed tool ran the nested tool with no
 * budget of any kind. Each nested call is a fresh worker on the same
 * process-wide pool, and the calling worker keeps its own slot while it
 * waits -- so a tool that invokes itself filled the pool with its own
 * ancestors, the next level queued behind them forever, and every other
 * tenant's sandbox work queued behind that until the timeouts (which had
 * no upper bound) ran out. A tool that catches the error and tries again
 * fans out without limit instead.
 *
 * Also here: a legitimate one-level nested call must keep working when
 * the pool is as small as it can be, which is the deadlock the budget
 * must not introduce.
 */
describe('nested tools.invoke - depth, fan-out and the pool', () => {
  const saved: Record<string, string | undefined> = {};
  const env: Record<string, string> = {
    SANDBOX_MAX_WORKERS: '4',
    SANDBOX_MAX_INVOKE_DEPTH: '3',
    SANDBOX_MAX_NESTED_INVOCATIONS: '10',
  };
  const mockedAxios = axios as unknown as jest.Mock;

  jest.setTimeout(90_000);

  beforeAll(() => {
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
  });

  const opts = { userId: 'u1', organizationId: 'org-1' };

  async function waitForIdle(sandbox: any, ms: number): Promise<number> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if ((sandbox.activeWorkers ?? 0) + (sandbox.activeNestedWorkers ?? 0) === 0) return 0;
      await new Promise((r) => setTimeout(r, 50));
    }
    return (sandbox.activeWorkers ?? 0) + (sandbox.activeNestedWorkers ?? 0);
  }

  it('a tool that invokes itself stops at the depth limit and leaves the pool idle', async () => {
    const { service, sandbox, executeSpy } = buildHarness({
      loop: jsTool('loop', "return await tools.invoke('loop', {});"),
    });

    const result = await service.executeTool('loop', {}, opts);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/depth/i);
    // root + 3 nested levels, then the fourth nested call is refused
    // before it reaches the executor.
    expect(executeSpy).toHaveBeenCalledTimes(4);
    // Nothing is left holding a worker once the root has answered.
    expect(await waitForIdle(sandbox, 2000)).toBe(0);
  });

  it('a tool that swallows the error and keeps invoking hits the fan-out budget', async () => {
    const { service, executeSpy } = buildHarness({
      fanout: jsTool(
        'fanout',
        `let n = 0;
         for (let i = 0; i < 40; i++) {
           try { await tools.invoke('leaf', {}); n++; }
           catch (e) { return { n, error: e.message }; }
         }
         return { n };`,
      ),
      leaf: httpTool('leaf', 'https://api.example.com/leaf'),
    });

    const result = await service.executeTool('fanout', {}, opts);

    expect(result.success).toBe(true);
    expect(result.data.n).toBe(10);
    expect(result.data.error).toMatch(/nested/i);
    expect(executeSpy).toHaveBeenCalledTimes(11);
  });

  it('a legitimate one-level nested call still works with a single-worker pool', async () => {
    const prev = process.env.SANDBOX_MAX_WORKERS;
    const prevOrg = process.env.SANDBOX_MAX_WORKERS_PER_ORG;
    process.env.SANDBOX_MAX_WORKERS = '1';
    process.env.SANDBOX_MAX_WORKERS_PER_ORG = '1';
    try {
      const { service } = buildHarness({
        outer: jsTool('outer', "const r = await tools.invoke('inner', { x: 21 }); return r * 2;"),
        inner: jsTool('inner', 'return parameters.x;'),
      });

      const result = await service.executeTool('outer', {}, opts);

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.data).toBe(42);
    } finally {
      restoreEnv('SANDBOX_MAX_WORKERS', prev);
      restoreEnv('SANDBOX_MAX_WORKERS_PER_ORG', prevOrg);
    }
  });

  it('nested work is torn down when the calling tool times out', async () => {
    const { service, sandbox } = buildHarness({
      parent: jsTool('parent', "await tools.invoke('sleeper', {}); return 'done';", {
        configuration: { timeout: 1500 },
      }),
      sleeper: jsTool('sleeper', 'await new Promise(r => setTimeout(r, 20000)); return 1;', {
        configuration: { timeout: 20000 },
      }),
    });

    const result = await service.executeTool('parent', {}, opts);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/);
    // The nested worker does not outlive the parent that asked for it.
    expect(await waitForIdle(sandbox, 3000)).toBe(0);
  });
});
