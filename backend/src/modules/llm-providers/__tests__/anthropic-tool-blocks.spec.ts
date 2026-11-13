import { Readable } from 'stream';

import {
  ANTHROPIC_UNCARDED_MAX_TOKENS,
  callAnthropic,
  callAnthropicStream,
  callWithDeprecatedParamRetry,
} from '../providers/anthropic.provider';
import { toAnthropicMessages } from '../providers/anthropic-messages';
import * as safeRequest from '../providers/safe-request';
import { LlmProviderType } from '../../../entities/llm-provider.entity';
import { MessageRole } from '../../../entities/message.entity';

/**
 * Earlier tool calls go to Claude as structured `tool_use` / `tool_result`
 * blocks, every call of a turn kept, the same on the streaming and the
 * non-streaming path.
 *
 * The conversation below is the shape of a research-digest run on staging
 * (model comparison, 2026-11-13): a turn that called two tools at once
 * (openalex_search_works and recall_memory, thinking first), their two
 * results, a store_memory call and its result. The adapter used to send
 * every one of those as a plain `{role, content}` text message, the tool
 * turns with empty text, and kept only the first tool_use of a reply; the
 * model did not see its calls as calls and made store_memory again five
 * times, re-sending 21-37k input tokens each time.
 */

const THINKING = { type: 'thinking', thinking: '', signature: 'sig-recorded-1' };

const recordedConversation = (): any[] => [
  { role: MessageRole.SYSTEM, content: 'You are a research digest agent.' },
  { role: MessageRole.USER, content: 'New papers on LLM agent benchmarks since 2026-11-05.' },
  {
    role: MessageRole.ASSISTANT,
    content: 'Searching OpenAlex and checking what I reported before.',
    toolCalls: [
      { id: 'toolu_01', name: 'openalex_search_works', parameters: { search: 'llm agent benchmark', from_publication_date: '2026-11-05' } },
      { id: 'toolu_02', name: 'recall_memory', parameters: { query: 'reported works' } },
    ],
    providerContent: {
      format: 'anthropic',
      blocks: [
        THINKING,
        { type: 'text', text: 'Searching OpenAlex and checking what I reported before.' },
        { type: 'tool_use', id: 'toolu_01', name: 'openalex_search_works', input: { search: 'llm agent benchmark', from_publication_date: '2026-11-05' } },
        { type: 'tool_use', id: 'toolu_02', name: 'recall_memory', input: { query: 'reported works' } },
      ],
    },
  },
  { role: MessageRole.TOOL, content: '{"meta":{"count":466},"results":[{"id":"W1"}]}', toolCallId: 'toolu_01' },
  { role: MessageRole.TOOL, content: 'No relevant memories found.', toolCallId: 'toolu_02' },
  {
    role: MessageRole.ASSISTANT,
    content: '',
    toolCalls: [{ id: 'toolu_03', name: 'store_memory', parameters: { content: 'Reported W1', importance: 'long' } }],
  },
  { role: MessageRole.TOOL, content: 'Memory stored (id: m-1)', toolCallId: 'toolu_03' },
];

const tools: any[] = [
  { name: 'openalex_search_works', description: 'Search works', parameters: { type: 'object', properties: {} } },
  { name: 'recall_memory', description: 'Recall', parameters: { type: 'object', properties: {} } },
  { name: 'store_memory', description: 'Store', parameters: { type: 'object', properties: {} } },
];

const EXPECTED_MESSAGES = [
  { role: 'user', content: 'New papers on LLM agent benchmarks since 2026-11-05.' },
  {
    role: 'assistant',
    content: [
      THINKING,
      { type: 'text', text: 'Searching OpenAlex and checking what I reported before.' },
      { type: 'tool_use', id: 'toolu_01', name: 'openalex_search_works', input: { search: 'llm agent benchmark', from_publication_date: '2026-11-05' } },
      { type: 'tool_use', id: 'toolu_02', name: 'recall_memory', input: { query: 'reported works' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_01', content: '{"meta":{"count":466},"results":[{"id":"W1"}]}' },
      { type: 'tool_result', tool_use_id: 'toolu_02', content: 'No relevant memories found.' },
    ],
  },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_03', name: 'store_memory', input: { content: 'Reported W1', importance: 'long' } }],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_03', content: 'Memory stored (id: m-1)' }] },
];

function provider(): any {
  return {
    type: LlmProviderType.ANTHROPIC,
    getApiUrl: () => 'https://api.anthropic.com/v1',
    getAuthHeaders: () => ({ 'x-api-key': 'test-key' }),
    configuration: { model: 'claude-opus-5-5' },
  };
}

const conversation: any = { id: 'c1', context: {} };

function sse(events: Array<[string, unknown]>): Readable {
  return Readable.from(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

describe('Anthropic tool calls as structured blocks', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends a recorded multi-tool conversation as tool_use / tool_result blocks with matching ids (non-streaming)', async () => {
    const sent: any[] = [];
    jest.spyOn(safeRequest, 'callLlmProviderHttp').mockImplementation(async (cfg: any) => {
      sent.push(cfg.data);
      return { data: { content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn', model: 'claude-opus-5-5' } } as any;
    });

    await callAnthropic(provider(), { messages: recordedConversation() } as any, conversation, tools, Date.now(), () => 0);

    expect(sent[0].system).toBe('You are a research digest agent.');
    expect(sent[0].messages).toEqual(EXPECTED_MESSAGES);
  });

  it('sends the same blocks on the streaming path', async () => {
    const sent: any[] = [];
    jest.spyOn(safeRequest, 'callLlmProviderHttpStream').mockImplementation(async (cfg: any) => {
      sent.push(cfg.data);
      return { data: sse([['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }]]) } as any;
    });

    await callAnthropicStream(provider(), { messages: recordedConversation() } as any, conversation, tools, Date.now(), () => 0, () => undefined);

    expect(sent[0].messages).toEqual(EXPECTED_MESSAGES);
    expect(sent[0].stream).toBe(true);
  });

  it('answers a call with no recorded result, and sends a result whose call is gone as text', () => {
    const messages: any[] = [
      { role: MessageRole.USER, content: 'go' },
      { role: MessageRole.TOOL, content: 'old result', toolCallId: 'toolu_gone' },
      {
        role: MessageRole.ASSISTANT,
        content: 'two calls',
        toolCalls: [
          { id: 'toolu_a', name: 'a', parameters: {} },
          { id: 'toolu_b', name: 'b', parameters: {} },
        ],
      },
      { role: MessageRole.TOOL, content: 'a ok', toolCallId: 'toolu_a' },
      { role: MessageRole.USER, content: 'and now?' },
    ];

    expect(toAnthropicMessages(messages, true)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'go' },
          { type: 'text', text: '[Result of an earlier tool call (toolu_gone)]\nold result' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'two calls' },
          { type: 'tool_use', id: 'toolu_a', name: 'a', input: {} },
          { type: 'tool_use', id: 'toolu_b', name: 'b', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_a', content: 'a ok' },
          { type: 'tool_result', tool_use_id: 'toolu_b', content: 'No result was recorded for this call.', is_error: true },
          { type: 'text', text: 'and now?' },
        ],
      },
    ]);
  });

  it('writes calls and results as text when the request offers no tools (the API refuses tool blocks then)', () => {
    const out = toAnthropicMessages(recordedConversation(), false);
    const flat = JSON.stringify(out);
    expect(flat).not.toContain('tool_use');
    expect(flat).not.toContain('tool_result');
    expect(flat).not.toContain('"thinking"');
    expect(out[1]).toEqual({
      role: 'assistant',
      content:
        'Searching OpenAlex and checking what I reported before.\n' +
        '[Called openalex_search_works with {"search":"llm agent benchmark","from_publication_date":"2026-11-05"}]\n' +
        '[Called recall_memory with {"query":"reported works"}]',
    });
  });

  it('reads every tool_use block of a non-streaming reply, and keeps the turn to send back', async () => {
    const content = [
      THINKING,
      { type: 'tool_use', id: 'toolu_x', name: 'get_weather', input: { city: 'Berlin' } },
      { type: 'tool_use', id: 'toolu_y', name: 'store_memory', input: { content: 'Berlin asked' } },
    ];
    jest.spyOn(safeRequest, 'callLlmProviderHttp').mockResolvedValue({
      data: { content, usage: { input_tokens: 5, output_tokens: 7 }, stop_reason: 'tool_use', model: 'claude-opus-5-5' },
    } as any);

    const res = await callAnthropic(provider(), { messages: [{ role: 'user', content: 'hi' }] } as any, conversation, tools, Date.now(), () => 0);

    expect(res.message.toolCalls).toEqual([
      { id: 'toolu_x', name: 'get_weather', parameters: { city: 'Berlin' } },
      { id: 'toolu_y', name: 'store_memory', parameters: { content: 'Berlin asked' } },
    ]);
    expect(res.message.providerContent).toEqual({ format: 'anthropic', blocks: content });
  });

  it('streams thinking, its signature and two tool_use blocks into the same turn', async () => {
    jest.spyOn(safeRequest, 'callLlmProviderHttpStream').mockResolvedValue({
      data: sse([
        ['message_start', { message: { model: 'claude-opus-5-5', usage: { input_tokens: 9 } } }],
        ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-' } }],
        ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'streamed' } }],
        ['content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_x', name: 'get_weather', input: {} } }],
        ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"Ber' } }],
        ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'lin"}' } }],
        ['content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_y', name: 'store_memory', input: {} } }],
        ['content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"content":"x"}' } }],
        ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } }],
      ]),
    } as any);

    const res = await callAnthropicStream(provider(), { messages: [{ role: 'user', content: 'hi' }] } as any, conversation, tools, Date.now(), () => 0, () => undefined);

    expect(res.message.toolCalls).toEqual([
      { id: 'toolu_x', name: 'get_weather', parameters: { city: 'Berlin' } },
      { id: 'toolu_y', name: 'store_memory', parameters: { content: 'x' } },
    ]);
    expect(res.message.providerContent).toEqual({
      format: 'anthropic',
      blocks: [
        { type: 'thinking', thinking: '', signature: 'sig-streamed' },
        { type: 'tool_use', id: 'toolu_x', name: 'get_weather', input: { city: 'Berlin' } },
        { type: 'tool_use', id: 'toolu_y', name: 'store_memory', input: { content: 'x' } },
      ],
    });
  });

  it('fails a stream that reports an error event instead of settling it as an empty reply', async () => {
    jest.spyOn(safeRequest, 'callLlmProviderHttpStream').mockResolvedValue({
      data: sse([
        ['message_start', { message: { model: 'claude-opus-5-5', usage: { input_tokens: 9 } } }],
        ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
      ]),
    } as any);

    await expect(
      callAnthropicStream(provider(), { messages: [{ role: 'user', content: 'hi' }] } as any, conversation, [], Date.now(), () => 0, () => undefined),
    ).rejects.toThrow('Overloaded');
  });
});

describe('Anthropic output limit', () => {
  afterEach(() => jest.restoreAllMocks());

  const sentBody = async (request: any, context: any = {}) => {
    const sent: any[] = [];
    jest.spyOn(safeRequest, 'callLlmProviderHttp').mockImplementation(async (cfg: any) => {
      sent.push(cfg.data);
      return { data: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' } } as any;
    });
    await callAnthropic(provider(), request, { id: 'c', context } as any, [], Date.now(), () => 0);
    return sent[0];
  };

  it('never falls back to 1024 when the call names no limit', async () => {
    const body = await sentBody({ messages: [{ role: 'user', content: 'hi' }] });
    expect(body.max_tokens).toBe(ANTHROPIC_UNCARDED_MAX_TOKENS);
    expect(body.max_tokens).toBeGreaterThan(1024);
  });

  it('sends the limit the call names (the card or the agent setting, resolved by the runner)', async () => {
    const body = await sentBody({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 128_000 });
    expect(body.max_tokens).toBe(128_000);
  });

  it("lowers the limit to the model's own when the API says it is above it", async () => {
    const body: Record<string, unknown> = { max_tokens: ANTHROPIC_UNCARDED_MAX_TOKENS };
    const call = jest
      .fn()
      .mockRejectedValueOnce({
        response: {
          status: 400,
          data: { error: { type: 'invalid_request_error', message: 'max_tokens: 64000 > 8192, which is the maximum allowed number of output tokens for claude-3-5-haiku' } },
        },
      })
      .mockResolvedValueOnce({ data: 'ok' });

    await callWithDeprecatedParamRetry(call, body);

    expect(call).toHaveBeenCalledTimes(2);
    expect(body.max_tokens).toBe(8192);
  });

  it('sends the turns again without their thinking blocks when the API refuses them', async () => {
    const body: Record<string, any> = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [THINKING, { type: 'tool_use', id: 't', name: 'a', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
      ],
    };
    const call = jest
      .fn()
      .mockRejectedValueOnce({
        response: { status: 400, data: { error: { type: 'invalid_request_error', message: 'Invalid signature in thinking block: bound to a different conversation' } } },
      })
      .mockResolvedValueOnce({ data: 'ok' });

    await callWithDeprecatedParamRetry(call, body);

    expect(call).toHaveBeenCalledTimes(2);
    expect(body.messages[1].content).toEqual([{ type: 'tool_use', id: 't', name: 'a', input: {} }]);
  });
});
