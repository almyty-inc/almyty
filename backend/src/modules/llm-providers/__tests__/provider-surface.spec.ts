// eslint-disable-next-line @typescript-eslint/no-var-requires
const baseline = require('./provider-surface.baseline.json');
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { LlmProviderType } from '../../../entities/llm-provider-type';

/**
 * The regression net for moving vendors from switch statements into the
 * provider profile registry.
 *
 * `provider-profile.spec.ts` compared each profile against the entity's
 * own switches, which was the right check while the switches were still
 * the implementation. The moment the entity started reading profiles that
 * comparison became tautological, so it cannot be what guards the swap.
 *
 * This file is the guard instead. The baseline JSON was generated from the
 * entity BEFORE the swap, so it records what every provider type actually
 * resolved to. Any change to a base URL or an auth header for any of the
 * 38 types, on any of the nine configurations, fails here and names the
 * vendor.
 *
 * Regenerating the baseline to make this pass is almost always wrong. If a
 * vendor's surface genuinely changed, change the entry deliberately and
 * say why in the commit, with a dated source.
 */
const CONFIGS: Record<string, Record<string, unknown>> = {
  plain: {},
  bedrockRegion: { bedrock: { region: 'eu-west-1' } },
  azureRes: { azure: { resourceName: 'my-res', deploymentName: 'dep' } },
  runpodEp: { runpod: { endpointId: 'ep1' } },
  vertexProj: { vertex: { projectId: 'proj' } },
  sparkLegacy: { spark: { generation: 'legacy' } },
  sparkX15: { spark: { generation: 'x1.5' } },
  arkMainland: { ark: { edition: 'mainland' } },
  hfEndpoint: { huggingface: { endpoint: 'https://x.endpoints.huggingface.cloud' } },
  // Anthropic's version header is customer-pinnable. A profile that
  // hardcoded it dropped the override silently, which is why it is here.
  apiVersion: { apiVersion: '2024-01-01' },
};

const surface = baseline as unknown as Record<string, Record<string, { url: string; headers: Record<string, string> }>>;

function makeProvider(type: LlmProviderType, extra: Record<string, unknown>): LlmProvider {
  return Object.assign(new LlmProvider(), {
    organizationId: 'org',
    type,
    configuration: { apiKey: 'test-key', ...extra },
  });
}

describe('the provider surface is unchanged by the move to profiles', () => {
  const types = Object.values(LlmProviderType);

  it('covers every provider type, so a new one cannot slip past unrecorded', () => {
    expect(Object.keys(surface).filter((k) => k !== 'default').sort()).toEqual([...types].sort());
  });

  it.each(Object.values(LlmProviderType))('%s resolves the same base URL on every configuration', (type) => {
    for (const [name, extra] of Object.entries(CONFIGS)) {
      expect(`${name}: ${makeProvider(type, extra).getApiUrl()}`).toBe(`${name}: ${surface[type][name].url}`);
    }
  });

  it.each(Object.values(LlmProviderType))('%s sends the same auth headers on every configuration', (type) => {
    for (const [name, extra] of Object.entries(CONFIGS)) {
      expect({ [name]: makeProvider(type, extra).getAuthHeaders() }).toEqual({ [name]: surface[type][name].headers });
    }
  });

  it('still sends no key material when there is no key', () => {
    for (const type of types) {
      const headers = Object.assign(new LlmProvider(), {
        organizationId: 'org', type, configuration: {},
      }).getAuthHeaders();
      expect(JSON.stringify(headers)).not.toContain('test-key');
    }
  });
});
