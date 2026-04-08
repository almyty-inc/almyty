import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { LlmSession } from '../../../entities/llm-session.entity';
import { MessageRole, ToolCall } from '../../../entities/llm-message.entity';
import { Tool } from '../../../entities/tool.entity';
import { ChatRequest, ChatResponse } from '../llm-providers.service';
import { callLlmProviderHttp } from './safe-request';

/**
 * Handles OpenAI-compatible provider calls (OpenAI, Azure OpenAI, Mistral, xAI,
 * DeepSeek, Groq, Together, OpenRouter).
 */
export async function callOpenAI(
  provider: LlmProvider,
  request: ChatRequest,
  session: LlmSession,
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
    max_tokens: request.maxTokens || session.context?.maxTokens,
    temperature: request.temperature ?? session.context?.temperature,
    top_p: request.topP ?? session.context?.topP,
    frequency_penalty: request.frequencyPenalty ?? session.context?.frequencyPenalty,
    presence_penalty: request.presencePenalty ?? session.context?.presencePenalty,
    stop: request.stopSequences || session.context?.stopSequences,
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
    sessionId: session.id,
    messageId: '',
    responseTime,
  };
}
