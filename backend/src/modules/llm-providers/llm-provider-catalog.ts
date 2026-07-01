import { LlmProviderType } from '../../entities/llm-provider.entity';

/**
 * Static catalog of LLM provider display data — display names,
 * marketing descriptions, and feature badges. Pulled out of
 * LlmProvidersController so the controller can stay focused on
 * the HTTP surface rather than hard-coded copy.
 */

export function getProviderDisplayName(type: LlmProviderType): string {
  const names: Record<string, string> = {
    [LlmProviderType.OPENAI]: 'OpenAI',
    [LlmProviderType.ANTHROPIC]: 'Anthropic',
    [LlmProviderType.GOOGLE]: 'Google Gemini',
    [LlmProviderType.MISTRAL]: 'Mistral AI',
    [LlmProviderType.XAI]: 'xAI',
    [LlmProviderType.DEEPSEEK]: 'DeepSeek',
    [LlmProviderType.GROQ]: 'Groq',
    [LlmProviderType.TOGETHER]: 'Together AI',
    [LlmProviderType.OPENROUTER]: 'OpenRouter',
    [LlmProviderType.AZURE_OPENAI]: 'Azure OpenAI',
    [LlmProviderType.AWS_BEDROCK]: 'AWS Bedrock',
    [LlmProviderType.COHERE]: 'Cohere',
    [LlmProviderType.HUGGINGFACE]: 'Hugging Face',
    [LlmProviderType.CUSTOM]: 'Custom',
  };
  return names[type] || type;
}

export function getProviderDescription(type: LlmProviderType): string {
  const descriptions: Record<string, string> = {
    [LlmProviderType.OPENAI]: 'GPT-4o, o3, o4-mini and more',
    [LlmProviderType.ANTHROPIC]: 'Claude Opus, Sonnet, and Haiku',
    [LlmProviderType.GOOGLE]: 'Gemini 2.0 Flash, Pro and more',
    [LlmProviderType.MISTRAL]: 'Mistral Large, Small, and Codestral',
    [LlmProviderType.XAI]: 'Grok models with real-time knowledge',
    [LlmProviderType.DEEPSEEK]: 'DeepSeek Chat and Reasoner',
    [LlmProviderType.GROQ]: 'Ultra-fast inference for open models',
    [LlmProviderType.TOGETHER]: 'Open-source models at scale',
    [LlmProviderType.OPENROUTER]: 'Unified access to 200+ models from all providers',
    [LlmProviderType.AZURE_OPENAI]: 'OpenAI models on Microsoft Azure',
    [LlmProviderType.AWS_BEDROCK]: 'Foundation models through AWS',
    [LlmProviderType.COHERE]: 'Enterprise language models',
    [LlmProviderType.HUGGINGFACE]: 'Open-source model inference',
    [LlmProviderType.CUSTOM]: 'Any OpenAI-compatible API endpoint',
  };
  return descriptions[type] || 'Custom AI model provider';
}

export function getProviderFeatures(type: LlmProviderType): string[] {
  const features: Record<string, string[]> = {
    [LlmProviderType.OPENAI]: ['Tool Use', 'Streaming', 'Vision', 'Reasoning'],
    [LlmProviderType.ANTHROPIC]: ['Tool Use', 'Streaming', 'Vision', '200K Context'],
    [LlmProviderType.GOOGLE]: ['Tool Use', 'Streaming', 'Vision', '1M Context'],
    [LlmProviderType.MISTRAL]: ['Tool Use', 'Streaming', 'Code Generation'],
    [LlmProviderType.XAI]: ['Tool Use', 'Streaming', 'Vision', 'Real-time Knowledge'],
    [LlmProviderType.DEEPSEEK]: ['Tool Use', 'Streaming', 'Reasoning'],
    [LlmProviderType.GROQ]: ['Tool Use', 'Streaming', 'Ultra-fast Inference'],
    [LlmProviderType.TOGETHER]: ['Tool Use', 'Streaming', 'Open Source Models'],
    [LlmProviderType.OPENROUTER]: ['Tool Use', 'Streaming', '200+ Models', 'Multi-Provider'],
    [LlmProviderType.AZURE_OPENAI]: ['Tool Use', 'Streaming', 'Enterprise Security'],
    [LlmProviderType.AWS_BEDROCK]: ['Multiple Providers', 'Enterprise Security'],
    [LlmProviderType.COHERE]: ['Tool Use', 'Streaming', 'Enterprise'],
    [LlmProviderType.HUGGINGFACE]: ['Open Source', 'Multiple Models'],
    [LlmProviderType.CUSTOM]: ['Flexible', 'Any OpenAI-Compatible API'],
  };
  return features[type] || [];
}

/**
 * Canonical page where a user creates/copies their API key for a
 * provider, shown as a "Get your API key" deep-link in the add-provider
 * dialog so onboarding doesn't require hunting through each vendor's
 * console.
 *
 * Return contract — deliberately three-valued so a newly-added provider
 * can't slip through unmapped:
 *   string    → the key-creation page
 *   null      → provider has no single canonical URL (e.g. CUSTOM, whose
 *               key location depends on the user's own endpoint)
 *   undefined → NOT mapped: a bug. The completeness test asserts every
 *               LlmProviderType is explicitly handled (string | null),
 *               so adding an enum value without a mapping fails CI.
 */
export function getProviderKeyUrl(type: LlmProviderType): string | null | undefined {
  const urls: Record<string, string | null> = {
    [LlmProviderType.OPENAI]: 'https://platform.openai.com/api-keys',
    [LlmProviderType.ANTHROPIC]: 'https://console.anthropic.com/settings/keys',
    [LlmProviderType.GOOGLE]: 'https://aistudio.google.com/apikey',
    [LlmProviderType.MISTRAL]: 'https://console.mistral.ai/api-keys',
    [LlmProviderType.XAI]: 'https://console.x.ai',
    [LlmProviderType.DEEPSEEK]: 'https://platform.deepseek.com/api_keys',
    [LlmProviderType.GROQ]: 'https://console.groq.com/keys',
    [LlmProviderType.TOGETHER]: 'https://api.together.xyz/settings/api-keys',
    [LlmProviderType.OPENROUTER]: 'https://openrouter.ai/keys',
    // Azure OpenAI + AWS Bedrock use cloud IAM credentials, not a simple
    // key — deep-link to where those live in each console.
    [LlmProviderType.AZURE_OPENAI]: 'https://portal.azure.com',
    [LlmProviderType.AWS_BEDROCK]: 'https://console.aws.amazon.com/bedrock',
    [LlmProviderType.COHERE]: 'https://dashboard.cohere.com/api-keys',
    [LlmProviderType.HUGGINGFACE]: 'https://huggingface.co/settings/tokens',
    [LlmProviderType.CUSTOM]: null,
  };
  return urls[type];
}

/**
 * Provider documentation home, shown as a secondary "Docs" link. Same
 * three-valued contract as getProviderKeyUrl.
 */
export function getProviderDocsUrl(type: LlmProviderType): string | null | undefined {
  const urls: Record<string, string | null> = {
    [LlmProviderType.OPENAI]: 'https://platform.openai.com/docs',
    [LlmProviderType.ANTHROPIC]: 'https://docs.anthropic.com',
    [LlmProviderType.GOOGLE]: 'https://ai.google.dev/docs',
    [LlmProviderType.MISTRAL]: 'https://docs.mistral.ai',
    [LlmProviderType.XAI]: 'https://docs.x.ai',
    [LlmProviderType.DEEPSEEK]: 'https://api-docs.deepseek.com',
    [LlmProviderType.GROQ]: 'https://console.groq.com/docs',
    [LlmProviderType.TOGETHER]: 'https://docs.together.ai',
    [LlmProviderType.OPENROUTER]: 'https://openrouter.ai/docs',
    [LlmProviderType.AZURE_OPENAI]: 'https://learn.microsoft.com/azure/ai-services/openai/',
    [LlmProviderType.AWS_BEDROCK]: 'https://docs.aws.amazon.com/bedrock/',
    [LlmProviderType.COHERE]: 'https://docs.cohere.com',
    [LlmProviderType.HUGGINGFACE]: 'https://huggingface.co/docs',
    [LlmProviderType.CUSTOM]: null,
  };
  return urls[type];
}
