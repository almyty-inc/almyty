import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import { callLlmProviderHttp } from './providers/safe-request';
import { LlmProvider, LlmProviderType } from '../../entities/llm-provider.entity';

@Injectable()
export class LlmModelsHelper {
  private readonly logger = new Logger(LlmModelsHelper.name);

  async fetchModelsFromProvider(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    try {
      switch (provider.type) {
        case LlmProviderType.OPENAI:
        case LlmProviderType.MISTRAL:
        case LlmProviderType.XAI:
        case LlmProviderType.DEEPSEEK:
        case LlmProviderType.GROQ:
        case LlmProviderType.TOGETHER:
        case LlmProviderType.OPENROUTER:
          return this.fetchOpenAIModels(provider);
        case LlmProviderType.ANTHROPIC:
          return this.fetchAnthropicModels(provider);
        case LlmProviderType.GOOGLE:
          return this.fetchGoogleModels(provider);
        default:
          // For other providers, return the hardcoded defaults
          return this.getDefaultCapabilities(provider.type).supportedModels.map(m => ({
            id: m,
            name: m,
          }));
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch models from ${provider.type} API: ${error.message}`);
      // Fallback to hardcoded defaults
      return this.getDefaultCapabilities(provider.type).supportedModels.map(m => ({
        id: m,
        name: m,
      }));
    }
  }

  private async fetchOpenAIModels(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    const apiUrl = provider.configuration.apiUrl || 'https://api.openai.com/v1';
    // callLlmProviderHttp runs the SSRF gate and applies the shared
    // content / redirect hygiene defaults before delegating to axios.
    const response = await callLlmProviderHttp({
      method: 'GET',
      url: `${apiUrl}/models`,
      headers: {
        'Authorization': `Bearer ${provider.getDecryptedApiKey()}`,
      },
      timeout: 10000,
    });

    const models = response.data?.data || [];

    // Filter to chat-compatible models and sort by created date (newest first)
    const isOpenAI = provider.type === LlmProviderType.OPENAI;
    const chatModels = models
      .filter((m: any) => {
        const id = m.id?.toLowerCase() || '';
        // Always exclude non-chat models
        if (id.includes('embedding') || id.includes('whisper') || id.includes('tts')
          || id.includes('dall-e') || id.includes('realtime') || id.includes('moderation')) {
          return false;
        }
        // For OpenAI specifically, only include GPT and o-series models
        if (isOpenAI) {
          return id.includes('gpt') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4');
        }
        // For other OpenAI-compatible providers, include all non-excluded models
        return true;
      })
      .sort((a: any, b: any) => (b.created || 0) - (a.created || 0))
      .map((m: any) => ({
        id: m.id,
        name: m.id,
        created: m.created,
        owned_by: m.owned_by,
      }));

    return chatModels;
  }

  private async fetchAnthropicModels(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    const apiUrl = provider.configuration.apiUrl || 'https://api.anthropic.com/v1';
    const response = await callLlmProviderHttp({
      method: 'GET',
      url: `${apiUrl}/models`,
      headers: {
        'x-api-key': provider.getDecryptedApiKey(),
        'anthropic-version': provider.configuration.apiVersion || '2023-06-01',
      },
      timeout: 10000,
    });

    const models = response.data?.data || [];

    return models
      .sort((a: any, b: any) => {
        // Sort by created_at descending (newest first)
        const aDate = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bDate = b.created_at ? new Date(b.created_at).getTime() : 0;
        return bDate - aDate;
      })
      .map((m: any) => ({
        id: m.id,
        name: m.display_name || m.id,
        created: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : undefined,
        owned_by: 'anthropic',
      }));
  }

  private async fetchGoogleModels(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    const apiKey = provider.getDecryptedApiKey();
    // URL-encode the apiKey. The previous shape interpolated it raw,
    // so a key containing `&`, `#`, or a newline would have broken
    // URL parsing or injected extra query params. Google keys are
    // normally `[A-Za-z0-9_-]` only, but defence in depth.
    const target = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(apiKey || '')}`;
    const response = await callLlmProviderHttp({
      method: 'GET',
      url: target,
      timeout: 10000,
    });

    const models = response.data?.models || [];

    return models
      .filter((m: any) => {
        // Only include generative models
        const methods = m.supportedGenerationMethods || [];
        return methods.includes('generateContent');
      })
      .map((m: any) => ({
        id: m.name?.replace('models/', '') || m.name,
        name: m.displayName || m.name,
        owned_by: 'google',
      }));
  }

  /**
   * Fetch models by provider type and API key without needing a saved provider.
   * Used during provider creation to show available models before the provider is saved.
   */
  async fetchModelsByType(type: LlmProviderType, apiKey: string): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    // Create a temporary provider-like object
    const tempProvider = new LlmProvider();
    tempProvider.type = type;
    tempProvider.configuration = { apiKey };

    return this.fetchModelsFromProvider(tempProvider);
  }

  getDefaultCapabilities(type: LlmProviderType): LlmProvider['capabilities'] {
    const baseCapabilities = {
      supportedModels: [],
      maxTokens: 4096,
      supportsFunctionCalling: false,
      supportsStreaming: false,
      supportsBatching: false,
      supportsVision: false,
      supportsAudio: false,
      supportsToolUse: false,
      supportedToolFormats: [],
    };

    // Models are fetched dynamically from provider APIs via fetchModelsFromProvider().
    // These defaults only define capability flags — supportedModels is intentionally
    // empty because the real list comes from the API at runtime.
    const openaiCompatible = {
      ...baseCapabilities,
      supportedModels: [],
      supportsFunctionCalling: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportedToolFormats: ['openai'],
    };

    switch (type) {
      case LlmProviderType.OPENAI:
        return { ...openaiCompatible, maxTokens: 128000, supportsVision: true };

      case LlmProviderType.ANTHROPIC:
        return {
          ...baseCapabilities,
          supportedModels: [],
          maxTokens: 200000,
          supportsStreaming: true,
          supportsVision: true,
          supportsToolUse: true,
          supportedToolFormats: ['anthropic'],
        };

      case LlmProviderType.GOOGLE:
        return {
          ...baseCapabilities,
          supportedModels: [],
          maxTokens: 1000000,
          supportsStreaming: true,
          supportsVision: true,
          supportsToolUse: true,
          supportedToolFormats: ['google'],
        };

      case LlmProviderType.MISTRAL:
        return { ...openaiCompatible, maxTokens: 128000 };

      case LlmProviderType.XAI:
        return { ...openaiCompatible, maxTokens: 131072, supportsVision: true };

      case LlmProviderType.DEEPSEEK:
        return { ...openaiCompatible, maxTokens: 64000 };

      case LlmProviderType.GROQ:
        return { ...openaiCompatible, maxTokens: 131072 };

      case LlmProviderType.TOGETHER:
        return { ...openaiCompatible, maxTokens: 131072 };

      case LlmProviderType.OPENROUTER:
        return { ...openaiCompatible, maxTokens: 200000, supportsVision: true };

      case LlmProviderType.AZURE_OPENAI:
        return { ...openaiCompatible, maxTokens: 128000, supportsVision: true };

      case LlmProviderType.AWS_BEDROCK:
        return { ...baseCapabilities, supportedModels: [], maxTokens: 200000 };

      case LlmProviderType.COHERE:
        return { ...openaiCompatible, maxTokens: 128000 };

      case LlmProviderType.HUGGINGFACE:
        return { ...baseCapabilities, supportedModels: [], supportsStreaming: true };

      default:
        return baseCapabilities;
    }
  }

  /**
   * Calculate the cost of a provider call in dollars.
   * Uses configured pricing from metadata if available, otherwise falls back
   * to default pricing for well-known models.
   */
  calculateProviderCost(provider: LlmProvider, inputTokens: number, outputTokens: number): number {
    // 1. Use the provider's configured pricing from metadata if available
    const modelInfo = provider.metadata?.modelInfo;
    if (modelInfo?.inputTokenCost && modelInfo?.outputTokenCost) {
      return ((inputTokens / 1000) * modelInfo.inputTokenCost) + ((outputTokens / 1000) * modelInfo.outputTokenCost);
    }

    // 2. Fall back to default pricing for well-known models (per 1K tokens, in dollars)
    const model = (provider.configuration?.model || '').toLowerCase();
    const pricing = this.getDefaultModelPricing(model, provider.type);
    if (pricing) {
      return ((inputTokens / 1000) * pricing.input) + ((outputTokens / 1000) * pricing.output);
    }

    return 0;
  }

  /**
   * Default per-1K-token pricing for common models.
   * Returns { input, output } in dollars per 1K tokens, or null if model is unknown.
   */
  private getDefaultModelPricing(
    model: string,
    providerType: LlmProviderType,
  ): { input: number; output: number } | null {
    // OpenAI models
    if (model.includes('gpt-4o-mini')) return { input: 0.00015, output: 0.0006 };
    if (model.includes('gpt-4o')) return { input: 0.0025, output: 0.01 };
    if (model.includes('gpt-4-turbo') || model.includes('gpt-4-1106')) return { input: 0.01, output: 0.03 };
    if (model.includes('gpt-4')) return { input: 0.03, output: 0.06 };
    if (model.includes('gpt-3.5-turbo')) return { input: 0.0005, output: 0.0015 };
    if (model.includes('o1-mini')) return { input: 0.003, output: 0.012 };
    if (model.includes('o1')) return { input: 0.015, output: 0.06 };

    // Anthropic models
    if (model.includes('claude-3-5-sonnet') || model.includes('claude-sonnet-4')) return { input: 0.003, output: 0.015 };
    if (model.includes('claude-3-opus') || model.includes('claude-opus-4')) return { input: 0.015, output: 0.075 };
    if (model.includes('claude-3-5-haiku') || model.includes('claude-3-haiku')) return { input: 0.00025, output: 0.00125 };

    // Google models
    if (model.includes('gemini-1.5-pro')) return { input: 0.00125, output: 0.005 };
    if (model.includes('gemini-1.5-flash')) return { input: 0.000075, output: 0.0003 };
    if (model.includes('gemini-pro') || model.includes('gemini-2')) return { input: 0.00125, output: 0.005 };

    // DeepSeek models
    if (model.includes('deepseek-chat') || model.includes('deepseek-v3')) return { input: 0.00027, output: 0.0011 };
    if (model.includes('deepseek-reasoner') || model.includes('deepseek-r1')) return { input: 0.00055, output: 0.0022 };

    return null;
  }
}
