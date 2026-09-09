/**
 * Model deployments + registry versions, as the API returns them.
 * Mirrors backend/src/entities/model-deployment.entity.ts,
 * model-version.entity.ts and the adapter contract.
 */

export type RegistrySource = 'hub' | 's3' | 'gcs' | 'local'

/**
 * Where a model can live, as the backend's registry grammar names it.
 * Artifact schemes point at bytes and carry an `@pin`; provider schemes
 * name a model a platform already holds and version themselves.
 * Mirrors backend/src/modules/model-registry/registry-uri.ts.
 */
export type ArtifactScheme = 'hf' | 's3' | 'gs' | 'file'
export type ProviderScheme = 'bedrock' | 'sagemaker' | 'vertex' | 'foundry' | 'azureml' | 'fireworks' | 'together' | 'baseten'
export type ModelScheme = ArtifactScheme | ProviderScheme

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
  /**
   * Every kind of model this provider can actually run, as scheme prefixes
   * (`hf://`, `s3://`, `bedrock://`). The form filters both ways with it:
   * the providers that can run the model you have, and the sources a
   * provider you already picked will accept.
   */
  modelSchemes?: string[]
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
  /** Set only when an operator deployed a registered version. */
  modelVersionId: string | null
  /** The model as configuration, when there is no version row: hf://org/repo@sha, bedrock://..., fireworks://... */
  modelRef: string | null
  /** Architecture family the operator named alongside a modelRef. */
  modelBase: string | null
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
  /**
   * Where the model is, as configuration. The normal path: a Hugging Face
   * repository, or a model that already lives on a platform.
   */
  model?: string
  /** Architecture family, when the provider checks it and the reference carries none. */
  base?: string
  /** The operator path instead: a registered artifact this org tracks. */
  modelVersionId?: string
  providerType: string
  desired?: ModelDeploymentDesired
  providerConfig?: Record<string, unknown>
  credentialId?: string
  connectionId?: string
  budgetId?: string
  modelId?: string
}

/**
 * What the backend sends back when the provider cannot run the model:
 * `ADAPTER_UNSUPPORTED_SOURCE` with the schemes it does accept.
 */
export interface AdapterRefusal {
  code?: string
  message: string
  accepts: string[]
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
  scheme?: ModelScheme
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
