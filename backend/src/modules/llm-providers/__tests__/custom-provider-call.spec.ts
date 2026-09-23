import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { MessageRole } from '../../../entities/message.entity';

jest.mock('../providers/safe-request', () => {
  const actual = jest.requireActual('../providers/safe-request');
  return { ...actual, callLlmProviderHttp: jest.fn() };
});

import { callLlmProviderHttp } from '../providers/safe-request';
import { callCustomProvider, customChatUrl } from '../providers/google.provider';

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
});
