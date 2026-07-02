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
 * catalog (llm-provider-catalog.ts getProviderKeyUrl); `custom` is
 * intentionally absent (the key lives at the user's own endpoint).
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
}
