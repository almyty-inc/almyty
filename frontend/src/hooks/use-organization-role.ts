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
    const membership = orgId
      ? user?.organizationMemberships?.find((m) => m.organizationId === orgId)
      : undefined
    const role = membership?.role ?? null
    return {
      role,
      canManage: role === OrganizationRole.ADMIN || role === OrganizationRole.OWNER,
      isOwner: role === OrganizationRole.OWNER,
    }
  }, [user, currentOrganization?.id])
}
