/**
 * The rows of the Credentials page, from GET /credentials: every key or
 * account added on Credentials or through the pick-or-create control
 * (with its service and whether it works), plus the keys a single API,
 * MCP server, channel or app keeps for itself, plus the model provider
 * connections (GET /llm-providers), one row each, used by that connection
 * on Models. A connection with no key (an Ollama or a server you run) is
 * there too; the key a connection keeps for itself is not listed a second
 * time. One table: a model provider's key is a credential like any other.
 */
import type { ServiceCheck } from '@/components/connect/status-label'
import type { Connection, Connector, ConnectorKind } from '@/types/connections'

import { connectionCheck, connectionWhoShort } from '@/components/connections/connection-status'
import { credentialPath } from './paths'
import { connectProviderPath, providerPath } from '@/components/llm-providers/paths'
import { providerCheck } from '@/components/llm-providers/provider-status'
import { providerTileLabel } from '@/components/llm-providers/provider-catalog'

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

/** A model provider connection, as GET /llm-providers lists it. */
export interface ProviderConnection {
  id: string
  name: string
  type: string
  visibility?: 'org' | 'team' | 'private' | null
  createdAt?: string
  status?: string
  keyChecked?: boolean
  isHealthy?: boolean
  lastError?: string | null
  lastHealthCheckAt?: string | null
  metadata?: { managedBy?: { kind: string } | null } | null
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
}

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
      return { label: 'A model connection', href: id ? providerPath(id) : connectProviderPath() }
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
    // A provider connection's key is changed on that connection's page, with its models.
    href: connection.providerId ? providerPath(connection.providerId) : credentialPath(connection.id),
  }
}

/** The words for "used by this model connection", the same in every row. */
export function modelConnectionUse(name: string, id: string): CredentialUse {
  return { label: `${name} connection`, href: providerPath(id) }
}

/** A model provider connection: its page, under Models, holds its key, its models and who can use it. */
export function providerRow(provider: ProviderConnection): CredentialRow {
  const check = providerCheck(provider as Parameters<typeof providerCheck>[0])
  return {
    id: provider.id,
    name: provider.name,
    service: providerTileLabel(provider.type),
    connectorKey: provider.type,
    kind: 'inference',
    check: { state: check.state, label: check.label, error: check.error },
    who: provider.visibility === 'private' ? 'Only you' : provider.visibility === 'team' ? 'One team' : 'Everyone',
    uses: [modelConnectionUse(provider.name, provider.id)],
    createdAt: provider.createdAt ?? null,
    href: providerPath(provider.id),
  }
}

/** A key a single API, MCP server, channel or app keeps for itself. */
export function storedRow(credential: StoredCredential): CredentialRow {
  const fromProvider = credential._source === 'llm_provider'
  const managed = managedUse(credential.metadata?.managedBy)
  const uses: CredentialUse[] = fromProvider
    ? (credential.usedBy ?? []).map((u) => modelConnectionUse(u.name, u.id))
    : managed
      ? [managed]
      : credential.apiId
        ? [{ label: 'An API', href: `/apis/${credential.apiId}` }]
        : []
  const providerKind = credential.metadata?.managedBy?.kind === 'llm_provider' || credential.metadata?.managedBy?.kind === 'llm_provider_usage'
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
    // A provider's own key has no page of its own here: it is changed on the provider connection.
    href: fromProvider ? uses[0]?.href ?? connectProviderPath() : providerKind && managed?.href ? managed.href : credentialPath(credential.id),
  }
}

/**
 * Every credential once: the connection's view where there is one (it
 * knows the service and whether the key works), else the stored row.
 * A stored row with a service is a credential the connection list keeps
 * from this person (someone else's private key), so it stays hidden.
 */
export function credentialRows(connections: Connection[], stored: StoredCredential[], connectors: Connector[] = [], providers: ProviderConnection[] = []): CredentialRow[] {
  const seen = new Set(connections.map((c) => c.id))
  const byKey = new Map(connectors.map((c) => [c.key, c]))
  // Keys a listed provider connection keeps for itself show as that connection.
  const listed = new Set(providers.map((p) => p.id))
  const ownKeyOfListed = (managedBy?: { kind: string; id?: string } | null, providerId?: string | null) =>
    (!!providerId && listed.has(providerId)) || (!!managedBy?.id && (managedBy.kind === 'llm_provider' || managedBy.kind === 'llm_provider_usage') && listed.has(managedBy.id))
  const rows = connections.filter((c) => !ownKeyOfListed(null, c.providerId)).map((c) => connectionRow(c, byKey.get(c.connectorKey)))
  for (const credential of stored) {
    if (seen.has(credential.id) || credential.connectorKey) continue
    if (ownKeyOfListed(credential.metadata?.managedBy) || (credential._source === 'llm_provider' && (credential.usedBy ?? []).some((u) => listed.has(u.id)))) continue
    rows.push(storedRow(credential))
  }
  // A model the platform runs on your cloud account is reached through its hosting page, not here.
  for (const provider of providers) if (provider.metadata?.managedBy?.kind !== 'model_endpoint') rows.push(providerRow(provider))
  return rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
}

/** GET /credentials has answered as a bare list and as `{ credentials }`. */
export function asStoredCredentials(raw: unknown): StoredCredential[] {
  const list = Array.isArray(raw) ? raw : (raw as { credentials?: unknown } | null)?.credentials
  return Array.isArray(list) ? (list as StoredCredential[]) : []
}
