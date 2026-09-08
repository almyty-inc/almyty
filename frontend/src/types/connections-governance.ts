/**
 * Connections governance (EE, entitlement `connections_governance`):
 * org-wide policies over the Connections layer, the review of user-scoped
 * connections granted to agents and workspaces, expiry and rotation runs,
 * and the audit export.
 *
 * Mirrors backend/src/entities/connection-policy.entity.ts and
 * backend/ee/modules/connections-governance/*. Dates travel as ISO strings.
 */
import type { ConnectionHealthStatus, ConnectionOwner, GrantPrincipalType } from './connections'

export type ConnectionPolicyKind =
  | 'connector_allowlist'
  | 'connector_denylist'
  | 'scope_rule'
  | 'expiry_rule'
  | 'rotation_rule'

/** Picker order. */
export const CONNECTION_POLICY_KINDS: ConnectionPolicyKind[] = [
  'connector_allowlist',
  'connector_denylist',
  'scope_rule',
  'expiry_rule',
  'rotation_rule',
]

export const POLICY_KIND_LABELS: Record<ConnectionPolicyKind, string> = {
  connector_allowlist: 'Allow list',
  connector_denylist: 'Deny list',
  scope_rule: 'Scope rule',
  expiry_rule: 'Expiry rule',
  rotation_rule: 'Rotation rule',
}

export const POLICY_KIND_DESCRIPTIONS: Record<ConnectionPolicyKind, string> = {
  connector_allowlist: 'Only these connectors may be connected. Several allow lists are unioned.',
  connector_denylist: 'These connectors may never be connected, whatever the allow lists say.',
  scope_rule: 'What a kind of principal may resolve, for example: production agents only use organization connections from approved connectors.',
  expiry_rule: 'A secret older than the maximum age is expired. Owners are warned ahead; with enforcement, expiry also revokes the grants.',
  rotation_rule: 'Rotate secrets on a schedule through the provider API. Connectors without API rotation are reported to their owners.',
}

/** Who a scope rule applies to: the principal kind the connection is resolved for. */
export type ScopePrincipalKind = 'agent' | 'workspace' | 'user' | 'team' | 'role'

export const SCOPE_PRINCIPAL_KINDS: ScopePrincipalKind[] = ['agent', 'workspace', 'user', 'team', 'role']

export const SCOPE_PRINCIPAL_KIND_LABELS: Record<ScopePrincipalKind, string> = {
  agent: 'Agents',
  workspace: 'Workspaces',
  user: 'Users',
  team: 'Teams',
  role: 'Roles',
}

/** `connector_allowlist` and `connector_denylist`. `owners` absent means both org and user connects. */
export interface ConnectorListRule {
  connectorKeys: string[]
  owners?: ConnectionOwner[]
}

/** `scope_rule`. `requireOwner` is always `org`; `environments` absent means everywhere. */
export interface ScopeRule {
  principalKinds: ScopePrincipalKind[]
  environments?: string[]
  requireOwner: 'org'
  approvedConnectorsOnly?: boolean
}

/** `expiry_rule`. */
export interface ExpiryRule {
  maxAgeDays: number
  warnDays: number
  enforce: boolean
}

/** `rotation_rule`. `connectorKeys` absent means every connector; `requireProviderApi` is always true. */
export interface RotationRule {
  connectorKeys?: string[]
  everyDays: number
  requireProviderApi: true
}

export type ConnectionPolicyRule = ConnectorListRule | ScopeRule | ExpiryRule | RotationRule

export interface ConnectionPolicy {
  id: string
  organizationId?: string
  kind: ConnectionPolicyKind
  name: string | null
  rule: ConnectionPolicyRule
  enabled: boolean
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface CreatePolicyBody {
  kind: ConnectionPolicyKind
  name?: string | null
  rule: ConnectionPolicyRule
  enabled?: boolean
}

/** `kind` cannot change after creation. */
export interface UpdatePolicyBody {
  name?: string | null
  rule?: ConnectionPolicyRule
  enabled?: boolean
}

/** Body of the HTTP 400 an invalid rule returns. */
export interface PolicyInvalidFailure {
  code: 'CONNECTION_POLICY_INVALID'
  message: string
  errors: string[]
}

export interface ReviewGrant {
  id: string
  principalType: GrantPrincipalType
  principalId: string
  principalName: string | null
  /** The agent's environment, for example `production`; null for workspaces. */
  environment: string | null
  permission: string
  budgetId: string | null
  expiresAt: string | null
  grantedBy: string | null
  createdAt: string
}

export interface ReviewConnection {
  id: string
  name: string
  connectorKey: string
  accountLabel: string | null
  owner: 'user'
  health: { status: ConnectionHealthStatus | string; checkedAt: string | null; error: string | null }
  expiresAt: string | null
  secretSetAt: string | null
  createdAt: string
}

export interface ReviewLastResolve {
  at: string
  userId: string | null
  agentId: string | null
  workspaceId: string | null
  purpose: string | null
}

/** One user-scoped connection with an unexpired agent or workspace grant. */
export interface ReviewRow {
  connection: ReviewConnection
  owner: { id: string; email: string | null; name: string | null }
  grants: ReviewGrant[]
  lastResolve: ReviewLastResolve | null
}

export type ReviewEnvironment = 'any' | 'production'

export interface RevokeGrantsResult {
  revoked: number
  grantIds: string[]
}

export interface ExpiryAction {
  connectionId: string
  connectorKey: string | null
  ownerUserId: string | null
  ageDays: number
  maxAgeDays: number
  /** When the secret reaches maxAgeDays. */
  expiresOn: string
  policyId: string | null
}

/** GET /ee/connections/expiring: what the sweep would act on, without acting. */
export interface ExpiryActions {
  warn: ExpiryAction[]
  expire: ExpiryAction[]
  /** Whether the governing rule revokes grants on expiry. */
  enforce: boolean
}

export interface ExpiryRunResult {
  organizationId: string
  warned: number
  expired: number
  revokedGrants: number
  enforce: boolean
}

export interface RotationCandidate {
  connectionId: string
  connectorKey: string | null
  ownerUserId: string | null
  ageDays: number
  everyDays: number
  policyId: string | null
}

/** GET /ee/connections/rotate-due. */
export interface RotationDue {
  /** Rotated through the provider API by the sweep. */
  due: RotationCandidate[]
  /** Due, but the connector has no API rotation: the owner rotates by hand. */
  manual: RotationCandidate[]
}

export interface RotationRunResult {
  organizationId: string
  rotated: number
  failed: number
  manual: number
}

export type AuditExportFormat = 'json' | 'csv'

export interface AuditExportParams {
  /** ISO instants. */
  from?: string
  to?: string
  limit?: number
}
