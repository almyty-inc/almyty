import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { MessageRole } from '../../../entities/message.entity';

jest.mock('../providers/safe-request', () => {
  const actual = jest.requireActual('../providers/safe-request');
  return { ...actual, callLlmProviderHttp: jest.fn() };
});

import { callLlmProviderHttp } from '../providers/safe-request';
import { callCustomProvider, customChatUrl } from '../providers/google.provider';
import { LlmChatRunnerHelper } from '../llm-chat-runner.helper';
import { LlmModelsHelper } from '../llm-models.helper';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';

/**
 * A server you run is a `custom` inference provider pointed at its
 * OpenAI-compatible base. Two things have to hold for it to answer: the
 * chat request goes to <base>/chat/completions (the same base the model
 * list is read from), and LLM_ALLOW_PRIVATE_URLS reaches the call, since
 * such a server is usually on the org's own network.
 */
describe('calling a custom inference provider', () => {
  const saved = process.env.LLM_ALLOW_PRIVATE_URLS;
  afterEach(() => {
    if (saved === undefined) delete process.env.LLM_ALLOW_PRIVATE_URLS;
    else process.env.LLM_ALLOW_PRIVATE_URLS = saved;
    jest.mocked(callLlmProviderHttp).mockReset();
  });

  const provider = (apiUrl: string) =>
    Object.assign(new LlmProvider(), {
      id: 'p-box',
      type: LlmProviderType.CUSTOM,
      configuration: { apiUrl, model: 'qwen3-14b' },
    });

  it('sends an OpenAI-format call to <base>/chat/completions', () => {
    expect(customChatUrl('http://10.0.0.5:8000/v1', 'openai')).toBe('http://10.0.0.5:8000/v1/chat/completions');
    expect(customChatUrl('http://10.0.0.5:8000/v1/', 'openai')).toBe('http://10.0.0.5:8000/v1/chat/completions');
    expect(customChatUrl('http://h/v1/chat/completions', 'openai')).toBe('http://h/v1/chat/completions');
    expect(customChatUrl('http://h/generate', 'custom')).toBe('http://h/generate');
  });

  it('passes the private-URL escape hatch to the request, and posts to the chat endpoint', async () => {
    process.env.LLM_ALLOW_PRIVATE_URLS = 'true';
    jest.mocked(callLlmProviderHttp).mockResolvedValue({
      data: { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    } as any);

    const result = await callCustomProvider(
      provider('http://10.0.0.5:8000/v1'),
      { messages: [{ role: MessageRole.USER, content: 'ping' }] } as any,
      { id: 's', context: {} } as any,
      [],
      Date.now(),
    );

    expect(result.message.content).toBe('OK');
    const [config, opts] = jest.mocked(callLlmProviderHttp).mock.calls[0];
    expect(config.url).toBe('http://10.0.0.5:8000/v1/chat/completions');
    expect(opts).toEqual(expect.objectContaining({ allowPrivateUrls: true }));
  });

  it('keeps private URLs closed when the operator has not opened them', async () => {
    delete process.env.LLM_ALLOW_PRIVATE_URLS;
    jest.mocked(callLlmProviderHttp).mockResolvedValue({ data: { choices: [{ message: { content: 'OK' } }] } } as any);
    await callCustomProvider(provider('https://llm.example.com/v1'), { messages: [{ role: MessageRole.USER, content: 'ping' }] } as any, { id: 's', context: {} } as any, [], Date.now());
    const [, opts] = jest.mocked(callLlmProviderHttp).mock.calls[0];
    expect(opts?.allowPrivateUrls).toBe(false);
  });

  it('offers an agent its tools and reads the tool call back (OpenAI format)', async () => {
    jest.mocked(callLlmProviderHttp).mockResolvedValue({
      data: {
        model: 'qwen3-14b',
        choices: [{
          message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_forecast', arguments: '{"city":"Lisbon"}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
    } as any);
    const runner = new LlmChatRunnerHelper(
      {} as any,
      {} as any,
      new LlmModelsHelper(makeEnvelopeCryptoMock()),
      { warmOrg: jest.fn() } as any,
      { resolve: jest.fn(), invalidate: jest.fn() } as any,
    );
    const tools = [{ name: 'get_forecast', description: 'Forecast for a city', parameters: { type: 'object', properties: { city: { type: 'string' } } } }] as any;

    const result = await runner.dispatchProviderCall(
      provider('http://10.0.0.5:8000/v1'),
      { messages: [{ role: MessageRole.USER, content: 'weather in Lisbon?' }], model: 'qwen3-14b' } as any,
      { id: 's', organizationId: 'org', context: {} } as any,
      tools,
      Date.now(),
    );

    const [config] = jest.mocked(callLlmProviderHttp).mock.calls[0];
    expect(config.url).toBe('http://10.0.0.5:8000/v1/chat/completions');
    expect((config.data as any).tools).toEqual([expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'get_forecast' }) })]);
    expect(result.message.toolCalls).toEqual([expect.objectContaining({ name: 'get_forecast' })]);
  });

  it('keeps a base that already names the chat endpoint as it is', async () => {
    jest.mocked(callLlmProviderHttp).mockResolvedValue({ data: { choices: [{ message: { content: 'OK' } }] } } as any);
    const runner = new LlmChatRunnerHelper({} as any, {} as any, new LlmModelsHelper(makeEnvelopeCryptoMock()), { warmOrg: jest.fn() } as any, { resolve: jest.fn(), invalidate: jest.fn() } as any);
    await runner.dispatchProviderCall(provider('http://h/v1/chat/completions'), { messages: [], model: 'm' } as any, { id: 's', context: {} } as any, [], Date.now());
    expect(jest.mocked(callLlmProviderHttp).mock.calls[0][0].url).toBe('http://h/v1/chat/completions');
  });
});
