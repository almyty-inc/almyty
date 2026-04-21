import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { Conversation } from '../../../entities/conversation.entity';
import { MessageRole, ToolCall } from '../../../entities/message.entity';
import { Tool } from '../../../entities/tool.entity';
import { ChatRequest, ChatResponse, StreamChunk } from '../llm-providers.service';
import { callLlmProviderHttp, callLlmProviderHttpStream } from './safe-request';

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

  // Extract system messages for Anthropic's system parameter
  const systemMessages = request.messages.filter(msg => msg.role === MessageRole.SYSTEM || msg.role === 'system' as MessageRole);
  const nonSystemMessages = request.messages.filter(msg => msg.role !== MessageRole.SYSTEM && msg.role !== 'system' as MessageRole);

  // Prepare Anthropic request
  const anthropicRequest: Record<string, unknown> = {
    model: request.model || provider.configuration.model || 'claude-sonnet-4-20250514',
    max_tokens: request.maxTokens || conversation.context?.maxTokens || 1024,
    temperature: request.temperature ?? conversation.context?.temperature,
    top_p: request.topP ?? conversation.context?.topP,
    stop_sequences: request.stopSequences || conversation.context?.stopSequences,
    messages: nonSystemMessages.map(msg => ({
      role: msg.role === MessageRole.ASSISTANT ? 'assistant' : 'user',
      content: msg.content,
    })),
  };

  // Add system prompt if present
  if (systemMessages.length > 0) {
    anthropicRequest.system = systemMessages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
  }

  // Add tools if available
  if (tools.length > 0) {
    anthropicRequest.tools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  const config: AxiosRequestConfig = {
    method: 'POST',
    url: `${apiUrl}/messages`,
    headers,
    data: anthropicRequest,
    timeout: provider.configuration.timeout || 30000,
    signal: request.signal,
  };

  const response: AxiosResponse = await callLlmProviderHttp(config);
  const responseTime = Date.now() - startTime;

  const usage = response.data.usage;

  const cost = calculateProviderCost(provider, usage.input_tokens, usage.output_tokens);

  // Process tool use
  let toolCalls: ToolCall[] = [];
  if (response.data.content) {
    const toolUseContent = response.data.content.find((c: { type: string }) => c.type === 'tool_use');
    if (toolUseContent) {
      toolCalls = [{
        id: toolUseContent.id,
        name: toolUseContent.name,
        parameters: toolUseContent.input,
      }];
    }
  }

  const textContent = response.data.content
    ?.filter((c: { type: string }) => c.type === 'text')
    ?.map((c: { text: string }) => c.text)
    ?.join(' ') || '';

  return {
    message: {
      role: MessageRole.ASSISTANT,
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: response.data.stop_reason,
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
function buildAnthropicRequestBody(
  provider: LlmProvider,
  request: ChatRequest,
  conversation: Conversation,
  tools: Tool[],
  stream: boolean,
): Record<string, unknown> {
  const systemMessages = request.messages.filter(msg => msg.role === MessageRole.SYSTEM || msg.role === 'system' as MessageRole);
  const nonSystemMessages = request.messages.filter(msg => msg.role !== MessageRole.SYSTEM && msg.role !== 'system' as MessageRole);

  const body: Record<string, unknown> = {
    model: request.model || provider.configuration.model || 'claude-sonnet-4-20250514',
    max_tokens: request.maxTokens || conversation.context?.maxTokens || 1024,
    temperature: request.temperature ?? conversation.context?.temperature,
    top_p: request.topP ?? conversation.context?.topP,
    stop_sequences: request.stopSequences || conversation.context?.stopSequences,
    stream,
    messages: nonSystemMessages.map(msg => ({
      role: msg.role === MessageRole.ASSISTANT ? 'assistant' : 'user',
      content: msg.content,
    })),
  };

  if (systemMessages.length > 0) {
    body.system = systemMessages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
  }

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

  const response: AxiosResponse = await callLlmProviderHttpStream(config);

  let contentAccumulator = '';
  let modelName = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = '';
  // Track tool use content blocks (Anthropic streams tool calls differently)
  const toolBlocks: Map<number, { id: string; name: string; inputJson: string }> = new Map();
  let currentBlockIndex = -1;
  let currentBlockType = '';

  return new Promise<ChatResponse>((resolve, reject) => {
    let buffer = '';
    let currentEventType = '';

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

            case 'content_block_start':
              currentBlockIndex = parsed.index ?? (currentBlockIndex + 1);
              currentBlockType = parsed.content_block?.type || '';
              if (currentBlockType === 'tool_use') {
                toolBlocks.set(currentBlockIndex, {
                  id: parsed.content_block.id || '',
                  name: parsed.content_block.name || '',
                  inputJson: '',
                });
              }
              break;

            case 'content_block_delta':
              if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
                contentAccumulator += parsed.delta.text;
                onChunk({ content: parsed.delta.text });
              }
              if (parsed.delta?.type === 'input_json_delta' && parsed.delta.partial_json) {
                const index = parsed.index ?? currentBlockIndex;
                const block = toolBlocks.get(index);
                if (block) {
                  block.inputJson += parsed.delta.partial_json;
                }
              }
              break;

            case 'message_delta':
              if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
              if (parsed.usage?.output_tokens) outputTokens = parsed.usage.output_tokens;
              break;
          }
        } catch {
          // Malformed JSON — skip
        }
      }
    });

    stream.on('end', () => {
      const responseTime = Date.now() - startTime;

      // Build tool calls from accumulated blocks
      let toolCalls: ToolCall[] = [];
      if (toolBlocks.size > 0) {
        toolCalls = Array.from(toolBlocks.values()).map(block => {
          let parameters: Record<string, any> = {};
          try {
            parameters = block.inputJson ? JSON.parse(block.inputJson) : {};
          } catch {
            parameters = { __rawArguments: block.inputJson, __parseError: true };
          }
          return { id: block.id, name: block.name, parameters };
        });
      }

      const cost = calculateProviderCost(provider, inputTokens, outputTokens);

      resolve({
        message: {
          role: MessageRole.ASSISTANT,
          content: contentAccumulator || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason: stopReason,
        },
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        cost,
        model: modelName || (request.model || provider.configuration.model || 'claude-sonnet-4-20250514'),
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
