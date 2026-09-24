import { Readable } from 'stream';

import { HostedChatController } from '../hosted-chat.controller';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';
import { LlmProvider } from '../../../../entities/llm-provider.entity';
import { Conversation } from '../../../../entities/conversation.entity';
import { MessageRole } from '../../../../entities/message.entity';
import type { Tool } from '../../../../entities/tool.entity';
import { callAnthropicStream } from '../../../llm-providers/providers/anthropic.provider';
import { callOpenAIStream } from '../../../llm-providers/providers/openai.provider';
import { emitStreamChunk } from '../../../agents/llm-stream-events';

// Only the socket is faked: the provider parsers, the chunk-to-event
// mapping the runtime uses and the controller are all the real code.
jest.mock('../../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));
const { callLlmProviderHttpStream } = require('../../../llm-providers/providers/safe-request');

/**
 * What a hosted chat visitor receives for real provider byte streams,
 * from the provider parser through the run events to the SSE frames.
 */
describe('hosted chat streaming, provider to visitor', () => {
  const crmTool = { name: 'crm_lookup', description: 'Look up an account', parameters: { type: 'object', properties: {} } } as unknown as Tool;

  const anthropicToolStep = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":9}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looking up account 4411"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" for jane@corp.test"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"crm_lookup"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const anthropicAnswer = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":20}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Your order"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" ships"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" Monday."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const openaiToolStep = [
    'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Let me check account 4411"},"finish_reason":null}]}\n\n',
    'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tc-1","type":"function","function":{"name":"crm_lookup","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
    'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const openaiAnswer = [
    'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Your order"},"finish_reason":null}]}\n\n',
    'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" ships"},"finish_reason":null}]}\n\n',
    'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" Monday."},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const anthropic = Object.assign(new LlmProvider(), {
    id: 'p-1',
    type: 'anthropic',
    configuration: { model: 'claude-sonnet-5', timeout: 30000 },
    getApiUrl: () => 'https://api.anthropic.com/v1',
    getAuthHeaders: () => ({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }),
  });
  const openai = Object.assign(new LlmProvider(), {
    id: 'p-2',
    type: 'openai',
    configuration: { model: 'gpt-4o', timeout: 30000 },
    getApiUrl: () => 'https://api.openai.com/v1',
    getAuthHeaders: () => ({ Authorization: 'Bearer k' }),
  });
  const conversation = Object.assign(new Conversation(), { id: 'conv-1', context: {} });

  /** Run one agent step the way the step processor does, emitting its events. */
  async function step(
    emit: (type: string, data: Record<string, unknown>) => void,
    n: number,
    call: typeof callAnthropicStream | typeof callOpenAIStream,
    provider: LlmProvider,
    sse: string[],
  ) {
    (callLlmProviderHttpStream as jest.Mock).mockResolvedValueOnce({ data: Readable.from(sse.map((s) => Buffer.from(s))) });
    emit('llm.started', { step: n });
    const response = await call(
      provider,
      { messages: [{ role: MessageRole.USER, content: 'Where is my order?' }], model: provider.configuration.model },
      conversation,
      [crmTool],
      Date.now(),
      () => 0,
      (chunk) => emitStreamChunk(emit, n, chunk),
    );
    emit('llm.response', {
      step: n,
      content: response.message.content,
      toolCalls: response.message.toolCalls?.map((tc) => ({ id: tc.id, name: tc.name })),
    });
  }

  async function visitorSees(call: typeof callAnthropicStream | typeof callOpenAIStream, provider: LlmProvider, steps: string[][]) {
    const gateway = Object.assign(new Gateway(), {
      id: 'gw-1',
      type: GatewayType.HOSTED_CHAT,
      status: GatewayStatus.ACTIVE,
      organizationId: 'org-1',
      agentId: 'agent-1',
      configuration: { hostedChat: { slug: 'acme' } },
    });
    const hostedChat = {
      findBySlug: async () => gateway,
      resolveEndUser: async () => ({ endUser: { id: 'eu-1' }, issuedSessionKey: null }),
      requiresAuth: () => false,
      runBelongsToEndUser: async () => true,
    };
    const agentRuntime = {
      getRun: async () => ({ id: 'run-1', agent: { agentConfig: {} } }),
      subscribeRunEvents: async (_runId: string, handler: (event: any) => void) => {
        const emit = (type: string, data: Record<string, unknown>) => handler({ type, data });
        for (let n = 0; n < steps.length; n++) await step(emit, n, call, provider, steps[n]);
        handler({ type: 'run.completed', data: {} });
      },
    };
    const frames: string[] = [];
    const res = {
      setHeader: () => undefined,
      flushHeaders: () => undefined,
      write: (frame: string) => frames.push(frame),
      end: () => undefined,
    };
    const controller = new HostedChatController(hostedChat as any, {} as any, agentRuntime as any);
    await controller.stream('acme', 'run-1', { headers: {}, cookies: {}, ip: '203.0.113.9', on: () => undefined } as any, res as any);
    return {
      raw: frames.join(''),
      tokens: frames.filter((f) => f.startsWith('event: token')).map((f) => JSON.parse(f.split('data: ')[1]).content),
    };
  }

  it('Anthropic: narration in a text block ahead of tool_use never reaches the visitor; the answer streams in order', async () => {
    const seen = await visitorSees(callAnthropicStream, anthropic, [anthropicToolStep, anthropicAnswer]);

    expect(seen.raw).not.toContain('4411');
    expect(seen.raw).not.toContain('jane@corp.test');
    expect(seen.raw).not.toContain('event: reset');
    expect(seen.tokens).toEqual(['Your order', ' ships', ' Monday.']);
    expect(seen.tokens.join('')).toBe('Your order ships Monday.');
  });

  it('chat completions: content ahead of tool_calls never reaches the visitor; the answer streams in order', async () => {
    const seen = await visitorSees(callOpenAIStream, openai, [openaiToolStep, openaiAnswer]);

    expect(seen.raw).not.toContain('4411');
    expect(seen.raw).not.toContain('event: reset');
    expect(seen.tokens).toEqual(['Your order', ' ships', ' Monday.']);
  });
});
