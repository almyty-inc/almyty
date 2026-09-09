import { LlmProviderType } from '../../../entities/llm-provider.entity';
import {
  getProviderKeyUrl,
  getProviderDocsUrl,
  getProviderDisplayName,
} from '../llm-provider-catalog';

const ALL_TYPES = Object.values(LlmProviderType);

describe('llm-provider-catalog key/docs URLs', () => {
  it('maps every provider type (string | null, never undefined)', () => {
    // The whole point of the three-valued contract: an unmapped provider
    // returns undefined. If someone adds an enum value without a mapping,
    // this fails instead of silently shipping a provider with no help link.
    for (const type of ALL_TYPES) {
      expect(getProviderKeyUrl(type)).not.toBeUndefined();
      expect(getProviderDocsUrl(type)).not.toBeUndefined();
    }
  });

  it('returns valid https URLs wherever a mapping exists', () => {
    for (const type of ALL_TYPES) {
      for (const url of [getProviderKeyUrl(type), getProviderDocsUrl(type)]) {
        if (url == null) continue;
        expect(url).toMatch(/^https:\/\/\S+$/);
        // must actually parse as a URL
        expect(() => new URL(url)).not.toThrow();
      }
    }
  });

  it('deep-links known providers to their real key pages', () => {
    expect(getProviderKeyUrl(LlmProviderType.OPENAI)).toBe(
      'https://platform.openai.com/api-keys',
    );
    expect(getProviderKeyUrl(LlmProviderType.ANTHROPIC)).toBe(
      'https://console.anthropic.com/settings/keys',
    );
    expect(getProviderKeyUrl(LlmProviderType.GOOGLE)).toBe(
      'https://aistudio.google.com/apikey',
    );
  });

  it('has no canonical key/docs URL for CUSTOM (user-defined endpoint)', () => {
    expect(getProviderKeyUrl(LlmProviderType.CUSTOM)).toBeNull();
    expect(getProviderDocsUrl(LlmProviderType.CUSTOM)).toBeNull();
  });

  it('ollama links the CLOUD key page (local mode is keyless) and docs at ollama.com', () => {
    expect(getProviderKeyUrl(LlmProviderType.OLLAMA)).toBe('https://ollama.com/settings/keys');
    expect(getProviderDocsUrl(LlmProviderType.OLLAMA)).toBe('https://ollama.com');
    expect(getProviderDisplayName(LlmProviderType.OLLAMA)).toBe('Ollama');
  });

  it('maps the OpenAI-compatible inference hosts to their consoles and docs (verified 2026-09-08)', () => {
    const expected: Array<[LlmProviderType, string, string, string]> = [
      [LlmProviderType.FIREWORKS, 'Fireworks AI', 'https://app.fireworks.ai/settings/users/api-keys', 'https://docs.fireworks.ai'],
      [LlmProviderType.CEREBRAS, 'Cerebras', 'https://cloud.cerebras.ai', 'https://inference-docs.cerebras.ai'],
      [LlmProviderType.DEEPINFRA, 'DeepInfra', 'https://deepinfra.com/dash/api_keys', 'https://docs.deepinfra.com'],
      [LlmProviderType.NOVITA, 'Novita', 'https://novita.ai/settings/key-management', 'https://docs.novita.ai'],
      [LlmProviderType.PERPLEXITY, 'Perplexity', 'https://console.perplexity.ai', 'https://docs.perplexity.ai'],
      [LlmProviderType.ZAI, 'Z.ai', 'https://z.ai/manage-apikey/apikey-list', 'https://docs.z.ai'],
      [LlmProviderType.BASETEN, 'Baseten', 'https://app.baseten.co/settings/api_keys', 'https://docs.baseten.co'],
      [LlmProviderType.NEBIUS, 'Nebius Token Factory', 'https://tokenfactory.nebius.com/settings/api-keys', 'https://docs.tokenfactory.nebius.com'],
      [LlmProviderType.SAMBANOVA, 'SambaNova', 'https://cloud.sambanova.ai/apis', 'https://docs.sambanova.ai'],
    ];
    for (const [type, name, keyUrl, docsUrl] of expected) {
      expect(getProviderDisplayName(type)).toBe(name);
      expect(getProviderKeyUrl(type)).toBe(keyUrl);
      expect(getProviderDocsUrl(type)).toBe(docsUrl);
    }
  });

  it('still resolves a display name for every type (sanity)', () => {
    for (const type of ALL_TYPES) {
      expect(getProviderDisplayName(type)).toBeTruthy();
    }
  });
});
