/**
 * Visual constants for LLM provider rows: emoji logos, status dot colors,
 * and health text colors. Shared by `pages/llm-providers.tsx`, the table
 * column factory, and the provider details sheet.
 */
import { LlmProviderType } from '@/types'

/**
 * Every provider type, with the name a person reads, in the order the
 * create form offers them. One list, because two hand-maintained ones
 * drift: the filter on the providers page was eight entries behind the
 * create form, so a provider you could create could not be filtered for.
 * `provider-types.test.ts` fails if an enum value has no entry here.
 */
export const providerTypeLabels: Record<LlmProviderType, string> = {
  [LlmProviderType.OPENAI]: 'OpenAI',
  [LlmProviderType.ANTHROPIC]: 'Anthropic',
  [LlmProviderType.GOOGLE]: 'Google Gemini',
  [LlmProviderType.MISTRAL]: 'Mistral AI',
  [LlmProviderType.XAI]: 'xAI (Grok)',
  [LlmProviderType.DEEPSEEK]: 'DeepSeek',
  [LlmProviderType.MOONSHOT]: 'Moonshot (Kimi)',
  [LlmProviderType.QWEN]: 'Qwen (QwenCloud)',
  [LlmProviderType.MINIMAX]: 'MiniMax',
  [LlmProviderType.UPSTAGE]: 'Upstage Solar',
  [LlmProviderType.WRITER]: 'Writer (Palmyra)',
  [LlmProviderType.QIANFAN]: 'Baidu ERNIE (Qianfan)',
  [LlmProviderType.HUNYUAN]: 'Tencent Hunyuan (TokenHub)',
  [LlmProviderType.VOLCENGINE]: 'ByteDance Doubao (Ark)',
  [LlmProviderType.SPARK]: 'iFlytek Spark',
  [LlmProviderType.ZAI]: 'Z.ai (GLM)',
  [LlmProviderType.COHERE]: 'Cohere',
  [LlmProviderType.PERPLEXITY]: 'Perplexity',
  [LlmProviderType.GROQ]: 'Groq',
  [LlmProviderType.TOGETHER]: 'Together AI',
  [LlmProviderType.OPENROUTER]: 'OpenRouter',
  [LlmProviderType.FIREWORKS]: 'Fireworks AI',
  [LlmProviderType.CEREBRAS]: 'Cerebras',
  [LlmProviderType.DEEPINFRA]: 'DeepInfra',
  [LlmProviderType.NOVITA]: 'Novita',
  [LlmProviderType.BASETEN]: 'Baseten',
  [LlmProviderType.NEBIUS]: 'Nebius Token Factory',
  [LlmProviderType.SAMBANOVA]: 'SambaNova',
  [LlmProviderType.HUGGINGFACE]: 'Hugging Face',
  [LlmProviderType.AZURE_OPENAI]: 'Azure OpenAI',
  [LlmProviderType.AZURE_AI_FOUNDRY]: 'Azure AI Foundry',
  [LlmProviderType.AWS_BEDROCK]: 'AWS Bedrock',
  [LlmProviderType.VERTEX_AI]: 'Google Vertex AI',
  [LlmProviderType.DIGITALOCEAN]: 'DigitalOcean Gradient',
  [LlmProviderType.RUNPOD]: 'RunPod',
  [LlmProviderType.MODAL]: 'Modal',
  [LlmProviderType.OLLAMA]: 'Ollama',
  [LlmProviderType.CUSTOM]: 'Custom',
}

/** The list both the create form and the page filter render. */
export const providerTypeOptions: { value: LlmProviderType; label: string }[] = (
  Object.entries(providerTypeLabels) as [LlmProviderType, string][]
).map(([value, label]) => ({ value, label }))

export const providerLogos: Record<string, string> = {
  openai: '🤖',
  anthropic: '🧠',
  google: '✦',
  mistral: '🔷',
  xai: '𝕏',
  deepseek: '🔮',
  groq: '⚡',
  together: '🤝',
  openrouter: '🔀',
  azure_openai: '☁️',
  aws_bedrock: '🪨',
  cohere: '🌀',
  huggingface: '🤗',
  ollama: '🦙',
  fireworks: '✧',
  cerebras: '◎',
  deepinfra: '∞',
  novita: '◈',
  perplexity: '◇',
  zai: '❋',
  baseten: '▣',
  nebius: '◉',
  sambanova: '◆',
  moonshot: '☾',
  qwen: '通',
  minimax: '∞',
  upstage: '☀',
  writer: '✍',
  qianfan: '熊',
  hunyuan: '鹅',
  volcengine: '豆',
  spark: '✦',
  vertex_ai: '▲',
  azure_ai_foundry: '⬡',
  digitalocean: '🌊',
  runpod: '⬢',
  modal: '◐',
  custom: '⚙️',
}

export const statusColors: Record<string, string> = {
  active: 'bg-emerald-500',
  inactive: 'bg-muted-foreground',
  error: 'bg-red-500',
  configuring: 'bg-yellow-500',
}

export const healthColors = {
  healthy: 'text-green-600',
  degraded: 'text-yellow-600',
  down: 'text-red-600',
  unknown: 'text-muted-foreground',
}

/**
 * Provider types whose first-party usage/cost API almyty can ingest for
 * cost reconciliation. Mirrors the backend capability map
 * (backend/src/modules/provider-usage/provider-usage.capability.ts) —
 * keep the two in sync. These APIs need an ADMIN-scoped key (OpenAI
 * sk-admin-..., Anthropic admin key), not the inference key, which is
 * why the dialogs collect a separate usageApiKey.
 */
export const providerUsageApiSupport: Record<string, { docsUrl: string }> = {
  openai: { docsUrl: 'https://platform.openai.com/docs/api-reference/usage' },
  anthropic: {
    docsUrl: 'https://docs.anthropic.com/en/api/admin-api/usage-cost/get-messages-usage-report',
  },
}

export function usageApiSupported(type?: string): boolean {
  return !!(type && providerUsageApiSupport[type])
}

/**
 * Where each provider's API key is created. Rendered as a "Get your API
 * key ↗" deep-link in the add/edit-provider dialog so onboarding doesn't
 * require hunting through each vendor's console. Mirrors the backend
 * catalog (llm-provider-catalog.ts getProviderKeyUrl); `custom` and
 * `custom` is intentionally absent (keys live at the user's own
 * endpoint). ollama links the CLOUD key page (ollama.com also runs a
 * hosted service); local mode is keyless — the dialog shows a setup
 * note instead of a key link).
 */
export const providerKeyUrls: Record<string, string> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
  mistral: 'https://console.mistral.ai/api-keys',
  xai: 'https://console.x.ai',
  deepseek: 'https://platform.deepseek.com/api_keys',
  groq: 'https://console.groq.com/keys',
  together: 'https://api.together.xyz/settings/api-keys',
  openrouter: 'https://openrouter.ai/keys',
  azure_openai: 'https://portal.azure.com',
  aws_bedrock: 'https://console.aws.amazon.com/bedrock',
  cohere: 'https://dashboard.cohere.com/api-keys',
  huggingface: 'https://huggingface.co/settings/tokens',
  ollama: 'https://ollama.com/settings/keys',
  // OpenAI-compatible inference hosts (backend catalog is the source of
  // truth; verified 2026-09-08 in docs/design/call-only-vendors.md).
  fireworks: 'https://app.fireworks.ai/settings/users/api-keys',
  cerebras: 'https://cloud.cerebras.ai',
  deepinfra: 'https://deepinfra.com/dash/api_keys',
  novita: 'https://novita.ai/settings/key-management',
  perplexity: 'https://console.perplexity.ai',
  zai: 'https://z.ai/manage-apikey/apikey-list',
  baseten: 'https://app.baseten.co/settings/api_keys',
  nebius: 'https://tokenfactory.nebius.com/settings/api-keys',
  sambanova: 'https://cloud.sambanova.ai/apis',
  // First-party model families and cloud / serverless call targets
  // (verified 2026-09-09).
  moonshot: 'https://platform.kimi.ai/console/api-keys',
  qwen: 'https://home.qwencloud.com/api-keys',
  minimax: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  upstage: 'https://console.upstage.ai/api-keys',
  writer: 'https://app.writer.com/aistudio/organization/api-keys',
  qianfan: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
  hunyuan: 'https://console.cloud.tencent.com/tokenhub/apikey',
  volcengine: 'https://ai.byteplus.com/ark/region:ap-southeast-1/apikey',
  spark: 'https://console.xfyun.cn/services/bmx1',
  vertex_ai: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
  azure_ai_foundry: 'https://ai.azure.com',
  digitalocean: 'https://cloud.digitalocean.com/model-studio/manage-keys',
  runpod: 'https://console.runpod.io/user/settings',
  modal: 'https://modal.com/docs/guide/endpoint-integrations',
}
