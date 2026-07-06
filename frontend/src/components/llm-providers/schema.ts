/**
 * LLM provider form schemas and shared types.
 *
 * Used by `pages/llm-providers.tsx` and the dialogs/columns under
 * `components/llm-providers/` to keep the create form, table, and detail
 * page in sync without re-declaring the entity shape in every file.
 */
import * as z from 'zod'

// Zod schema for create provider form with API key validation.
// Ollama is keyless (local inference; an optional key covers auth
// proxies) — every other type requires a key of at least 8 chars.
export const createProviderSchema = z.object({
  name: z.string().min(1, 'Provider name is required'),
  type: z.string().min(1, 'Provider type is required'),
  apiKey: z.string().optional(),
  // Optional server URL — currently surfaced for Ollama (default
  // http://localhost:11434).
  apiUrl: z.string().optional(),
  organizationId: z.string().optional(),
  // Optional admin-scoped key for the provider's usage/cost API (issue
  // #241) — only rendered for types in providerUsageApiSupport.
  usageApiKey: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.type === 'ollama') {
    // Key optional; when provided it still has to look like a token.
    if (data.apiKey && data.apiKey.length < 8) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'API key is too short', path: ['apiKey'] })
    }
    return
  }
  if (!data.apiKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'API key is required', path: ['apiKey'] })
  } else if (data.apiKey.length < 8) {
    // Just check it's not comically short — actual validation happens
    // when we test the connection.
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'API key is too short', path: ['apiKey'] })
  }
})

export type CreateProviderFormData = z.infer<typeof createProviderSchema>

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
  | 'custom'

export type LlmProviderStatus = 'active' | 'inactive' | 'error' | 'configuring'

export interface LlmProvider {
  id: string
  name: string
  description?: string
  type: LlmProviderType
  status: LlmProviderStatus
  organizationId: string
  configuration: {
    apiKey?: string
    usageApiKey?: string
    baseUrl?: string
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
