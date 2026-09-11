import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { COMMON_HEADERS, PROVIDER_PROFILES, profileAuthHeaders, preferredBinding, profileBaseUrl, providerProfile } from '../provider-profile';

/**
 * The safety net for turning vendors into data.
 *
 * A profile is only worth having if it says exactly what the code says. Each
 * profile below is checked against the entity's own `getApiUrl()` and
 * `getAuthHeaders()` for the same configuration, so the switches can be
 * replaced by a lookup with evidence rather than hope. If a profile and the
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

describe('every provider profile matches the code it replaces', () => {
  it.each(PROVIDER_PROFILES.map((p) => [p.key, p] as const))('%s resolves the same base URL', (type, profile) => {
    expect(profileBaseUrl(profile, { apiKey: 'test-key' })).toBe(makeProvider(type).getApiUrl());
  });

  it.each(PROVIDER_PROFILES.map((p) => [p.key, p] as const))('%s sends the same auth headers', (type, profile) => {
    expect(profileAuthHeaders(profile, 'test-key')).toEqual(makeProvider(type).getAuthHeaders());
  });

  it.each(PROVIDER_PROFILES.map((p) => [p.key, p] as const))('%s sends no key material without a key', (type, profile) => {
    // The common headers still go out; nothing key-derived does.
    expect(profileAuthHeaders(profile, undefined)).toEqual(COMMON_HEADERS);
    expect(profileAuthHeaders(profile, undefined)).toEqual(makeProvider(type, { apiKey: undefined }).getAuthHeaders());
  });
});

describe('a quirk is a field, not a reason to exclude a vendor', () => {
  it('picks the base by the field the vendor actually varies on', () => {
    const spark = providerProfile(LlmProviderType.SPARK)!;
    expect(profileBaseUrl(spark, {})).toBe('https://spark-api-open.xf-yun.com/x2');
    expect(profileBaseUrl(spark, { spark: { generation: 'x1.5' } })).toBe('https://spark-api-open.xf-yun.com/v2');
    expect(profileBaseUrl(spark, { spark: { generation: 'legacy' } })).toBe('https://spark-api-open.xf-yun.com/v1');

    const ark = providerProfile(LlmProviderType.VOLCENGINE)!;
    expect(profileBaseUrl(ark, {})).toBe('https://ark.ap-southeast.bytepluses.com/api/v3');
    expect(profileBaseUrl(ark, { ark: { edition: 'mainland' } })).toBe('https://ark.cn-beijing.volces.com/api/v3');
  });

  it('agrees with the entity on a selected base too', () => {
    for (const [type, configuration] of [
      [LlmProviderType.SPARK, { spark: { generation: 'x1.5' } }],
      [LlmProviderType.SPARK, { spark: { generation: 'legacy' } }],
      [LlmProviderType.VOLCENGINE, { ark: { edition: 'mainland' } }],
    ] as const) {
      const profile = providerProfile(type)!;
      expect(profileBaseUrl(profile, { apiKey: 'test-key', ...configuration })).toBe(
        makeProvider(type, configuration).getApiUrl(),
      );
    }
  });


  it('fills a base that embeds the account\'s own region, resource or endpoint', () => {
    // These were switch cases building a template string. Substitution
    // keeps them data, and the entity is the oracle for each.
    for (const [type, configuration] of [
      [LlmProviderType.AWS_BEDROCK, { bedrock: { region: 'eu-west-1' } }],
      [LlmProviderType.AWS_BEDROCK, {}],
      [LlmProviderType.AZURE_AI_FOUNDRY, { azure: { resourceName: 'my-res' } }],
      [LlmProviderType.RUNPOD, { runpod: { endpointId: 'gpt-oss-120b' } }],
    ] as const) {
      const profile = providerProfile(type)!;
      expect(profileBaseUrl(profile, { apiKey: 'test-key', ...configuration })).toBe(
        makeProvider(type, configuration).getApiUrl(),
      );
    }

    expect(profileBaseUrl(providerProfile(LlmProviderType.AWS_BEDROCK)!, { bedrock: { region: 'eu-west-1' } })).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1',
    );
    // The default after || in the placeholder is what fills a missing one.
    expect(profileBaseUrl(providerProfile(LlmProviderType.AWS_BEDROCK)!, {})).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    );
    expect(profileBaseUrl(providerProfile(LlmProviderType.RUNPOD)!, { runpod: { endpointId: 'ep1' } })).toBe(
      'https://api.runpod.ai/v2/ep1/openai/v1',
    );
  });
  it('keeps a stored apiUrl winning, which is how a customer reaches a variant we do not list', () => {
    const profile = providerProfile(LlmProviderType.OPENAI)!;
    expect(profileBaseUrl(profile, { apiUrl: 'https://gateway.internal/v1' })).toBe('https://gateway.internal/v1');
    const spark = providerProfile(LlmProviderType.SPARK)!;
    expect(profileBaseUrl(spark, { apiUrl: 'https://mirror/x2', spark: { generation: 'legacy' } })).toBe('https://mirror/x2');
  });

  it('carries a non-bearer scheme and its extra headers', () => {
    // Anthropic takes the key in x-api-key with a required version header,
    // and OpenRouter is a bearer plus attribution. Both were switch cases.
    expect(profileAuthHeaders(providerProfile(LlmProviderType.ANTHROPIC)!, 'k')).toMatchObject({
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
    });
    expect(profileAuthHeaders(providerProfile(LlmProviderType.GOOGLE)!, 'k')).toMatchObject({ 'x-goog-api-key': 'k' });
    expect(profileAuthHeaders(providerProfile(LlmProviderType.OPENROUTER)!, 'k')).toMatchObject({
      Authorization: 'Bearer k',
      'X-OpenRouter-Title': 'almyty',
    });
  });

  it('records a missing listing as null rather than pretending one exists', () => {
    // Four shipped vendors document no /models. That is a normal answer:
    // the user names the model and a miss is NO_MODEL_CONFIGURED. It was
    // once used as grounds to exclude a vendor, which is why it is stated.
    expect(preferredBinding(providerProfile(LlmProviderType.VOLCENGINE)!).listingPath).toBeNull();
    expect(preferredBinding(providerProfile(LlmProviderType.SPARK)!).listingPath).toBeNull();
    expect(preferredBinding(providerProfile(LlmProviderType.WRITER)!).path).toBe('/chat');
  });
});

describe('the profile set is coherent', () => {
  it('has no duplicate keys and names every vendor it carries', () => {
    const keys = PROVIDER_PROFILES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const profile of PROVIDER_PROFILES) {
      expect(profile.displayName.trim().length).toBeGreaterThan(0);
      expect(profile.blurb.trim().length).toBeGreaterThan(0);
      expect(profile.keyUrl).toMatch(/^https:\/\//);
      expect(profile.docsUrl).toMatch(/^https:\/\//);
      expect(profile.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('gives every vendor at least one protocol, with exactly one preferred', () => {
    for (const profile of PROVIDER_PROFILES) {
      expect(profile.protocols.length).toBeGreaterThan(0);
      const preferred = profile.protocols.filter((b) => b.preferred);
      expect(preferred.length).toBe(1);
      // A vendor never lists the same protocol twice.
      const kinds = profile.protocols.map((b) => b.protocol);
      expect(new Set(kinds).size).toBe(kinds.length);
    }
  });

  it('gives every base and path a usable shape', () => {
    for (const profile of PROVIDER_PROFILES) {
      for (const binding of profile.protocols) {
        expect(binding.baseUrl).toMatch(/^https:\/\//);
        expect(binding.baseUrl.endsWith('/')).toBe(false);
        expect(binding.path.startsWith('/')).toBe(true);
        if (binding.bases) {
          expect(binding.basesField).toBeDefined();
          expect(Object.values(binding.bases)).toContain(binding.baseUrl);
        }
      }
    }
  });
});
