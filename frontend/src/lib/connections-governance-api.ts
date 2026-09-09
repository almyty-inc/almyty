/**
 * Client for the EE connections governance routes under /ee/connections.
 * Every route needs the `connections_governance` entitlement (402 without
 * it) and an owner or admin; the UI gates on the entitlement first. The
 * helpers below unwrap the `{ success, data }` envelope.
 */
import { api, apiDel, apiGet, apiPatch, apiPost } from './api'
import { downloadBlob } from './hosted-chat'
import type { GrantPrincipalType } from '@/types/connections'
import {
  POLICY_KIND_LABELS,
  SCOPE_PRINCIPAL_KIND_LABELS,
  type AuditExportFormat,
  type AuditExportParams,
  type ConnectionPolicy,
  type ConnectionPolicyKind,
  type ConnectionPolicyRule,
  type ConnectorListRule,
  type CreatePolicyBody,
  type ExpiryActions,
  type ExpiryRule,
  type ExpiryRunResult,
  type PolicyInvalidFailure,
  type ReviewEnvironment,
  type ReviewRow,
  type RevokeGrantsResult,
  type RotationDue,
  type RotationRule,
  type RotationRunResult,
  type ScopePrincipalKind,
  type ScopeRule,
  type UpdatePolicyBody,
} from '@/types/connections-governance'

export const CONNECTIONS_GOVERNANCE_ENTITLEMENT = 'connections_governance'

const BASE = '/ee/connections'

export const POLICIES_QUERY_KEY = ['connections-governance', 'policies'] as const
export const REVIEW_QUERY_KEY = ['connections-governance', 'review'] as const
export const EXPIRING_QUERY_KEY = ['connections-governance', 'expiring'] as const
export const ROTATION_QUERY_KEY = ['connections-governance', 'rotate-due'] as const

export const connectionPoliciesApi = {
  list: () => apiGet<ConnectionPolicy[]>(`${BASE}/policies`),

  get: (id: string) => apiGet<ConnectionPolicy>(`${BASE}/policies/${id}`),

  create: (body: CreatePolicyBody) => apiPost<ConnectionPolicy>(`${BASE}/policies`, body),

  update: (id: string, body: UpdatePolicyBody) => apiPatch<ConnectionPolicy>(`${BASE}/policies/${id}`, body),

  remove: (id: string) => apiDel<void>(`${BASE}/policies/${id}`),
}

export const connectionsReviewApi = {
  /** User-scoped connections currently granted to agents or workspaces. */
  list: (environment: ReviewEnvironment = 'any') =>
    apiGet<ReviewRow[]>(`${BASE}/review`, environment !== 'any' ? { params: { environment } } : undefined),

  /** Without `principalTypes` the server revokes the agent and workspace grants. */
  revokeGrants: (connectionId: string, principalTypes?: GrantPrincipalType[]) =>
    apiPost<RevokeGrantsResult>(`${BASE}/review/${connectionId}/revoke-grants`, principalTypes?.length ? { principalTypes } : {}),
}

export const connectionsExpiryApi = {
  list: () => apiGet<ExpiryActions>(`${BASE}/expiring`),

  enforce: () => apiPost<ExpiryRunResult>(`${BASE}/expiring/enforce`),
}

export const connectionsRotationApi = {
  candidates: () => apiGet<RotationDue>(`${BASE}/rotate-due`),

  rotateDue: () => apiPost<RotationRunResult>(`${BASE}/rotate-due`),
}

/** Name from a Content-Disposition header, else `<fallback>`. */
export function exportFilename(contentDisposition: unknown, fallback: string): string {
  if (typeof contentDisposition !== 'string') return fallback
  const match = /filename\*?="?([^";]+)"?/i.exec(contentDisposition)
  const candidate = match?.[1]?.trim().split(/[\\/]/).pop()
  return candidate || fallback
}

export interface AuditExportDownload {
  filename: string
  count: number | null
  retentionDays: number | 'unlimited' | null
}

/**
 * The connections event stream as a file. Fetched as a blob because the
 * server answers with a Content-Disposition attachment; the browser
 * download goes through the shared helper.
 */
export const connectionsAuditExportApi = {
  download: async (format: AuditExportFormat, params: AuditExportParams = {}): Promise<AuditExportDownload> => {
    const query: Record<string, string> = { format }
    if (params.from) query.from = params.from
    if (params.to) query.to = params.to
    if (params.limit) query.limit = String(params.limit)
    const res = await api.get(`${BASE}/audit-export`, { params: query, responseType: 'blob' })
    const headers = (res?.headers ?? {}) as Record<string, unknown>
    const filename = exportFilename(headers['content-disposition'], `connections-audit.${format}`)
    const type = format === 'csv' ? 'text/csv' : 'application/json'
    const blob = res.data instanceof Blob ? res.data : new Blob([typeof res.data === 'string' ? res.data : JSON.stringify(res.data)], { type })
    downloadBlob(blob, filename)
    const countHeader = headers['x-audit-export-count']
    const retentionHeader = headers['x-audit-retention-days']
    const count = typeof countHeader === 'string' && countHeader !== '' && Number.isFinite(Number(countHeader)) ? Number(countHeader) : null
    const retentionDays = retentionHeader === 'unlimited' ? 'unlimited' : typeof retentionHeader === 'string' && retentionHeader !== '' && Number.isFinite(Number(retentionHeader)) ? Number(retentionHeader) : null
    return { filename, count, retentionDays }
  },
}

// ── Rule type guards ──

export function isConnectorListRule(rule: ConnectionPolicyRule): rule is ConnectorListRule {
  return Array.isArray((rule as ConnectorListRule).connectorKeys) && !('everyDays' in rule)
}

export function isScopeRule(rule: ConnectionPolicyRule): rule is ScopeRule {
  return Array.isArray((rule as ScopeRule).principalKinds)
}

export function isExpiryRule(rule: ConnectionPolicyRule): rule is ExpiryRule {
  return typeof (rule as ExpiryRule).maxAgeDays === 'number'
}

export function isRotationRule(rule: ConnectionPolicyRule): rule is RotationRule {
  return typeof (rule as RotationRule).everyDays === 'number'
}

// ── Policy form: one flat shape, one rule per kind ──

/** Sane defaults: expiry 90 days with a 7 day warning, rotation every 90 days. */
export const POLICY_FORM_DEFAULTS = {
  maxAgeDays: 90,
  warnDays: 7,
  everyDays: 90,
} as const

export interface PolicyFormValues {
  kind: ConnectionPolicyKind
  name: string
  connectorKeys: string[]
  /** Empty means both org and user connects. */
  owners: Array<'org' | 'user'>
  principalKinds: ScopePrincipalKind[]
  environments: string[]
  approvedConnectorsOnly: boolean
  maxAgeDays: number
  warnDays: number
  enforce: boolean
  everyDays: number
}

export function emptyPolicyForm(kind: ConnectionPolicyKind = 'connector_allowlist'): PolicyFormValues {
  return {
    kind,
    name: '',
    connectorKeys: [],
    owners: [],
    principalKinds: ['agent', 'workspace'],
    environments: ['production'],
    approvedConnectorsOnly: true,
    maxAgeDays: POLICY_FORM_DEFAULTS.maxAgeDays,
    warnDays: POLICY_FORM_DEFAULTS.warnDays,
    enforce: true,
    everyDays: POLICY_FORM_DEFAULTS.everyDays,
  }
}

/** The form state a stored policy edits as. */
export function policyToForm(policy: Pick<ConnectionPolicy, 'kind' | 'name' | 'rule'>): PolicyFormValues {
  const form = emptyPolicyForm(policy.kind)
  form.name = policy.name ?? ''
  const rule = policy.rule
  if (isRotationRule(rule)) {
    form.connectorKeys = rule.connectorKeys ?? []
    form.everyDays = rule.everyDays
  } else if (isConnectorListRule(rule)) {
    form.connectorKeys = rule.connectorKeys
    form.owners = rule.owners ?? []
  } else if (isScopeRule(rule)) {
    form.principalKinds = rule.principalKinds
    form.environments = rule.environments ?? []
    form.approvedConnectorsOnly = rule.approvedConnectorsOnly === true
  } else if (isExpiryRule(rule)) {
    form.maxAgeDays = rule.maxAgeDays
    form.warnDays = rule.warnDays
    form.enforce = rule.enforce
  }
  return form
}

function uniqueTrimmed(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))]
}

/** The rule the server validates for this kind, built from the flat form. */
export function buildPolicyRule(values: PolicyFormValues): ConnectionPolicyRule {
  switch (values.kind) {
    case 'connector_allowlist':
    case 'connector_denylist': {
      const rule: ConnectorListRule = { connectorKeys: uniqueTrimmed(values.connectorKeys) }
      const owners = [...new Set(values.owners)]
      if (owners.length === 1) rule.owners = owners
      return rule
    }
    case 'scope_rule': {
      const rule: ScopeRule = { principalKinds: [...new Set(values.principalKinds)], requireOwner: 'org' }
      const environments = uniqueTrimmed(values.environments).map((e) => e.toLowerCase())
      if (environments.length) rule.environments = environments
      if (values.approvedConnectorsOnly) rule.approvedConnectorsOnly = true
      return rule
    }
    case 'expiry_rule':
      return { maxAgeDays: values.maxAgeDays, warnDays: values.warnDays, enforce: values.enforce }
    case 'rotation_rule': {
      const rule: RotationRule = { everyDays: values.everyDays, requireProviderApi: true }
      const keys = uniqueTrimmed(values.connectorKeys)
      if (keys.length) rule.connectorKeys = keys
      return rule
    }
  }
}

/** The POST body for a new policy. */
export function buildCreatePolicyBody(values: PolicyFormValues, enabled = true): CreatePolicyBody {
  const name = values.name.trim()
  return { kind: values.kind, name: name ? name : null, rule: buildPolicyRule(values), enabled }
}

/** The PATCH body for an existing policy; the kind stays. */
export function buildUpdatePolicyBody(values: PolicyFormValues): UpdatePolicyBody {
  const name = values.name.trim()
  return { name: name ? name : null, rule: buildPolicyRule(values) }
}

/** Client-side check mirroring the server's per-kind rules; empty when valid. */
export function validatePolicyForm(values: PolicyFormValues): string[] {
  const errors: string[] = []
  switch (values.kind) {
    case 'connector_allowlist':
    case 'connector_denylist':
      if (uniqueTrimmed(values.connectorKeys).length === 0) errors.push('Pick at least one connector')
      break
    case 'scope_rule':
      if (values.principalKinds.length === 0) errors.push('Pick at least one principal kind')
      break
    case 'expiry_rule':
      if (!Number.isInteger(values.maxAgeDays) || values.maxAgeDays < 1) errors.push('Maximum age must be a whole number of days, at least 1')
      if (!Number.isInteger(values.warnDays) || values.warnDays < 0) errors.push('Warning must be a whole number of days, 0 or more')
      if (errors.length === 0 && values.warnDays >= values.maxAgeDays) errors.push('Warning must come before the maximum age')
      break
    case 'rotation_rule':
      if (!Number.isInteger(values.everyDays) || values.everyDays < 1) errors.push('Rotation interval must be a whole number of days, at least 1')
      break
  }
  return errors
}

// ── Words ──

function listWords(items: string[], max = 4): string {
  if (items.length <= max) return items.join(', ')
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`
}

function days(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`
}

/**
 * A one-line summary of what a policy does, for the table. Connector
 * keys are shown by display name when `connectorNames` knows them.
 */
export function describePolicyRule(policy: Pick<ConnectionPolicy, 'kind' | 'rule'>, connectorNames: Record<string, string> = {}): string {
  const rule = policy.rule
  const nameOf = (key: string) => connectorNames[key] ?? key
  switch (policy.kind) {
    case 'connector_allowlist':
    case 'connector_denylist': {
      if (!isConnectorListRule(rule)) return POLICY_KIND_LABELS[policy.kind]
      const who = rule.owners?.length === 1 ? (rule.owners[0] === 'org' ? 'Organization connections' : 'Personal connections') : 'All connections'
      const verb = policy.kind === 'connector_allowlist' ? 'may only use' : 'may never use'
      return `${who} ${verb} ${listWords(rule.connectorKeys.map(nameOf))}`
    }
    case 'scope_rule': {
      if (!isScopeRule(rule)) return POLICY_KIND_LABELS[policy.kind]
      const kinds = listWords(rule.principalKinds.map((k) => SCOPE_PRINCIPAL_KIND_LABELS[k] ?? k))
      const where = rule.environments?.length ? ` in ${listWords(rule.environments)}` : ''
      const approved = rule.approvedConnectorsOnly ? ' from approved connectors' : ''
      return `${kinds}${where} may only use organization connections${approved}`
    }
    case 'expiry_rule': {
      if (!isExpiryRule(rule)) return POLICY_KIND_LABELS[policy.kind]
      const enforce = rule.enforce ? ', grants are revoked on expiry' : ', owners are notified only'
      return `Secrets expire after ${days(rule.maxAgeDays)}, warning ${days(rule.warnDays)} ahead${enforce}`
    }
    case 'rotation_rule': {
      if (!isRotationRule(rule)) return POLICY_KIND_LABELS[policy.kind]
      const which = rule.connectorKeys?.length ? listWords(rule.connectorKeys.map(nameOf)) : 'every connector'
      return `Rotate ${which} every ${days(rule.everyDays)} through the provider API`
    }
    default:
      return String(policy.kind)
  }
}

/** Pull the per-field problems out of a 400 CONNECTION_POLICY_INVALID rejection. */
export function readPolicyInvalid(error: unknown): PolicyInvalidFailure | null {
  const data = (error as any)?.response?.data
  if (!data || typeof data !== 'object') return null
  const body = data.data && typeof data.data === 'object' ? data.data : data
  const code = body.code ?? data.code
  if (code !== 'CONNECTION_POLICY_INVALID') return null
  const errors = Array.isArray(body.errors) ? body.errors.map(String) : []
  return { code: 'CONNECTION_POLICY_INVALID', message: String(body.message ?? 'The rule is invalid'), errors }
}

/** Whole days until an ISO instant; negative when it has passed. */
export function daysUntil(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.ceil((t - now) / (24 * 60 * 60 * 1000))
}
