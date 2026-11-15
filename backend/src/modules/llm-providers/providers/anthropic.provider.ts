import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { Conversation } from '../../../entities/conversation.entity';
import { MessageRole, ToolCall } from '../../../entities/message.entity';
import { Tool } from '../../../entities/tool.entity';
import { ChatRequest, ChatResponse, StreamChunk } from '../llm-providers.service';
import { stepKindSignal } from '../dto/llm-providers.dto';
import { callLlmProviderHttp, callLlmProviderHttpStream, llmCallOptionsFor } from './safe-request';
import { requireModel } from '../model-errors';
import { anthropicSystemPrompt, anthropicTurn, toAnthropicMessages, toolCallOf } from './anthropic-messages';


/**
 * Anthropic deprecates sampling params per model generation (e.g.
 * `temperature` is rejected with a 400 invalid_request_error on
 * claude-opus-4-8+). Callers like the provider health check set such
 * params unconditionally, so instead of hardcoding a model->param
 * matrix that rots, strip the named param and retry once when the API
 * tells us exactly which one it no longer accepts.
 */
const DEPRECATED_PARAM_RE = /`(\w+)` is deprecated/;

/**
 * The output limit sent when neither the call nor the model's card names
 * one (a model with no card yet). Anthropic needs a number; a model that
 * writes less refuses this one with its own most in the message, and the
 * call is made again with that (OUTPUT_LIMIT_RE). Never a low number: a
 * reply that runs into the limit has no answer (output-limit.ts).
 */
export const ANTHROPIC_UNCARDED_MAX_TOKENS = 64_000;

/** "max_tokens: 64000 > 8192, which is the maximum allowed number of output tokens for ..." */
const OUTPUT_LIMIT_RE = /max_tokens:\s*\d+\s*>\s*(\d+)/;

/**
 * A thinking block sent back after the conversation before it changed
 * (the system prompt carries the time of each step, and compaction folds
 * old turns) is refused on accounts the history check is enforced on. The
 * documented recovery: send the turns without their thinking blocks.
 */
const THINKING_REFUSED_RE = /thinking/i;
const THINKING_REFUSAL_DETAIL_RE = /signature|different conversation|thinking block/i;

function stripThinking(body: Record<string, unknown>): boolean {
  let stripped = false;
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  for (const message of messages ?? []) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const kept = message.content.filter((b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
    if (kept.length !== message.content.length) {
      message.content = kept;
      stripped = true;
    }
  }
  return stripped;
}

/**
 * Make the call, and make it again (once per kind) when the API says
 * exactly what to change: a sampling param this model no longer takes, an
 * output limit above the model's own, or thinking blocks it no longer
 * accepts back.
 */
export async function callWithDeprecatedParamRetry<T>(
  call: () => Promise<T>,
  body: Record<string, unknown>,
): Promise<T> {
  const fixed = new Set<string>();
  for (;;) {
    try {
      return await call();
    } catch (error: any) {
      const message = error?.response?.data?.error?.message;
      if (typeof message !== 'string') throw error;
      const deprecated = message.match(DEPRECATED_PARAM_RE);
      if (deprecated && deprecated[1] in body && !fixed.has(`param:${deprecated[1]}`)) {
        fixed.add(`param:${deprecated[1]}`);
        delete body[deprecated[1]];
        continue;
      }
      const limit = message.match(OUTPUT_LIMIT_RE);
      if (limit && !fixed.has('max_tokens') && Number(limit[1]) > 0) {
        fixed.add('max_tokens');
        body.max_tokens = Number(limit[1]);
        continue;
      }
      if (THINKING_REFUSED_RE.test(message) && THINKING_REFUSAL_DETAIL_RE.test(message) && !fixed.has('thinking') && stripThinking(body)) {
        fixed.add('thinking');
        continue;
      }
      throw error;
    }
  }
}

/** What a reply's content blocks say: its text, every tool call (a turn may make several) and the turn to send back with them. */
export function readAnthropicContent(blocks: Array<Record<string, any>> | undefined): {
  text: string;
  toolCalls: ToolCall[];
  providerContent: ReturnType<typeof anthropicTurn>;
} {
  const list = Array.isArray(blocks) ? blocks : [];
  return {
    text: list.filter((b) => b?.type === 'text').map((b) => b.text).join(' '),
    toolCalls: list.filter((b) => b?.type === 'tool_use').map(toolCallOf),
    providerContent: anthropicTurn(list),
  };
}


/**
 * Handles Anthropic Claude API calls.
 */
export async function callAnthropic(
  provider: LlmProvider,
  request: ChatRequest,
  conversation: Conversation,
  tools: Tool[],
  startTime: number,
  calculateProviderCost: (provider: LlmProvider, inputTokens: number, outputTokens: number) => number,
): Promise<ChatResponse> {
  const apiUrl = provider.getApiUrl();
  const headers = provider.getAuthHeaders();

  // The same body as the streaming path, so both send the same conversation.
  const anthropicRequest = buildAnthropicRequestBody(provider, request, conversation, tools, false);

  const config: AxiosRequestConfig = {
    method: 'POST',
    url: `${apiUrl}/messages`,
    headers,
    data: anthropicRequest,
    timeout: provider.configuration.timeout || 30000,
    signal: request.signal,
  };

  const response: AxiosResponse = await callWithDeprecatedParamRetry(
    () => callLlmProviderHttp(config, llmCallOptionsFor(provider)),
    anthropicRequest,
  );
  const responseTime = Date.now() - startTime;

  const usage = response.data.usage;

  const cost = calculateProviderCost(provider, usage.input_tokens, usage.output_tokens);

  const { text, toolCalls, providerContent } = readAnthropicContent(response.data.content);

  return {
    message: {
      role: MessageRole.ASSISTANT,
      content: text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: response.data.stop_reason,
      ...(providerContent ? { providerContent } : {}),
    },
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
    },
    cost,
    model: response.data.model,
    conversationId: conversation.id,
    messageId: '',
    responseTime,
  };
}

/**
 * Build the common Anthropic request body shared by both the
 * non-streaming and streaming paths.
 */
export function buildAnthropicRequestBody(
  provider: LlmProvider,
  request: ChatRequest,
  conversation: Conversation,
  tools: Tool[],
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: requireModel(request, provider),
    // The call's limit, which the runner sets from the model's card when
    // the caller names none (output-limit.ts).
    max_tokens: request.maxTokens || conversation?.context?.maxTokens || ANTHROPIC_UNCARDED_MAX_TOKENS,
    temperature: request.temperature ?? conversation?.context?.temperature,
    top_p: request.topP ?? conversation?.context?.topP,
    stop_sequences: request.stopSequences || conversation?.context?.stopSequences,
    stream,
    messages: toAnthropicMessages(request.messages, tools.length > 0),
  };

  const system = anthropicSystemPrompt(request.messages);
  if (system) body.system = system;

  if (tools.length > 0) {
    body.tools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  return body;
}

/**
 * Streaming Anthropic Claude API call. Parses the SSE response,
 * emitting `onChunk` for each content_block_delta text event,
 * and returns the full accumulated ChatResponse.
 *
 * Anthropic SSE event types:
 *   message_start        — contains model, usage.input_tokens
 *   content_block_start  — type=text or type=tool_use
 *   content_block_delta  — text_delta or input_json_delta
 *   content_block_stop
 *   message_delta        — stop_reason, usage.output_tokens
 *   message_stop
 */
export async function callAnthropicStream(
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

  const anthropicRequest = buildAnthropicRequestBody(provider, request, conversation, tools, true);

  const config: AxiosRequestConfig = {
    method: 'POST',
    url: `${apiUrl}/messages`,
    headers,
    data: anthropicRequest,
    timeout: provider.configuration.timeout || 30000,
    signal: request.signal,
  };

  const response: AxiosResponse = await callWithDeprecatedParamRetry(
    () => callLlmProviderHttpStream(config, llmCallOptionsFor(provider)).catch(readStreamedErrorBody),
    anthropicRequest,
  );

  let contentAccumulator = '';
  let modelName = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = '';
  // Every block of the reply by its index, as the API would have returned
  // it whole: the turn that is sent back with its tool calls.
  const blocks = new Map<number, Record<string, any>>();
  // Tool use blocks' input, streamed as JSON text.
  const toolBlocks: Map<number, { id: string; name: string; inputJson: string }> = new Map();
  let currentBlockIndex = -1;
  let currentBlockType = '';

  // Whether this reply is an answer or a tool step, reported once that
  // is certain. A Claude message can open with a text block and follow
  // it with a tool_use block, so text that has streamed says nothing
  // about the step: a tool_use block start makes it a tool step at once,
  // and a text step is only certain at message_delta, after every block
  // has closed. The one earlier certainty: a request that offered no
  // tools cannot get a tool_use block back.
  const stepKind = stepKindSignal(onChunk);
  if (tools.length === 0) stepKind.decide('text');

  return new Promise<ChatResponse>((resolve, reject) => {
    let buffer = '';
    let currentEventType = '';
    // An `error` event mid-stream (overloaded, for one): the call failed,
    // and must not settle as an empty reply.
    let streamError: Error | null = null;

    const stream = response.data as NodeJS.ReadableStream;

    stream.on('data', (rawChunk: Buffer) => {
      buffer += rawChunk.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Anthropic SSE uses "event: <type>" followed by "data: <json>"
        if (trimmed.startsWith('event: ')) {
          currentEventType = trimmed.slice(7);
          continue;
        }

        if (!trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6);

        try {
          const parsed = JSON.parse(jsonStr);

          switch (currentEventType) {
            case 'message_start':
              if (parsed.message?.model) modelName = parsed.message.model;
              if (parsed.message?.usage?.input_tokens) inputTokens = parsed.message.usage.input_tokens;
              break;

            case 'content_block_start': {
              currentBlockIndex = parsed.index ?? (currentBlockIndex + 1);
              currentBlockType = parsed.content_block?.type || '';
              const block = { ...(parsed.content_block ?? {}) };
              if (currentBlockType === 'text') block.text = block.text ?? '';
              if (currentBlockType === 'thinking') {
                block.thinking = block.thinking ?? '';
                block.signature = block.signature ?? '';
              }
              blocks.set(currentBlockIndex, block);
              if (currentBlockType === 'tool_use') {
                stepKind.decide('tool');
                toolBlocks.set(currentBlockIndex, {
                  id: parsed.content_block.id || '',
                  name: parsed.content_block.name || '',
                  inputJson: '',
                });
              }
              break;
            }

            case 'content_block_delta': {
              const index = parsed.index ?? currentBlockIndex;
              const block = blocks.get(index);
              if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
                contentAccumulator += parsed.delta.text;
                if (block) block.text = (block.text ?? '') + parsed.delta.text;
                onChunk({ content: parsed.delta.text });
              }
              if (parsed.delta?.type === 'thinking_delta' && block) {
                block.thinking = (block.thinking ?? '') + (parsed.delta.thinking ?? '');
              }
              if (parsed.delta?.type === 'signature_delta' && block) {
                block.signature = (block.signature ?? '') + (parsed.delta.signature ?? '');
              }
              if (parsed.delta?.type === 'input_json_delta' && parsed.delta.partial_json) {
                const toolBlock = toolBlocks.get(index);
                if (toolBlock) {
                  toolBlock.inputJson += parsed.delta.partial_json;
                }
              }
              break;
            }

            case 'message_delta':
              if (parsed.delta?.stop_reason) {
                stopReason = parsed.delta.stop_reason;
                // message_delta comes after the last content block has
                // closed; no block, tool_use or otherwise, can start after
                // it. This is the first point a text reply is certain.
                stepKind.decide(toolBlocks.size > 0 || stopReason === 'tool_use' ? 'tool' : 'text');
              }
              if (parsed.usage?.output_tokens) outputTokens = parsed.usage.output_tokens;
              break;

            case 'error':
              streamError = Object.assign(new Error(parsed.error?.message || 'The model stream reported an error'), {
                code: parsed.error?.type,
                status: parsed.error?.type === 'overloaded_error' ? 529 : undefined,
              });
              break;
          }
        } catch {
          // Malformed JSON — skip
        }
      }
    });

    stream.on('end', () => {
      if (streamError) {
        reject(streamError);
        return;
      }
      // A stream that ended without a message_delta: settle it on what
      // was accumulated, which is what the runtime will act on.
      stepKind.decide(toolBlocks.size > 0 ? 'tool' : 'text');
      const responseTime = Date.now() - startTime;

      // Build tool calls from accumulated blocks
      let toolCalls: ToolCall[] = [];
      if (toolBlocks.size > 0) {
        toolCalls = Array.from(toolBlocks.entries()).map(([index, block]) => {
          let parameters: Record<string, any> = {};
          let input: Record<string, any> = {};
          try {
            parameters = block.inputJson ? JSON.parse(block.inputJson) : {};
            input = parameters;
          } catch {
            parameters = { __rawArguments: block.inputJson, __parseError: true };
          }
          const whole = blocks.get(index);
          if (whole) whole.input = input;
          return { id: block.id, name: block.name, parameters };
        });
      }
      const providerContent = anthropicTurn(Array.from(blocks.entries()).sort(([a], [b]) => a - b).map(([, b]) => b));

      const cost = calculateProviderCost(provider, inputTokens, outputTokens);

      resolve({
        message: {
          role: MessageRole.ASSISTANT,
          content: contentAccumulator || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason: stopReason,
          ...(providerContent ? { providerContent } : {}),
        },
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        cost,
        model: modelName || requireModel(request, provider),
        conversationId: conversation.id,
        messageId: '',
        responseTime,
      });
    });

    stream.on('error', (err: Error) => {
      reject(err);
    });
  });
}

/**
 * A streamed call the API refused carries its error body as a stream;
 * read it, so the refusal says what it says (callWithDeprecatedParamRetry
 * and the error log read `error.response.data`).
 */
export async function readStreamedErrorBody(error: any): Promise<never> {
  const data = error?.response?.data;
  if (data && typeof data.on === 'function' && typeof data.pipe === 'function') {
    try {
      const text = await new Promise<string>((resolve, reject) => {
        let out = '';
        data.on('data', (c: Buffer) => {
          if (out.length < 65_536) out += c.toString();
        });
        data.on('end', () => resolve(out));
        data.on('error', reject);
      });
      try {
        error.response.data = JSON.parse(text);
      } catch {
        error.response.data = text;
      }
    } catch {
      // Leave the error as it was.
    }
  }
  throw error;
}