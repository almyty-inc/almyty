import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import { callLlmProviderHttp, llmCallOptionsFor } from './providers/safe-request';
import { LlmProvider, LlmProviderType } from '../../entities/llm-provider.entity';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';

@Injectable()
export class LlmModelsHelper {
  private readonly logger = new Logger(LlmModelsHelper.name);

  constructor(private readonly envelopeCrypto: EnvelopeCryptoService) {}

  async fetchModelsFromProvider(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    // Warm the org's DEK cache so the sync getDecryptedApiKey reads below can
    // unwrap a customer-managed key. No-op for non-KMS orgs.
    await this.envelopeCrypto.warmOrg(provider.organizationId);
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
        case LlmProviderType.OLLAMA:
          // Native /api/tags — lists locally pulled models. Works
          // without an API key (fetchModelsByType may pass an empty
          // one for the pre-creation probe).
          return this.fetchOllamaModels(provider);
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
    // Per-type default base URL (api.mistral.ai for Mistral, api.groq.com
    // for Groq, ...). The previous hardcoded api.openai.com fallback broke
    // the models list for every OpenAI-compatible vendor in BOTH paths -
    // stored providers (401: their key went to OpenAI) and the pre-creation
    // fetchModelsByType probe (empty list, Codestral never surfaced) - and
    // sent foreign API keys to the wrong host. Found live on staging.
    const apiUrl = provider.getApiUrl() || 'https://api.openai.com/v1';
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
        // Always exclude non-chat models. 'embed' (not just 'embedding')
        // also catches Mistral's embedding models ('mistral-embed',
        // 'codestral-embed'), which its OpenAI-compat /models endpoint
        // lists alongside chat models. Codestral chat models
        // ('codestral-latest', 'codestral-2501', ...) pass through.
        if (id.includes('embed') || id.includes('whisper') || id.includes('tts')
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
    const target = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey || '')}`;
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
   * Ollama's native model list — GET <server>/api/tags. The OpenAI-compat
   * /v1/models endpoint exists on recent Ollama versions but /api/tags is
   * the canonical surface and includes locally pulled models only.
   *
   * Keyless by default: the Authorization header is attached only when a
   * key is configured (auth proxy in front of Ollama). The tags call runs
   * through callLlmProviderHttp with llmCallOptionsFor so the
   * OLLAMA_ALLOW_PRIVATE_URLS escape hatch applies here exactly like it
   * does for chat.
   */
  private async fetchOllamaModels(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    const baseUrl = provider.getOllamaBaseUrl();
    const headers: Record<string, string> = {};
    const apiKey = provider.getDecryptedApiKey();
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await callLlmProviderHttp(
      {
        method: 'GET',
        url: `${baseUrl}/api/tags`,
        headers,
        timeout: 10000,
      },
      llmCallOptionsFor(provider),
    );

    const models = response.data?.models || [];

    return models
      .map((m: any) => ({
        id: m.name || m.model,
        name: m.name || m.model,
        created: m.modified_at ? Math.floor(new Date(m.modified_at).getTime() / 1000) : undefined,
        owned_by: 'ollama',
      }))
      .filter((m: any) => !!m.id)
      .sort((a: any, b: any) => (b.created || 0) - (a.created || 0));
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

      case LlmProviderType.OLLAMA:
        // OpenAI-compatible /v1 surface with tool calling and streaming.
        // Context window varies per local model; 32k is a conservative
        // default users can raise per provider.
        return { ...openaiCompatible, maxTokens: 32768 };

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
    const pricing = getDefaultModelPricing(model, provider.type);
    if (pricing) {
      return ((inputTokens / 1000) * pricing.input) + ((outputTokens / 1000) * pricing.output);
    }

    return 0;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Default model pricing catalog
//
// Dollars per 1K tokens (published per-1M prices divided by 1000).
// Substring rules: the lowercased model id is matched against `match`
// via includes(); the FIRST matching rule in a provider's list wins, so
// more specific ids must precede their prefixes (gpt-4o-mini before
// gpt-4o, gpt-4.1 before gpt-4, ...).
//
// These are list prices for estimation only — reconciliation against
// provider actuals lives in the provider-usage module. Update the as-of
// comments when refreshing numbers.
// ────────────────────────────────────────────────────────────────────────

export interface DefaultModelPricing {
  /** Substring matched against the lowercased model id; first hit wins. */
  match: string;
  /** Dollars per 1K input tokens. */
  input: number;
  /** Dollars per 1K output tokens. */
  output: number;
}

// OpenAI list prices as of 2026-01 (platform.openai.com/docs/pricing).
const OPENAI_PRICING: DefaultModelPricing[] = [
  { match: 'gpt-5-mini', input: 0.00025, output: 0.002 },
  { match: 'gpt-5-nano', input: 0.00005, output: 0.0004 },
  { match: 'gpt-5', input: 0.00125, output: 0.01 },
  { match: 'gpt-4.1-mini', input: 0.0004, output: 0.0016 },
  { match: 'gpt-4.1-nano', input: 0.0001, output: 0.0004 },
  { match: 'gpt-4.1', input: 0.002, output: 0.008 },
  { match: 'gpt-4o-mini', input: 0.00015, output: 0.0006 },
  { match: 'gpt-4o', input: 0.0025, output: 0.01 },
  { match: 'gpt-4-turbo', input: 0.01, output: 0.03 },
  { match: 'gpt-4-1106', input: 0.01, output: 0.03 },
  { match: 'gpt-4', input: 0.03, output: 0.06 },
  { match: 'gpt-3.5-turbo', input: 0.0005, output: 0.0015 },
  { match: 'o4-mini', input: 0.0011, output: 0.0044 },
  { match: 'o3-mini', input: 0.0011, output: 0.0044 },
  { match: 'o3', input: 0.002, output: 0.008 },
  { match: 'o1-mini', input: 0.003, output: 0.012 },
  { match: 'o1', input: 0.015, output: 0.06 },
  { match: 'text-embedding-3-small', input: 0.00002, output: 0 },
  { match: 'text-embedding-3-large', input: 0.00013, output: 0 },
];

// Anthropic list prices as of 2026-01 (docs.anthropic.com pricing).
const ANTHROPIC_PRICING: DefaultModelPricing[] = [
  { match: 'claude-3-5-sonnet', input: 0.003, output: 0.015 },
  { match: 'claude-3-7-sonnet', input: 0.003, output: 0.015 },
  { match: 'claude-sonnet-4', input: 0.003, output: 0.015 },
  { match: 'claude-3-opus', input: 0.015, output: 0.075 },
  { match: 'claude-opus-4', input: 0.015, output: 0.075 },
  { match: 'claude-haiku-4', input: 0.001, output: 0.005 },
  { match: 'claude-3-5-haiku', input: 0.0008, output: 0.004 },
  { match: 'claude-3-haiku', input: 0.00025, output: 0.00125 },
];

// Google Gemini list prices as of 2026-01 (ai.google.dev/pricing);
// pro-tier prices are the <=200k-token prompt bracket.
const GOOGLE_PRICING: DefaultModelPricing[] = [
  { match: 'gemini-2.5-flash-lite', input: 0.0001, output: 0.0004 },
  { match: 'gemini-2.5-flash', input: 0.0003, output: 0.0025 },
  { match: 'gemini-2.5-pro', input: 0.00125, output: 0.01 },
  { match: 'gemini-2.0-flash', input: 0.0001, output: 0.0004 },
  { match: 'gemini-1.5-flash', input: 0.000075, output: 0.0003 },
  { match: 'gemini-1.5-pro', input: 0.00125, output: 0.005 },
  { match: 'gemini-pro', input: 0.00125, output: 0.005 },
  { match: 'gemini-2', input: 0.00125, output: 0.005 },
];

// Mistral La Plateforme list prices as of 2026-01 (mistral.ai/pricing).
const MISTRAL_PRICING: DefaultModelPricing[] = [
  { match: 'mistral-large', input: 0.002, output: 0.006 },
  { match: 'mistral-medium', input: 0.0004, output: 0.002 },
  { match: 'mistral-small', input: 0.0001, output: 0.0003 },
  { match: 'codestral', input: 0.0003, output: 0.0009 },
  { match: 'ministral-8b', input: 0.0001, output: 0.0001 },
  { match: 'ministral-3b', input: 0.00004, output: 0.00004 },
  { match: 'open-mistral-nemo', input: 0.00015, output: 0.00015 },
  { match: 'pixtral-large', input: 0.002, output: 0.006 },
  { match: 'pixtral', input: 0.00015, output: 0.00015 },
  // Embeddings are billed on input only.
  { match: 'mistral-embed', input: 0.0001, output: 0 },
];

// xAI list prices as of 2026-01 (docs.x.ai pricing).
const XAI_PRICING: DefaultModelPricing[] = [
  { match: 'grok-code', input: 0.0002, output: 0.0015 },
  { match: 'grok-4-fast', input: 0.0002, output: 0.0005 },
  { match: 'grok-4', input: 0.003, output: 0.015 },
  { match: 'grok-3-mini', input: 0.0003, output: 0.0005 },
  { match: 'grok-3', input: 0.003, output: 0.015 },
  { match: 'grok-2', input: 0.002, output: 0.01 },
];

// DeepSeek list prices as of 2026-01 (api-docs.deepseek.com pricing,
// cache-miss input rate).
const DEEPSEEK_PRICING: DefaultModelPricing[] = [
  { match: 'deepseek-chat', input: 0.00027, output: 0.0011 },
  { match: 'deepseek-v3', input: 0.00027, output: 0.0011 },
  { match: 'deepseek-reasoner', input: 0.00055, output: 0.0022 },
  { match: 'deepseek-r1', input: 0.00055, output: 0.0022 },
];

// Groq list prices as of 2026-01 (groq.com/pricing). Groq hosts open
// models at its own rates — do not reuse for other hosts.
const GROQ_PRICING: DefaultModelPricing[] = [
  { match: 'llama-4-scout', input: 0.00011, output: 0.00034 },
  { match: 'llama-4-maverick', input: 0.0002, output: 0.0006 },
  { match: 'llama-3.3-70b', input: 0.00059, output: 0.00079 },
  { match: 'llama-3.1-8b', input: 0.00005, output: 0.00008 },
  { match: 'gpt-oss-120b', input: 0.00015, output: 0.0006 },
  { match: 'gpt-oss-20b', input: 0.0001, output: 0.0005 },
  { match: 'gemma2', input: 0.0002, output: 0.0002 },
];

// Together list prices as of 2026-01 (together.ai/pricing).
const TOGETHER_PRICING: DefaultModelPricing[] = [
  { match: 'llama-4-scout', input: 0.00018, output: 0.00059 },
  { match: 'llama-4-maverick', input: 0.00027, output: 0.00085 },
  { match: 'llama-3.3-70b', input: 0.00088, output: 0.00088 },
  { match: 'llama-3.1-405b', input: 0.0035, output: 0.0035 },
  { match: 'llama-3.1-70b', input: 0.00088, output: 0.00088 },
  { match: 'llama-3.1-8b', input: 0.00018, output: 0.00018 },
  { match: 'qwen2.5-72b', input: 0.0012, output: 0.0012 },
];

// Cohere list prices as of 2026-01 (cohere.com/pricing).
const COHERE_PRICING: DefaultModelPricing[] = [
  { match: 'command-a', input: 0.0025, output: 0.01 },
  { match: 'command-r-plus', input: 0.0025, output: 0.01 },
  { match: 'command-r7b', input: 0.0000375, output: 0.00015 },
  { match: 'command-r', input: 0.00015, output: 0.0006 },
];

/**
 * Per-provider default pricing. A full Record so adding a new
 * LlmProviderType without deciding on pricing is a compile error; the
 * completeness spec additionally enforces non-empty tables for every
 * provider type whose chat dispatch computes cost from this catalog.
 *
 * Empty tables are deliberate:
 *  - AWS_BEDROCK has no chat dispatch implementation yet.
 *  - HUGGINGFACE and CUSTOM serve arbitrary models; their dispatch does
 *    not take the cost function and pricing must come from
 *    `metadata.modelInfo` on the provider.
 *  - OLLAMA is local inference and always costs $0. The zero table is
 *    load-bearing: getDefaultModelPricing() short-circuits for OLLAMA
 *    before the cross-provider fallback so a locally served
 *    'mistral-large' is never billed at Mistral's hosted list price.
 */
export const DEFAULT_MODEL_PRICING: Record<LlmProviderType, DefaultModelPricing[]> = {
  [LlmProviderType.OPENAI]: OPENAI_PRICING,
  // Azure OpenAI list prices track OpenAI's per-token list prices.
  [LlmProviderType.AZURE_OPENAI]: OPENAI_PRICING,
  [LlmProviderType.ANTHROPIC]: ANTHROPIC_PRICING,
  [LlmProviderType.GOOGLE]: GOOGLE_PRICING,
  [LlmProviderType.MISTRAL]: MISTRAL_PRICING,
  [LlmProviderType.XAI]: XAI_PRICING,
  [LlmProviderType.DEEPSEEK]: DEEPSEEK_PRICING,
  [LlmProviderType.GROQ]: GROQ_PRICING,
  [LlmProviderType.TOGETHER]: TOGETHER_PRICING,
  [LlmProviderType.COHERE]: COHERE_PRICING,
  // OpenRouter passes vendor models through at (approximately) vendor
  // list prices; ids like 'openai/gpt-4o' substring-match the vendor
  // rules. Groq/Together host-specific open-model rates are excluded —
  // OpenRouter routes those to many hosts at varying prices.
  [LlmProviderType.OPENROUTER]: [
    ...OPENAI_PRICING,
    ...ANTHROPIC_PRICING,
    ...GOOGLE_PRICING,
    ...MISTRAL_PRICING,
    ...XAI_PRICING,
    ...DEEPSEEK_PRICING,
    ...COHERE_PRICING,
  ],
  [LlmProviderType.AWS_BEDROCK]: [],
  [LlmProviderType.HUGGINGFACE]: [],
  // Zero-cost by design (local inference) — see doc comment above.
  [LlmProviderType.OLLAMA]: [],
  [LlmProviderType.CUSTOM]: [],
};

/**
 * Cross-provider fallback scan, preserving the historical behavior where
 * a known model name was priced regardless of provider type (e.g. a
 * CUSTOM provider proxying gpt-4o). Vendor tables only — host-specific
 * open-model rates (Groq/Together) are excluded because the same model
 * id costs different amounts per host.
 */
const GLOBAL_PRICING_FALLBACK: DefaultModelPricing[] = [
  ...OPENAI_PRICING,
  ...ANTHROPIC_PRICING,
  ...GOOGLE_PRICING,
  ...MISTRAL_PRICING,
  ...XAI_PRICING,
  ...DEEPSEEK_PRICING,
  ...COHERE_PRICING,
];

/**
 * Default pricing lookup for a (model, providerType) pair.
 * Returns { input, output } in dollars per 1K tokens, or null if unknown.
 */
export function getDefaultModelPricing(
  model: string,
  providerType: LlmProviderType,
): { input: number; output: number } | null {
  if (!model) return null;
  // Local inference is free: never price an Ollama-served model, and
  // never fall through to the global vendor fallback — a local
  // 'mistral-large' or 'gpt-oss' would otherwise be billed at the
  // hosted vendor's list price. Explicit per-provider overrides via
  // metadata.modelInfo still apply (handled in calculateProviderCost).
  if (providerType === LlmProviderType.OLLAMA) return null;
  const rules = DEFAULT_MODEL_PRICING[providerType] ?? [];
  for (const rule of rules) {
    if (model.includes(rule.match)) return { input: rule.input, output: rule.output };
  }
  for (const rule of GLOBAL_PRICING_FALLBACK) {
    if (model.includes(rule.match)) return { input: rule.input, output: rule.output };
  }
  return null;
}