import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { Conversation } from '../../../entities/conversation.entity';
import { MessageRole } from '../../../entities/message.entity';
import { Tool } from '../../../entities/tool.entity';
import { ChatRequest, ChatResponse } from '../llm-providers.service';
import { callLlmProviderHttp } from './safe-request';
import { requireModel } from '../model-errors';


/**
 * Handles Google Gemini API calls.
 */
export async function callGoogle(
  provider: LlmProvider,
  request: ChatRequest,
  conversation: Conversation,
  tools: Tool[],
  startTime: number,
  calculateProviderCost: (provider: LlmProvider, inputTokens: number, outputTokens: number) => number,
): Promise<ChatResponse> {
  // Google Gemini API implementation
  const apiUrl = provider.getApiUrl();
  const apiKey = provider.getDecryptedApiKey();

  const googleRequest: Record<string, unknown> = {
    contents: request.messages.map(msg => ({
      role: msg.role === MessageRole.USER ? 'user' : 'model',
      parts: [{ text: msg.content }],
    })),
    generationConfig: {
      maxOutputTokens: request.maxTokens || conversation.context?.maxTokens,
      temperature: request.temperature ?? conversation.context?.temperature,
      topP: request.topP ?? conversation.context?.topP,
      topK: request.topK ?? conversation.context?.topK,
    },
  };

  // URL-encode the model id: a value like `../../v1beta/chat` would
  // otherwise escape the intended path. The API key travels in the
  // x-goog-api-key header (Google's documented scheme) rather than a
  // ?key= query parameter, which leaks the key into URLs and logs.
  const safeModel = encodeURIComponent(requireModel(request, provider));
  const config: AxiosRequestConfig = {
    method: 'POST',
    url: `${apiUrl}/models/${safeModel}:generateContent`,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
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
    model: requireModel(request, provider),
    conversationId: conversation.id,
    messageId: '',
    responseTime,
  };
}

/*
 * Cohere and Hugging Face used to have bespoke implementations here and no
 * longer do:
 *
 *  - Cohere's native /v2/chat is not OpenAI-shaped, and the code that
 *    targeted it still sent the v1 body (`message` + `chat_history`), so it
 *    could not have worked against the v2 path it was pointed at. Cohere
 *    now rides its OpenAI-compatible Compatibility API through callOpenAI.
 *  - Hugging Face's text-generation body (`inputs` / `generated_text`)
 *    targeted api-inference.huggingface.co, a host that no longer resolves
 *    in DNS. Hugging Face now rides the OpenAI-compatible Inference
 *    Providers router through callOpenAI.
 *
 * Both get streaming and tool calling for free as a result. See
 * docs/design/call-only-vendors.md (verified 2026-09-09).
 */

/**
 * Handles custom/generic provider calls.
 */
export async function callCustomProvider(
  provider: LlmProvider,
  request: ChatRequest,
  conversation: Conversation,
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
      max_tokens: request.maxTokens || conversation.context?.maxTokens,
      temperature: request.temperature ?? conversation.context?.temperature,
    };
  } else if (requestFormat === 'anthropic') {
    requestData = {
      model: request.model || provider.configuration.model,
      messages: request.messages,
      max_tokens: request.maxTokens || conversation.context?.maxTokens,
      temperature: request.temperature ?? conversation.context?.temperature,
    };
  } else {
    // Custom format
    requestData = {
      prompt: request.messages.map(m => m.content).join('\n'),
      max_tokens: request.maxTokens || conversation.context?.maxTokens,
      temperature: request.temperature ?? conversation.context?.temperature,
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
    model: requireModel(request, provider),
    conversationId: conversation.id,
    messageId: '',
    responseTime,
  };
}
