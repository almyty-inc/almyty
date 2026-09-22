/**
 * Connections layer types: connectors (what can be connected), connections
 * (an account the org or a user connected) and grants (who may use one).
 *
 * Mirrors backend/src/modules/connections/connector.types.ts and the
 * /connectors, /connections and /connections/:id/grants controllers. Secret
 * values never travel in any of these shapes.
 */
import type { JsonSchemaObject } from './deployments'

export type ConnectorKind =
  | 'inference'
  | 'deployment'
  | 'memory'
  | 'mcp'
  | 'tool_source'
  | 'channel'
  | 'cloud'
  | 'registry'

/** Gallery order. */
export const CONNECTOR_KINDS: ConnectorKind[] = [
  'inference',
  'deployment',
  'memory',
  'mcp',
  'tool_source',
  'channel',
  'cloud',
  'registry',
]

export const CONNECTOR_KIND_LABELS: Record<ConnectorKind, string> = {
  inference: 'Inference',
  deployment: 'Deployment',
  memory: 'Memory',
  mcp: 'MCP servers',
  tool_source: 'Tool sources',
  channel: 'Channels',
  cloud: 'Clouds',
  registry: 'Registries',
}

export type ConnectMethodType =
  | 'oauth2_pkce'
  | 'oauth2_code'
  | 'oauth2_client_credentials'
  | 'api_key'
  | 'cloud_iam'
  | 'service_account'
  | 'installation'

export const CONNECT_METHOD_LABELS: Record<ConnectMethodType, string> = {
  oauth2_pkce: 'OAuth',
  oauth2_code: 'OAuth',
  oauth2_client_credentials: 'OAuth client',
  api_key: 'API key',
  cloud_iam: 'Cloud IAM',
  service_account: 'Service account',
  installation: 'App install',
}

export interface ConnectMethod {
  type: ConnectMethodType
  label?: string
  /** Plain-text instructions shown above the form. */
  description?: string
  /** What the user supplies; secret fields carry "x-secret": true. */
  schema?: JsonSchemaObject
  /** Deep link to where the user creates the key; falls back to the connector's keyPageUrl. */
  keyPageUrl?: string | null
  /** cloud_iam: the per-org CloudFormation quick-create link, filled in by the server. */
  quickCreateUrl?: string
  scopes?: string[]
}

/** How the backend proves a credential works; only the kind matters to the UI. */
export interface ConnectorValidation {
  kind: 'http' | 'format' | 'aws_caller_identity' | 'aws_assume_role' | 'gcp_service_account' | 'oauth2_client_credentials' | 's3_bucket' | 'mcp_initialize'
  [key: string]: unknown
}

export interface Connector {
  key: string
  kind: ConnectorKind
  displayName: string
  description?: string
  docsUrl?: string | null
  /** Where the user gets the key or token. */
  keyPageUrl?: string | null
  /** Ranked best first. */
  connect: ConnectMethod[]
  capabilities?: string[]
  scopesNeeded?: string[]
  validation?: ConnectorValidation
  pricingSource?: string
  adapterKey?: string
  providerType?: string
  /** Set on org-defined (custom) connectors. */
  organizationId?: string
}

export interface CreateConnectorBody {
  key: string
  kind: ConnectorKind
  displayName: string
  description?: string
  connect: ConnectMethod[]
  validation: ConnectorValidation
  capabilities?: string[]
  scopesNeeded?: string[]
  keyPageUrl?: string
  docsUrl?: string
}

export type ConnectionOwner = 'org' | 'user'

export type ConnectionHealthStatus = 'valid' | 'expired' | 'revoked' | 'quota' | 'unknown' | 'failed'

export interface ConnectionHealth {
  status: ConnectionHealthStatus
  checkedAt?: string | null
  error?: string | null
}

export interface ConnectionUsedBy {
  type: string
  id: string
  name: string
}

export interface Connection {
  id: string
  name: string
  connectorKey: string
  connectorDisplayName?: string
  kind: ConnectorKind | null
  owner: ConnectionOwner
  ownerUserId?: string | null
  method?: ConnectMethodType | null
  /** The account on the other side, e.g. the workspace or email. */
  accountLabel?: string | null
  health: ConnectionHealth
  scopesGranted?: string[]
  /** Not part of the list view yet; shown when the server sends it. */
  usedBy?: ConnectionUsedBy[]
  createdAt: string
  updatedAt?: string
  expiresAt?: string | null
}

export interface ConnectBody {
  method?: ConnectMethodType
  owner?: ConnectionOwner
  /** headless: the provider prints the code and the user pastes it. */
  mode?: 'browser' | 'headless'
  input?: Record<string, unknown>
  name?: string
}

export interface RotateBody {
  input?: Record<string, unknown>
  mode?: 'browser' | 'headless'
}

/** api_key, service_account, cloud_iam: validated live, the connection comes back. */
export interface ConnectDone {
  pending: false
  connection: Connection
}

/** oauth2_* and installation: the browser goes to authorizeUrl; the page polls until the callback lands. */
export interface ConnectRedirect {
  pending: true
  method: ConnectMethodType
  mode: 'browser' | 'headless'
  authorizeUrl: string
  state: string
  expiresInSeconds: number
  completeWith: 'callback' | 'code'
}

/** rotate without input on a form method: the server hands back the form to fill. */
export interface ConnectForm {
  pending: true
  method: ConnectMethodType
  form: { schema?: JsonSchemaObject; keyPageUrl: string | null }
}

export type ConnectResult = ConnectDone | ConnectRedirect | ConnectForm

export interface CompleteConnectBody {
  state: string
  code: string
}

export interface DisconnectResult {
  revoked: boolean
  revokeError?: string
}

export type GrantPrincipalType = 'user' | 'team' | 'role' | 'agent' | 'workspace'

export type GrantPermission = 'use' | 'manage'

export interface ConnectionGrant {
  id: string
  principalType: GrantPrincipalType
  principalId: string
  principalName?: string
  permission: GrantPermission
  budgetId?: string | null
  expiresAt?: string | null
  grantedBy: string
  createdAt: string
}

export interface CreateGrantBody {
  principalType: GrantPrincipalType
  principalId: string
  permission?: GrantPermission
  budgetId?: string
  expiresAt?: string
}

/** Body of the HTTP 422 a live validation failure returns. */
export interface ConnectionValidationFailure {
  code: 'CONNECTION_VALIDATION_FAILED'
  message: string
  /** Kept with health.status = 'failed' so the user can retry or rotate. */
  connection?: Connection
}
