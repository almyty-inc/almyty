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
