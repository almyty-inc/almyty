import { ToolCacheRateLimitHelper } from '../tool-cache-rate-limit.helper';

/** What the cache helper uses of Redis, in memory. */
function memoryRedis() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    setex: async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    },
  };
}

/**
 * A tool's cached answers are kept for one run, unless the tool says they
 * may be shared. An always-on agent checking for replies every few minutes
 * got its previous wake's inbox from the cache (five minutes by default for
 * every generated read) and missed the reply that had just come in.
 */
describe('tool answers are cached per run', () => {
  const tool = (cache: Record<string, any>) => ({ id: 'tool-inbox', configuration: { cache: { enabled: true, ttl: 300, ...cache } } }) as any;

  it('keeps an answer to the run that asked, and shares it only when the tool opts in', () => {
    expect(ToolCacheRateLimitHelper.cacheScope(tool({}), 'run-1')).toBe('run:run-1');
    expect(ToolCacheRateLimitHelper.cacheScope(tool({}), undefined)).toBeNull();
    expect(ToolCacheRateLimitHelper.cacheScope(tool({ shared: true }), 'run-1')).toBe('shared');
    expect(ToolCacheRateLimitHelper.cacheScope(tool({ shared: true }), null)).toBe('shared');
  });

  it("a second run does not get the first run's answer", async () => {
    const helper = new ToolCacheRateLimitHelper(memoryRedis() as any);
    const t = tool({});
    await helper.cacheResult(t, { q: 'in:sent' }, { success: true, data: { messages: [] } } as any, 'run:run-1');

    expect(await helper.getCachedResult(t, { q: 'in:sent' }, 'run:run-1')).toMatchObject({ data: { messages: [] } });
    expect(await helper.getCachedResult(t, { q: 'in:sent' }, 'run:run-2')).toBeNull();
    expect(await helper.getCachedResult(t, { q: 'in:sent' }, 'shared')).toBeNull();
  });
});
