import { apiGet, apiPost, apiPatch, apiDel } from './api'
import type {
  ListModelsQuery,
  ModelCard,
  RegisterEndpointBody,
  RegisterModelBody,
  SyncModelsResult,
  UpdateModelBody,
  ValidateModelResult,
} from '@/types/models'

/**
 * The model catalog client. Every helper unwraps the `{ success, data }`
 * envelope, so callers get cards, not responses.
 */
export const modelsApi = {
  list: (query?: ListModelsQuery) =>
    apiGet<ModelCard[]>('/models', query && Object.keys(query).length ? { params: query } : undefined),

  get: (id: string) => apiGet<ModelCard>(`/models/${id}`),

  register: (body: RegisterModelBody) => apiPost<ModelCard>('/models', body),

  registerEndpoint: (body: RegisterEndpointBody) => apiPost<ModelCard>('/models/register-endpoint', body),

  /** One provider when given; every configured provider when omitted. */
  sync: (providerId?: string) =>
    providerId
      ? apiPost<SyncModelsResult>('/models/sync', { providerId })
      : apiPost<SyncModelsResult>('/models/sync'),

  update: (id: string, body: UpdateModelBody) => apiPatch<ModelCard>(`/models/${id}`, body),

  remove: (id: string) => apiDel<void>(`/models/${id}`),

  /** Runs one real call through the card. `passed` is the verdict; a failed run is not an HTTP error. */
  validate: (id: string) => apiPost<ValidateModelResult>(`/models/${id}/validate`),
}

/** Formats a per-million-token price pair for a table cell. */
export function formatModelPrice(pricing: { inPerMTok: number; outPerMTok: number; currency?: string } | null | undefined): string {
  if (!pricing) return 'Unpriced'
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
  adapter: 'Deployment',
  manual: 'Override',
  unpriced: 'No price',
}
