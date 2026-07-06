import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { LlmModelsHelper } from '../llm-models.helper';

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
  const helper = new LlmModelsHelper();

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
});
