import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { Conversation } from '../../../entities/conversation.entity';
import { MessageRole, ToolCall } from '../../../entities/message.entity';
import { Tool } from '../../../entities/tool.entity';
import { ChatRequest, ChatResponse, StreamChunk } from '../llm-providers.service';
import { callLlmProviderHttp, callLlmProviderHttpStream } from './safe-request';

/**
 * Handles OpenAI-compatible provider calls (OpenAI, Azure OpenAI, Mistral, xAI,
 * DeepSeek, Groq, Together, OpenRouter).
 */
export async function callOpenAI(
  provider: LlmProvider,
  request: ChatRequest,
  conversation: Conversation,
  tools: Tool[],
  startTime: number,
  calculateProviderCost: (provider: LlmProvider, inputTokens: number, outputTokens: number) => number,
): Promise<ChatResponse> {
  const apiUrl = provider.getApiUrl();
  const headers = provider.getAuthHeaders();

  // Prepare OpenAI request
  const openaiRequest: Record<string, unknown> = {
    model: request.model || provider.configuration.model || 'gpt-4o',
    messages: request.messages.map(msg => {
      const openaiMsg: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.toolCalls?.length > 0) {
        openaiMsg.tool_calls = msg.toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.parameters),
          },
        }));
      }

      if (msg.toolCallId) {
        openaiMsg.tool_call_id = msg.toolCallId;
      }

      return openaiMsg;
    }),
    max_tokens: request.maxTokens || conversation.context?.maxTokens,
    temperature: request.temperature ?? conversation.context?.temperature,
    top_p: request.topP ?? conversation.context?.topP,
    frequency_penalty: request.frequencyPenalty ?? conversation.context?.frequencyPenalty,
    presence_penalty: request.presencePenalty ?? conversation.context?.presencePenalty,
    stop: request.stopSequences || conversation.context?.stopSequences,
    stream: request.stream || false,
  };

  // Add tools if available
  if (tools.length > 0) {
    openaiRequest.tools = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  const config: AxiosRequestConfig = {
    method: 'POST',
    url: `${apiUrl}/chat/completions`,
    headers,
    data: openaiRequest,
    timeout: provider.configuration.timeout || 30000,
    // Propagate the caller's cancellation context down to the
    // socket so a disconnected client doesn't leave the provider
    // call hanging for the full 30s timeout.
    signal: request.signal,
  };

  const response: AxiosResponse = await callLlmProviderHttp(config);
  const responseTime = Date.now() - startTime;

  const choice = response.data.choices[0];
  const usage = response.data.usage;

  const cost = calculateProviderCost(provider, usage.prompt_tokens, usage.completion_tokens);

  // Process tool calls. OpenAI occasionally emits malformed JSON for
  // arguments (truncated outputs, unescaped quotes from the model); a
  // raw JSON.parse would crash the entire request and leak a stack
  // trace. Fall back to an empty object and surface the raw text so
  // the caller can decide how to handle it.
  let toolCalls: ToolCall[] = [];
  if (choice.message.tool_calls) {
    toolCalls = choice.message.tool_calls.map(
      (tc: { id: string; function: { name: string; arguments: string } }) => {
        let parameters: Record<string, any> = {};
        try {
          parameters = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          parameters = { __rawArguments: tc.function.arguments, __parseError: true };
        }
        return {
          id: tc.id,
          name: tc.function.name,
          parameters,
        };
      },
    );
  }

  return {
    message: {
      role: MessageRole.ASSISTANT,
      content: choice.message.content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: choice.finish_reason,
    },
    usage: {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    },
    cost,
    model: response.data.model,
    conversationId: conversation.id,
    messageId: '',
    responseTime,
  };
}

/**
 * Build the common OpenAI request body shared by both the
 * non-streaming and streaming paths.
 */
function buildOpenAIRequestBody(
  provider: LlmProvider,
  request: ChatRequest,
  conversation: Conversation,
  tools: Tool[],
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model || provider.configuration.model || 'gpt-4o',
    messages: request.messages.map(msg => {
      const openaiMsg: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.toolCalls?.length > 0) {
        openaiMsg.tool_calls = msg.toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.parameters),
          },
        }));
      }

      if (msg.toolCallId) {
        openaiMsg.tool_call_id = msg.toolCallId;
      }

      return openaiMsg;
    }),
    max_tokens: request.maxTokens || conversation.context?.maxTokens,
    temperature: request.temperature ?? conversation.context?.temperature,
    top_p: request.topP ?? conversation.context?.topP,
    frequency_penalty: request.frequencyPenalty ?? conversation.context?.frequencyPenalty,
    presence_penalty: request.presencePenalty ?? conversation.context?.presencePenalty,
    stop: request.stopSequences || conversation.context?.stopSequences,
    stream,
  };

  if (stream) {
    // Request usage stats in the final stream chunk so we can
    // calculate cost without a second API call.
    body.stream_options = { include_usage: true };
  }

  if (tools.length > 0) {
    body.tools = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  return body;
}

/**
 * Streaming OpenAI-compatible provider call. Parses the SSE
 * response line-by-line, emitting `onChunk` for each content
 * delta, and returns the full accumulated ChatResponse.
 */
export async function callOpenAIStream(
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

  const openaiRequest = buildOpenAIRequestBody(provider, request, conversation, tools, true);

  const config: AxiosRequestConfig = {
    method: 'POST',
    url: `${apiUrl}/chat/completions`,
    headers,
    data: openaiRequest,
    timeout: provider.configuration.timeout || 30000,
    signal: request.signal,
  };

  const response: AxiosResponse = await callLlmProviderHttpStream(config);

  // Parse SSE stream
  let contentAccumulator = '';
  let finishReason = '';
  let modelName = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  const toolCallAccumulator: Map<number, { id: string; name: string; arguments: string }> = new Map();

  return new Promise<ChatResponse>((resolve, reject) => {
    let buffer = '';

    const stream = response.data as NodeJS.ReadableStream;

    stream.on('data', (rawChunk: Buffer) => {
      buffer += rawChunk.toString();

      // Process complete SSE lines
      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const jsonStr = trimmed.slice(6); // remove 'data: '
        if (jsonStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(jsonStr);

          if (parsed.model) {
            modelName = parsed.model;
          }

          // Usage stats arrive in the final chunk (stream_options.include_usage)
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens || 0;
            completionTokens = parsed.usage.completion_tokens || 0;
            totalTokens = parsed.usage.total_tokens || (promptTokens + completionTokens);
          }

          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          // Content delta
          if (delta.content) {
            contentAccumulator += delta.content;
            onChunk({ content: delta.content });
          }

          // Tool call deltas
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index ?? 0;
              if (!toolCallAccumulator.has(index)) {
                toolCallAccumulator.set(index, { id: tc.id || '', name: tc.function?.name || '', arguments: '' });
              }
              const entry = toolCallAccumulator.get(index)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            }
          }

          // Finish reason
          if (parsed.choices?.[0]?.finish_reason) {
            finishReason = parsed.choices[0].finish_reason;
          }
        } catch {
          // Malformed JSON line — skip
        }
      }
    });

    stream.on('end', () => {
      const responseTime = Date.now() - startTime;

      // Build tool calls from accumulated data
      let toolCalls: ToolCall[] = [];
      if (toolCallAccumulator.size > 0) {
        toolCalls = Array.from(toolCallAccumulator.values()).map(tc => {
          let parameters: Record<string, any> = {};
          try {
            parameters = tc.arguments ? JSON.parse(tc.arguments) : {};
          } catch {
            parameters = { __rawArguments: tc.arguments, __parseError: true };
          }
          return { id: tc.id, name: tc.name, parameters };
        });
      }

      const cost = calculateProviderCost(provider, promptTokens, completionTokens);

      resolve({
        message: {
          role: MessageRole.ASSISTANT,
          content: contentAccumulator || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason,
        },
        usage: {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          totalTokens,
        },
        cost,
        model: modelName || (request.model || provider.configuration.model || 'gpt-4o'),
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
