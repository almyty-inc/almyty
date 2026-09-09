import { EndpointProviderHelper } from '../endpoint-provider.helper';
import { LlmChatRunnerHelper } from '../llm-chat-runner.helper';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../../entities/llm-provider.entity';

jest.mock('../providers/safe-request', () => ({
  ...jest.requireActual('../providers/safe-request'),
  callLlmProviderHttp: jest.fn(),
}));
const { callLlmProviderHttp } = require('../providers/safe-request');

/**
 * The boundary a routed endpoint card actually crosses: the URL the
 * request is POSTed to, the Authorization header on it, and the body.
 * Asserting provider.configuration is not enough, that is what let a card
 * POST chat messages at the bare base URL.
 */
describe('an endpoint-backed card dispatches like an OpenAI-compatible server', () => {
  const provider = (over: Partial<LlmProvider> = {}) =>
    Object.assign(new LlmProvider(), {
      id: 'p-endpoint',
      organizationId: 'org',
      name: 'deployed llama',
      type: LlmProviderType.OPENAI,
      status: LlmProviderStatus.ACTIVE,
      isHealthy: true,
      configuration: { apiUrl: 'https://ep.example/v1', model: 'my-llama', apiKey: 'sk-endpoint' },
      ...over,
    });

  const runner = () =>
    new LlmChatRunnerHelper(
      {} as any,
      {} as any,
      { calculateProviderCost: jest.fn().mockReturnValue(0) } as any,
      { warmOrg: jest.fn().mockResolvedValue(undefined) } as any,
      { resolve: jest.fn(), invalidate: jest.fn() } as any,
    );

  beforeEach(() => {
    callLlmProviderHttp.mockReset();
    callLlmProviderHttp.mockResolvedValue({
      data: { choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, model: 'my-llama' },
    });
  });

  it('posts to <base>/chat/completions with the bearer key and the requested model', async () => {
    const session = { id: 'conv-1', organizationId: 'org', context: {} } as any;
    await runner().callWithRetries(provider(), { messages: [{ role: 'user', content: 'hello' } as any], model: 'my-llama' }, session, []);

    expect(callLlmProviderHttp).toHaveBeenCalledTimes(1);
    const [config] = callLlmProviderHttp.mock.calls[0];
    expect(config.url).toBe('https://ep.example/v1/chat/completions');
    expect(config.method).toBe('POST');
    expect(config.headers.Authorization).toBe('Bearer sk-endpoint');
    expect(config.data).toMatchObject({ model: 'my-llama', messages: [{ role: 'user', content: 'hello' }] });
  });

  it('a private endpoint is allowed only when the deployment says so', async () => {
    const saved = process.env.LLM_ALLOW_PRIVATE_URLS;
    delete process.env.LLM_ALLOW_PRIVATE_URLS;
    const session = { id: 'conv-1', organizationId: 'org', context: {} } as any;
    await runner().callWithRetries(provider(), { messages: [], model: 'my-llama' }, session, []);
    const [, opts] = callLlmProviderHttp.mock.calls[0];
    // An openai-typed row is a public host by default; the escape hatch is
    // the custom type, which is what a LAN box is registered as.
    expect(opts?.allowPrivateUrls).toBe(false);
    if (saved === undefined) delete process.env.LLM_ALLOW_PRIVATE_URLS;
    else process.env.LLM_ALLOW_PRIVATE_URLS = saved;
  });

  describe('the base an adapter URL maps to', () => {
    it('keeps a URL that already carries the OpenAI surface', () => {
      expect(EndpointProviderHelper.baseFor('https://ep.example/v1')).toBe('https://ep.example/v1');
      expect(EndpointProviderHelper.baseFor('https://ep.example/v1/')).toBe('https://ep.example/v1');
      expect(EndpointProviderHelper.baseFor('https://api.fireworks.ai/inference/v1')).toBe('https://api.fireworks.ai/inference/v1');
    });

    it('appends /v1 to an endpoint root, which is where every vLLM and TGI server serves it', () => {
      expect(EndpointProviderHelper.baseFor('https://abc.endpoints.huggingface.cloud')).toBe('https://abc.endpoints.huggingface.cloud/v1');
      expect(EndpointProviderHelper.baseFor('https://ws--app-fn.modal.run')).toBe('https://ws--app-fn.modal.run/v1');
    });

    it('an adapter that knows its base is believed', () => {
      expect(EndpointProviderHelper.baseFor('https://abc.endpoints.huggingface.cloud', 'https://abc.endpoints.huggingface.cloud/v1')).toBe('https://abc.endpoints.huggingface.cloud/v1');
    });
  });
});
