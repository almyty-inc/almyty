/**
 * Models layer types: catalog cards, routing policies, and the attribution a
 * routed call leaves on a run. Field meanings follow docs/models.md.
 */

export type ModelPrivacyTier = 'local' | 'private_cloud' | 'public'
export type ModelStatus = 'active' | 'inactive' | 'error' | 'deploying'
export type ModelPricingSource =
  | 'feed:litellm'
  | 'feed:openrouter'
  | 'native'
  | 'adapter'
  | 'manual'
  | 'unpriced'
export type ModelValidationStatus = 'never' | 'passed' | 'failed'

export const MODEL_PRIVACY_TIERS: ModelPrivacyTier[] = ['local', 'private_cloud', 'public']
export const MODEL_PRIVACY_TIER_LABELS: Record<ModelPrivacyTier, string> = {
  local: 'Local',
  private_cloud: 'Private cloud',
  public: 'Public',
}

export interface ModelCapabilities {
  tools?: boolean
  vision?: boolean
  reasoning?: boolean
  embedding?: boolean
  structuredOutput?: boolean
}

export type ModelCapabilityKey = keyof ModelCapabilities

export const MODEL_CAPABILITY_KEYS: ModelCapabilityKey[] = ['tools', 'vision', 'reasoning', 'embedding', 'structuredOutput']
export const MODEL_CAPABILITY_LABELS: Record<ModelCapabilityKey, string> = {
  tools: 'Tools',
  vision: 'Vision',
  reasoning: 'Reasoning',
  embedding: 'Embedding',
  structuredOutput: 'Structured output',
}

/** Dollars per million tokens. */
export interface ModelPricing {
  inPerMTok: number
  outPerMTok: number
  currency?: string
}

export interface ModelLatency {
  p50: number
  p95: number
  updatedAt: string
}

/** A card as GET /models returns it: the entity plus the two derived fields. */
export interface ModelCard {
  id: string
  organizationId: string
  name: string
  providerId: string | null
  providerType: string | null
  vendorModelId: string
  endpointRef: Record<string, any> | null
  base: string | null
  modelVersionId: string | null
  capabilities: ModelCapabilities
  contextLength: number | null
  pricing: ModelPricing | null
  pricingSource: ModelPricingSource
  pricingFetchedAt: string | null
  pricingOverride: ModelPricing | null
  measuredLatencyMs: ModelLatency | null
  privacyTier: ModelPrivacyTier
  region: string | null
  status: ModelStatus
  validationStatus: ModelValidationStatus
  lastValidatedAt: string | null
  lastValidationError: string | null
  metadata: Record<string, any> | null
  createdAt: string
  updatedAt: string
  /** status active + a dispatch path + a passing validation run. */
  selectable: boolean
  /** The override when set, else the feed price. */
  effectivePricing: ModelPricing | null
}

export interface ListModelsQuery {
  selectable?: boolean
  status?: ModelStatus
  privacyTier?: ModelPrivacyTier
  providerId?: string
}

export interface RegisterModelBody {
  name: string
  vendorModelId: string
  providerId?: string
  endpointRef?: Record<string, any>
  modelVersionId?: string
  capabilities?: ModelCapabilities
  contextLength?: number
  privacyTier?: ModelPrivacyTier
  region?: string
  pricingOverride?: ModelPricing
  base?: string
  metadata?: Record<string, any>
}

export interface RegisterEndpointBody {
  name: string
  url: string
  apiKey?: string
  vendorModelId: string
  capabilities?: ModelCapabilities
  contextLength?: number
  privacyTier?: ModelPrivacyTier
  region?: string
  pricingOverride?: ModelPricing
}

export interface UpdateModelBody {
  name?: string
  capabilities?: ModelCapabilities
  contextLength?: number | null
  privacyTier?: ModelPrivacyTier
  region?: string | null
  status?: ModelStatus
  /** null clears the override so the feed price applies again. */
  pricingOverride?: ModelPricing | null
  modelVersionId?: string | null
}

export interface ValidateModelResult {
  passed: boolean
  latencyMs: number
  error?: string
  model: ModelCard
}

export interface SyncModelsResult {
  created: ModelCard[]
  skipped: Array<{ vendorModelId: string; reason: string }> | string[] | number
}

export type RoutingObjective = 'cheapest' | 'fastest' | 'pinned'

export const ROUTING_OBJECTIVES: RoutingObjective[] = ['cheapest', 'fastest', 'pinned']
export const ROUTING_OBJECTIVE_LABELS: Record<RoutingObjective, string> = {
  cheapest: 'Cheapest',
  fastest: 'Fastest',
  pinned: 'Pinned card',
}

/** Goes on an llm_call node's config as `routing`, instead of a providerId. */
export interface RoutingPolicy {
  objective?: RoutingObjective
  /** Ceiling: local < private_cloud < public. */
  privacyTier?: ModelPrivacyTier
  regions?: string[]
  capabilities?: ModelCapabilities
  /** Card ids, in order. */
  fallbackChain?: string[]
  /** Card id, used when objective is `pinned`. */
  pinnedModel?: string
  budgetHeadroomCents?: number | null
}

/** What a routed call records on the run: nodeResults[nodeId].routing. */
export interface RouteAttribution {
  modelId: string
  modelVersionId: string | null
  vendorModelId: string
  providerId: string | null
  rationale: string
  attempt: number
  tried: Array<{ modelId: string; reason: string }>
  rejected: Array<{ modelId: string; reason: string }>
}
