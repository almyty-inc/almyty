/**
 * Model deployments + registry versions, as the API returns them.
 * Mirrors backend/src/entities/model-deployment.entity.ts,
 * model-version.entity.ts and the adapter contract.
 */

export type RegistrySource = 's3' | 'hub' | 'local'

export interface AdapterCapabilities {
  architectures: string[] | 'any'
  lora: 'merged' | 'multi' | 'none'
  serverless: boolean
  dedicated: boolean
  scaleToZero: boolean
  /** Empty means the provider chooses. */
  regions: string[]
  registrySources: RegistrySource[]
}

/** The subset of JSON Schema adapters use for providerConfig. */
export interface JsonSchemaProperty {
  type?: 'string' | 'integer' | 'number' | 'boolean'
  title?: string
  description?: string
  default?: string | number | boolean
  enum?: Array<string | number>
  minimum?: number
  maximum?: number
  format?: string
  'x-secret'?: boolean
}

export interface JsonSchemaObject {
  type: 'object'
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
}

export interface ModelAdapter {
  key: string
  displayName: string
  capabilities: AdapterCapabilities
  configSchema: JsonSchemaObject
}

export type ModelDeploymentState =
  | 'pending'
  | 'deploying'
  | 'ready'
  | 'degraded'
  | 'scaling'
  | 'tearing_down'
  | 'orphaned'
  | 'torn_down'
  | 'failed'

export type PrivacyTier = 'local' | 'private_cloud' | 'public'

export interface ModelDeploymentDesired {
  hardware?: string
  replicas?: number
  minScale?: number
  maxScale?: number
  quantization?: string
  region?: string
  privacyTier?: PrivacyTier
}

export interface ModelDeploymentActual {
  state?: string
  url?: string
  replicas?: number
  hardware?: string
  region?: string
  message?: string
  spentCents?: number
  ratePerHourCents?: number
  costObservedAt?: string
  details?: Record<string, unknown>
}

export interface ModelDeployment {
  id: string
  organizationId?: string
  modelVersionId: string
  modelId: string | null
  providerType: string
  desired: ModelDeploymentDesired
  /** Secrets arrive masked as ********. */
  providerConfig: Record<string, unknown>
  externalRef: Record<string, unknown> | null
  actual: ModelDeploymentActual | null
  state: ModelDeploymentState
  lastReconcileAt: string | null
  lastError: string | null
  budgetId: string | null
  createdBy?: string | null
  createdAt: string
  updatedAt?: string
}

export interface CreateModelDeploymentBody {
  modelVersionId: string
  providerType: string
  desired?: ModelDeploymentDesired
  providerConfig?: Record<string, unknown>
  credentialId?: string
  connectionId?: string
  budgetId?: string
  modelId?: string
}

export interface ModelLineage {
  trainingJobId?: string
  datasetRef?: string
  parentVersionId?: string
}

/** What the API keeps about almyty-manifest.json under metadata.manifest: enough to describe, not the file list. */
export interface ModelManifestSummary {
  license: string
  tokenizer: string
  created: string
  fileCount: number
  chatTemplate?: string
}

export interface ModelVersionMetadata {
  /** Registry scheme the URI was parsed as. */
  scheme?: 's3' | 'hf' | 'file'
  /** Null when the URI carried no manifest (most hf:// repos). */
  manifest?: ModelManifestSummary | null
  [key: string]: unknown
}

export interface ModelVersion {
  id: string
  organizationId?: string
  name: string
  registryUri: string
  base: string
  /** bigint on the wire: a string, or null when unknown. */
  sizeBytes: string | number | null
  quantizations: string[]
  lineage: ModelLineage | null
  evalScores?: Record<string, unknown> | null
  manifestSha: string | null
  metadata: ModelVersionMetadata | null
  createdAt: string
  updatedAt?: string
}

export interface RegisterModelVersionBody {
  name: string
  registryUri: string
  /** Read from the manifest when present; required when the URI carries none. */
  base?: string
  quantizations?: string[]
  lineage?: ModelLineage
  metadata?: Record<string, unknown>
}

/** What the budgets API lists; no display name, so pickers describe the rule. */
export interface SpendBudgetSummary {
  id: string
  agentId: string | null
  llmProviderId: string | null
  periodType: 'day' | 'month'
  limitCents: number
  behavior: 'warn_log' | 'reject'
  active: boolean
}
