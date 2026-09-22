/**
 * Who may call one tool on one gateway.
 *
 * `gateway_tools.permissions` shipped with four fields (allowedUsers,
 * allowedRoles, allowedOrganizations, requiredScopes), a PATCH endpoint
 * that wrote all four, a dashboard that edited them, and a
 * `GatewayTool.hasPermission()` that implemented them -- with no caller
 * anywhere in src or ee. A tool restricted to two named users answered
 * anyone who could reach the gateway.
 *
 * A pure function rather than an entity method, for the same reason
 * gateway-tool-policy.ts is one: the decision has to be callable from the
 * executor with whatever the repository handed back, and a method only
 * exists on a hydrated entity. The entity keeps hasPermission() and
 * delegates here, so the two can never disagree.
 */

export interface GatewayToolPermissions {
  allowedUsers?: string[];
  allowedRoles?: string[];
  allowedOrganizations?: string[];
  requiredScopes?: string[];
}

export interface ToolCaller {
  userId?: string | null;
  roles?: string[];
  organizationId?: string | null;
  scopes?: string[];
}

export interface PermissionDecision {
  allowed: boolean;
  /** Which clause refused, for the error the caller sees. */
  reason?: string;
}

/**
 * An absent or empty list is "no restriction on this axis" -- narrowing is
 * something an operator opts into. A list that IS set is exhaustive: an
 * anonymous caller (no userId, no roles, no scopes) fails it, which is the
 * whole point of having written the list.
 */
export function decideToolCaller(
  permissions: GatewayToolPermissions | null | undefined,
  caller: ToolCaller,
): PermissionDecision {
  if (!permissions) return { allowed: true };

  const { allowedUsers, allowedRoles, allowedOrganizations, requiredScopes } = permissions;

  if (allowedUsers?.length) {
    if (!caller.userId || !allowedUsers.includes(caller.userId)) {
      return { allowed: false, reason: 'the caller is not on this tool\'s allowed-user list' };
    }
  }

  if (allowedRoles?.length) {
    const roles = caller.roles ?? [];
    if (!roles.some((role) => allowedRoles.includes(role))) {
      return { allowed: false, reason: 'the caller holds none of this tool\'s allowed roles' };
    }
  }

  if (allowedOrganizations?.length) {
    if (!caller.organizationId || !allowedOrganizations.includes(caller.organizationId)) {
      return { allowed: false, reason: 'the caller\'s organization is not on this tool\'s allowed list' };
    }
  }

  if (requiredScopes?.length) {
    const scopes = caller.scopes ?? [];
    if (!requiredScopes.some((scope) => scopes.includes(scope))) {
      return { allowed: false, reason: `this tool requires one of the scopes: ${requiredScopes.join(', ')}` };
    }
  }

  return { allowed: true };
}
