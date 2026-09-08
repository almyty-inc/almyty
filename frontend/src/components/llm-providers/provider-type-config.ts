/**
 * Visual constants for LLM provider rows: emoji logos, status dot colors,
 * and health text colors. Shared by `pages/llm-providers.tsx`, the table
 * column factory, and the provider details sheet.
 */

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
}
