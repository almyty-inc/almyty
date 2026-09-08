import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  LITELLM_COST_MAP_URL,
  OPENROUTER_MODELS_URL,
  PRICE_FEED_CACHE_KEY,
  PRICE_FEED_CACHE_TTL_SECONDS,
  PriceFeedService,
  snapshotAlias,
} from '../price-feed.service';
import { Model } from '../../../../entities/model.entity';
import { AuditAction, AuditResource } from '../../../../entities/audit-log.entity';
import { AuditLogService } from '../../../audit-log/audit-log.service';

// Same singleton pattern as llm-providers.service.spec: the application
// code's `axios_1.default` and this spec's `require('axios').default` are
// one jest.fn, so callLlmProviderHttp reaches the mock.
jest.mock('axios', () => {
  const mockFn = jest.fn();
  return {
    __esModule: true,
    default: mockFn,
    isAxiosError: jest.fn().mockReturnValue(false),
    AxiosError: class extends Error {},
  };
});

const mockAxios = require('axios').default as jest.Mock;

const REDIS_TOKEN = 'default_IORedisModuleConnectionToken';

// Per-token dollars, exactly as LiteLLM publishes them.
const LITELLM_FIXTURE: Record<string, any> = {
  sample_spec: { litellm_provider: 'openai', input_cost_per_token: 0.0, output_cost_per_token: 0.0 },
  'gpt-4o': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    max_input_tokens: 128000,
  },
  'o1-2024-06-01': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00004,
  },
  'o1-2024-12-17': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 0.000015,
    output_cost_per_token: 0.00006,
  },
  'dall-e-3': { litellm_provider: 'openai', mode: 'image_generation', input_cost_per_pixel: 0.0000001 },
  'anthropic/claude-sonnet-4-20250514': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    max_input_tokens: 200000,
  },
  'openrouter/anthropic/claude-sonnet-4': {
    litellm_provider: 'openrouter',
    mode: 'chat',
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
  },
  'bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0': {
    litellm_provider: 'bedrock',
    mode: 'chat',
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
  },
  'gemini/gemini-2.5-flash': {
    litellm_provider: 'gemini',
    mode: 'chat',
    input_cost_per_token: 0.0000003,
    output_cost_per_token: 0.0000025,
  },
  'mistral/mistral-large-latest': {
    litellm_provider: 'mistral',
    mode: 'chat',
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000006,
  },
  'accounts/fireworks/models/some-model': {
    litellm_provider: 'fireworks_ai',
    mode: 'chat',
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000001,
  },
  'cerebras/llama-3.3-70b': {
    litellm_provider: 'cerebras',
    mode: 'chat',
    input_cost_per_token: 0.00000085,
    output_cost_per_token: 0.0000012,
  },
  'nebius/deepseek-ai/DeepSeek-V3': {
    litellm_provider: 'nebius',
    mode: 'chat',
    input_cost_per_token: 0.0000005,
    output_cost_per_token: 0.0000015,
  },
  'sambanova/DeepSeek-V3.1': {
    litellm_provider: 'sambanova',
    mode: 'chat',
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.0000045,
  },
  'perplexity/sonar-pro': {
    litellm_provider: 'perplexity',
    mode: 'chat',
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
  },
};

// Strings, as OpenRouter returns them.
const OPENROUTER_FIXTURE = {
  data: [
    { id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' }, context_length: 128000 },
    { id: 'anthropic/claude-sonnet-4', pricing: { prompt: '0.000003', completion: '0.000015' }, context_length: 200000 },
    { id: 'mistralai/mistral-large-latest', pricing: { prompt: '0.000004', completion: '0.000006' } },
    { id: 'x-ai/grok-4', pricing: { prompt: '0.000003', completion: '0.000015' }, context_length: 256000 },
    { id: 'meta-llama/llama-3.3-70b-instruct', pricing: { prompt: '0.0000001', completion: '0.0000003' } },
    { id: 'perplexity/sonar-pro', pricing: { prompt: '0.000003', completion: '0.000015' }, context_length: 200000 },
    { id: 'z-ai/glm-5', pricing: { prompt: '0.000001', completion: '0.0000032' }, context_length: 200000 },
    { id: 'broken/no-pricing', pricing: {} },
  ],
};

function routeAxios(overrides: { litellm?: any; openrouter?: any } = {}) {
  mockAxios.mockImplementation(async (config: any) => {
    const url: string = config.url;
    if (url === (process.env.MODEL_PRICE_FEED_LITELLM_URL || LITELLM_COST_MAP_URL)) {
      if (overrides.litellm instanceof Error) throw overrides.litellm;
      return { data: overrides.litellm ?? LITELLM_FIXTURE };
    }
    if (url === (process.env.MODEL_PRICE_FEED_OPENROUTER_URL || OPENROUTER_MODELS_URL)) {
      if (overrides.openrouter instanceof Error) throw overrides.openrouter;
      return { data: overrides.openrouter ?? OPENROUTER_FIXTURE };
    }
    throw new Error(`unexpected url ${url}`);
  });
}

function makeRow(partial: Partial<Model>): Model {
  return Object.assign(new Model(), {
    id: 'row',
    organizationId: 'org-1',
    name: 'row',
    providerId: 'prov',
    providerType: 'openai',
    vendorModelId: 'gpt-4o',
    pricing: null,
    pricingSource: 'unpriced',
    pricingFetchedAt: null,
    pricingOverride: null,
    contextLength: null,
    metadata: null,
    ...partial,
  });
}

describe('PriceFeedService', () => {
  let service: PriceFeedService;
  let redis: { get: jest.Mock; set: jest.Mock; setex: jest.Mock };
  let modelRepository: { find: jest.Mock; save: jest.Mock };
  let auditLog: { log: jest.Mock };
  const originalEnv = { ...process.env };

  async function build(): Promise<PriceFeedService> {
    const module = await Test.createTestingModule({
      providers: [
        PriceFeedService,
        { provide: getRepositoryToken(Model), useValue: modelRepository },
        { provide: REDIS_TOKEN, useValue: redis },
        { provide: AuditLogService, useValue: auditLog },
      ],
    }).compile();
    return module.get(PriceFeedService);
  }

  beforeEach(async () => {
    delete process.env.MODEL_PRICE_FEED_DISABLED;
    delete process.env.MODEL_PRICE_FEED_LITELLM_URL;
    delete process.env.MODEL_PRICE_FEED_OPENROUTER_URL;
    mockAxios.mockReset();
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), setex: jest.fn().mockResolvedValue('OK') };
    modelRepository = { find: jest.fn().mockResolvedValue([]), save: jest.fn(async (row) => row) };
    auditLog = { log: jest.fn().mockResolvedValue(null) };
    service = await build();
    routeAxios();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('snapshotAlias', () => {
    it.each([
      ['claude-sonnet-4-20250514', 'claude-sonnet-4'],
      ['gpt-4o-2024-08-06', 'gpt-4o'],
      ['gpt-3.5-turbo-0125', 'gpt-3.5-turbo'],
      ['claude-opus-4-1-20250805', 'claude-opus-4-1'],
      ['gemini-1.5-flash-002', 'gemini-1.5-flash'],
      ['o1-2024-12-17', 'o1'],
    ])('%s aliases to %s', (id, alias) => {
      expect(snapshotAlias(id)).toBe(alias);
    });

    it.each(['claude-sonnet-4', 'gpt-4o', 'llama-3.3-70b-versatile', 'gpt-4-turbo', '20250514'])(
      '%s has no snapshot suffix',
      (id) => {
        expect(snapshotAlias(id)).toBeNull();
      },
    );
  });

  describe('refresh + normalisation', () => {
    it('fetches both sources and converts per-token dollars to per-million', async () => {
      const result = await service.refresh();

      expect(mockAxios).toHaveBeenCalledTimes(2);
      expect(result.litellm).toBeGreaterThan(0);
      expect(result.openrouter).toBeGreaterThan(0);

      const quote = service.lookup('openai', 'gpt-4o');
      expect(quote).toMatchObject({
        inPerMTok: 2.5,
        outPerMTok: 10,
        currency: 'USD',
        source: 'feed:litellm',
        contextLength: 128000,
      });
      expect(quote!.fetchedAt).toEqual(result.fetchedAt);
      expect(quote!.disagreement).toBeUndefined();
    });

    it('parses OpenRouter string prices and serves OpenRouter ids verbatim for the openrouter type', async () => {
      await service.refresh();

      // Not in LiteLLM under an openrouter key, so OpenRouter is the source.
      expect(service.lookup('openrouter', 'openai/gpt-4o')).toMatchObject({
        inPerMTok: 2.5,
        outPerMTok: 10,
        source: 'feed:openrouter',
        contextLength: 128000,
      });
      // LiteLLM's "openrouter/vendor/model" key, prefix stripped, wins for the same id.
      expect(service.lookup('openrouter', 'anthropic/claude-sonnet-4')).toMatchObject({
        inPerMTok: 3,
        outPerMTok: 15,
        source: 'feed:litellm',
      });
      expect(service.lookup('openrouter', 'meta-llama/llama-3.3-70b-instruct')).toMatchObject({
        inPerMTok: 0.1,
        outPerMTok: 0.3,
        source: 'feed:openrouter',
      });
    });

    it('skips entries without per-token prices and providers we do not map', async () => {
      await service.refresh();
      expect(service.lookup('openai', 'dall-e-3')).toBeNull();
      expect(service.lookup('openai', 'sample_spec')).toBeNull();
      expect(service.lookup('custom', 'accounts/fireworks/models/some-model')).toBeNull();
      expect(service.lookup('openrouter', 'broken/no-pricing')).toBeNull();
    });

    it('strips the LiteLLM provider prefix so vendor ids match', async () => {
      await service.refresh();
      expect(service.lookup('anthropic', 'claude-sonnet-4-20250514')).toMatchObject({
        inPerMTok: 3,
        outPerMTok: 15,
        source: 'feed:litellm',
        contextLength: 200000,
      });
      expect(service.lookup('google', 'gemini-2.5-flash')).toMatchObject({ inPerMTok: 0.3, outPerMTok: 2.5 });
      expect(service.lookup('aws_bedrock', 'anthropic.claude-3-5-sonnet-20241022-v2:0')).toMatchObject({
        inPerMTok: 3,
        outPerMTok: 15,
      });
      expect(service.lookup('mistral', 'mistral-large-latest')).toMatchObject({ inPerMTok: 2, outPerMTok: 6 });
    });

    it('prices the OpenAI-compatible inference hosts from their LiteLLM namespaces', async () => {
      await service.refresh();
      // The stripped key is exactly what each host's /models returns.
      expect(service.lookup('fireworks', 'accounts/fireworks/models/some-model')).toMatchObject({ inPerMTok: 1, outPerMTok: 1, source: 'feed:litellm' });
      expect(service.lookup('cerebras', 'llama-3.3-70b')).toMatchObject({ inPerMTok: 0.85, outPerMTok: 1.2 });
      expect(service.lookup('nebius', 'deepseek-ai/DeepSeek-V3')).toMatchObject({ inPerMTok: 0.5, outPerMTok: 1.5 });
      expect(service.lookup('sambanova', 'DeepSeek-V3.1')).toMatchObject({ inPerMTok: 3, outPerMTok: 4.5 });
      // OpenRouter cross-checks Perplexity and Z.ai under their own namespaces.
      expect(service.lookup('perplexity', 'sonar-pro')).toMatchObject({ inPerMTok: 3, outPerMTok: 15, source: 'feed:litellm' });
      expect(service.lookup('zai', 'glm-5')).toMatchObject({ inPerMTok: 1, outPerMTok: 3.2, source: 'feed:openrouter' });
      // Hosts share ids with the model authors but are priced per host.
      expect(service.lookup('deepseek', 'DeepSeek-V3.1')).toBeNull();
      expect(service.lookup('novita', 'DeepSeek-V3.1')).toBeNull();
    });

    it('matches ids case-insensitively', async () => {
      await service.refresh();
      expect(service.lookup('openai', 'GPT-4o')).toMatchObject({ inPerMTok: 2.5 });
    });

    it('resolves a dated card id to the undated feed entry', async () => {
      await service.refresh();
      expect(service.lookup('openai', 'gpt-4o-2024-08-06')).toMatchObject({ inPerMTok: 2.5, outPerMTok: 10 });
    });

    it('resolves an undated card id to the newest dated feed entry', async () => {
      await service.refresh();
      // LiteLLM only carries claude-sonnet-4-20250514 for the anthropic type;
      // OpenRouter has the undated id, but LiteLLM's alias is preferred.
      expect(service.lookup('anthropic', 'claude-sonnet-4')).toMatchObject({
        inPerMTok: 3,
        outPerMTok: 15,
        source: 'feed:litellm',
      });
      // Two o1 snapshots: the greatest key (newest date) wins the alias.
      expect(service.lookup('openai', 'o1')).toMatchObject({ inPerMTok: 15, outPerMTok: 60 });
    });

    it('flags a disagreement above 25% but still returns LiteLLM prices', async () => {
      await service.refresh();
      const quote = service.lookup('mistral', 'mistral-large-latest');
      expect(quote).toMatchObject({ inPerMTok: 2, outPerMTok: 6, source: 'feed:litellm' });
      expect(quote!.disagreement).toEqual({
        litellm: { inPerMTok: 2, outPerMTok: 6 },
        openrouter: { inPerMTok: 4, outPerMTok: 6 },
      });
    });

    it('does not flag when both sources agree', async () => {
      await service.refresh();
      expect(service.lookup('openai', 'gpt-4o')!.disagreement).toBeUndefined();
      expect(service.lookup('anthropic', 'claude-sonnet-4-20250514')!.disagreement).toBeUndefined();
    });

    it('falls back to OpenRouter when LiteLLM lacks the model', async () => {
      await service.refresh();
      expect(service.lookup('xai', 'grok-4')).toMatchObject({
        inPerMTok: 3,
        outPerMTok: 15,
        source: 'feed:openrouter',
        contextLength: 256000,
      });
    });

    it('prices local Ollama models at zero with a native source and leaves custom unpriced', async () => {
      await service.refresh();
      expect(service.lookup('ollama', 'llama3.2')).toMatchObject({ inPerMTok: 0, outPerMTok: 0, source: 'native' });
      expect(service.lookup('custom', 'gpt-4o')).toBeNull();
      expect(service.lookup('openai', 'no-such-model')).toBeNull();
      expect(service.lookup('', 'gpt-4o')).toBeNull();
    });

    it('keeps the other source when one fails', async () => {
      await service.refresh();
      const before = service.lookup('openai', 'gpt-4o');

      routeAxios({ litellm: new Error('github down'), openrouter: { data: [{ id: 'x-ai/grok-4', pricing: { prompt: '0.000001', completion: '0.000002' } }] } });
      const result = await service.refresh();

      expect(result.litellm).toBeGreaterThan(0);
      expect(result.openrouter).toBe(1);
      expect(service.lookup('openai', 'gpt-4o')).toMatchObject({ inPerMTok: before!.inPerMTok });
      expect(service.lookup('xai', 'grok-4')).toMatchObject({ inPerMTok: 1, outPerMTok: 2 });
    });

    it('throws when both sources fail on a cold start', async () => {
      routeAxios({ litellm: new Error('a'), openrouter: new Error('b') });
      await expect(service.refresh()).rejects.toThrow(/refresh failed/);
      expect(service.hasData()).toBe(false);
    });

    it('honours URL overrides from the environment', async () => {
      process.env.MODEL_PRICE_FEED_LITELLM_URL = 'https://mirror.example.com/litellm.json';
      process.env.MODEL_PRICE_FEED_OPENROUTER_URL = 'https://mirror.example.com/openrouter.json';
      routeAxios();

      await service.refresh();

      const urls = mockAxios.mock.calls.map((c) => c[0].url).sort();
      expect(urls).toEqual([
        'https://mirror.example.com/litellm.json',
        'https://mirror.example.com/openrouter.json',
      ]);
    });

    it('skips the network entirely when MODEL_PRICE_FEED_DISABLED=true', async () => {
      process.env.MODEL_PRICE_FEED_DISABLED = 'true';
      const result = await service.refresh();
      expect(mockAxios).not.toHaveBeenCalled();
      expect(result).toMatchObject({ litellm: 0, openrouter: 0 });
      expect(redis.setex).not.toHaveBeenCalled();
    });
  });

  describe('Redis cache', () => {
    it('persists the normalised map with a 7-day TTL and reloads it on init', async () => {
      await service.refresh();

      expect(redis.setex).toHaveBeenCalledTimes(1);
      const [key, ttl, payload] = redis.setex.mock.calls[0];
      expect(key).toBe(PRICE_FEED_CACHE_KEY);
      expect(ttl).toBe(PRICE_FEED_CACHE_TTL_SECONDS);
      expect(ttl).toBe(7 * 24 * 60 * 60);

      // A fresh replica: nothing fetched, cache primed.
      mockAxios.mockReset();
      redis.get.mockResolvedValue(payload);
      const fresh = await build();
      expect(fresh.hasData()).toBe(false);
      await fresh.onModuleInit();

      expect(redis.get).toHaveBeenCalledWith(PRICE_FEED_CACHE_KEY);
      expect(fresh.hasData()).toBe(true);
      expect(mockAxios).not.toHaveBeenCalled();
      expect(fresh.lookup('openai', 'gpt-4o')).toMatchObject({ inPerMTok: 2.5, outPerMTok: 10, source: 'feed:litellm' });
      expect(fresh.lookup('mistral', 'mistral-large-latest')!.disagreement).toBeDefined();
    });

    it('starts empty and does not throw when the cache is unreadable', async () => {
      redis.get.mockResolvedValue('{not json');
      const fresh = await build();
      await expect(fresh.onModuleInit()).resolves.toBeUndefined();
      expect(fresh.hasData()).toBe(false);
    });

    it('works without a Redis connection at all', async () => {
      const module = await Test.createTestingModule({
        providers: [
          PriceFeedService,
          { provide: getRepositoryToken(Model), useValue: modelRepository },
        ],
      }).compile();
      const noRedis = module.get(PriceFeedService);
      await noRedis.onModuleInit();
      await noRedis.refresh();
      expect(noRedis.lookup('openai', 'gpt-4o')).toMatchObject({ inPerMTok: 2.5 });
    });
  });

  describe('applyToCatalog', () => {
    it('prices feed-known cards, marks unknown ones unpriced, flags disagreements and skips overrides', async () => {
      await service.refresh();
      const rows = [
        makeRow({ id: 'priced', providerType: 'openai', vendorModelId: 'gpt-4o' }),
        makeRow({
          id: 'overridden',
          providerType: 'openai',
          vendorModelId: 'gpt-4o',
          pricingSource: 'manual',
          pricing: { inPerMTok: 1, outPerMTok: 1, currency: 'USD' },
          pricingOverride: { inPerMTok: 1, outPerMTok: 1, currency: 'USD' },
        }),
        makeRow({ id: 'unknown', providerType: 'openai', vendorModelId: 'no-such-model' }),
        makeRow({ id: 'flagged', providerType: 'mistral', vendorModelId: 'mistral-large-latest' }),
        makeRow({ id: 'no-provider', providerType: null, vendorModelId: 'anything' }),
      ];
      modelRepository.find.mockResolvedValue(rows);

      const result = await service.applyToCatalog();

      expect(result).toEqual({ priced: 2, unpriced: 1, flagged: 1 });

      const saved = modelRepository.save.mock.calls.map((c) => c[0] as Model);
      expect(saved.map((r) => r.id).sort()).toEqual(['flagged', 'priced', 'unknown']);

      const priced = rows[0];
      expect(priced.pricing).toEqual({ inPerMTok: 2.5, outPerMTok: 10, currency: 'USD' });
      expect(priced.pricingSource).toBe('feed:litellm');
      expect(priced.pricingFetchedAt).toBeInstanceOf(Date);
      expect(priced.contextLength).toBe(128000);
      expect(priced.metadata).toBeNull();

      const overridden = rows[1];
      expect(overridden.pricingSource).toBe('manual');
      expect(overridden.pricing).toEqual({ inPerMTok: 1, outPerMTok: 1, currency: 'USD' });

      const unknown = rows[2];
      expect(unknown.pricing).toBeNull();
      expect(unknown.pricingSource).toBe('unpriced');

      const flagged = rows[3];
      expect(flagged.pricingSource).toBe('feed:litellm');
      expect(flagged.metadata?.pricingDisagreement).toEqual({
        litellm: { inPerMTok: 2, outPerMTok: 6 },
        openrouter: { inPerMTok: 4, outPerMTok: 6 },
      });

      expect(rows[4].pricingSource).toBe('unpriced');
      expect(rows[4].pricing).toBeNull();
    });

    it('does not re-save unchanged cards on a second pass', async () => {
      await service.refresh();
      const rows = [
        makeRow({ id: 'priced', providerType: 'openai', vendorModelId: 'gpt-4o' }),
        makeRow({ id: 'unknown', providerType: 'openai', vendorModelId: 'no-such-model' }),
      ];
      modelRepository.find.mockResolvedValue(rows);

      await service.applyToCatalog();
      expect(modelRepository.save).toHaveBeenCalledTimes(2);

      modelRepository.save.mockClear();
      await service.applyToCatalog();
      expect(modelRepository.save).not.toHaveBeenCalled();
    });

    it('clears a stale disagreement flag once the sources agree again', async () => {
      await service.refresh();
      const row = makeRow({
        id: 'was-flagged',
        providerType: 'openai',
        vendorModelId: 'gpt-4o',
        metadata: { pricingDisagreement: { litellm: {}, openrouter: {} }, keep: true },
      });
      modelRepository.find.mockResolvedValue([row]);

      await service.applyToCatalog();

      expect(row.metadata).toEqual({ keep: true });
    });

    it('scopes to one organization and emits one audit event per organization', async () => {
      await service.refresh();
      modelRepository.find.mockResolvedValue([
        makeRow({ id: 'a', organizationId: 'org-1', vendorModelId: 'gpt-4o' }),
        makeRow({ id: 'b', organizationId: 'org-1', vendorModelId: 'no-such-model' }),
        makeRow({ id: 'c', organizationId: 'org-2', providerType: 'mistral', vendorModelId: 'mistral-large-latest' }),
      ]);

      const result = await service.applyToCatalog();
      expect(result).toEqual({ priced: 2, unpriced: 1, flagged: 1 });
      expect(modelRepository.find).toHaveBeenCalledWith({ where: {} });

      expect(auditLog.log).toHaveBeenCalledTimes(2);
      expect(auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          action: AuditAction.MODEL_PRICE_UPDATED,
          resourceType: AuditResource.MODEL,
          resourceId: 'feed',
          details: expect.objectContaining({ priced: 1, unpriced: 1, flagged: 0 }),
        }),
      );
      expect(auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-2',
          details: expect.objectContaining({ priced: 1, unpriced: 0, flagged: 1 }),
        }),
      );

      auditLog.log.mockClear();
      modelRepository.find.mockResolvedValue([]);
      await service.applyToCatalog('org-2');
      expect(modelRepository.find).toHaveBeenCalledWith({ where: { organizationId: 'org-2' } });
      expect(auditLog.log).not.toHaveBeenCalled();
    });

    it('survives an audit log failure', async () => {
      await service.refresh();
      auditLog.log.mockRejectedValue(new Error('audit down'));
      modelRepository.find.mockResolvedValue([makeRow({ id: 'a', vendorModelId: 'gpt-4o' })]);
      await expect(service.applyToCatalog()).resolves.toEqual({ priced: 1, unpriced: 0, flagged: 0 });
    });
  });
});
