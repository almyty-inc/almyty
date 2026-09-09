/**
 * LLM provider form schemas and shared types.
 *
 * Used by `pages/llm-providers.tsx` and the dialogs/columns under
 * `components/llm-providers/` to keep the create form, table, and detail
 * page in sync without re-declaring the entity shape in every file.
 */
import * as z from 'zod'

/** Types whose server URL is part of the form (sent as configuration.apiUrl). */
export function baseUrlSupported(type: string | undefined | null): type is 'ollama' | 'custom' {
  return type === 'ollama' || type === 'custom'
}

/** Shown under every Base URL field: the server refuses private hosts unless told otherwise. */
export const BASE_URL_PRIVATE_HOST_HINT =
  'Private or LAN hosts (10.x, 192.168.x, .internal, localhost) need LLM_ALLOW_PRIVATE_URLS=true on the almyty server.'

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

// Zod schema for create provider form with API key validation.
// Ollama is keyless (local inference; an optional key covers auth
// proxies) — every other type requires a key of at least 8 chars. A
// custom (OpenAI-compatible) provider has no default host, so its base
// URL is required.
export const createProviderSchema = z.object({
  name: z.string().min(1, 'Provider name is required'),
  type: z.string().min(1, 'Provider type is required'),
  apiKey: z.string().optional(),
  // Server URL, sent as configuration.apiUrl: optional for Ollama
  // (default http://localhost:11434), required for custom.
  apiUrl: z.string().optional(),
  organizationId: z.string().optional(),
  // Optional admin-scoped key for the provider's usage/cost API (issue
  // #241) — only rendered for types in providerUsageApiSupport.
  usageApiKey: z.string().optional(),
  // Set when the user connected an account through the connect sheet
  // instead of pasting a key; the backend resolves the secret from it.
  connectionId: z.string().optional(),
  // Set when the user picked an existing vault credential / connection.
  credentialId: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.type === 'custom' && !isHttpUrl(data.apiUrl)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Base URL is required (http or https)', path: ['apiUrl'] })
  }
  if (data.type === 'ollama') {
    // Key optional; when provided it still has to look like a token.
    if (data.apiKey && data.apiKey.length < 8) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'API key is too short', path: ['apiKey'] })
    }
    return
  }
  // A connected account or an existing connection stands in for the key.
  if (data.connectionId || data.credentialId) return
  if (!data.apiKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'API key is required', path: ['apiKey'] })
  } else if (data.apiKey.length < 8) {
    // Just check it's not comically short — actual validation happens
    // when we test the connection.
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'API key is too short', path: ['apiKey'] })
  }
})

export type CreateProviderFormData = z.infer<typeof createProviderSchema>


/** The API's placeholder for a stored key; never sent back as a key. */
export const MASKED_PROVIDER_KEY = '***masked***'

function isMasked(value: unknown): boolean {
  return typeof value === 'string' && /^\*+masked\*+$/.test(value)
}

/** A typed, non-masked key; anything else means "nothing pasted". */
function pastedKey(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && !isMasked(value) ? value : undefined
}

/**
 * POST /llm-providers body from the create form. A connected account or a
 * vault credential goes up as `credentialId`; a pasted key rides inside
 * `configuration`; the masked marker never does.
 */
export function buildProviderCreateBody(data: CreateProviderFormData): Record<string, any> {
  const credentialId = data.connectionId || data.credentialId || undefined
  const apiKey = credentialId ? undefined : pastedKey(data.apiKey)
  const usageApiKey = pastedKey(data.usageApiKey)
  return {
    name: data.name,
    type: data.type,
    ...(credentialId && { credentialId }),
    configuration: {
      // Ollama is keyless: only send the key when one was typed (the zod
      // schema enforces presence for all other types).
      ...(apiKey && { apiKey }),
      // Optional server URL (Ollama base URL field).
      ...(data.apiUrl && { apiUrl: data.apiUrl }),
      ...(data.organizationId && { organizationId: data.organizationId }),
      // Admin-scoped usage/cost API key, only when one was typed.
      ...(usageApiKey && { usageApiKey }),
    },
  }
}

export interface ProviderUpdateFormData {
  name?: string
  model?: string
  maxTokens?: number
  temperature?: number
  apiKey?: string
  usageApiKey?: string
  /** Server URL (ollama, custom); blank keeps the stored one. Sent as configuration.apiUrl. */
  apiUrl?: string
  /** undefined keeps the current connection, an id points at one, null clears it. */
  credentialId?: string | null
  usageCredentialId?: string | null
}

/**
 * PATCH /llm-providers/:id body from the edit form. `credentialId` /
 * `usageCredentialId` travel only when the form set them (a picked
 * connection or an explicit null); a blank or masked key is left out, so
 * the stored key survives an unrelated edit.
 */
export function buildProviderUpdateBody(data: ProviderUpdateFormData): Record<string, any> {
  const apiKey = data.credentialId ? undefined : pastedKey(data.apiKey)
  const usageApiKey = data.usageCredentialId ? undefined : pastedKey(data.usageApiKey)
  const apiUrl = typeof data.apiUrl === 'string' && data.apiUrl.trim() ? data.apiUrl.trim() : undefined
  return {
    name: data.name,
    ...(data.credentialId !== undefined && { credentialId: data.credentialId }),
    ...(data.usageCredentialId !== undefined && { usageCredentialId: data.usageCredentialId }),
    configuration: {
      model: data.model,
      maxTokens: data.maxTokens,
      temperature: data.temperature,
      ...(apiUrl && { apiUrl }),
      ...(apiKey && { apiKey }),
      ...(usageApiKey && { usageApiKey }),
    },
  }
}
export type LlmProviderType =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'mistral'
  | 'xai'
  | 'deepseek'
  | 'groq'
  | 'together'
  | 'openrouter'
  | 'azure_openai'
  | 'aws_bedrock'
  | 'cohere'
  | 'huggingface'
  | 'ollama'
  | 'fireworks'
  | 'cerebras'
  | 'deepinfra'
  | 'novita'
  | 'perplexity'
  | 'zai'
  | 'baseten'
  | 'nebius'
  | 'sambanova'
  | 'custom'

export type LlmProviderStatus = 'active' | 'inactive' | 'error' | 'configuring'

/** What the API shows about the connection backing a provider. Never the config. */
export interface LlmProviderCredentialRef {
  id: string
  name: string | null
  connectorKey: string | null
  healthStatus: string | null
}

export interface LlmProvider {
  id: string
  name: string
  description?: string
  type: LlmProviderType
  status: LlmProviderStatus
  organizationId: string
  /** The connection behind the inference key, when it is one. */
  credentialRef?: LlmProviderCredentialRef | null
  /** The connection behind the usage/admin key, when it is one. */
  usageCredentialRef?: LlmProviderCredentialRef | null
  configuration: {
    apiKey?: string
    usageApiKey?: string
    baseUrl?: string
    /** Server URL for ollama / custom (what the backend reads). */
    apiUrl?: string
    region?: string
    model?: string
    maxTokens?: number
    temperature?: number
    customHeaders?: Record<string, string>
  }
  capabilities?: {
    supportedModels: string[]
    maxTokens: number
    supportsFunctionCalling: boolean
    supportsStreaming: boolean
    supportsBatching: boolean
    supportsVision: boolean
    supportsAudio: boolean
    supportsToolUse: boolean
    supportedToolFormats: string[]
  }
  metadata?: any
  totalRequests: number
  successfulRequests: number
  totalTokensUsed: number
  totalCost: number
  lastRequestAt?: string
  lastHealthCheckAt?: string
  isHealthy: boolean
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface Model {
  id: string
  name: string
  description: string
  maxTokens: number
  pricing: {
    input: number  // per 1K tokens
    output: number // per 1K tokens
  }
  capabilities: string[]
  status: 'available' | 'deprecated' | 'beta'
}
