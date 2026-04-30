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
