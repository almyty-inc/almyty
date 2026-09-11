import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { MessageRole } from '../../../entities/message.entity';
import {
  buildPerplexityInput,
  buildPerplexityTools,
  readPerplexityOutput,
  callPerplexity,
  callPerplexityStream,
} from '../providers/perplexity.provider';

jest.mock('../providers/safe-request', () => ({
  callLlmProviderHttp: jest.fn(),
  callLlmProviderHttpStream: jest.fn(),
  llmCallOptionsFor: jest.fn().mockReturnValue({}),
}));

const { callLlmProviderHttp, callLlmProviderHttpStream } = require('../providers/safe-request');

/**
 * Perplexity's generally available surface is the Responses-shaped Agent
 * API, not chat completions. The chat-completions alias on the bare host
 * retires 2026-09-27 and the Router that serves one is private preview, so
 * a `<base>/chat/completions` client has nowhere to point after that date.
 * Verified 2026-09-09, see docs/design/call-only-vendors.md.
 */
function makeProvider(configuration: Record<string, unknown> = { apiKey: 'pplx-key', model: 'perplexity/sonar' }): LlmProvider {
  return Object.assign(new LlmProvider(), {
    id: 'p-pplx',
    organizationId: 'org',
    name: 'perplexity',
    type: LlmProviderType.PERPLEXITY,
    configuration,
  });
}

const session = { id: 'conv-1', organizationId: 'org', context: {} } as any;

describe('Perplexity base URL and auth', () => {
  it('defaults to the Agent API base a paying customer can use today', () => {
    expect(makeProvider().getApiUrl()).toBe('https://api.perplexity.ai/v1');
  });

  it('lets the private-preview Router be selected explicitly', () => {
    const provider = makeProvider({ apiKey: 'k', apiUrl: 'https://api.perplexity.ai/router/v1' });
    expect(provider.getApiUrl()).toBe('https://api.perplexity.ai/router/v1');
  });

  it('authenticates with a plain Bearer key', () => {
    expect(makeProvider().getAuthHeaders()).toMatchObject({ Authorization: 'Bearer pplx-key' });
  });

  it('lists models from <base>/models', () => {
    expect(makeProvider().getModelsUrl()).toBe('https://api.perplexity.ai/v1/models');
  });
});

describe('buildPerplexityInput', () => {
  it('lifts system messages into instructions and leaves the rest as typed items', () => {
    const { input, instructions } = buildPerplexityInput({
      messages: [
        { role: MessageRole.SYSTEM, content: 'Be terse.' },
        { role: MessageRole.USER, content: 'Hello' },
        { role: MessageRole.ASSISTANT, content: 'Hi' },
      ],
    } as any);
    expect(instructions).toBe('Be terse.');
    expect(input).toEqual([
      { type: 'message', role: 'user', content: 'Hello' },
      { type: 'message', role: 'assistant', content: 'Hi' },
    ]);
  });

  it('replays a tool call next to the result that answers it', () => {
    const { input } = buildPerplexityInput({
      messages: [
        { role: MessageRole.ASSISTANT, content: '', toolCalls: [{ id: 'call_1', name: 'lookup', parameters: { q: 'x' } }] },
        { role: MessageRole.TOOL, content: '{"ok":true}', toolCallId: 'call_1' },
      ],
    } as any);
    expect(input).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
    ]);
  });

  it('flattens structured content parts to their text', () => {
    const { input } = buildPerplexityInput({
      messages: [{ role: MessageRole.USER, content: [{ type: 'text', text: 'a' }, { type: 'image', url: 'u' }] }],
    } as any);
    expect(input[0].content).toBe('a');
  });
});

describe('buildPerplexityTools', () => {
  it('emits the flat Responses shape, not the nested Chat Completions one', () => {
    const tools = buildPerplexityTools([
      { name: 'lookup', description: 'looks up', parameters: { type: 'object', properties: {} } } as any,
    ]);
    expect(tools).toEqual([
      { type: 'function', name: 'lookup', description: 'looks up', parameters: { type: 'object', properties: {} } },
    ]);
    // The Chat Completions nesting would be rejected here.
    expect(tools[0]).not.toHaveProperty('function');
  });
});

describe('readPerplexityOutput', () => {
  it('finds the message even when search results come first', () => {
    const parsed = readPerplexityOutput([
      { type: 'search_results', queries: ['x'], results: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ]);
    expect(parsed.content).toBe('answer');
  });

  it('parses function_call items into tool calls', () => {
    const parsed = readPerplexityOutput([
      { type: 'function_call', call_id: 'call_9', name: 'lookup', arguments: '{"q":"y"}' },
    ]);
    expect(parsed.toolCalls).toEqual([{ id: 'call_9', name: 'lookup', parameters: { q: 'y' } }]);
  });

  it('keeps malformed tool arguments instead of throwing', () => {
    const parsed = readPerplexityOutput([
      { type: 'function_call', call_id: 'c', name: 'n', arguments: '{"broken":' },
    ]);
    expect(parsed.toolCalls[0].parameters).toEqual({ __rawArguments: '{"broken":', __parseError: true });
  });
});

describe('callPerplexity', () => {
  beforeEach(() => {
    (callLlmProviderHttp as jest.Mock).mockReset().mockResolvedValue({
      data: {
        status: 'completed',
        model: 'perplexity/sonar',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      },
    });
  });

  it('posts Responses-shaped JSON to <base>/responses', async () => {
    const res = await callPerplexity(makeProvider(), { messages: [{ role: MessageRole.USER, content: 'q' }] } as any, session, [], Date.now(), () => 0);
    const config = (callLlmProviderHttp as jest.Mock).mock.calls[0][0];
    expect(config.url).toBe('https://api.perplexity.ai/v1/responses');
    expect(config.data.model).toBe('perplexity/sonar');
    expect(config.data.input).toEqual([{ type: 'message', role: 'user', content: 'q' }]);
    // A chat-completions body would carry `messages`; this must not.
    expect(config.data).not.toHaveProperty('messages');
    expect(res.message.content).toBe('answer');
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
    expect(res.message.finishReason).toBe('completed');
  });

  it('always sends max_output_tokens, which anthropic/* models require', async () => {
    await callPerplexity(makeProvider(), { messages: [] } as any, session, [], Date.now(), () => 0);
    expect((callLlmProviderHttp as jest.Mock).mock.calls[0][0].data.max_output_tokens).toBe(4096);
  });
});

describe('callPerplexityStream', () => {
  function fakeStream(events: string[]) {
    const handlers: Record<string, Function> = {};
    return {
      on(event: string, handler: Function) {
        handlers[event] = handler;
        if (event === 'error') {
          // Deliver once both data and end are registered.
          setImmediate(() => {
            for (const line of events) handlers.data(Buffer.from(line));
            handlers.end();
          });
        }
        return this;
      },
    };
  }

  it('accumulates output_text deltas and takes usage from response.completed', async () => {
    (callLlmProviderHttpStream as jest.Mock).mockReset().mockResolvedValue({
      data: fakeStream([
        'data: {"type":"response.output_text.delta","delta":"an"}\n',
        'data: {"type":"response.output_text.delta","delta":"swer"}\n',
        'data: {"type":"response.unknown.event","delta":"IGNORED"}\n',
        'data: {"type":"response.completed","response":{"model":"perplexity/sonar","status":"completed","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5},"output":[]}}\n',
        'data: [DONE]\n',
      ]),
    });

    const chunks: string[] = [];
    const res = await callPerplexityStream(
      makeProvider(),
      { messages: [], stream: true } as any,
      session,
      [],
      Date.now(),
      () => 0,
      (chunk) => { if (chunk.content) chunks.push(chunk.content); },
    );

    expect(chunks).toEqual(['an', 'swer']);
    expect(res.message.content).toBe('answer');
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect((callLlmProviderHttpStream as jest.Mock).mock.calls[0][0].data.stream).toBe(true);
  });
});
