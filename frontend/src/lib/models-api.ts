import { apiGet, apiPost, apiPatch } from './api'
import type {
  ListModelsQuery,
  ModelCard,
  SyncModelsResult,
  UpdateModelBody,
} from '@/types/models'

/**
 * The model catalog client. Every helper unwraps the `{ success, data }`
 * envelope, so callers get cards, not responses.
 */
export const modelsApi = {
  list: (query?: ListModelsQuery) =>
    apiGet<ModelCard[]>('/models', query && Object.keys(query).length ? { params: query } : undefined),

  get: (id: string) => apiGet<ModelCard>(`/models/${id}`),

  /** One provider when given; every configured provider when omitted. */
  sync: (providerId?: string) =>
    providerId
      ? apiPost<SyncModelsResult>('/models/sync', { providerId })
      : apiPost<SyncModelsResult>('/models/sync'),

  update: (id: string, body: UpdateModelBody) => apiPatch<ModelCard>(`/models/${id}`, body),

  /** The models an agent names that cannot be used now, and why (the banner on the agent). */
  agentIssues: (agentId: string) => apiGet<AgentModelIssue[]>(`/models/agents/${agentId}/issues`),
}

/** One model an agent names that is not usable now. */
export interface AgentModelIssue {
  model: string
  modelName: string
  providerId: string
  /** Null when you may not see the connection. */
  connectionName: string | null
  reason: string
  /** Where in the agent it is named: "model", "step Summarise", "role Checker". */
  where: string[]
  since: string | null
}

/** Formats a per-million-token price pair for a table cell. */
export function formatModelPrice(pricing: { inPerMTok: number; outPerMTok: number; currency?: string } | null | undefined): string {
  if (!pricing) return 'Price unknown'
  if (pricing.inPerMTok === 0 && pricing.outPerMTok === 0) return 'Free'
  const unit = pricing.currency && pricing.currency !== 'USD' ? ` ${pricing.currency}` : ''
  return `$${trimPrice(pricing.inPerMTok)} in / $${trimPrice(pricing.outPerMTok)} out${unit}`
}

function trimPrice(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 100) return n.toFixed(0)
  if (n >= 1) return n.toFixed(2)
  return String(Number(n.toFixed(4)))
}

export const PRICING_SOURCE_LABELS: Record<string, string> = {
  'feed:litellm': 'LiteLLM feed',
  'feed:openrouter': 'OpenRouter feed',
  native: 'Provider',
  adapter: 'Reported by your cloud',
  manual: 'Override',
  unpriced: 'Price unknown',
}
