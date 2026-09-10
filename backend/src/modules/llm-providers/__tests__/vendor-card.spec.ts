import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { COMMON_HEADERS, VENDOR_CARDS, cardAuthHeaders, cardBaseUrl, vendorCard } from '../vendor-card';

/**
 * The safety net for turning vendors into data.
 *
 * A card is only worth having if it says exactly what the code says. Each
 * card below is checked against the entity's own `getApiUrl()` and
 * `getAuthHeaders()` for the same configuration, so the switches can be
 * replaced by a lookup with evidence rather than hope. If a card and the
 * switch ever disagree, this fails and names the vendor.
 */
function makeProvider(type: LlmProviderType, configuration: Record<string, unknown> = {}): LlmProvider {
  return Object.assign(new LlmProvider(), {
    id: `p-${type}`,
    organizationId: 'org',
    name: type,
    type,
    configuration: { apiKey: 'test-key', ...configuration },
  });
}

describe('every vendor card matches the code it replaces', () => {
  it.each(VENDOR_CARDS.map((c) => [c.key, c] as const))('%s resolves the same base URL', (type, card) => {
    expect(cardBaseUrl(card, { apiKey: 'test-key' })).toBe(makeProvider(type).getApiUrl());
  });

  it.each(VENDOR_CARDS.map((c) => [c.key, c] as const))('%s sends the same auth headers', (type, card) => {
    expect(cardAuthHeaders(card, 'test-key')).toEqual(makeProvider(type).getAuthHeaders());
  });

  it.each(VENDOR_CARDS.map((c) => [c.key, c] as const))('%s sends no key material without a key', (type, card) => {
    // The common headers still go out; nothing key-derived does.
    expect(cardAuthHeaders(card, undefined)).toEqual(COMMON_HEADERS);
    expect(cardAuthHeaders(card, undefined)).toEqual(makeProvider(type, { apiKey: undefined }).getAuthHeaders());
  });
});

describe('a quirk is a field, not a reason to exclude a vendor', () => {
  it('picks the base by the field the vendor actually varies on', () => {
    const spark = vendorCard(LlmProviderType.SPARK)!;
    expect(cardBaseUrl(spark, {})).toBe('https://spark-api-open.xf-yun.com/x2');
    expect(cardBaseUrl(spark, { spark: { generation: 'x1.5' } })).toBe('https://spark-api-open.xf-yun.com/v2');
    expect(cardBaseUrl(spark, { spark: { generation: 'legacy' } })).toBe('https://spark-api-open.xf-yun.com/v1');

    const ark = vendorCard(LlmProviderType.VOLCENGINE)!;
    expect(cardBaseUrl(ark, {})).toBe('https://ark.ap-southeast.bytepluses.com/api/v3');
    expect(cardBaseUrl(ark, { ark: { edition: 'mainland' } })).toBe('https://ark.cn-beijing.volces.com/api/v3');
  });

  it('agrees with the entity on a selected base too', () => {
    for (const [type, configuration] of [
      [LlmProviderType.SPARK, { spark: { generation: 'x1.5' } }],
      [LlmProviderType.SPARK, { spark: { generation: 'legacy' } }],
      [LlmProviderType.VOLCENGINE, { ark: { edition: 'mainland' } }],
    ] as const) {
      const card = vendorCard(type)!;
      expect(cardBaseUrl(card, { apiKey: 'test-key', ...configuration })).toBe(
        makeProvider(type, configuration).getApiUrl(),
      );
    }
  });

  it('keeps a stored apiUrl winning, which is how a customer reaches a variant we do not list', () => {
    const card = vendorCard(LlmProviderType.OPENAI)!;
    expect(cardBaseUrl(card, { apiUrl: 'https://gateway.internal/v1' })).toBe('https://gateway.internal/v1');
    const spark = vendorCard(LlmProviderType.SPARK)!;
    expect(cardBaseUrl(spark, { apiUrl: 'https://mirror/x2', spark: { generation: 'legacy' } })).toBe('https://mirror/x2');
  });

  it('carries a non-bearer scheme and its extra headers', () => {
    // Anthropic takes the key in x-api-key with a required version header,
    // and OpenRouter is a bearer plus attribution. Both were switch cases.
    expect(cardAuthHeaders(vendorCard(LlmProviderType.ANTHROPIC)!, 'k')).toMatchObject({
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
    });
    expect(cardAuthHeaders(vendorCard(LlmProviderType.GOOGLE)!, 'k')).toMatchObject({ 'x-goog-api-key': 'k' });
    expect(cardAuthHeaders(vendorCard(LlmProviderType.OPENROUTER)!, 'k')).toMatchObject({
      Authorization: 'Bearer k',
      'X-OpenRouter-Title': 'almyty',
    });
  });

  it('records a missing listing as null rather than pretending one exists', () => {
    // Four shipped vendors document no /models. That is a normal answer:
    // the user names the model and a miss is NO_MODEL_CONFIGURED. It was
    // once used as grounds to exclude a vendor, which is why it is stated.
    expect(vendorCard(LlmProviderType.VOLCENGINE)!.listingPath).toBeNull();
    expect(vendorCard(LlmProviderType.SPARK)!.listingPath).toBeNull();
    expect(vendorCard(LlmProviderType.WRITER)!.chatPath).toBe('/chat');
  });
});

describe('the card set is coherent', () => {
  it('has no duplicate keys and names every vendor it carries', () => {
    const keys = VENDOR_CARDS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const card of VENDOR_CARDS) {
      expect(card.displayName.trim().length).toBeGreaterThan(0);
      expect(card.blurb.trim().length).toBeGreaterThan(0);
      expect(card.keyUrl).toMatch(/^https:\/\//);
      expect(card.docsUrl).toMatch(/^https:\/\//);
      expect(card.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('gives every base and chat path a usable shape', () => {
    for (const card of VENDOR_CARDS) {
      expect(card.baseUrl).toMatch(/^https:\/\//);
      expect(card.baseUrl.endsWith('/')).toBe(false);
      expect(card.chatPath.startsWith('/')).toBe(true);
      if (card.bases) {
        expect(card.basesField).toBeDefined();
        expect(Object.values(card.bases)).toContain(card.baseUrl);
      }
    }
  });
});
