import { Readable } from 'stream';
import { callOpenAIStream } from '../providers/openai.provider';
import { callAnthropicStream } from '../providers/anthropic.provider';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { Conversation } from '../../../entities/conversation.entity';
import { MessageRole } from '../../../entities/message.entity';
import { ChatRequest, StreamChunk } from '../llm-providers.service';

// Mock safe-request to avoid real HTTP calls
jest.mock('../providers/safe-request', () => ({
  callLlmProviderHttp: jest.fn(),
  callLlmProviderHttpStream: jest.fn(),
}));

const { callLlmProviderHttpStream } = require('../providers/safe-request');

/** Create a readable stream that emits the given string chunks. */
function createSSEStream(chunks: string[]): Readable {
  const stream = new Readable({
    read() {
      for (const chunk of chunks) {
        this.push(Buffer.from(chunk));
      }
      this.push(null);
    },
  });
  return stream;
}

/** Build a minimal mock provider. */
function mockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  const provider = new LlmProvider();
  Object.assign(provider, {
    id: 'provider-1',
    type: 'openai',
    configuration: {
      apiKey: 'sk-test',
      model: 'gpt-4o',
      timeout: 30000,
    },
    getApiUrl: () => 'https://api.openai.com/v1',
    getAuthHeaders: () => ({ Authorization: 'Bearer sk-test' }),
    ...overrides,
  });
  return provider;
}

/** Build a minimal mock conversation. */
function mockConversation(): Conversation {
  const conv = new Conversation();
  conv.id = 'conv-1';
  conv.context = {};
  return conv;
}

/** Build a basic chat request. */
function mockRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    messages: [{ role: MessageRole.USER, content: 'Hello' }],
    model: 'gpt-4o',
    maxTokens: 100,
    temperature: 0.7,
    ...overrides,
  };
}

describe('callOpenAIStream', () => {
  const costFn = jest.fn().mockReturnValue(0.001);

  beforeEach(() => {
    jest.clearAllMocks();
    costFn.mockReturnValue(0.001);
  });

  it('should stream content deltas and accumulate full response', async () => {
    const sseData = [
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
      'data: [DONE]\n\n',
    ];

    const stream = createSSEStream(sseData);
    (callLlmProviderHttpStream as jest.Mock).mockResolvedValue({ data: stream });

    const chunks: StreamChunk[] = [];
    const onChunk = (chunk: StreamChunk) => chunks.push(chunk);

    const result = await callOpenAIStream(
      mockProvider(),
      mockRequest(),
      mockConversation(),
      [],
      Date.now(),
      costFn,
      onChunk,
    );

    // Content chunks should have been emitted
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe('Hello');
    expect(chunks[1].content).toBe(' world');

    // Accumulated response should have full content
    expect(result.message.content).toBe('Hello world');
    expect(result.message.role).toBe(MessageRole.ASSISTANT);
    expect(result.message.finishReason).toBe('stop');
    expect(result.message.toolCalls).toBeUndefined();

    // Usage should be parsed from the final chunk
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(2);
    expect(result.usage.totalTokens).toBe(12);

    // Cost function should have been called
    expect(costFn).toHaveBeenCalledWith(expect.anything(), 10, 2);
    expect(result.cost).toBe(0.001);
    expect(result.model).toBe('gpt-4o');
  });

  it('should accumulate tool call deltas across multiple chunks', async () => {
    const sseData = [
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"tc-1","type":"function","function":{"name":"web_search","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\": \\"test\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30}}\n\n',
      'data: [DONE]\n\n',
    ];

    const stream = createSSEStream(sseData);
    (callLlmProviderHttpStream as jest.Mock).mockResolvedValue({ data: stream });

    const chunks: StreamChunk[] = [];
    const result = await callOpenAIStream(
      mockProvider(),
      mockRequest(),
      mockConversation(),
      [],
      Date.now(),
      costFn,
      (chunk) => chunks.push(chunk),
    );

    // No content chunks (tool call only)
    expect(chunks).toHaveLength(0);

    // Tool calls should be accumulated and parsed
    expect(result.message.toolCalls).toHaveLength(1);
    expect(result.message.toolCalls![0].id).toBe('tc-1');
    expect(result.message.toolCalls![0].name).toBe('web_search');
    expect(result.message.toolCalls![0].parameters).toEqual({ q: 'test' });
    expect(result.message.finishReason).toBe('tool_calls');
  });

  it('should handle stream errors gracefully', async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error('Connection reset'));
      },
    });

    (callLlmProviderHttpStream as jest.Mock).mockResolvedValue({ data: stream });

    await expect(
      callOpenAIStream(
        mockProvider(),
        mockRequest(),
        mockConversation(),
        [],
        Date.now(),
        costFn,
        () => {},
      ),
    ).rejects.toThrow('Connection reset');
  });

  it('should handle empty stream', async () => {
    const sseData = [
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":0,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ];

    const stream = createSSEStream(sseData);
    (callLlmProviderHttpStream as jest.Mock).mockResolvedValue({ data: stream });

    const chunks: StreamChunk[] = [];
    const result = await callOpenAIStream(
      mockProvider(),
      mockRequest(),
      mockConversation(),
      [],
      Date.now(),
      costFn,
      (chunk) => chunks.push(chunk),
    );

    expect(chunks).toHaveLength(0);
    expect(result.message.content).toBeUndefined();
    expect(result.message.finishReason).toBe('stop');
  });
});

describe('callAnthropicStream', () => {
  const costFn = jest.fn().mockReturnValue(0.002);

  beforeEach(() => {
    jest.clearAllMocks();
    costFn.mockReturnValue(0.002);
  });

  it('should stream content deltas from Anthropic SSE format', async () => {
    const sseData = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":15}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" from Claude"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    const stream = createSSEStream(sseData);
    (callLlmProviderHttpStream as jest.Mock).mockResolvedValue({ data: stream });

    const provider = mockProvider({
      type: 'anthropic' as any,
      configuration: {
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-20250514',
        apiVersion: '2023-06-01',
        timeout: 30000,
      },
      getApiUrl: () => 'https://api.anthropic.com/v1',
      getAuthHeaders: () => ({
        'x-api-key': 'sk-ant-test',
        'anthropic-version': '2023-06-01',
      }),
    } as any);

    const chunks: StreamChunk[] = [];
    const result = await callAnthropicStream(
      provider,
      mockRequest(),
      mockConversation(),
      [],
      Date.now(),
      costFn,
      (chunk) => chunks.push(chunk),
    );

    // Content chunks
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe('Hello');
    expect(chunks[1].content).toBe(' from Claude');

    // Full response
    expect(result.message.content).toBe('Hello from Claude');
    expect(result.message.role).toBe(MessageRole.ASSISTANT);
    expect(result.message.finishReason).toBe('end_turn');
    expect(result.message.toolCalls).toBeUndefined();

    // Usage
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(20);

    expect(costFn).toHaveBeenCalledWith(expect.anything(), 15, 5);
    expect(result.cost).toBe(0.002);
    expect(result.model).toBe('claude-sonnet-4-20250514');
  });

  it('should accumulate Anthropic tool_use blocks from stream', async () => {
    const sseData = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":20}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"calculator"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"expression\\""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":": \\"2+2\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    const stream = createSSEStream(sseData);
    (callLlmProviderHttpStream as jest.Mock).mockResolvedValue({ data: stream });

    const provider = mockProvider({
      type: 'anthropic' as any,
      getApiUrl: () => 'https://api.anthropic.com/v1',
      getAuthHeaders: () => ({ 'x-api-key': 'test', 'anthropic-version': '2023-06-01' }),
    } as any);

    const chunks: StreamChunk[] = [];
    const result = await callAnthropicStream(
      provider,
      mockRequest(),
      mockConversation(),
      [],
      Date.now(),
      costFn,
      (chunk) => chunks.push(chunk),
    );

    // No content chunks (tool use)
    expect(chunks).toHaveLength(0);

    // Tool call should be accumulated
    expect(result.message.toolCalls).toHaveLength(1);
    expect(result.message.toolCalls![0].id).toBe('toolu_1');
    expect(result.message.toolCalls![0].name).toBe('calculator');
    expect(result.message.toolCalls![0].parameters).toEqual({ expression: '2+2' });
    expect(result.message.finishReason).toBe('tool_use');
  });

  it('should handle stream errors gracefully', async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error('Anthropic connection lost'));
      },
    });

    (callLlmProviderHttpStream as jest.Mock).mockResolvedValue({ data: stream });

    const provider = mockProvider({
      type: 'anthropic' as any,
      getApiUrl: () => 'https://api.anthropic.com/v1',
      getAuthHeaders: () => ({ 'x-api-key': 'test', 'anthropic-version': '2023-06-01' }),
    } as any);

    await expect(
      callAnthropicStream(
        provider,
        mockRequest(),
        mockConversation(),
        [],
        Date.now(),
        costFn,
        () => {},
      ),
    ).rejects.toThrow('Anthropic connection lost');
  });
});
