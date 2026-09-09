import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { LlmChatRunnerHelper } from '../llm-chat-runner.helper';
import { LlmModelsHelper } from '../llm-models.helper';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { callOpenAI } from '../providers/openai.provider';

jest.mock('../providers/openai.provider', () => ({
  callOpenAI: jest.fn(),
  callOpenAIStream: jest.fn(),
}));

/**
 * The OpenAI-compatible inference hosts added in 2026-09 (Fireworks,
 * Cerebras, DeepInfra, Novita, Perplexity, Z.ai, Baseten, Nebius,
 * SambaNova) ride the exact same path as xAI/DeepSeek/Groq/Together:
 * vendor base URL, Bearer key, OpenAI chat dispatch, tool + stream flags.
 * Verified endpoints are recorded in docs/design/call-only-vendors.md.
 */
const VENDOR_BASES: Array<[LlmProviderType, string]> = [
  [LlmProviderType.FIREWORKS, 'https://api.fireworks.ai/inference/v1'],
  [LlmProviderType.CEREBRAS, 'https://api.cerebras.ai/v1'],
  [LlmProviderType.DEEPINFRA, 'https://api.deepinfra.com/v1/openai'],
  [LlmProviderType.NOVITA, 'https://api.novita.ai/openai'],
  [LlmProviderType.PERPLEXITY, 'https://api.perplexity.ai/router/v1'],
  [LlmProviderType.ZAI, 'https://api.z.ai/api/paas/v4'],
  [LlmProviderType.BASETEN, 'https://inference.baseten.co/v1'],
  [LlmProviderType.NEBIUS, 'https://api.tokenfactory.nebius.com/v1'],
  [LlmProviderType.SAMBANOVA, 'https://api.sambanova.ai/v1'],
];

function makeProvider(type: LlmProviderType, configuration: Record<string, unknown> = { apiKey: 'test-key' }): LlmProvider {
  return Object.assign(new LlmProvider(), {
    id: `p-${type}`,
    organizationId: 'org',
    name: type,
    type,
    configuration,
  });
}

describe('OpenAI-compatible inference hosts', () => {
  const modelsHelper = new LlmModelsHelper(makeEnvelopeCryptoMock());

  it('enumerates the nine new types under stable string values', () => {
    expect(VENDOR_BASES.map(([type]) => type)).toEqual([
      'fireworks', 'cerebras', 'deepinfra', 'novita', 'perplexity', 'zai', 'baseten', 'nebius', 'sambanova',
    ]);
    for (const [type] of VENDOR_BASES) expect(Object.values(LlmProviderType)).toContain(type);
  });

  it.each(VENDOR_BASES)('%s resolves its vendor base URL, overridable per provider', (type, base) => {
    expect(makeProvider(type).getApiUrl()).toBe(base);
    expect(makeProvider(type, { apiKey: 'k', apiUrl: 'https://proxy.example/v1' }).getApiUrl()).toBe('https://proxy.example/v1');
  });

  it.each(VENDOR_BASES)('%s authenticates with a plain Bearer key', (type) => {
    expect(makeProvider(type).getAuthHeaders()).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(makeProvider(type, {}).getAuthHeaders().Authorization).toBeUndefined();
  });

  it.each(VENDOR_BASES)('%s requires an API key at save time', (type) => {
    const runner = new LlmChatRunnerHelper({} as any, {} as any, modelsHelper, { warmOrg: jest.fn() } as any, { resolve: jest.fn(), invalidate: jest.fn() } as any);
    expect(() => runner.validateProviderConfiguration(type, {})).toThrow(/requires an API key/);
    expect(() => runner.validateProviderConfiguration(type, { apiKey: 'k' })).not.toThrow();
  });

  it('flags tool calling and streaming on the OpenAI tool format, except Perplexity which only streams', () => {
    for (const [type] of VENDOR_BASES) {
      const caps = modelsHelper.getDefaultCapabilities(type);
      expect(caps.supportsStreaming).toBe(true);
      expect(caps.supportedModels).toEqual([]);
      if (type === LlmProviderType.PERPLEXITY) {
        expect(caps.supportsToolUse).toBe(false);
        expect(caps.supportedToolFormats).toEqual([]);
      } else {
        expect(caps.supportsToolUse).toBe(true);
        expect(caps.supportsFunctionCalling).toBe(true);
        expect(caps.supportedToolFormats).toEqual(['openai']);
      }
    }
  });

  it.each(VENDOR_BASES)('%s dispatches through the OpenAI chat path', async (type) => {
    (callOpenAI as jest.Mock).mockReset().mockResolvedValue({ message: { role: 'assistant', content: 'ok' }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: 0, model: 'm' });
    const runner = new LlmChatRunnerHelper({} as any, {} as any, modelsHelper, { warmOrg: jest.fn() } as any, { resolve: jest.fn(), invalidate: jest.fn() } as any);
    const provider = makeProvider(type);
    const session = { id: 'conv', organizationId: 'org' } as any;
    const res = await runner.dispatchProviderCall(provider, { messages: [], model: 'm' }, session, [], Date.now());
    expect(res.message.content).toBe('ok');
    expect(callOpenAI).toHaveBeenCalledTimes(1);
    expect((callOpenAI as jest.Mock).mock.calls[0][0]).toBe(provider);
  });
});
