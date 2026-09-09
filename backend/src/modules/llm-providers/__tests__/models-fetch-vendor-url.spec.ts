import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { LlmModelsHelper } from '../llm-models.helper';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';

jest.mock('../providers/safe-request', () => ({
  callLlmProviderHttp: jest.fn(),
  callLlmProviderHttpStream: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { callLlmProviderHttp } = require('../providers/safe-request');

/**
 * Regression: fetchOpenAIModels defaulted its base URL to api.openai.com for
 * ANY provider lacking a custom apiUrl, so every OpenAI-compatible vendor's
 * stored-provider models call (mistral/xai/deepseek/groq/together/openrouter)
 * 401'd AND sent that vendor's API key to OpenAI. Found live on staging: a
 * healthy Mistral provider whose /models call failed with 401.
 */
describe('fetchOpenAIModels vendor URL resolution', () => {
  const helper = new LlmModelsHelper(makeEnvelopeCryptoMock());

  const makeProvider = (type: LlmProviderType): LlmProvider => {
    const p = new LlmProvider();
    p.type = type;
    p.configuration = { apiKey: 'test-key' } as any;
    return p;
  };

  beforeEach(() => {
    (callLlmProviderHttp as jest.Mock).mockReset();
    (callLlmProviderHttp as jest.Mock).mockResolvedValue({ data: { data: [{ id: 'codestral-latest' }] } });
  });

  it.each([
    [LlmProviderType.MISTRAL, 'https://api.mistral.ai/v1/models'],
    [LlmProviderType.OPENAI, 'https://api.openai.com/v1/models'],
  ])('%s models call goes to its own vendor', async (type, expectedUrl) => {
    const provider = makeProvider(type);
    await helper.fetchModelsFromProvider(provider);
    const cfg = (callLlmProviderHttp as jest.Mock).mock.calls[0][0];
    expect(cfg.url).toBe(expectedUrl);
  });

  it('a custom apiUrl still wins', async () => {
    const provider = makeProvider(LlmProviderType.MISTRAL);
    (provider.configuration as any).apiUrl = 'https://mistral.internal.example/v1';
    await helper.fetchModelsFromProvider(provider);
    const cfg = (callLlmProviderHttp as jest.Mock).mock.calls[0][0];
    expect(cfg.url).toBe('https://mistral.internal.example/v1/models');
  });

  it.each([
    [LlmProviderType.FIREWORKS, 'https://api.fireworks.ai/inference/v1/models'],
    [LlmProviderType.CEREBRAS, 'https://api.cerebras.ai/v1/models'],
    [LlmProviderType.DEEPINFRA, 'https://api.deepinfra.com/v1/openai/models'],
    [LlmProviderType.NOVITA, 'https://api.novita.ai/openai/models'],
    [LlmProviderType.PERPLEXITY, 'https://api.perplexity.ai/router/v1/models'],
    [LlmProviderType.ZAI, 'https://api.z.ai/api/paas/v4/models'],
    [LlmProviderType.BASETEN, 'https://inference.baseten.co/v1/models'],
    [LlmProviderType.NEBIUS, 'https://api.tokenfactory.nebius.com/v1/models'],
    [LlmProviderType.SAMBANOVA, 'https://api.sambanova.ai/v1/models'],
  ])('%s lists models from its own OpenAI-compatible base with a Bearer key', async (type, expectedUrl) => {
    const provider = makeProvider(type);
    const models = await helper.fetchModelsFromProvider(provider);
    const cfg = (callLlmProviderHttp as jest.Mock).mock.calls[0][0];
    expect(cfg.url).toBe(expectedUrl);
    expect(cfg.headers.Authorization).toBe('Bearer test-key');
    expect(models.map((m) => m.id)).toEqual(['codestral-latest']);
  });

  it('keeps host-namespaced ids verbatim (Fireworks accounts/... and org/model ids)', async () => {
    (callLlmProviderHttp as jest.Mock).mockResolvedValue({
      data: { data: [
        { id: 'accounts/fireworks/models/llama-v3p1-70b-instruct', created: 2 },
        { id: 'accounts/fireworks/models/nomic-embed-text-v1', created: 1 },
      ] },
    });
    const models = await helper.fetchModelsFromProvider(makeProvider(LlmProviderType.FIREWORKS));
    expect(models.map((m) => m.id)).toEqual(['accounts/fireworks/models/llama-v3p1-70b-instruct']);
  });

  it('surfaces a failed listing on a base without /models (same contract as every type; the resolver maps it)', async () => {
    // Perplexity's legacy Sonar base (https://api.perplexity.ai) has no
    // /models. The rejection reaches the caller: /test-connection turns it
    // into ok:false, DefaultModelResolver into NO_MODEL_CONFIGURED.
    (callLlmProviderHttp as jest.Mock).mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }));
    const provider = makeProvider(LlmProviderType.PERPLEXITY);
    (provider.configuration as any).apiUrl = 'https://api.perplexity.ai';
    await expect(helper.fetchModelsFromProvider(provider)).rejects.toThrow('status code 404');
    expect((callLlmProviderHttp as jest.Mock).mock.calls[0][0].url).toBe('https://api.perplexity.ai/models');
  });
});
