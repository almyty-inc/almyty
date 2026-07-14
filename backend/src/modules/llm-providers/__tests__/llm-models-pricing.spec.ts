import { LlmModelsHelper, DEFAULT_MODEL_PRICING, getDefaultModelPricing } from '../llm-models.helper';
import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';

/**
 * Pricing catalog completeness + correctness.
 *
 * The completeness test exists so that adding a chat implementation for
 * a provider type without giving it default pricing fails CI — that gap
 * is exactly how staging ended up showing $0.00 costs for real usage.
 */

function providerWith(type: LlmProviderType, model: string): LlmProvider {
  return {
    type,
    configuration: { model },
    metadata: undefined,
  } as unknown as LlmProvider;
}

describe('DEFAULT_MODEL_PRICING completeness', () => {
  /**
   * Provider types whose chat dispatch (llm-chat-runner.helper.ts)
   * passes calculateProviderCost into the provider implementation.
   * Every one of these MUST have a non-empty default pricing table.
   *
   * Deliberately absent:
   *  - AWS_BEDROCK: no chat dispatch implementation yet.
   *  - HUGGINGFACE / CUSTOM: chat dispatch does not take the cost
   *    function; arbitrary models are priced via metadata.modelInfo.
   *  - OLLAMA: chat dispatch takes the cost function but local
   *    inference is zero-cost by design — the table stays empty and
   *    getDefaultModelPricing short-circuits before the global
   *    fallback (see 'ollama zero-cost' tests below).
   */
  const CHAT_TYPES_REQUIRING_PRICING: LlmProviderType[] = [
    LlmProviderType.OPENAI,
    LlmProviderType.AZURE_OPENAI,
    LlmProviderType.MISTRAL,
    LlmProviderType.XAI,
    LlmProviderType.DEEPSEEK,
    LlmProviderType.GROQ,
    LlmProviderType.TOGETHER,
    LlmProviderType.OPENROUTER,
    LlmProviderType.ANTHROPIC,
    LlmProviderType.GOOGLE,
    LlmProviderType.COHERE,
  ];

  it.each(CHAT_TYPES_REQUIRING_PRICING)(
    '%s has a non-empty default pricing table',
    (type) => {
      expect(DEFAULT_MODEL_PRICING[type]).toBeDefined();
      expect(DEFAULT_MODEL_PRICING[type].length).toBeGreaterThan(0);
    },
  );

  it('has an entry (possibly empty) for every provider type', () => {
    for (const type of Object.values(LlmProviderType)) {
      expect(DEFAULT_MODEL_PRICING[type]).toBeDefined();
    }
  });

  it('every rule has positive input pricing and non-negative output pricing', () => {
    for (const rules of Object.values(DEFAULT_MODEL_PRICING)) {
      for (const rule of rules) {
        expect(rule.input).toBeGreaterThan(0);
        expect(rule.output).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('resolves a flagship model to a real price for every chat provider type', () => {
    const flagship: Record<string, string> = {
      [LlmProviderType.OPENAI]: 'gpt-4o',
      [LlmProviderType.AZURE_OPENAI]: 'gpt-4o-mini',
      [LlmProviderType.MISTRAL]: 'mistral-large-latest',
      [LlmProviderType.XAI]: 'grok-4',
      [LlmProviderType.DEEPSEEK]: 'deepseek-chat',
      [LlmProviderType.GROQ]: 'llama-3.3-70b-versatile',
      [LlmProviderType.TOGETHER]: 'meta-llama/llama-3.3-70b-instruct-turbo',
      [LlmProviderType.OPENROUTER]: 'anthropic/claude-sonnet-4',
      [LlmProviderType.ANTHROPIC]: 'claude-sonnet-4-20250514',
      [LlmProviderType.GOOGLE]: 'gemini-2.5-flash',
      [LlmProviderType.COHERE]: 'command-r-plus',
    };
    for (const type of CHAT_TYPES_REQUIRING_PRICING) {
      const pricing = getDefaultModelPricing(flagship[type], type);
      expect(pricing).not.toBeNull();
      expect(pricing!.input).toBeGreaterThan(0);
    }
  });
});

describe('calculateProviderCost', () => {
  const helper = new LlmModelsHelper();
  const MILLION = 1_000_000;

  it('prices mistral-large-latest at $2/$6 per 1M tokens', () => {
    const cost = helper.calculateProviderCost(
      providerWith(LlmProviderType.MISTRAL, 'mistral-large-latest'),
      MILLION,
      MILLION,
    );
    expect(cost).toBeCloseTo(2 + 6, 6);
  });

  it('prices mistral-small-latest at $0.10/$0.30 per 1M tokens', () => {
    const cost = helper.calculateProviderCost(
      providerWith(LlmProviderType.MISTRAL, 'mistral-small-latest'),
      MILLION,
      MILLION,
    );
    expect(cost).toBeCloseTo(0.1 + 0.3, 6);
  });

  it('prices codestral-latest at $0.30/$0.90 per 1M tokens', () => {
    const cost = helper.calculateProviderCost(
      providerWith(LlmProviderType.MISTRAL, 'codestral-latest'),
      MILLION,
      MILLION,
    );
    expect(cost).toBeCloseTo(0.3 + 0.9, 6);
  });

  it('prices mistral-embed on input only ($0.10 per 1M tokens)', () => {
    const cost = helper.calculateProviderCost(
      providerWith(LlmProviderType.MISTRAL, 'mistral-embed'),
      MILLION,
      0,
    );
    expect(cost).toBeCloseTo(0.1, 6);
  });

  it('disambiguates the same open model by host (groq vs together)', () => {
    const onGroq = helper.calculateProviderCost(
      providerWith(LlmProviderType.GROQ, 'llama-3.3-70b-versatile'),
      MILLION,
      0,
    );
    const onTogether = helper.calculateProviderCost(
      providerWith(LlmProviderType.TOGETHER, 'llama-3.3-70b-instruct-turbo'),
      MILLION,
      0,
    );
    expect(onGroq).toBeCloseTo(0.59, 6);
    expect(onTogether).toBeCloseTo(0.88, 6);
    expect(onGroq).not.toBeCloseTo(onTogether, 6);
  });

  it('prices vendor models on custom providers via the cross-provider fallback', () => {
    const cost = helper.calculateProviderCost(
      providerWith(LlmProviderType.CUSTOM, 'gpt-4o'),
      MILLION,
      MILLION,
    );
    expect(cost).toBeCloseTo(2.5 + 10, 6);
  });

  it('prefers configured metadata pricing over the default catalog', () => {
    const provider = {
      type: LlmProviderType.MISTRAL,
      configuration: { model: 'mistral-large-latest' },
      metadata: { modelInfo: { inputTokenCost: 0.001, outputTokenCost: 0.002 } },
    } as unknown as LlmProvider;
    const cost = helper.calculateProviderCost(provider, 1000, 1000);
    expect(cost).toBeCloseTo(0.001 + 0.002, 9);
  });

  it('ollama zero-cost: a vendor-named local model is NOT priced via the global fallback', () => {
    // 'mistral-large' pulled locally must cost $0, not Mistral's hosted
    // list price — the OLLAMA short-circuit runs before the fallback scan.
    expect(getDefaultModelPricing('mistral-large', LlmProviderType.OLLAMA)).toBeNull();
    const cost = helper.calculateProviderCost(
      providerWith(LlmProviderType.OLLAMA, 'mistral-large'),
      MILLION,
      MILLION,
    );
    expect(cost).toBe(0);
  });

  it('ollama zero-cost: common local models cost 0', () => {
    for (const model of ['llama3.2', 'qwen3:8b', 'gpt-oss-20b', 'nomic-embed-text']) {
      expect(
        helper.calculateProviderCost(providerWith(LlmProviderType.OLLAMA, model), MILLION, MILLION),
      ).toBe(0);
    }
  });

  it('ollama still honors explicit metadata.modelInfo pricing overrides', () => {
    const provider = {
      type: LlmProviderType.OLLAMA,
      configuration: { model: 'llama3.2' },
      metadata: { modelInfo: { inputTokenCost: 0.0001, outputTokenCost: 0.0002 } },
    } as unknown as LlmProvider;
    expect(helper.calculateProviderCost(provider, 1000, 1000)).toBeCloseTo(0.0003, 9);
  });

  it('returns 0 for unknown models', () => {
    const cost = helper.calculateProviderCost(
      providerWith(LlmProviderType.CUSTOM, 'my-bespoke-model'),
      MILLION,
      MILLION,
    );
    expect(cost).toBe(0);
  });

  it('returns 0 when no model is configured', () => {
    const cost = helper.calculateProviderCost(
      providerWith(LlmProviderType.MISTRAL, ''),
      MILLION,
      MILLION,
    );
    expect(cost).toBe(0);
  });
});
