import { GrantPermission, GrantPrincipalType } from '../../../entities/connection-grant.entity';
import { CONNECTIONS_MANAGE, roleHasConnectionPermission } from '../connections.permissions';

/**
 * Pure grant decisions for the Connections layer (gate 2). No I/O: the
 * service loads the connection, the principal's memberships and the
 * grants, this module answers `canUse` / `canManage` with a reason.
 * Rules are tabled in docs/design/connections-grants.md.
 */

/** The caller as seen by the grant check: a user plus the run context. */
export interface GrantPrincipal {
  userId: string;
  /** Org role names in the connection's organization (`owner`, `admin`, `member`, `viewer`). */
  roles: string[];
  /** Teams the user belongs to in the connection's organization. */
  teamIds: string[];
  /** Extra permission strings from the membership row (EE custom roles). */
  permissions?: string[];
  agentId?: string;
  workspaceId?: string;
}

/** Where the use happens. Overrides the principal's agent / workspace when set. */
export interface GrantContext {
  agentId?: string;
  workspaceId?: string;
  runId?: string;
  purpose?: string;
  now?: Date;
}

export interface ConnectionLike {
  id: string;
  organizationId: string;
  ownerUserId?: string | null;
  visibility?: 'org' | 'team' | null;
  teamId?: string | null;
}

export interface GrantLike {
  id?: string;
  principalType: GrantPrincipalType;
  principalId: string;
  permission: GrantPermission;
  expiresAt?: Date | string | null;
}

export type GrantVia = 'owner' | 'connections:manage' | 'grant';

export interface GrantDecision {
  allowed: boolean;
  reason: string;
  /** How the decision was reached when allowed. */
  via?: GrantVia;
  /** The grant that carried the decision, when `via === 'grant'`. */
  grant?: GrantLike;
}

const allow = (reason: string, via: GrantVia, grant?: GrantLike): GrantDecision => ({ allowed: true, reason, via, grant });
const deny = (reason: string): GrantDecision => ({ allowed: false, reason });

export function isExpired(grant: GrantLike, now: Date = new Date()): boolean {
  if (!grant.expiresAt) return false;
  const at = grant.expiresAt instanceof Date ? grant.expiresAt : new Date(grant.expiresAt);
  return Number.isNaN(at.getTime()) ? false : at.getTime() <= now.getTime();
}

/** `connections:manage` through the org role or a membership permission. */
export function hasManagePermission(principal: GrantPrincipal): boolean {
  if (principal.roles.some((role) => roleHasConnectionPermission(role, CONNECTIONS_MANAGE))) return true;
  return (principal.permissions ?? []).includes(CONNECTIONS_MANAGE);
}

export function effectiveAgentId(principal: GrantPrincipal, context: GrantContext = {}): string | undefined {
  return context.agentId ?? principal.agentId;
}

export function effectiveWorkspaceId(principal: GrantPrincipal, context: GrantContext = {}): string | undefined {
  return context.workspaceId ?? principal.workspaceId;
}

/** Does this (unexpired) grant name the principal, in this run context? */
export function grantMatches(grant: GrantLike, principal: GrantPrincipal, context: GrantContext = {}): boolean {
  if (isExpired(grant, context.now)) return false;
  switch (grant.principalType) {
    case 'user':
      return grant.principalId === principal.userId;
    case 'team':
      return principal.teamIds.includes(grant.principalId);
    case 'role':
      return principal.roles.includes(grant.principalId);
    case 'agent':
      return !!grant.principalId && grant.principalId === effectiveAgentId(principal, context);
    case 'workspace':
      return !!grant.principalId && grant.principalId === effectiveWorkspaceId(principal, context);
    default:
      return false;
  }
}

/** Every unexpired grant that names the principal, `manage` grants first. */
export function matchingGrants(grants: GrantLike[], principal: GrantPrincipal, context: GrantContext = {}): GrantLike[] {
  return grants
    .filter((grant) => grantMatches(grant, principal, context))
    .sort((a, b) => (a.permission === b.permission ? 0 : a.permission === 'manage' ? -1 : 1));
}

function isOwner(connection: ConnectionLike, principal: GrantPrincipal): boolean {
  return !!connection.ownerUserId && connection.ownerUserId === principal.userId;
}

/**
 * Team-visibility connections are only ever usable by members of that
 * team; `connections:manage` bypasses, as it does everywhere else in
 * AccessPolicyService.
 */
function teamGate(connection: ConnectionLike, principal: GrantPrincipal): GrantDecision | null {
  if (connection.visibility !== 'team') return null;
  if (!connection.teamId) return deny('team-scoped connection without a team');
  if (hasManagePermission(principal)) return null;
  if (!principal.teamIds.includes(connection.teamId)) return deny('not a member of the connection team');
  return null;
}

function describe(grant: GrantLike): string {
  return `${grant.permission} grant to ${grant.principalType} ${grant.principalId}`;
}

/**
 * May `principal` resolve the connection's secret for a run?
 *
 * - The owner of a user-scoped connection always can.
 * - `connections:manage` (owner / admin roles) can use any org-scoped
 *   connection; it does not reach into user-scoped ones.
 * - Otherwise a matching, unexpired `use` or `manage` grant is needed.
 * - Team-visibility connections additionally require team membership.
 */
export function canUse(connection: ConnectionLike, principal: GrantPrincipal, grants: GrantLike[], context: GrantContext = {}): GrantDecision {
  if (isOwner(connection, principal)) return allow('connection owner', 'owner');

  const gate = teamGate(connection, principal);
  if (gate) return gate;

  if (!connection.ownerUserId && hasManagePermission(principal)) return allow('connections:manage on an org-scoped connection', 'connections:manage');

  const matched = matchingGrants(grants, principal, context)[0];
  if (matched) return allow(describe(matched), 'grant', matched);

  return deny(connection.ownerUserId ? 'no grant on this user-scoped connection' : 'no grant on this org-scoped connection');
}

/**
 * May `principal` list, add or revoke grants on the connection?
 *
 * - The owner of a user-scoped connection always can; nobody else does
 *   by default, not even an admin (it is their secret).
 * - `connections:manage` manages every org-scoped connection.
 * - A matching, unexpired `manage` grant manages either kind.
 * - Team-visibility connections additionally require team membership.
 */
export function canManage(connection: ConnectionLike, principal: GrantPrincipal, grants: GrantLike[], context: GrantContext = {}): GrantDecision {
  if (isOwner(connection, principal)) return allow('connection owner', 'owner');

  const gate = teamGate(connection, principal);
  if (gate) return gate;

  if (!connection.ownerUserId && hasManagePermission(principal)) return allow('connections:manage on an org-scoped connection', 'connections:manage');

  const matched = matchingGrants(grants, principal, context).find((grant) => grant.permission === 'manage');
  if (matched) return allow(describe(matched), 'grant', matched);

  return deny(connection.ownerUserId ? 'only the owner or a manage grant can manage a user-scoped connection' : 'connections:manage or a manage grant is required');
}
