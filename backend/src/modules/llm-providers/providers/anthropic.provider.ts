import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { LlmSession } from '../../../entities/llm-session.entity';
import { MessageRole, ToolCall } from '../../../entities/llm-message.entity';
import { Tool } from '../../../entities/tool.entity';
import { ChatRequest, ChatResponse } from '../llm-providers.service';
import { callLlmProviderHttp } from './safe-request';

/**
 * Handles Anthropic Claude API calls.
 */
export async function callAnthropic(
  provider: LlmProvider,
  request: ChatRequest,
  session: LlmSession,
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
    max_tokens: request.maxTokens || session.context?.maxTokens || 1024,
    temperature: request.temperature ?? session.context?.temperature,
    top_p: request.topP ?? session.context?.topP,
    stop_sequences: request.stopSequences || session.context?.stopSequences,
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
    sessionId: session.id,
    messageId: '',
    responseTime,
  };
}
