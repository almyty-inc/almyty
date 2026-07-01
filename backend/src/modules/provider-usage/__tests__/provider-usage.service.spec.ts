import { ProviderUsageService } from '../provider-usage.service';
import {
  providerUsageCapability,
  listProviderUsageCapabilities,
} from '../provider-usage.capability';
import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';

/**
 * Unit tests for the P7 provider-usage ingestion. All external HTTP is
 * mocked at the `fetchJson` seam — no real network. Covers: OpenAI +
 * Anthropic payload parsing, the capability gate (unsupported provider →
 * no call), upsert idempotency, and reconciliation delta math.
 */
describe('ProviderUsageService', () => {
  function makeProvider(
    type: LlmProviderType,
    overrides: Partial<LlmProvider> = {},
  ): LlmProvider {
    return Object.assign(new LlmProvider(), {
      id: `prov-${type}`,
      name: `${type} provider`,
      type,
      organizationId: 'org-1',
      configuration: { usageApiKey: 'sk-admin-test' },
      ...overrides,
    }) as LlmProvider;
  }

  function makeQb(rawMany: any[]) {
    const qb: any = {};
    for (const m of ['select', 'addSelect', 'where', 'andWhere', 'groupBy']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn().mockResolvedValue(rawMany);
    return qb;
  }

  function makeService(opts: {
    snapshotRepo?: any;
    providerRepo?: any;
    conversationRepo?: any;
  } = {}) {
    const snapshotRepo = opts.snapshotRepo ?? { upsert: jest.fn(), createQueryBuilder: jest.fn() };
    const providerRepo = opts.providerRepo ?? { find: jest.fn() };
    const conversationRepo = opts.conversationRepo ?? { createQueryBuilder: jest.fn() };
    return new ProviderUsageService(snapshotRepo, providerRepo, conversationRepo);
  }

  // ── capability catalog ─────────────────────────────────────────────

  it('flags OpenAI + Anthropic as supported and requiring an admin key', () => {
    expect(providerUsageCapability(LlmProviderType.OPENAI).supported).toBe(true);
    expect(providerUsageCapability(LlmProviderType.OPENAI).requiresAdminKey).toBe(true);
    expect(providerUsageCapability(LlmProviderType.ANTHROPIC).supported).toBe(true);
  });

  it('flags the other 12 provider types as unsupported', () => {
    const unsupported = listProviderUsageCapabilities().filter((c) => !c.supported);
    expect(unsupported.map((c) => c.type).sort()).toEqual(
      [
        LlmProviderType.AWS_BEDROCK,
        LlmProviderType.AZURE_OPENAI,
        LlmProviderType.COHERE,
        LlmProviderType.CUSTOM,
        LlmProviderType.DEEPSEEK,
        LlmProviderType.GOOGLE,
        LlmProviderType.GROQ,
        LlmProviderType.HUGGINGFACE,
        LlmProviderType.MISTRAL,
        LlmProviderType.OPENROUTER,
        LlmProviderType.TOGETHER,
        LlmProviderType.XAI,
      ].sort(),
    );
    // every unsupported entry must carry an explanatory note
    expect(unsupported.every((c) => !!c.note)).toBe(true);
  });

  // ── OpenAI parsing ─────────────────────────────────────────────────

  it('parses + merges OpenAI usage (tokens) and costs (dollars) by bucket', () => {
    const service = makeService();
    const usage = {
      data: [
        { start_time: 1719792000, end_time: 1719878400, results: [{ input_tokens: 1000, output_tokens: 500 }] },
        { start_time: 1719878400, end_time: 1719964800, results: [{ input_tokens: 2000, output_tokens: 800 }] },
      ],
    };
    const costs = {
      data: [
        { start_time: 1719792000, end_time: 1719878400, results: [{ amount: { value: 0.15, currency: 'usd' } }] },
        { start_time: 1719878400, end_time: 1719964800, results: [{ amount: { value: 0.3, currency: 'usd' } }] },
      ],
    };

    const buckets = service.parseOpenAiBuckets(usage, costs);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      costCents: 15,
      currency: 'usd',
    });
    expect(buckets[1]).toMatchObject({ totalTokens: 2800, costCents: 30 });
    expect(buckets[0].periodStart.toISOString()).toBe('2024-07-01T00:00:00.000Z');
  });

  // ── Anthropic parsing ──────────────────────────────────────────────

  it('parses Anthropic usage (split token fields) + cost (decimal string)', () => {
    const service = makeService();
    const usage = {
      data: [
        {
          starting_at: '2024-07-01T00:00:00Z',
          ending_at: '2024-07-02T00:00:00Z',
          results: [{ uncached_input_tokens: 1000, cache_read_input_tokens: 200, output_tokens: 400 }],
        },
      ],
    };
    const costs = {
      data: [
        {
          starting_at: '2024-07-01T00:00:00Z',
          ending_at: '2024-07-02T00:00:00Z',
          results: [{ amount: '0.25', currency: 'USD' }],
        },
      ],
    };

    const buckets = service.parseAnthropicBuckets(usage, costs);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      inputTokens: 1200,
      outputTokens: 400,
      totalTokens: 1600,
      costCents: 25,
      currency: 'usd',
    });
  });

  // ── dispatch / capability gate ─────────────────────────────────────

  it('makes NO network call for an unsupported provider type', async () => {
    const service = makeService();
    const spy = jest.spyOn(service as any, 'fetchJson');
    const res = await service.fetchProviderUsage(
      makeProvider(LlmProviderType.GROQ),
      new Date('2024-07-01'),
      new Date('2024-07-03'),
    );
    expect(res.supported).toBe(false);
    expect(res.buckets).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns an error (no call) when a supported provider has no usage key', async () => {
    const service = makeService();
    const spy = jest.spyOn(service as any, 'fetchJson');
    const provider = makeProvider(LlmProviderType.OPENAI, { configuration: {} });
    const res = await service.fetchProviderUsage(provider, new Date(), new Date());
    expect(res.supported).toBe(true);
    expect(res.error).toMatch(/no usage/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches + normalizes OpenAI usage through the mocked HTTP seam', async () => {
    const service = makeService();
    jest.spyOn(service as any, 'fetchJson').mockImplementation((...args: any[]) => {
      const url = args[0] as string;
      if (url.includes('/costs')) {
        return Promise.resolve({
          data: [{ start_time: 1719792000, end_time: 1719878400, results: [{ amount: { value: 0.42 } }] }],
        });
      }
      return Promise.resolve({
        data: [{ start_time: 1719792000, end_time: 1719878400, results: [{ input_tokens: 10, output_tokens: 5 }] }],
      });
    });

    const res = await service.fetchProviderUsage(
      makeProvider(LlmProviderType.OPENAI),
      new Date('2024-07-01T00:00:00Z'),
      new Date('2024-07-02T00:00:00Z'),
    );
    expect(res.supported).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.buckets).toHaveLength(1);
    expect(res.buckets[0]).toMatchObject({ totalTokens: 15, costCents: 42 });
  });

  // ── upsert idempotency ─────────────────────────────────────────────

  it('upserts one snapshot per bucket with the dedup conflictPaths (idempotent)', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const service = makeService({ snapshotRepo: { upsert } });
    jest.spyOn(service, 'fetchProviderUsage').mockResolvedValue({
      supported: true,
      capability: providerUsageCapability(LlmProviderType.OPENAI),
      buckets: [
        {
          periodStart: new Date('2024-07-01T00:00:00Z'),
          periodEnd: new Date('2024-07-02T00:00:00Z'),
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          costCents: 42,
          currency: 'usd',
        },
      ],
    });

    const provider = makeProvider(LlmProviderType.OPENAI);
    const first = await service.syncProvider(provider, new Date(), new Date());
    const second = await service.syncProvider(provider, new Date(), new Date());

    expect(first).toEqual({ supported: true, written: 1 });
    expect(second).toEqual({ supported: true, written: 1 });
    expect(upsert).toHaveBeenCalledTimes(2);
    // both runs pass the identical row + dedup key → overwrite, not duplicate
    expect(upsert.mock.calls[0][1]).toEqual({
      conflictPaths: ['organizationId', 'llmProviderId', 'periodStart'],
      skipUpdateIfNoValuesChanged: false,
    });
    expect(upsert.mock.calls[0][0]).toEqual(upsert.mock.calls[1][0]);
    expect(upsert.mock.calls[0][0][0]).toMatchObject({
      organizationId: 'org-1',
      llmProviderId: 'prov-openai',
      costCents: 42,
      source: 'provider',
    });
  });

  it('does not call upsert when the provider is unsupported', async () => {
    const upsert = jest.fn();
    const service = makeService({ snapshotRepo: { upsert } });
    const res = await service.syncProvider(makeProvider(LlmProviderType.MISTRAL), new Date(), new Date());
    expect(res).toEqual({ supported: false, written: 0 });
    expect(upsert).not.toHaveBeenCalled();
  });

  // ── reconciliation math ────────────────────────────────────────────

  it('reconciles estimate (Conversation, dollars) vs actual (snapshots, cents)', async () => {
    const openai = makeProvider(LlmProviderType.OPENAI, { id: 'p-openai', name: 'My OpenAI' });
    const groq = makeProvider(LlmProviderType.GROQ, { id: 'p-groq', name: 'My Groq' });

    const conversationRepo = {
      createQueryBuilder: jest.fn(() =>
        makeQb([{ providerId: 'p-openai', cost: '1.00', tokens: '1500' }]),
      ),
    };
    const snapshotRepo = {
      upsert: jest.fn(),
      createQueryBuilder: jest.fn(() =>
        makeQb([{ providerId: 'p-openai', cents: '120', tokens: '1600' }]),
      ),
    };
    const providerRepo = { find: jest.fn().mockResolvedValue([openai, groq]) };
    const service = makeService({ snapshotRepo, providerRepo, conversationRepo });

    const rows = await service.getReconciliation('org-1', { from: new Date('2024-07-01') });
    const byId = Object.fromEntries(rows.map((r) => [r.llmProviderId, r]));

    // OpenAI: $1.00 estimate → 100c, $1.20 actual → 120c, +20c (+20%)
    expect(byId['p-openai']).toMatchObject({
      estimateCents: 100,
      estimateTokens: 1500,
      actualCents: 120,
      actualTokens: 1600,
      deltaCents: 20,
      deltaPct: 20,
      capabilitySupported: true,
    });
    // Groq: unsupported, no estimate, no actual → nulls + a note
    expect(byId['p-groq']).toMatchObject({
      estimateCents: 0,
      actualCents: null,
      deltaCents: null,
      deltaPct: null,
      capabilitySupported: false,
    });
    expect(byId['p-groq'].note).toBeTruthy();
  });
});
