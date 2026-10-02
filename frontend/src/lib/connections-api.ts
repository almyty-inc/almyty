import { getApiErrorMessage } from './api-error'
import { apiDel, apiGet, apiPatch, apiPost } from './api'
import type {
  CompleteConnectBody,
  ConnectBody,
  ConnectForm,
  ConnectMethod,
  ConnectMethodType,
  ConnectRedirect,
  ConnectResult,
  Connection,
  ConnectionValidationFailure,
  Connector,
  ConnectorKind,
  DisconnectResult,
  RotateBody,
} from '@/types/connections'

/**
 * Services: the catalog of what a credential can be added for. Custom ones
 * are created here too (OpenAI-compatible, MCP, S3 registries). Everything
 * here lives under /credentials; the older /connectors and /connections
 * routes still answer the same.
 */
export const connectorsApi = {
  list: (kind?: ConnectorKind) => apiGet<Connector[]>('/credentials/services', kind ? { params: { kind } } : undefined),

}

/** The server may answer a bare view or `{ connection }`; both are read. */
function unwrapConnection(result: unknown): Connection {
  const r = result as any
  return (r && typeof r === 'object' && 'connection' in r && r.connection ? r.connection : r) as Connection
}

/**
 * Credentials added for a service (a "connection" in the code): a key or
 * account with the service it belongs to and whether it works. Every
 * helper unwraps the `{ success, data }` envelope. Secret values never
 * come back.
 */
export const connectionsApi = {
  /** GET /credentials, keeping the rows that belong to a service (they carry `health`). */
  list: () =>
    apiGet<Array<Connection | { health?: undefined }>>('/credentials').then((rows) =>
      (Array.isArray(rows) ? rows : []).filter((row): row is Connection => Boolean(row && (row as Connection).health)),
    ),

  /**
   * api_key / service_account / cloud_iam: validated live, resolves with
   * `{ pending: false, connection }`; a failed validation rejects with HTTP 422
   * (see `readValidationFailure`). oauth2_* / installation: resolves with
   * `{ pending: true, authorizeUrl, state, completeWith }`.
   */
  connect: (connectorKey: string, body: ConnectBody) =>
    apiPost<ConnectResult>(`/credentials/connect/${encodeURIComponent(connectorKey)}`, body),

  /** Headless OAuth: the user pastes the code the provider showed. */
  complete: (connectorKey: string, body: CompleteConnectBody) =>
    apiPost<unknown>(`/credentials/connect/${encodeURIComponent(connectorKey)}/complete`, body).then(unwrapConnection),

  validate: (id: string) => apiPost<unknown>(`/credentials/${id}/validate`).then(unwrapConnection),

  /** Same shapes as `connect`; without input on a form method the server hands the form back. */
  rotate: (id: string, body: RotateBody = {}) => apiPost<ConnectResult>(`/credentials/${id}/rotate`, body),

  remove: (id: string) => apiDel<DisconnectResult>(`/credentials/${id}`),

  /** Who can use it, changed after it was added: everyone, one team (with its id) or only you. */
  setSharing: (id: string, body: { owner: 'org' | 'team' | 'private'; teamId?: string }) =>
    apiPatch<unknown>(`/credentials/${id}/sharing`, body).then(unwrapConnection),

}

/**
 * Org toggle for user-scoped connections. Lives in the organization's
 * `settings` object (GET /organizations/:id -> settings.allowUserScopedConnections)
 * and is patched there; the server merges `settings` shallowly.
 */
export const connectionSettingsApi = {
  setAllowUserScopedConnections: (organizationId: string, allow: boolean) =>
    apiPatch<{ settings?: { allowUserScopedConnections?: boolean } }>(`/organizations/${organizationId}`, { settings: { allowUserScopedConnections: allow } }),
}

/** Personal / free orgs let members keep their own keys; production tiers start closed. */
export function defaultAllowUserScopedConnections(plan: string | null | undefined): boolean {
  return !plan || plan === 'free' || plan === 'personal'
}

/** The effective toggle: the explicit setting when set, else the plan default. */
export function allowUserScopedConnections(org: { plan?: string | null; settings?: { allowUserScopedConnections?: unknown } | null } | null | undefined): boolean {
  const setting = org?.settings?.allowUserScopedConnections
  if (typeof setting === 'boolean') return setting
  return defaultAllowUserScopedConnections(org?.plan)
}

/** Methods that send the browser to the provider and finish on the callback. */
export const REDIRECT_METHOD_TYPES: ConnectMethodType[] = ['oauth2_pkce', 'oauth2_code', 'installation']

export function isRedirectMethod(type: ConnectMethodType | undefined | null): boolean {
  return !!type && REDIRECT_METHOD_TYPES.includes(type)
}

export function isOAuthMethod(type: ConnectMethodType | undefined | null): boolean {
  return type === 'oauth2_pkce' || type === 'oauth2_code' || type === 'oauth2_client_credentials'
}

/** Methods that take a form: the user types what the schema asks for. */
export function isFormMethod(type: ConnectMethodType | undefined | null): boolean {
  return type === 'api_key' || type === 'service_account' || type === 'cloud_iam' || type === 'oauth2_client_credentials'
}

/** The connector's ranked-first method, if it has one. */
export function bestConnectMethod(connector: Pick<Connector, 'connect'> | null | undefined): ConnectMethod | null {
  return connector?.connect?.[0] ?? null
}

export function isConnectRedirect(result: ConnectResult | null | undefined): result is ConnectRedirect {
  return !!result && (result as ConnectRedirect).pending === true && typeof (result as ConnectRedirect).authorizeUrl === 'string'
}

export function isConnectForm(result: ConnectResult | null | undefined): result is ConnectForm {
  return !!result && (result as ConnectForm).pending === true && typeof (result as ConnectForm).form === 'object' && !(result as ConnectRedirect).authorizeUrl
}


/**
 * Pull the validation failure out of an axios rejection. The backend answers
 * HTTP 422 with `{ code: 'CONNECTION_VALIDATION_FAILED', message, connection? }`,
 * possibly wrapped in the usual envelope; both shapes are read.
 */
export function readValidationFailure(error: unknown): ConnectionValidationFailure | null {
  const data = (error as any)?.response?.data
  if (!data || typeof data !== 'object') return null
  const body = data.error && typeof data.error === 'object' ? { ...data.error, ...data } : data
  const code = body.code ?? body.error?.code ?? data.data?.code
  if (code !== 'CONNECTION_VALIDATION_FAILED') return null
  const message = body.message ?? body.error?.message ?? data.data?.message ?? 'The account could not be validated'
  const connection = body.connection ?? data.data?.connection
  return { code: 'CONNECTION_VALIDATION_FAILED', message: String(message), connection: connection ?? undefined }
}

export function errorMessage(error: unknown, fallback: string): string {
  const anyErr = error as any
  return getApiErrorMessage(anyErr, fallback)
}

/** Connectors grouped in gallery order; empty kinds are left out. */
export function groupConnectorsByKind(connectors: Connector[], order: ConnectorKind[]): Array<{ kind: ConnectorKind; connectors: Connector[] }> {
  const buckets = new Map<ConnectorKind, Connector[]>()
  for (const c of connectors) {
    const list = buckets.get(c.kind) ?? []
    list.push(c)
    buckets.set(c.kind, list)
  }
  const out: Array<{ kind: ConnectorKind; connectors: Connector[] }> = []
  for (const kind of order) {
    const list = buckets.get(kind)
    if (list && list.length > 0) out.push({ kind, connectors: list })
  }
  for (const [kind, list] of buckets) {
    if (!order.includes(kind) && list.length > 0) out.push({ kind, connectors: list })
  }
  return out
}

/** Case-insensitive match on key, display name, description and kind. */
export function matchesConnectorSearch(connector: Connector, term: string): boolean {
  const q = term.trim().toLowerCase()
  if (!q) return true
  return [connector.key, connector.displayName, connector.description ?? '', connector.kind]
    .some((s) => s.toLowerCase().includes(q))
}

export interface PollOptions {
  intervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** Test seam; defaults to setTimeout. */
  wait?: (ms: number) => Promise<void>
  /** Which lister to poll; defaults to connectionsApi.list. */
  list?: () => Promise<Connection[]>
}

export interface PollTarget {
  connectorKey: string
  /** Only connections created or updated after this instant count. */
  since: number
  /** A rotate: the same row, refreshed. */
  connectionId?: string
}

/** Whether a listed connection is the one a redirect flow just produced. */
export function matchesPollTarget(connection: Connection, target: PollTarget): boolean {
  if (target.connectionId) {
    if (connection.id !== target.connectionId) return false
    const updated = Date.parse(connection.updatedAt ?? '')
    return Number.isFinite(updated) && updated >= target.since
  }
  if (connection.connectorKey !== target.connectorKey) return false
  const created = Date.parse(connection.createdAt ?? '')
  return Number.isFinite(created) && created >= target.since
}

/**
 * After the provider tab opens, wait for the callback to land: list the
 * connections until one matching the target appears (the list has no
 * state filter). Resolves null on timeout or abort.
 */
export async function pollForConnection(target: PollTarget, options: PollOptions = {}): Promise<Connection | null> {
  const intervalMs = options.intervalMs ?? 2000
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + timeoutMs
  while (!options.signal?.aborted && Date.now() < deadline) {
    try {
      const rows = await (options.list ?? connectionsApi.list)()
      const found = Array.isArray(rows) ? rows.find((c) => matchesPollTarget(c, target)) : undefined
      if (found) return found
    } catch {
      // A transient listing error is not a reason to stop waiting.
    }
    await wait(intervalMs)
  }
  return null
}
