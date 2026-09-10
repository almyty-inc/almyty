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
    // DeepInfra documents the OpenAI-shaped listing one segment ABOVE its
    // chat base, so this is deliberately not `<chat base>/models`.
    [LlmProviderType.DEEPINFRA, 'https://api.deepinfra.com/v1/models'],
    [LlmProviderType.NOVITA, 'https://api.novita.ai/openai/v1/models'],
    [LlmProviderType.PERPLEXITY, 'https://api.perplexity.ai/v1/models'],
    [LlmProviderType.ZAI, 'https://api.z.ai/api/paas/v4/models'],
    [LlmProviderType.BASETEN, 'https://inference.baseten.co/v1/models'],
    [LlmProviderType.NEBIUS, 'https://api.tokenfactory.nebius.com/v1/models'],
    [LlmProviderType.SAMBANOVA, 'https://api.sambanova.ai/v1/models'],
    // Bedrock's OpenAI surface lists with the same bearer key as chat - no
    // SigV4 and no control-plane host.
    [LlmProviderType.AWS_BEDROCK, 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/models'],
    // Cohere chats on /compatibility/v1 but documents its listing only on
    // the native host.
    [LlmProviderType.COHERE, 'https://api.cohere.com/v1/models'],
    [LlmProviderType.HUGGINGFACE, 'https://router.huggingface.co/v1/models'],
  ])('%s lists models from its documented listing URL with a Bearer key', async (type, expectedUrl) => {
    const provider = makeProvider(type);
    const models = await helper.fetchModelsFromProvider(provider);
    const cfg = (callLlmProviderHttp as jest.Mock).mock.calls[0][0];
    expect(cfg.url).toBe(expectedUrl);
    expect(cfg.headers.Authorization).toBe('Bearer test-key');
    expect(models.map((m) => m.id)).toEqual(['codestral-latest']);
  });

  it('sends the Azure API key in api-key, not Authorization', async () => {
    const provider = makeProvider(LlmProviderType.AZURE_OPENAI);
    (provider.configuration as any).azure = { resourceName: 'res', deploymentName: 'dep' };
    await helper.fetchModelsFromProvider(provider);
    const cfg = (callLlmProviderHttp as jest.Mock).mock.calls[0][0];
    expect(cfg.url).toBe('https://res.openai.azure.com/openai/v1/models');
    expect(cfg.headers['api-key']).toBe('test-key');
    expect(cfg.headers.Authorization).toBeUndefined();
  });

  it('a configured apiUrl steps over the documented listing override', async () => {
    const provider = makeProvider(LlmProviderType.DEEPINFRA);
    (provider.configuration as any).apiUrl = 'https://proxy.example/v1';
    await helper.fetchModelsFromProvider(provider);
    expect((callLlmProviderHttp as jest.Mock).mock.calls[0][0].url).toBe('https://proxy.example/v1/models');
  });

  it('reads a bare-array listing (Together) and a {models:[...]} listing (Cohere)', async () => {
    (callLlmProviderHttp as jest.Mock).mockResolvedValue({ data: [{ id: 'moonshotai/Kimi-K2-Instruct' }] });
    const together = await helper.fetchModelsFromProvider(makeProvider(LlmProviderType.TOGETHER));
    expect(together.map((m) => m.id)).toEqual(['moonshotai/Kimi-K2-Instruct']);

    (callLlmProviderHttp as jest.Mock).mockResolvedValue({ data: { models: [{ name: 'command-a-03-2025' }] } });
    const cohere = await helper.fetchModelsFromProvider(makeProvider(LlmProviderType.COHERE));
    expect(cohere.map((m) => m.id)).toEqual(['command-a-03-2025']);
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
    // Z.ai documents no /models at all. The rejection reaches the caller:
    // /test-connection turns it into ok:false, DefaultModelResolver into
    // NO_MODEL_CONFIGURED. Never a guessed model id.
    (callLlmProviderHttp as jest.Mock).mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }));
    const provider = makeProvider(LlmProviderType.ZAI);
    await expect(helper.fetchModelsFromProvider(provider)).rejects.toThrow('status code 404');
    expect((callLlmProviderHttp as jest.Mock).mock.calls[0][0].url).toBe('https://api.z.ai/api/paas/v4/models');
  });

  it('reads a Writer model list by id, because its name field is a display label', async () => {
    // Writer answers {models:[{id,name}]} where name is "Palmyra X5".
    // Cohere and Google use the same envelope but put the identifier in
    // name, so the parser prefers id and falls back to name. Taking name
    // first would fill the catalog with labels that 404 on every call.
    (callLlmProviderHttp as jest.Mock).mockResolvedValue({
      data: { models: [{ id: 'palmyra-x5', name: 'Palmyra X5' }, { id: 'palmyra-x6', name: 'Palmyra X6' }] },
    });
    const models = await helper.fetchModelsFromProvider(makeProvider(LlmProviderType.WRITER));
    expect(models.map((m: any) => m.id)).toEqual(expect.arrayContaining(['palmyra-x5', 'palmyra-x6']));
    expect(JSON.stringify(models)).not.toContain('Palmyra X5');
  });

  it('still reads a Cohere-style list, where the identifier is the name', async () => {
    (callLlmProviderHttp as jest.Mock).mockResolvedValue({ data: { models: [{ name: 'command-r-plus' }] } });
    const models = await helper.fetchModelsFromProvider(makeProvider(LlmProviderType.COHERE));
    expect(models.map((m: any) => m.id)).toEqual(['command-r-plus']);
  });

  it('sends the models call to each new vendor, not to OpenAI', async () => {
    for (const [type, url] of [
      [LlmProviderType.MINIMAX, 'https://api.minimax.io/v1/models'],
      [LlmProviderType.UPSTAGE, 'https://api.upstage.ai/v1/models'],
      [LlmProviderType.WRITER, 'https://api.writer.com/v1/models'],
    ] as const) {
      (callLlmProviderHttp as jest.Mock).mockClear();
      (callLlmProviderHttp as jest.Mock).mockResolvedValue({ data: { data: [{ id: 'x' }] } });
      await helper.fetchModelsFromProvider(makeProvider(type));
      expect((callLlmProviderHttp as jest.Mock).mock.calls[0][0].url).toBe(url);
    }
  });
});
