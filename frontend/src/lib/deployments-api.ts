import { apiDel, apiGet, apiPost } from '@/lib/api'
import type {
  CreateModelDeploymentBody,
  ModelAdapter,
  ModelDeployment,
  ModelDeploymentState,
  ModelManifestSummary,
  ModelVersion,
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

export type RegistryScheme = 's3' | 'hf' | 'file'

export interface ParsedRegistryUri {
  scheme: RegistryScheme
  location: string
  prefix: string
  pin: string
}

/**
 * Frontend twin of backend/src/modules/model-registry/registry-uri.ts:
 *   s3://bucket/prefix@etag | hf://org/repo@sha | file:///abs/path@sha
 * Returns the parsed parts, or an error message the form can show.
 */
export function parseRegistryUri(raw: string): { ok: true; value: ParsedRegistryUri } | { ok: false; error: string } {
  const value = (raw ?? '').trim()
  const m = value.match(/^(s3|hf|file):\/\/(.+?)@([A-Za-z0-9._:-]+)$/)
  if (!m) {
    return { ok: false, error: 'Use s3://bucket/prefix@etag, hf://org/repo@sha or file:///path@sha. The @pin is required.' }
  }
  const scheme = m[1] as RegistryScheme
  const body = m[2]
  const pin = m[3]
  if (body.includes('..')) return { ok: false, error: 'A registry URI may not contain ..' }
  if (scheme === 's3') {
    const slash = body.indexOf('/')
    const bucket = slash === -1 ? body : body.slice(0, slash)
    const prefix = slash === -1 ? '' : body.slice(slash + 1).replace(/\/+$/, '')
    if (!bucket) return { ok: false, error: 'An s3 registry URI needs a bucket' }
    return { ok: true, value: { scheme, location: bucket, prefix, pin } }
  }
  if (scheme === 'hf') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(body)) return { ok: false, error: 'A hub registry URI must be hf://org/repo@sha' }
    return { ok: true, value: { scheme, location: body, prefix: '', pin } }
  }
  if (!body.startsWith('/')) return { ok: false, error: 'A file registry URI must be an absolute path' }
  return { ok: true, value: { scheme, location: body, prefix: '', pin } }
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
