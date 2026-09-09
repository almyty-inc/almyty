import { apiDel, apiGet, apiPost } from '@/lib/api'
import type {
  AdapterRefusal,
  ArtifactScheme,
  CreateModelDeploymentBody,
  ModelAdapter,
  ModelDeployment,
  ModelDeploymentState,
  ModelManifestSummary,
  ModelScheme,
  ModelVersion,
  ProviderScheme,
  RegisterModelVersionBody,
} from '@/types/deployments'

// Deployment adapters + deployments: backend/src/modules/model-deployments.
export const modelAdaptersApi = {
  list: () => apiGet<ModelAdapter[]>('/model-adapters'),
}

export const modelDeploymentsApi = {
  list: () => apiGet<ModelDeployment[]>('/model-deployments'),
  get: (id: string) => apiGet<ModelDeployment>(`/model-deployments/${id}`),
  create: (body: CreateModelDeploymentBody) => apiPost<ModelDeployment>('/model-deployments', body),
  scale: (id: string, replicas: number) => apiPost<ModelDeployment>(`/model-deployments/${id}/scale`, { replicas }),
  teardown: (id: string) => apiPost<ModelDeployment>(`/model-deployments/${id}/teardown`, {}),
  delete: (id: string) => apiDel<ModelDeployment>(`/model-deployments/${id}`),
}

// Registry versions. The backend module (model-registry) has the service
// but no controller yet; these paths are the agreed contract.
export const modelVersionsApi = {
  list: () => apiGet<ModelVersion[]>('/model-versions'),
  get: (id: string) => apiGet<ModelVersion>(`/model-versions/${id}`),
  create: (body: RegisterModelVersionBody) => apiPost<ModelVersion>('/model-versions', body),
  delete: (id: string) => apiDel<void>(`/model-versions/${id}`),
}

/** How often the deployments list refetches while a row is still moving. */
export const DEPLOYMENT_POLL_MS = 15_000

/** States the reconcile loop is still working on; the list polls while any row is in one. */
const IN_FLIGHT_STATES: ReadonlySet<ModelDeploymentState> = new Set(['pending', 'deploying', 'scaling', 'tearing_down', 'degraded'])

export function isInFlightState(state: ModelDeploymentState): boolean {
  return IN_FLIGHT_STATES.has(state)
}

/** Nothing more will happen to these rows; they can be deleted. */
export function isTerminalState(state: ModelDeploymentState): boolean {
  return state === 'torn_down' || state === 'failed'
}

export function canScale(state: ModelDeploymentState): boolean {
  return state === 'ready' || state === 'degraded' || state === 'scaling' || state === 'deploying' || state === 'pending'
}

export function canTeardown(state: ModelDeploymentState): boolean {
  return !isTerminalState(state) && state !== 'tearing_down'
}

/**
 * The model-reference grammar, kept in step with
 * backend/src/modules/model-registry/registry-uri.ts so a bad reference is
 * caught in the form rather than by a 400.
 *
 * Artifact schemes point at bytes and must carry an `@pin`, because the
 * reference has to be immutable. Provider schemes name a model a platform
 * already holds, and the platform does its own versioning, so no pin is
 * required.
 */
export const ARTIFACT_SCHEMES: ArtifactScheme[] = ['hf', 's3', 'gs', 'file']
export const PROVIDER_SCHEMES: ProviderScheme[] = ['bedrock', 'sagemaker', 'vertex', 'foundry', 'azureml', 'fireworks', 'together', 'baseten']
export const MODEL_SCHEMES: ModelScheme[] = [...ARTIFACT_SCHEMES, ...PROVIDER_SCHEMES]

/** Legacy alias: versions still speak of a registry URI, which is the artifact half of this grammar. */
export type RegistryScheme = ModelScheme

export interface ParsedModelRef {
  scheme: ModelScheme
  /** `artifact` points at bytes; `provider` names a model a platform already holds. */
  kind: 'artifact' | 'provider'
  /** Bucket for s3 and gs, org/repo for hf, absolute path for file, the whole reference for a provider. */
  location: string
  /** Key prefix for object storage; empty otherwise. */
  prefix: string
  /** The etag, sha or digest pinning the bytes. Empty for a provider reference. */
  pin: string
  raw: string
}

export type ParsedRegistryUri = ParsedModelRef

export type ParseModelRefResult = { ok: true; value: ParsedModelRef } | { ok: false; error: string }

/** How each scheme is written and what to call it in a form. */
export interface SchemeMeta {
  scheme: ModelScheme
  kind: 'artifact' | 'provider'
  label: string
  example: string
  hint: string
}

export const SCHEME_META: Record<ModelScheme, SchemeMeta> = {
  hf: { scheme: 'hf', kind: 'artifact', label: 'Hugging Face repo', example: 'hf://org/repo@sha', hint: 'A repository on the Hub, pinned to a commit.' },
  s3: { scheme: 's3', kind: 'artifact', label: 'Amazon S3', example: 's3://bucket/prefix@etag', hint: 'A bucket the provider reads itself. The bytes never pass through almyty.' },
  gs: { scheme: 'gs', kind: 'artifact', label: 'Cloud Storage', example: 'gs://bucket/prefix@generation', hint: 'A Google Cloud Storage prefix the provider reads itself.' },
  file: { scheme: 'file', kind: 'artifact', label: 'Path on the host', example: 'file:///models/repo@sha', hint: 'An absolute path on the machine that serves the model.' },
  bedrock: { scheme: 'bedrock', kind: 'provider', label: 'Amazon Bedrock', example: 'bedrock://<model id or arn>', hint: 'A model already on Bedrock. Bedrock versions it.' },
  sagemaker: { scheme: 'sagemaker', kind: 'provider', label: 'SageMaker', example: 'sagemaker://model-package/<arn>', hint: 'A model package already in SageMaker.' },
  vertex: { scheme: 'vertex', kind: 'provider', label: 'Vertex AI', example: 'vertex://publishers/<publisher>/models/<model>', hint: 'A model already in the Vertex Model Garden.' },
  foundry: { scheme: 'foundry', kind: 'provider', label: 'Azure AI Foundry', example: 'foundry://<format>/<name>@<version>', hint: 'A model already in Azure AI Foundry.' },
  azureml: { scheme: 'azureml', kind: 'provider', label: 'Azure ML registry', example: 'azureml://registries/<registry>/models/<name>/labels/<label>', hint: 'A model already in an Azure ML registry.' },
  fireworks: { scheme: 'fireworks', kind: 'provider', label: 'Fireworks', example: 'fireworks://accounts/<account>/models/<model>', hint: 'A model you already uploaded to Fireworks.' },
  together: { scheme: 'together', kind: 'provider', label: 'Together', example: 'together://<owner>/<model>', hint: 'A model you already uploaded to Together.' },
  baseten: { scheme: 'baseten', kind: 'provider', label: 'Baseten', example: 'baseten://<model id>', hint: 'A model you already deployed on Baseten.' },
}

/** The scheme a reference opens with, whether or not the rest of it parses. */
export function schemeOf(raw: string): ModelScheme | null {
  const value = (raw ?? '').trim()
  const at = value.indexOf('://')
  if (at <= 0) return null
  const scheme = value.slice(0, at) as ModelScheme
  return MODEL_SCHEMES.includes(scheme) ? scheme : null
}

/** `hf` becomes `hf://`, which is how the adapter listing spells its schemes. */
export function schemePrefix(scheme: ModelScheme): string {
  return `${scheme}://`
}

const ARTIFACT_RE = new RegExp(`^(${ARTIFACT_SCHEMES.join('|')}):\\/\\/(.+?)@([A-Za-z0-9._:-]+)$`)

/**
 * Parse a model reference the way the backend does. Returns the parts, or
 * the message the field shows.
 */
export function parseModelRef(raw: string): ParseModelRefResult {
  const value = (raw ?? '').trim()
  if (!value) return { ok: false, error: 'Say where the model is, for example hf://org/repo@sha or fireworks://accounts/acme/models/support' }

  const scheme = schemeOf(value)
  if (scheme && PROVIDER_SCHEMES.includes(scheme as ProviderScheme)) {
    const body = value.slice(scheme.length + 3).trim()
    if (!body) return { ok: false, error: `Name the model after ${scheme}://, for example ${SCHEME_META[scheme].example}` }
    if (body.includes('..')) return { ok: false, error: 'A model reference may not contain ..' }
    const at = body.lastIndexOf('@')
    const pin = at > 0 && !body.slice(at + 1).includes('/') ? body.slice(at + 1) : ''
    return { ok: true, value: { scheme, kind: 'provider', location: body, prefix: '', pin, raw: value } }
  }

  const m = value.match(ARTIFACT_RE)
  if (!m) {
    if (scheme && ARTIFACT_SCHEMES.includes(scheme as ArtifactScheme)) {
      return { ok: false, error: `${scheme}:// points at bytes, so it needs an @pin: ${SCHEME_META[scheme].example}` }
    }
    return {
      ok: false,
      error: 'Point at an artifact with a pin (hf://org/repo@sha, s3://bucket/prefix@etag, gs://bucket/prefix@generation, file:///path@sha), or at a model already on a platform (bedrock://, fireworks://, together://, baseten://, vertex://, sagemaker://, foundry://, azureml://).',
    }
  }
  const artifactScheme = m[1] as ArtifactScheme
  const body = m[2]
  const pin = m[3]
  if (body.includes('..')) return { ok: false, error: 'A model reference may not contain ..' }
  if (artifactScheme === 's3' || artifactScheme === 'gs') {
    const slash = body.indexOf('/')
    const bucket = slash === -1 ? body : body.slice(0, slash)
    const prefix = slash === -1 ? '' : body.slice(slash + 1).replace(/\/+$/, '')
    if (!bucket) return { ok: false, error: `A ${artifactScheme}:// reference needs a bucket` }
    return { ok: true, value: { scheme: artifactScheme, kind: 'artifact', location: bucket, prefix, pin, raw: value } }
  }
  if (artifactScheme === 'hf') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(body)) return { ok: false, error: 'A Hugging Face reference must be hf://org/repo@sha' }
    return { ok: true, value: { scheme: artifactScheme, kind: 'artifact', location: body, prefix: '', pin, raw: value } }
  }
  if (!body.startsWith('/')) return { ok: false, error: 'A file:// reference must be an absolute path' }
  return { ok: true, value: { scheme: artifactScheme, kind: 'artifact', location: body, prefix: '', pin, raw: value } }
}

/** The Versions tab still calls it a registry URI; same grammar, same parser. */
export const parseRegistryUri = parseModelRef

/** One line describing what the form understood, for the field's helper text. */
export function describeModelRef(parsed: ParsedModelRef): string {
  const meta = SCHEME_META[parsed.scheme]
  if (parsed.kind === 'provider') {
    return parsed.pin ? `${meta.label}: ${parsed.location.slice(0, parsed.location.lastIndexOf('@'))}, version ${parsed.pin}` : `${meta.label}: ${parsed.location}`
  }
  const where = parsed.prefix ? `${parsed.location}/${parsed.prefix}` : parsed.location
  return `${meta.label}: ${where}, pinned to ${parsed.pin}`
}

/** The schemes an adapter says it can run, as bare schemes. */
export function adapterSchemes(adapter: Pick<ModelAdapter, 'modelSchemes'>): ModelScheme[] {
  return (adapter.modelSchemes ?? [])
    .map((s) => s.replace('://', '') as ModelScheme)
    .filter((s) => MODEL_SCHEMES.includes(s))
}

/** Whether this provider can run a model written with this scheme. */
export function adapterAccepts(adapter: Pick<ModelAdapter, 'modelSchemes'>, scheme: ModelScheme | null): boolean {
  if (!scheme) return false
  return adapterSchemes(adapter).includes(scheme)
}

export interface AdapterMatch {
  adapter: ModelAdapter
  ok: boolean
  /** Why this provider cannot run the model, in the user's terms. */
  reason?: string
}

/**
 * Which providers can run this model, and why the others cannot. Both the
 * verdict and the reason come from the adapter listing's `modelSchemes`,
 * so the form never holds a second copy of the compatibility rule.
 */
export function matchAdapters(adapters: ModelAdapter[], scheme: ModelScheme | null): AdapterMatch[] {
  if (!scheme) return adapters.map((adapter) => ({ adapter, ok: true }))
  const owners = adapters.filter((a) => adapterAccepts(a, scheme)).map((a) => a.displayName)
  const meta = SCHEME_META[scheme]
  return adapters.map((adapter) => {
    if (adapterAccepts(adapter, scheme)) return { adapter, ok: true }
    if (meta.kind === 'provider') {
      return {
        adapter,
        ok: false,
        reason: owners.length
          ? `${schemePrefix(scheme)} names a model on ${owners.join(' or ')}, and only that provider can run it`
          : `${schemePrefix(scheme)} names a model held by ${SCHEME_META[scheme].label}, and only that provider can run it`,
      }
    }
    const accepted = adapterSchemes(adapter).map(schemePrefix)
    return {
      adapter,
      ok: false,
      reason: accepted.length
        ? `${adapter.displayName} reads ${accepted.join(', ')}, not ${schemePrefix(scheme)}`
        : `${adapter.displayName} does not say which sources it reads`,
    }
  })
}

/** The providers that can run this model, nothing else. */
export function runnableAdapters(adapters: ModelAdapter[], scheme: ModelScheme | null): ModelAdapter[] {
  return matchAdapters(adapters, scheme).filter((m) => m.ok).map((m) => m.adapter)
}

/**
 * Read the backend's ADAPTER_UNSUPPORTED_SOURCE refusal off an axios error,
 * so the form can show what the provider does accept instead of a bare 400.
 */
export function readAdapterRefusal(error: unknown): AdapterRefusal | null {
  const data = (error as { response?: { data?: any } })?.response?.data
  if (!data) return null
  const accepts = Array.isArray(data.accepts) ? data.accepts.filter((a: unknown): a is string => typeof a === 'string') : []
  const message = typeof data.message === 'string' ? data.message : ''
  if (!message) return null
  if (!accepts.length && data.code !== 'ADAPTER_UNSUPPORTED_SOURCE' && data.code !== 'REGISTRY_URI_INVALID' && data.code !== 'MODEL_REQUIRED') return null
  return { code: typeof data.code === 'string' ? data.code : undefined, message, accepts }
}

/** What a deployment is running, whichever way it was created. */
export function deploymentModelRef(deployment: Pick<ModelDeployment, 'modelRef' | 'modelVersionId'>, versions: ModelVersion[] = []): string {
  if (deployment.modelRef) return deployment.modelRef
  const version = deployment.modelVersionId ? versions.find((v) => v.id === deployment.modelVersionId) : null
  if (version) return version.registryUri
  return deployment.modelVersionId ? deployment.modelVersionId.slice(0, 8) : BLANK
}

/** Table placeholder for a value the provider has not reported. */
export const BLANK = '—'

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return BLANK
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)
}

export function formatBytes(bytes: string | number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes === '') return BLANK
  const n = typeof bytes === 'string' ? Number(bytes) : bytes
  if (!Number.isFinite(n) || n < 0) return BLANK
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

/** The backend refuses to delete a version while any deployment other than torn_down references it. */
export function holdsVersion(state: ModelDeploymentState): boolean {
  return state !== 'torn_down'
}

export function manifestSummaryOf(version: Pick<ModelVersion, 'metadata'> | null | undefined): ModelManifestSummary | null {
  const m = version?.metadata?.manifest
  return m && typeof m === 'object' ? m : null
}
