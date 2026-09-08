import { LlmModelsHelper, getDefaultModelPricing } from '../../../llm-providers/llm-models.helper';
import { LlmProvider, LlmProviderType } from '../../../../entities/llm-provider.entity';
import { makeEnvelopeCryptoMock } from '../../../../test/envelope-crypto.mock';
import { PriceFeedService, PriceQuote } from '../price-feed.service';

/**
 * calculateProviderCost consults the live feed before the offline seed
 * table, and behaves exactly as before when no feed is wired in.
 */

const MILLION = 1_000_000;

function providerWith(type: LlmProviderType, model: string, metadata?: any): LlmProvider {
  return { type, configuration: { model }, metadata } as unknown as LlmProvider;
}

function quote(inPerMTok: number, outPerMTok: number, source: PriceQuote['source'] = 'feed:litellm'): PriceQuote {
  return { inPerMTok, outPerMTok, currency: 'USD', source, fetchedAt: new Date() };
}

describe('LlmModelsHelper pricing with the feed', () => {
  let feed: { lookup: jest.Mock };
  let helper: LlmModelsHelper;

  beforeEach(() => {
    feed = { lookup: jest.fn().mockReturnValue(null) };
    helper = new LlmModelsHelper(makeEnvelopeCryptoMock(), feed as unknown as PriceFeedService);
  });

  it('prefers the feed quote and converts per-million to the per-1K unit', () => {
    // The seed table says $2.50/$10 for gpt-4o; the feed disagrees.
    feed.lookup.mockReturnValue(quote(2, 8));

    const cost = helper.calculateProviderCost(providerWith(LlmProviderType.OPENAI, 'gpt-4o'), MILLION, MILLION);

    expect(feed.lookup).toHaveBeenCalledWith(LlmProviderType.OPENAI, 'gpt-4o');
    expect(cost).toBeCloseTo(2 + 8, 6);
    expect(helper.getModelPricing('gpt-4o', LlmProviderType.OPENAI)).toEqual({ input: 0.002, output: 0.008 });
  });

  it('falls back to the seed table when the feed has no quote', () => {
    feed.lookup.mockReturnValue(null);

    const cost = helper.calculateProviderCost(providerWith(LlmProviderType.OPENAI, 'gpt-4o'), MILLION, MILLION);

    const seed = getDefaultModelPricing('gpt-4o', LlmProviderType.OPENAI)!;
    expect(cost).toBeCloseTo((seed.input + seed.output) * 1000, 6);
    expect(cost).toBeCloseTo(2.5 + 10, 6);
  });

  it('is byte-for-byte the seed table when no feed is injected', () => {
    const bare = new LlmModelsHelper(makeEnvelopeCryptoMock());
    const provider = providerWith(LlmProviderType.MISTRAL, 'mistral-large-latest');

    expect(bare.calculateProviderCost(provider, MILLION, MILLION)).toBeCloseTo(2 + 6, 6);
    expect(bare.getModelPricing('mistral-large-latest', LlmProviderType.MISTRAL)).toEqual(
      getDefaultModelPricing('mistral-large-latest', LlmProviderType.MISTRAL),
    );
    expect(bare.getModelPricing('', LlmProviderType.MISTRAL)).toBeNull();
  });

  it('still lets explicit metadata pricing win over the feed', () => {
    feed.lookup.mockReturnValue(quote(2, 8));
    const provider = providerWith(LlmProviderType.OPENAI, 'gpt-4o', {
      modelInfo: { inputTokenCost: 0.001, outputTokenCost: 0.002 },
    });

    const cost = helper.calculateProviderCost(provider, MILLION, MILLION);

    expect(cost).toBeCloseTo(1 + 2, 6);
    expect(feed.lookup).not.toHaveBeenCalled();
  });

  it('bills a feed-native local model at zero', () => {
    feed.lookup.mockReturnValue(quote(0, 0, 'native'));

    const cost = helper.calculateProviderCost(providerWith(LlmProviderType.OLLAMA, 'mistral-large'), MILLION, MILLION);

    expect(cost).toBe(0);
  });

  it('returns zero for a model neither the feed nor the table knows', () => {
    const cost = helper.calculateProviderCost(providerWith(LlmProviderType.OPENAI, 'no-such-model'), MILLION, MILLION);
    expect(cost).toBe(0);
  });
});
