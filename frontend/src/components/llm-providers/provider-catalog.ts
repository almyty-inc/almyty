/**
 * The provider tiles on /models/connect: every provider type, in the order a
 * person looks for them, with the name they know it by.
 *
 * `provider-catalog.test.ts` fails when a provider type has no tile, so a
 * type added to the enum cannot be left out of the one place a provider is
 * connected from.
 */
import { LlmProviderType } from '@/types'
import { providerKeyUrls, providerTypeLabels } from './provider-type-config'

export interface ProviderTileGroup {
  id: 'vendors' | 'fleet' | 'clouds' | 'own'
  title: string
  types: LlmProviderType[]
}

export const PROVIDER_TILE_GROUPS: ProviderTileGroup[] = [
  {
    id: 'vendors',
    title: 'Model makers',
    types: [
      LlmProviderType.OPENAI,
      LlmProviderType.ANTHROPIC,
      LlmProviderType.GOOGLE,
      LlmProviderType.MISTRAL,
      LlmProviderType.XAI,
      LlmProviderType.DEEPSEEK,
      LlmProviderType.COHERE,
      LlmProviderType.MOONSHOT,
      LlmProviderType.QWEN,
      LlmProviderType.MINIMAX,
      LlmProviderType.ZAI,
      LlmProviderType.UPSTAGE,
      LlmProviderType.WRITER,
      LlmProviderType.PERPLEXITY,
      LlmProviderType.QIANFAN,
      LlmProviderType.HUNYUAN,
      LlmProviderType.VOLCENGINE,
      LlmProviderType.SPARK,
    ],
  },
  {
    id: 'fleet',
    title: 'Open models, hosted for you',
    types: [
      LlmProviderType.GROQ,
      LlmProviderType.TOGETHER,
      LlmProviderType.OPENROUTER,
      LlmProviderType.FIREWORKS,
      LlmProviderType.CEREBRAS,
      LlmProviderType.DEEPINFRA,
      LlmProviderType.NOVITA,
      LlmProviderType.BASETEN,
      LlmProviderType.NEBIUS,
      LlmProviderType.SAMBANOVA,
      LlmProviderType.STRAITLY,
    ],
  },
  {
    id: 'clouds',
    title: 'Cloud accounts',
    types: [
      LlmProviderType.AZURE_OPENAI,
      LlmProviderType.AZURE_AI_FOUNDRY,
      LlmProviderType.AWS_BEDROCK,
      LlmProviderType.VERTEX_AI,
      LlmProviderType.DIGITALOCEAN,
      LlmProviderType.RUNPOD,
      LlmProviderType.MODAL,
      LlmProviderType.HUGGINGFACE,
    ],
  },
  {
    id: 'own',
    title: 'Your own',
    types: [LlmProviderType.CUSTOM, LlmProviderType.OLLAMA],
  },
]

/** Every tile, in display order. */
export const PROVIDER_TILE_ORDER: LlmProviderType[] = PROVIDER_TILE_GROUPS.flatMap((g) => g.types)

/** What a tile says. Only `custom` reads differently from its label elsewhere. */
export function providerTileLabel(type: string): string {
  if (type === LlmProviderType.CUSTOM) return 'Your own server (OpenAI-compatible)'
  return providerTypeLabels[type as LlmProviderType] || type
}

/** The name a new provider gets; editable later on its page. */
export function defaultProviderName(type: string): string {
  if (type === LlmProviderType.CUSTOM) return 'My server'
  return providerTypeLabels[type as LlmProviderType] || type
}

export function isProviderType(value: string | null | undefined): value is LlmProviderType {
  return !!value && (Object.values(LlmProviderType) as string[]).includes(value)
}

/** Types reached at a server URL the person gives (your own server, Ollama); the key is optional for both. */
export { baseUrlSupported as takesBaseUrl } from './schema'

export function keyUrlFor(type: string): string | undefined {
  return providerKeyUrls[type]
}

/**
 * The hosting integration (GET /model-adapters key) that starts open models
 * on this provider's cloud account. A provider page offers "Start a model"
 * only when the server has that integration and it takes Hugging Face
 * repositories.
 */
export const HOSTING_ADAPTER_FOR_TYPE: Partial<Record<LlmProviderType, string>> = {
  [LlmProviderType.HUGGINGFACE]: 'huggingface-endpoints',
  [LlmProviderType.MODAL]: 'modal',
  [LlmProviderType.AWS_BEDROCK]: 'aws-bedrock-import',
  [LlmProviderType.VERTEX_AI]: 'vertex',
  [LlmProviderType.AZURE_AI_FOUNDRY]: 'azure-foundry',
  [LlmProviderType.AZURE_OPENAI]: 'azure-foundry',
  [LlmProviderType.DIGITALOCEAN]: 'digitalocean',
  [LlmProviderType.RUNPOD]: 'runpod',
  [LlmProviderType.TOGETHER]: 'together',
  [LlmProviderType.FIREWORKS]: 'fireworks',
  [LlmProviderType.BASETEN]: 'baseten',
  [LlmProviderType.NEBIUS]: 'nebius',
}

/** Why POST /llm-providers/connect said no, in the words to show. */
export interface ConnectFailure {
  code: 'KEY_REJECTED' | 'CHECK_FAILED' | 'INVALID_CONFIGURATION' | string
  message: string
  detail?: string
  keyUrl?: string
}

/**
 * Reads a failed connect. The endpoint answers `{ success: false, error:
 * CODE, message, detail?, keyUrl? }`; the global exception filter's
 * `{ error: { code, message } }` shape is read too, and a request that
 * never reached the server is a network problem, said as such.
 */
export function readConnectFailure(error: unknown): ConnectFailure {
  const e = error as { response?: { data?: any }; message?: string } | undefined
  const data = e?.response?.data
  if (!e?.response) {
    return {
      code: 'CHECK_FAILED',
      message: 'Could not reach almyty to check the key. Try again in a moment.',
      detail: typeof e?.message === 'string' ? e.message : undefined,
    }
  }
  const nested = data && typeof data.error === 'object' && data.error !== null ? data.error : null
  const code = typeof data?.error === 'string' ? data.error : nested?.code || 'CHECK_FAILED'
  const message = (typeof data?.message === 'string' && data.message) || (typeof nested?.message === 'string' && nested.message) || 'The key could not be checked.'
  const detail = data?.detail ?? nested?.detail
  const keyUrl = data?.keyUrl ?? nested?.keyUrl
  return {
    code,
    message,
    ...(typeof detail === 'string' && detail ? { detail } : {}),
    ...(typeof keyUrl === 'string' && keyUrl ? { keyUrl } : {}),
  }
}
