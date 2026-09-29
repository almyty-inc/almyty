/**
 * The rows of the Credentials page, from GET /credentials: every key or
 * account added on Credentials or through the pick-or-create control
 * (with its service and whether it works), plus the keys a single API,
 * MCP server, channel or app keeps for itself. A key a model provider
 * uses goes in its own group.
 */
import type { ServiceCheck } from '@/components/connect/status-label'
import type { Connection, Connector, ConnectorKind } from '@/types/connections'

import { connectionCheck, connectionWhoShort } from '@/components/connections/connection-status'
import { credentialPath } from './paths'

/** A row of GET /credentials. Secrets arrive masked, and are never read here. */
export interface StoredCredential {
  id: string
  name: string
  type: string
  description?: string | null
  connectorKey?: string | null
  visibility?: 'org' | 'team' | 'private' | null
  isActive?: boolean
  apiId?: string | null
  lastUsedAt?: string | null
  createdAt?: string
  metadata?: { managedBy?: { kind: string; id?: string } | null } | null
  /** Set on a model provider key the server found on the provider itself. */
  _source?: 'llm_provider'
  _sourceId?: string
  usedBy?: Array<{ type: string; id: string; name: string }>
}

export interface CredentialUse {
  label: string
  href?: string
}

export interface CredentialRow {
  id: string
  name: string
  /** The service it signs in to, or what kind of key it is. */
  service: string
  connectorKey: string | null
  kind: ConnectorKind | null
  /** Whether it works; "Saved" for a key nobody can check from here. */
  check: ServiceCheck
  who: string
  uses: CredentialUse[]
  createdAt: string | null
  href: string
  group: 'models' | 'other'
}

/** Kinds whose keys are model provider keys, shown as their own group. */
export const MODEL_KINDS: ConnectorKind[] = ['inference']

/** What a key a single thing keeps is, in words. */
export const CREDENTIAL_TYPE_LABELS: Record<string, string> = {
  api_key: 'API key',
  bearer_token: 'Bearer token',
  basic_auth: 'Username and password',
  oauth2: 'Sign-in',
  jwt: 'JWT',
  custom: 'Key',
  aws_sigv4: 'AWS keys',
  google_service_account: 'Google service account',
  mtls: 'Client certificate',
  code_signing: 'Code-signing certificate',
  memory_backend: 'Memory account',
}

/** Who keeps a key of its own, and where that thing's page is. */
export function managedUse(managedBy: { kind: string; id?: string } | null | undefined): CredentialUse | null {
  if (!managedBy) return null
  const id = managedBy.id
  switch (managedBy.kind) {
    case 'api':
      return { label: 'An API', href: id ? `/apis/${id}` : '/apis' }
    case 'mcp_source':
      return { label: 'An MCP server', href: '/tools' }
    case 'llm_provider':
    case 'llm_provider_usage':
      return { label: 'A model provider', href: id ? `/models/providers/${id}` : '/models' }
    case 'gateway_channel':
      return { label: 'A channel', href: id ? `/gateways/${id}` : undefined }
    case 'channel_installation':
      return { label: 'A channel' }
    case 'hosted_chat_oauth':
      return { label: 'A hosted chat sign-in', href: id ? `/gateways/${id}` : undefined }
    default:
      return null
  }
}

/** A credential added on Credentials; its service's check says whether "works" can be known. */
export function connectionRow(connection: Connection, connector?: Pick<Connector, 'validation'> | null): CredentialRow {
  return {
    id: connection.id,
    name: connection.name,
    service: connection.connectorDisplayName ?? connection.connectorKey,
    connectorKey: connection.connectorKey,
    kind: connection.kind,
    check: connectionCheck(connection, connector),
    who: connectionWhoShort(connection),
    uses: (connection.usedBy ?? []).map((u) => ({ label: u.name })),
    createdAt: connection.createdAt ?? null,
    href: credentialPath(connection.id),
    group: connection.kind && MODEL_KINDS.includes(connection.kind) ? 'models' : 'other',
  }
}

/** A key a single API, MCP server, channel or app keeps for itself. */
export function storedRow(credential: StoredCredential): CredentialRow {
  const fromProvider = credential._source === 'llm_provider'
  const managed = managedUse(credential.metadata?.managedBy)
  const uses: CredentialUse[] = fromProvider
    ? (credential.usedBy ?? []).map((u) => ({ label: u.name, href: `/models/providers/${u.id}` }))
    : managed
      ? [managed]
      : credential.apiId
        ? [{ label: 'An API', href: `/apis/${credential.apiId}` }]
        : []
  const providerKind = managed?.href?.startsWith('/models')
  return {
    id: credential.id,
    name: credential.name,
    service: CREDENTIAL_TYPE_LABELS[credential.type] ?? 'Key',
    connectorKey: credential.connectorKey ?? null,
    kind: null,
    check: { state: 'ok', label: 'Saved' },
    who: credential.visibility === 'private' ? 'Only you' : credential.visibility === 'team' ? 'One team' : 'Everyone',
    uses,
    createdAt: credential.createdAt ?? null,
    // A provider's own key has no page of its own here: it is changed on the provider.
    href: fromProvider ? uses[0]?.href ?? '/models' : credentialPath(credential.id),
    group: fromProvider || providerKind ? 'models' : 'other',
  }
}

/**
 * Every credential once: the connection's view where there is one (it
 * knows the service and whether the key works), else the stored row.
 * A stored row with a service is a credential the connection list keeps
 * from this person (someone else's private key), so it stays hidden.
 */
export function credentialRows(connections: Connection[], stored: StoredCredential[], connectors: Connector[] = []): CredentialRow[] {
  const seen = new Set(connections.map((c) => c.id))
  const byKey = new Map(connectors.map((c) => [c.key, c]))
  const rows = connections.map((c) => connectionRow(c, byKey.get(c.connectorKey)))
  for (const credential of stored) {
    if (seen.has(credential.id) || credential.connectorKey) continue
    rows.push(storedRow(credential))
  }
  return rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
}

/** GET /credentials has answered as a bare list and as `{ credentials }`. */
export function asStoredCredentials(raw: unknown): StoredCredential[] {
  const list = Array.isArray(raw) ? raw : (raw as { credentials?: unknown } | null)?.credentials
  return Array.isArray(list) ? (list as StoredCredential[]) : []
}
