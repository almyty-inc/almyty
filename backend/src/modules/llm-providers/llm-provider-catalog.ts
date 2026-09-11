import { providerProfile } from './provider-profile';
import { LlmProviderType } from '../../entities/llm-provider.entity';

/**
 * Static catalog of LLM provider display data — display names,
 * marketing descriptions, and feature badges. Pulled out of
 * LlmProvidersController so the controller can stay focused on
 * the HTTP surface rather than hard-coded copy.
 */

/**
 * These maps carry the hand-written copy. Anything not in them falls back
 * to the vendor's provider profile, which already records the same facts,
 * so adding a vendor is a profile row rather than five map entries that
 * can drift out of step with each other.
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
    [LlmProviderType.OLLAMA]: 'Ollama',
    [LlmProviderType.FIREWORKS]: 'Fireworks AI',
    [LlmProviderType.CEREBRAS]: 'Cerebras',
    [LlmProviderType.DEEPINFRA]: 'DeepInfra',
    [LlmProviderType.NOVITA]: 'Novita',
    [LlmProviderType.PERPLEXITY]: 'Perplexity',
    [LlmProviderType.ZAI]: 'Z.ai',
    [LlmProviderType.BASETEN]: 'Baseten',
    [LlmProviderType.NEBIUS]: 'Nebius Token Factory',
    [LlmProviderType.SAMBANOVA]: 'SambaNova',
    [LlmProviderType.MOONSHOT]: 'Moonshot (Kimi)',
    [LlmProviderType.MINIMAX]: 'MiniMax',
    [LlmProviderType.UPSTAGE]: 'Upstage Solar',
    [LlmProviderType.WRITER]: 'Writer (Palmyra)',
    [LlmProviderType.QIANFAN]: 'Baidu ERNIE (Qianfan)',
    [LlmProviderType.HUNYUAN]: 'Tencent Hunyuan (TokenHub)',
    [LlmProviderType.VOLCENGINE]: 'ByteDance Doubao (Ark)',
    [LlmProviderType.SPARK]: 'iFlytek Spark',
    [LlmProviderType.QWEN]: 'Qwen (QwenCloud)',
    [LlmProviderType.VERTEX_AI]: 'Google Vertex AI',
    [LlmProviderType.AZURE_AI_FOUNDRY]: 'Azure AI Foundry',
    [LlmProviderType.DIGITALOCEAN]: 'DigitalOcean Gradient',
    [LlmProviderType.RUNPOD]: 'RunPod',
    [LlmProviderType.MODAL]: 'Modal',
    [LlmProviderType.CUSTOM]: 'Custom',
  };
  return names[type] ?? providerProfile(type)?.displayName ?? type;
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
    [LlmProviderType.OLLAMA]: 'Run open models locally — llama, qwen, mistral, and more',
    [LlmProviderType.FIREWORKS]: 'Fast serverless inference for open models',
    [LlmProviderType.CEREBRAS]: 'Wafer-scale inference for open models',
    [LlmProviderType.DEEPINFRA]: 'Low-cost hosting for open models',
    [LlmProviderType.NOVITA]: 'Open models with function calling and reasoning',
    [LlmProviderType.PERPLEXITY]: 'Sonar models with built-in web search',
    [LlmProviderType.ZAI]: 'GLM models from Zhipu',
    [LlmProviderType.BASETEN]: 'Model APIs for open frontier models',
    [LlmProviderType.NEBIUS]: 'Open models on Nebius Token Factory',
    [LlmProviderType.SAMBANOVA]: 'Fast inference for open models on SambaNova Cloud',
    [LlmProviderType.MOONSHOT]: 'Kimi K3 and the K2.7 coding models',
    [LlmProviderType.MINIMAX]: 'MiniMax M3 and the M2 family',
    [LlmProviderType.UPSTAGE]: 'Solar Pro 4 and Solar Mini',
    [LlmProviderType.WRITER]: 'Palmyra X6, X5 and the domain models',
    [LlmProviderType.QIANFAN]: 'ERNIE 5.1 and the open models Qianfan hosts',
    [LlmProviderType.HUNYUAN]: 'Hunyuan, plus DeepSeek, GLM, Kimi and MiniMax on TokenHub',
    [LlmProviderType.VOLCENGINE]: 'Doubao Seed 2.0, and DeepSeek on Ark',
    [LlmProviderType.SPARK]: 'Spark X2, X1.5 and the 4.0 Ultra line',
    [LlmProviderType.QWEN]: 'Qwen3 Max, Plus and Flash on QwenCloud',
    [LlmProviderType.VERTEX_AI]: 'Gemini and Model Garden in your own Google Cloud project',
    [LlmProviderType.AZURE_AI_FOUNDRY]: 'Your Foundry model deployments (DeepSeek, Llama, Grok, MAI)',
    [LlmProviderType.DIGITALOCEAN]: 'Serverless inference on DigitalOcean Gradient',
    [LlmProviderType.RUNPOD]: 'Public model endpoints and your own serverless workers',
    [LlmProviderType.MODAL]: 'Shared and dedicated endpoints on Modal',
    [LlmProviderType.CUSTOM]: 'Any OpenAI-compatible API endpoint',
  };
  return descriptions[type] ?? providerProfile(type)?.blurb ?? 'Custom AI model provider';
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
    [LlmProviderType.OLLAMA]: ['Tool Use', 'Streaming', 'Local Inference', 'Zero Cost'],
    [LlmProviderType.FIREWORKS]: ['Tool Use', 'Streaming', 'Open Source Models', 'Fast Inference'],
    [LlmProviderType.CEREBRAS]: ['Tool Use', 'Streaming', 'Ultra-fast Inference'],
    [LlmProviderType.DEEPINFRA]: ['Tool Use', 'Streaming', 'Open Source Models'],
    [LlmProviderType.NOVITA]: ['Tool Use', 'Streaming', 'Open Source Models'],
    [LlmProviderType.PERPLEXITY]: ['Streaming', 'Web Search', 'Citations'],
    [LlmProviderType.ZAI]: ['Tool Use', 'Streaming', 'Reasoning'],
    [LlmProviderType.BASETEN]: ['Tool Use', 'Streaming', 'Open Source Models'],
    [LlmProviderType.NEBIUS]: ['Tool Use', 'Streaming', 'Open Source Models'],
    [LlmProviderType.SAMBANOVA]: ['Tool Use', 'Streaming', 'Ultra-fast Inference'],
    [LlmProviderType.MOONSHOT]: ['Tool Use', 'Streaming', 'Vision', '1M Context'],
    [LlmProviderType.MINIMAX]: ['Tool Use', 'Streaming', 'Vision', '1M Context'],
    [LlmProviderType.UPSTAGE]: ['Tool Use', 'Streaming'],
    [LlmProviderType.WRITER]: ['Tool Use', 'Streaming', '1M Context'],
    [LlmProviderType.QIANFAN]: ['Tool Use', 'Streaming'],
    [LlmProviderType.HUNYUAN]: ['Tool Use', 'Streaming'],
    [LlmProviderType.VOLCENGINE]: ['Tool Use', 'Streaming', 'Vision'],
    [LlmProviderType.SPARK]: ['Tool Use', 'Streaming'],
    [LlmProviderType.QWEN]: ['Tool Use', 'Streaming', 'Vision', '1M Context'],
    [LlmProviderType.VERTEX_AI]: ['Tool Use', 'Streaming', 'Your GCP Project', 'Model Garden'],
    [LlmProviderType.AZURE_AI_FOUNDRY]: ['Tool Use', 'Streaming', 'Your Deployments', 'Enterprise Security'],
    [LlmProviderType.DIGITALOCEAN]: ['Streaming', 'Serverless', 'No Deployment'],
    [LlmProviderType.RUNPOD]: ['Streaming', 'Public Endpoints', 'Your Own Workers'],
    [LlmProviderType.MODAL]: ['Streaming', 'Shared Endpoints', 'Your Own Weights'],
    [LlmProviderType.CUSTOM]: ['Flexible', 'Any OpenAI-Compatible API'],
  };
  return features[type] ?? providerProfile(type)?.capabilities ?? [];
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
    // Ollama needs no API key — it runs on the user's own machine (an
    // optional key exists only for auth proxies), so like CUSTOM there
    // is no canonical key page.
    // Local Ollama needs no key; this is the CLOUD key page (ollama.com).
    [LlmProviderType.OLLAMA]: 'https://ollama.com/settings/keys',
    // OpenAI-compatible inference hosts (verified 2026-09-08, see
    // docs/design/call-only-vendors.md).
    [LlmProviderType.FIREWORKS]: 'https://app.fireworks.ai/settings/users/api-keys',
    [LlmProviderType.CEREBRAS]: 'https://cloud.cerebras.ai',
    [LlmProviderType.DEEPINFRA]: 'https://deepinfra.com/dash/api_keys',
    [LlmProviderType.NOVITA]: 'https://novita.ai/settings/key-management',
    [LlmProviderType.PERPLEXITY]: 'https://console.perplexity.ai',
    [LlmProviderType.ZAI]: 'https://z.ai/manage-apikey/apikey-list',
    [LlmProviderType.BASETEN]: 'https://app.baseten.co/settings/api_keys',
    [LlmProviderType.NEBIUS]: 'https://tokenfactory.nebius.com/settings/api-keys',
    [LlmProviderType.SAMBANOVA]: 'https://cloud.sambanova.ai/apis',
    // First-party model families and cloud/serverless call targets
    // (verified 2026-09-09).
    [LlmProviderType.MOONSHOT]: 'https://platform.kimi.ai/console/api-keys',
    [LlmProviderType.MINIMAX]: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    [LlmProviderType.UPSTAGE]: 'https://console.upstage.ai/api-keys',
    [LlmProviderType.WRITER]: 'https://app.writer.com/aistudio/organization/api-keys',
    [LlmProviderType.QIANFAN]: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
    [LlmProviderType.HUNYUAN]: 'https://console.cloud.tencent.com/tokenhub/apikey',
    [LlmProviderType.VOLCENGINE]: 'https://ai.byteplus.com/ark/region:ap-southeast-1/apikey',
    [LlmProviderType.SPARK]: 'https://console.xfyun.cn/services/bmx1',
    [LlmProviderType.QWEN]: 'https://home.qwencloud.com/api-keys',
    // Vertex takes a service-account key, not an API key.
    [LlmProviderType.VERTEX_AI]: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    [LlmProviderType.AZURE_AI_FOUNDRY]: 'https://ai.azure.com',
    [LlmProviderType.DIGITALOCEAN]: 'https://cloud.digitalocean.com/model-studio/manage-keys',
    [LlmProviderType.RUNPOD]: 'https://console.runpod.io/user/settings',
    // Modal's proxy token is minted with the CLI, not a console page.
    [LlmProviderType.MODAL]: 'https://modal.com/docs/guide/endpoint-integrations',
    [LlmProviderType.CUSTOM]: null,
  };
  return urls[type] ?? providerProfile(type)?.keyUrl ?? null;
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
    [LlmProviderType.OLLAMA]: 'https://ollama.com',
    [LlmProviderType.FIREWORKS]: 'https://docs.fireworks.ai',
    [LlmProviderType.CEREBRAS]: 'https://inference-docs.cerebras.ai',
    [LlmProviderType.DEEPINFRA]: 'https://docs.deepinfra.com',
    [LlmProviderType.NOVITA]: 'https://docs.novita.ai',
    [LlmProviderType.PERPLEXITY]: 'https://docs.perplexity.ai',
    [LlmProviderType.ZAI]: 'https://docs.z.ai',
    [LlmProviderType.BASETEN]: 'https://docs.baseten.co',
    [LlmProviderType.NEBIUS]: 'https://docs.tokenfactory.nebius.com',
    [LlmProviderType.SAMBANOVA]: 'https://docs.sambanova.ai',
    [LlmProviderType.MOONSHOT]: 'https://platform.kimi.ai/docs',
    [LlmProviderType.MINIMAX]: 'https://platform.minimax.io/docs/api-reference/text-chat-openai',
    [LlmProviderType.UPSTAGE]: 'https://console.upstage.ai/docs/capabilities/generate/chat',
    [LlmProviderType.WRITER]: 'https://dev.writer.com/api-reference/completion-api/chat-completion',
    [LlmProviderType.QIANFAN]: 'https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb',
    [LlmProviderType.HUNYUAN]: 'https://www.tencentcloud.com/act/pro/tokenhub',
    [LlmProviderType.VOLCENGINE]: 'https://docs.byteplus.com/en/docs/ModelArk/1494384',
    [LlmProviderType.SPARK]: 'https://www.xfyun.cn/doc/spark/X1http.html',
    [LlmProviderType.QWEN]: 'https://docs.qwencloud.com',
    [LlmProviderType.VERTEX_AI]: 'https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/openai',
    [LlmProviderType.AZURE_AI_FOUNDRY]: 'https://learn.microsoft.com/azure/ai-foundry/foundry-models/how-to/inference',
    [LlmProviderType.DIGITALOCEAN]: 'https://docs.digitalocean.com/products/inference/',
    [LlmProviderType.RUNPOD]: 'https://docs.runpod.io/public-endpoints/overview',
    [LlmProviderType.MODAL]: 'https://modal.com/docs/guide/endpoints',
    [LlmProviderType.CUSTOM]: null,
  };
  return urls[type] ?? providerProfile(type)?.docsUrl ?? null;
}
