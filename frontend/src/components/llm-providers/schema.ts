/**
 * LLM provider form schemas and shared types.
 *
 * Used by `pages/llm-providers.tsx` and the dialogs/columns under
 * `components/llm-providers/` to keep the create form, table, and detail
 * page in sync without re-declaring the entity shape in every file.
 */
import * as z from 'zod'

// Zod schema for create provider form with API key validation
export const createProviderSchema = z.object({
  name: z.string().min(1, 'Provider name is required'),
  type: z.string().min(1, 'Provider type is required'),
  apiKey: z.string().min(1, 'API key is required'),
  organizationId: z.string().optional(),
}).refine((data) => {
  // Just check it's not empty — actual validation happens when we test the connection
  return data.apiKey.length >= 8
}, {
  message: 'API key is too short',
  path: ['apiKey'],
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
