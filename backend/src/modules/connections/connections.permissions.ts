import { OrganizationRole } from '../../entities/user-organization.entity';

/**
 * RBAC vocabulary for the Connections layer. Org-scoped connections need
 * `connections:manage`; reading the (masked) list needs
 * `connections:read`. User-scoped connections are managed by their owner
 * and need only `connections:read` plus the org setting
 * `allowUserScopedConnections`.
 *
 * The same strings are listed in UserOrganization.hasPermission so the
 * RolesGuard's @RequirePermissions() and this module agree; an EE custom
 * role can add them through the membership `permissions` column.
 */
export const CONNECTIONS_READ = 'connections:read';
export const CONNECTIONS_MANAGE = 'connections:manage';

export const CONNECTION_PERMISSIONS = [CONNECTIONS_READ, CONNECTIONS_MANAGE] as const;

export const ROLE_CONNECTION_PERMISSIONS: Record<OrganizationRole, readonly string[]> = {
  [OrganizationRole.OWNER]: [CONNECTIONS_READ, CONNECTIONS_MANAGE],
  [OrganizationRole.ADMIN]: [CONNECTIONS_READ, CONNECTIONS_MANAGE],
  [OrganizationRole.MEMBER]: [CONNECTIONS_READ],
  [OrganizationRole.VIEWER]: [CONNECTIONS_READ],
};

export interface MembershipLike {
  organizationId?: string;
  organization?: { id: string };
  role: OrganizationRole | string;
  permissions?: string[] | null;
}

/** The request user as JwtStrategy attaches it: id plus memberships. */
export interface ConnectionPrincipal {
  id: string;
  organizationMemberships?: MembershipLike[];
}

export function membershipOf(principal: ConnectionPrincipal, organizationId: string): MembershipLike | undefined {
  return principal.organizationMemberships?.find(
    (m) => (m.organizationId ?? m.organization?.id) === organizationId,
  );
}

export function roleHasConnectionPermission(role: string | undefined, permission: string): boolean {
  if (!role) return false;
  return (ROLE_CONNECTION_PERMISSIONS[role as OrganizationRole] ?? []).includes(permission);
}

export function principalHasPermission(principal: ConnectionPrincipal, organizationId: string, permission: string): boolean {
  const membership = membershipOf(principal, organizationId);
  if (!membership) return false;
  if (roleHasConnectionPermission(membership.role, permission)) return true;
  return Array.isArray(membership.permissions) && membership.permissions.includes(permission);
}
