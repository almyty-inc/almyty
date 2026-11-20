import { useMemo } from 'react'
import { useAuthStore } from '@/store/auth'
import { useOrganizationStore } from '@/store/organization'
import { OrganizationRole } from '@/types'

/**
 * The signed-in person's role in the organization they are currently looking
 * at, and whether it lets them change things.
 *
 * Several routes are `@Roles('admin','owner')` on the server while the screen
 * rendered its create and delete controls to everyone — a member clicked New
 * and got a 403. The role has always been on the user (each
 * `organizationMembership` carries one); nothing read it, so every screen
 * that needed it either invented its own check or, more often, skipped one.
 *
 * This is a convenience for the interface, never a security boundary: the
 * server decides. Hiding a control the server would refuse is about not
 * offering someone an action that cannot work.
 */
export interface OrganizationRoleState {
  role: OrganizationRole | null
  /** admin or owner: may create, edit and delete within the organization. */
  canManage: boolean
  /** owner only: may change billing, transfer or delete the organization. */
  isOwner: boolean
}

export function useOrganizationRole(): OrganizationRoleState {
  const user = useAuthStore((s) => s.user)
  const { currentOrganization } = useOrganizationStore()

  return useMemo(() => {
    const orgId = currentOrganization?.id
    // GET /auth/profile re-projects each membership as
    // `{ id, role, joinedAt, organization: { id, name, slug } }` — there is
    // no `organizationId` on the wire, only the nested organization. Reading
    // the flat key alone matched nothing, so `role` was null and `canManage`
    // false for EVERY user including owners, which hid the spend-budget
    // controls from the people who own the org. Read the nested id first and
    // keep the flat one as a fallback for payloads that carry it.
    const membership = orgId
      ? user?.organizationMemberships?.find(
          (m) => (m.organization?.id ?? m.organizationId) === orgId,
        )
      : undefined
    const role = membership?.role ?? null
    return {
      role,
      canManage: role === OrganizationRole.ADMIN || role === OrganizationRole.OWNER,
      isOwner: role === OrganizationRole.OWNER,
    }
  }, [user, currentOrganization?.id])
}
/**
 * Whether the signed-in person may manage this agent. The server says so
 * on GET /agents/:id (`viewerCanManage`), by the same rule its manage paths
 * enforce, which also lets in a lead of the agent's team; when the page has
 * it, that answer wins. Without it, the guess is an admin or owner of the
 * organization, or the member who owns the agent. A convenience for the
 * interface: the server decides.
 */
export function useCanManageAgent(
  ownerId: string | null | undefined,
  viewerCanManage?: boolean | null,
): boolean {
  const user = useAuthStore((s) => s.user)
  const { canManage } = useOrganizationRole()
  if (typeof viewerCanManage === 'boolean') return viewerCanManage
  return canManage || (!!ownerId && !!user?.id && user.id === ownerId)
}