import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { LlmSession } from '../../../entities/llm-session.entity';
import { MessageRole } from '../../../entities/llm-message.entity';
import { Tool } from '../../../entities/tool.entity';
import { ChatRequest, ChatResponse } from '../llm-providers.service';
import { callLlmProviderHttp } from './safe-request';

/**
 * Handles Google Gemini API calls.
 */
export async function callGoogle(
  provider: LlmProvider,
  request: ChatRequest,
  session: LlmSession,
  tools: Tool[],
  startTime: number,
  calculateProviderCost: (provider: LlmProvider, inputTokens: number, outputTokens: number) => number,
): Promise<ChatResponse> {
  // Google Gemini API implementation
  const apiUrl = provider.getApiUrl();
  const apiKey = provider.configuration.apiKey;

  const googleRequest: Record<string, unknown> = {
    contents: request.messages.map(msg => ({
      role: msg.role === MessageRole.USER ? 'user' : 'model',
      parts: [{ text: msg.content }],
    })),
    generationConfig: {
      maxOutputTokens: request.maxTokens || session.context?.maxTokens,
      temperature: request.temperature ?? session.context?.temperature,
      topP: request.topP ?? session.context?.topP,
      topK: request.topK ?? session.context?.topK,
    },
  };

  // URL-encode the apiKey and the model id. Previously both were
  // interpolated raw, so a model id like `../../v1beta/chat` or a key
  // containing `&` / `#` would break URL parsing or inject extra
  // query params.
  const safeModel = encodeURIComponent(request.model || 'gemini-pro');
  const safeKey = encodeURIComponent(apiKey || '');
  const config: AxiosRequestConfig = {
    method: 'POST',
    url: `${apiUrl}/models/${safeModel}:generateContent?key=${safeKey}`,
    headers: {
      'Content-Type': 'application/json',
    },
    data: googleRequest,
    timeout: provider.configuration.timeout || 30000,
    signal: request.signal,
  };

  const response: AxiosResponse = await callLlmProviderHttp(config);
  const responseTime = Date.now() - startTime;

  const candidate = response.data.candidates?.[0];
  const content = candidate?.content?.parts?.[0]?.text || '';
  const usage = response.data.usageMetadata || {};

  const cost = calculateProviderCost(provider, usage.promptTokenCount || 0, usage.candidatesTokenCount || 0);

  return {
    message: {
      role: MessageRole.ASSISTANT,
      content,
      finishReason: candidate?.finishReason,
    },
    usage: {
      inputTokens: usage.promptTokenCount || 0,
      outputTokens: usage.candidatesTokenCount || 0,
      totalTokens: usage.totalTokenCount || 0,
    },
    cost,
    model: request.model || 'gemini-pro',
    sessionId: session.id,
    messageId: '',
    responseTime,
  };
}

/**
 * Handles Cohere API calls.
 */
export async function callCohere(
  provider: LlmProvider,
  request: ChatRequest,
  session: LlmSession,
  tools: Tool[],
  startTime: number,
  calculateProviderCost: (provider: LlmProvider, inputTokens: number, outputTokens: number) => number,
): Promise<ChatResponse> {
  // Cohere API implementation - simplified
  const apiUrl = provider.getApiUrl();
  const headers = provider.getAuthHeaders();

  const lastMessage = request.messages[request.messages.length - 1];
  const chatHistory = request.messages.slice(0, -1).map(msg => ({
    role: msg.role === MessageRole.USER ? 'USER' : 'CHATBOT',
    message: msg.content,
  }));

  const cohereRequest: Record<string, unknown> = {
    model: request.model || provider.configuration.model || 'command',
    message: lastMessage.content,
    chat_history: chatHistory,
    max_tokens: request.maxTokens || session.context?.maxTokens,
    temperature: request.temperature ?? session.context?.temperature,
    p: request.topP ?? session.context?.topP,
    k: request.topK ?? session.context?.topK,
    frequency_penalty: request.frequencyPenalty ?? session.context?.frequencyPenalty,
    presence_penalty: request.presencePenalty ?? session.context?.presencePenalty,
    stop_sequences: request.stopSequences || session.context?.stopSequences,
  };

  const config: AxiosRequestConfig = {
    method: 'POST',
    url: `${apiUrl}/chat`,
    headers,
    data: cohereRequest,
    timeout: provider.configuration.timeout || 30000,
    signal: request.signal,
  };

  const response: AxiosResponse = await callLlmProviderHttp(config);
  const responseTime = Date.now() - startTime;

  const inputTokens = JSON.stringify(cohereRequest).length / 4;
  const outputTokens = response.data.text?.length / 4 || 0;
  const cost = calculateProviderCost(provider, inputTokens, outputTokens);

  return {
    message: {
      role: MessageRole.ASSISTANT,
      content: response.data.text,
      finishReason: response.data.finish_reason,
    },
    usage: {
      inputTokens: Math.round(inputTokens),
      outputTokens: Math.round(outputTokens),
      totalTokens: Math.round(inputTokens + outputTokens),
    },
    cost,
    model: cohereRequest.model as string,
    sessionId: session.id,
    messageId: '',
    responseTime,
  };
}

/**
 * Handles HuggingFace Inference API calls.
 */
export async function callHuggingFace(
  provider: LlmProvider,
  request: ChatRequest,
  session: LlmSession,
  tools: Tool[],
  startTime: number,
): Promise<ChatResponse> {
  // HuggingFace Inference API implementation
  const apiUrl = provider.getApiUrl();
  const headers = provider.getAuthHeaders();

  const prompt = request.messages.map(msg => `${msg.role}: ${msg.content}`).join('\n') + '\nassistant:';

  const hfRequest: Record<string, unknown> = {
    inputs: prompt,
    parameters: {
      max_new_tokens: request.maxTokens || session.context?.maxTokens || 100,
      temperature: request.temperature ?? session.context?.temperature ?? 0.7,
      top_p: request.topP ?? session.context?.topP,
      top_k: request.topK ?? session.context?.topK,
      repetition_penalty: (request.frequencyPenalty || 0) + 1,
      stop_sequences: request.stopSequences || session.context?.stopSequences,
    },
  };

  const config: AxiosRequestConfig = {
    method: 'POST',
    url: `${apiUrl}/${request.model || provider.configuration.model}`,
    headers,
    data: hfRequest,
    timeout: provider.configuration.timeout || 30000,
    signal: request.signal,
  };

  const response: AxiosResponse = await callLlmProviderHttp(config);
  const responseTime = Date.now() - startTime;

  let content = '';
  if (Array.isArray(response.data) && response.data.length > 0) {
    content = response.data[0].generated_text || '';
    // Remove the original prompt from the response
    content = content.replace(prompt, '').trim();
  }

  // Approximate token counting (no usage info from HF)
  const inputTokens = prompt.length / 4;
  const outputTokens = content.length / 4;
  const cost = 0; // HuggingFace Inference API is often free

  return {
    message: {
      role: MessageRole.ASSISTANT,
      content,
      finishReason: 'stop',
    },
    usage: {
      inputTokens: Math.round(inputTokens),
      outputTokens: Math.round(outputTokens),
      totalTokens: Math.round(inputTokens + outputTokens),
    },
    cost,
    model: request.model || provider.configuration.model || 'unknown',
    sessionId: session.id,
    messageId: '',
    responseTime,
  };
}

/**
 * Handles custom/generic provider calls.
 */
export async function callCustomProvider(
  provider: LlmProvider,
  request: ChatRequest,
  session: LlmSession,
  tools: Tool[],
  startTime: number,
): Promise<ChatResponse> {
  // Custom provider implementation
  const apiUrl = provider.getApiUrl();
  const headers = provider.getAuthHeaders();

  let requestData: Record<string, unknown>;

  // Format based on custom configuration
  const requestFormat = provider.configuration.custom?.requestFormat || 'openai';

  if (requestFormat === 'openai') {
    requestData = {
      model: request.model || provider.configuration.model,
      messages: request.messages,
      max_tokens: request.maxTokens || session.context?.maxTokens,
      temperature: request.temperature ?? session.context?.temperature,
    };
  } else if (requestFormat === 'anthropic') {
    requestData = {
      model: request.model || provider.configuration.model,
      messages: request.messages,
      max_tokens: request.maxTokens || session.context?.maxTokens,
      temperature: request.temperature ?? session.context?.temperature,
    };
  } else {
    // Custom format
    requestData = {
      prompt: request.messages.map(m => m.content).join('\n'),
      max_tokens: request.maxTokens || session.context?.maxTokens,
      temperature: request.temperature ?? session.context?.temperature,
    };
  }

  const config: AxiosRequestConfig = {
    method: 'POST',
    url: apiUrl,
    headers,
    data: requestData,
    timeout: provider.configuration.timeout || 30000,
    signal: request.signal,
  };

  const response: AxiosResponse = await callLlmProviderHttp(config);
  const responseTime = Date.now() - startTime;

  // Try to parse response based on common formats
  let content = '';
  let usage = { inputTokens: 0, outputTokens: 0 };

  if (response.data.choices && response.data.choices[0]) {
    // OpenAI format
    content = response.data.choices[0].message?.content || response.data.choices[0].text || '';
    if (response.data.usage) {
      usage = {
        inputTokens: response.data.usage.prompt_tokens || 0,
        outputTokens: response.data.usage.completion_tokens || 0,
      };
    }
  } else if (response.data.content) {
    // Anthropic format
    content = Array.isArray(response.data.content)
      ? response.data.content.map((c: { text: string }) => c.text).join('')
      : response.data.content;
    if (response.data.usage) {
      usage = {
        inputTokens: response.data.usage.input_tokens || 0,
        outputTokens: response.data.usage.output_tokens || 0,
      };
    }
  } else if (response.data.text || response.data.response) {
    // Generic text response
    content = response.data.text || response.data.response || '';
  }

  // Fallback token counting
  if (usage.inputTokens === 0) {
    usage.inputTokens = Math.round(JSON.stringify(requestData).length / 4);
  }
  if (usage.outputTokens === 0) {
    usage.outputTokens = Math.round(content.length / 4);
  }

  return {
    message: {
      role: MessageRole.ASSISTANT,
      content,
      finishReason: 'stop',
    },
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
    },
    cost: 0, // Custom providers would need their own cost calculation
    model: request.model || provider.configuration.model || 'custom',
    sessionId: session.id,
    messageId: '',
    responseTime,
  };
}
