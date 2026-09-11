import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { Conversation } from '../../../entities/conversation.entity';
import { MessageRole, ToolCall } from '../../../entities/message.entity';
import { Tool } from '../../../entities/tool.entity';
import { ChatRequest, ChatResponse, StreamChunk } from '../dto/llm-providers.dto';
import { callLlmProviderHttp, callLlmProviderHttpStream, llmCallOptionsFor } from './safe-request';
import { requireModel } from '../model-errors';

/**
 * Perplexity's Agent API.
 *
 * Perplexity is deliberately NOT on the shared OpenAI chat path. Its
 * generally available surface is Responses-shaped, not chat-completions
 * shaped: `POST <base>/responses` (an alias of `<base>/agent`) taking
 * `model` + `input`, answering with an `output` array of typed items.
 *
 * The chat-completions alias that used to make Perplexity look
 * OpenAI-compatible lives on the bare host (`https://api.perplexity.ai` +
 * `/chat/completions`) and retires 2026-09-27. The Router API
 * (`https://api.perplexity.ai/router/v1`) is still private preview; it
 * serves `/responses` as well, so setting it as `apiUrl` keeps this same
 * dispatch working. Verified 2026-09-09, see
 * docs/design/call-only-vendors.md.
 */

/** Anthropic-hosted models on Perplexity reject a request with no output cap. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Flatten almyty's message list into the Responses `input` array.
 *
 * System messages become `instructions` (Perplexity's own field for them);
 * everything else becomes a typed item. A tool result carries the
 * `call_id` it answers, which is how the Agent API threads a tool loop:
 * the prior `function_call` item is replayed alongside the
 * `function_call_output` that answers it.
 */
/**
 * Message content is either a plain string or almyty's structured part
 * array. The Agent API takes a string per input item, so parts are flattened
 * to their text; a part with no text (an image, say) contributes nothing
 * rather than a stringified object.
 */
function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function buildPerplexityInput(request: ChatRequest): {
  input: Array<Record<string, unknown>>;
  instructions?: string;
} {
  const input: Array<Record<string, unknown>> = [];
  const instructions: string[] = [];

  for (const msg of request.messages ?? []) {
    if (msg.role === MessageRole.SYSTEM) {
      const text = asText(msg.content);
      if (text) instructions.push(text);
      continue;
    }

    if (msg.toolCallId) {
      input.push({
        type: 'function_call_output',
        call_id: msg.toolCallId,
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
      });
      continue;
    }

    if (msg.toolCalls?.length > 0) {
      // Replay the assistant's own tool requests so the model sees them
      // next to the results we are handing back.
      for (const call of msg.toolCalls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.parameters ?? {}),
        });
      }
      const text = asText(msg.content);
      if (text) {
        input.push({ type: 'message', role: 'assistant', content: text });
      }
      continue;
    }

    input.push({
      type: 'message',
      role: msg.role === MessageRole.ASSISTANT ? 'assistant' : 'user',
      content: asText(msg.content),
    });
  }

  return { input, instructions: instructions.length > 0 ? instructions.join('\n\n') : undefined };
}

/**
 * Tool definitions in the flat Responses shape:
 * `{type:'function', name, description, parameters}`. Chat Completions'
 * nested `{type:'function', function:{...}}` is rejected here.
 */
export function buildPerplexityTools(tools: Tool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function buildPerplexityBody(
  provider: LlmProvider,
  request: ChatRequest,
  conversation: Conversation,
  tools: Tool[],
  stream: boolean,
): Record<string, unknown> {
  const { input, instructions } = buildPerplexityInput(request);
  const body: Record<string, unknown> = {
    model: requireModel(request, provider),
    input,
    // Required for anthropic/* models, harmless for the rest.
    max_output_tokens:
      request.maxTokens || conversation.context?.maxTokens || provider.configuration?.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
    stream,
  };
  if (instructions) body.instructions = instructions;

  const temperature = request.temperature ?? conversation.context?.temperature;
  if (temperature !== undefined && temperature !== null) body.temperature = temperature;
  const topP = request.topP ?? conversation.context?.topP;
  if (topP !== undefined && topP !== null) body.top_p = topP;

  if (tools.length > 0) body.tools = buildPerplexityTools(tools);
  return body;
}

/**
 * Pull the assistant text and any tool calls out of the `output` array.
 * `output` is NOT "the message at index 0": it interleaves
 * `search_results` and `function_call` items with the message, so every
 * item is matched by `type`.
 */
export function readPerplexityOutput(output: unknown): { content: string; toolCalls: ToolCall[]; status?: string } {
  const items = Array.isArray(output) ? output : [];
  let content = '';
  const toolCalls: ToolCall[] = [];

  for (const item of items as Array<Record<string, any>>) {
    if (item?.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (typeof part?.text === 'string') content += part.text;
      }
    } else if (item?.type === 'function_call') {
      let parameters: Record<string, any> = {};
      try {
        parameters = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        parameters = { __rawArguments: item.arguments, __parseError: true };
      }
      toolCalls.push({ id: item.call_id ?? item.id, name: item.name, parameters });
    }
  }

  return { content, toolCalls };
}

export async function callPerplexity(
  provider: LlmProvider,
  request: ChatRequest,
  conversation: Conversation,
  tools: Tool[],
  startTime: number,
  calculateProviderCost: (provider: LlmProvider, inputTokens: number, outputTokens: number) => number,
): Promise<ChatResponse> {
  const apiUrl = provider.getApiUrl();
  const headers = provider.getAuthHeaders();
  const body = buildPerplexityBody(provider, request, conversation, tools, false);

  const config: AxiosRequestConfig = {
    method: 'POST',
    url: `${apiUrl}/responses`,
    headers,
    data: body,
    timeout: provider.configuration.timeout || 30000,
    signal: request.signal,
  };

  const response: AxiosResponse = await callLlmProviderHttp(config, llmCallOptionsFor(provider));
  const responseTime = Date.now() - startTime;

  const { content, toolCalls } = readPerplexityOutput(response.data?.output);
  const usage = response.data?.usage ?? {};
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;

  return {
    message: {
      role: MessageRole.ASSISTANT,
      content: content || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      // The Agent API reports a run `status` ('completed'), not a
      // per-choice finish_reason.
      finishReason: response.data?.status,
    },
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
    },
    cost: calculateProviderCost(provider, inputTokens, outputTokens),
    model: response.data?.model || requireModel(request, provider),
    conversationId: conversation.id,
    messageId: '',
    responseTime,
  };
}

export async function callPerplexityStream(
  provider: LlmProvider,
  request: ChatRequest,
  conversation: Conversation,
  tools: Tool[],
  startTime: number,
  calculateProviderCost: (provider: LlmProvider, inputTokens: number, outputTokens: number) => number,
  onChunk: (chunk: StreamChunk) => void,
): Promise<ChatResponse> {
  const apiUrl = provider.getApiUrl();
  const headers = provider.getAuthHeaders();
  const body = buildPerplexityBody(provider, request, conversation, tools, true);

  const config: AxiosRequestConfig = {
    method: 'POST',
    url: `${apiUrl}/responses`,
    headers,
    data: body,
    timeout: provider.configuration.timeout || 30000,
    signal: request.signal,
  };

  const response: AxiosResponse = await callLlmProviderHttpStream(config, llmCallOptionsFor(provider));

  let content = '';
  let toolCalls: ToolCall[] = [];
  let modelName = '';
  let status = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;

  return new Promise<ChatResponse>((resolve, reject) => {
    let buffer = '';
    const stream = response.data as NodeJS.ReadableStream;

    stream.on('data', (rawChunk: Buffer) => {
      buffer += rawChunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6);
        if (jsonStr === '[DONE]') continue;

        try {
          const event = JSON.parse(jsonStr);
          // Only two event types are documented. Everything else is
          // ignored rather than guessed at, so an added event type cannot
          // corrupt the accumulated answer.
          if (event.type === 'response.output_text.delta') {
            if (typeof event.delta === 'string' && event.delta.length > 0) {
              content += event.delta;
              onChunk({ content: event.delta });
            }
          } else if (event.type === 'response.completed') {
            const done = event.response ?? {};
            if (done.model) modelName = done.model;
            if (done.status) status = done.status;
            const usage = done.usage ?? {};
            inputTokens = usage.input_tokens ?? 0;
            outputTokens = usage.output_tokens ?? 0;
            totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
            // The terminal event carries the completed output array, so
            // tool calls are read from it rather than reassembled from
            // deltas.
            const parsed = readPerplexityOutput(done.output);
            if (parsed.toolCalls.length > 0) toolCalls = parsed.toolCalls;
            if (!content && parsed.content) content = parsed.content;
          }
        } catch {
          // Malformed JSON line - skip
        }
      }
    });

    stream.on('end', () => {
      resolve({
        message: {
          role: MessageRole.ASSISTANT,
          content: content || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason: status,
        },
        usage: { inputTokens, outputTokens, totalTokens },
        cost: calculateProviderCost(provider, inputTokens, outputTokens),
        model: modelName || requireModel(request, provider),
        conversationId: conversation.id,
        messageId: '',
        responseTime: Date.now() - startTime,
      });
    });

    stream.on('error', (err: Error) => reject(err));
  });
}
