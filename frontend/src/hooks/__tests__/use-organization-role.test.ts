import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCanManageAgent, useOrganizationRole } from '../use-organization-role'

/**
 * Several server routes are `@Roles('admin','owner')` while the screens that
 * drive them rendered their create and delete controls to everyone — a
 * member clicked New and got a 403. The role has always been on the user;
 * nothing read it.
 *
 * This is a convenience, never a boundary: the server still decides. The
 * point is not to offer an action that cannot work.
 */
let user: any = null
let currentOrganization: any = null

vi.mock('@/store/auth', () => ({
  useAuthStore: (selector: any) => selector({ user }),
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization }),
}))

const member = (organizationId: string, role: string) => ({ organizationId, role })

describe('useOrganizationRole', () => {
  beforeEach(() => {
    user = null
    currentOrganization = null
  })

  it('reads the role for the organization currently selected, not the first one', () => {
    currentOrganization = { id: 'org-2' }
    user = { organizationMemberships: [member('org-1', 'owner'), member('org-2', 'member')] }
    const { result } = renderHook(() => useOrganizationRole())
    // Taking the first membership would report owner here, which is how a
    // member of the org on screen gets controls they cannot use.
    expect(result.current.role).toBe('member')
    expect(result.current.canManage).toBe(false)
  })

  it.each([
    ['owner', true, true],
    ['admin', true, false],
    ['member', false, false],
    ['viewer', false, false],
  ])('maps %s to canManage=%s isOwner=%s', (role, canManage, isOwner) => {
    currentOrganization = { id: 'org-1' }
    user = { organizationMemberships: [member('org-1', role as string)] }
    const { result } = renderHook(() => useOrganizationRole())
    expect(result.current.canManage).toBe(canManage)
    expect(result.current.isOwner).toBe(isOwner)
  })

  it('refuses rather than assumes when there is no membership for this org', () => {
    currentOrganization = { id: 'org-9' }
    user = { organizationMemberships: [member('org-1', 'owner')] }
    const { result } = renderHook(() => useOrganizationRole())
    expect(result.current.role).toBeNull()
    expect(result.current.canManage).toBe(false)
  })

  /**
   * THE SHAPE THAT ACTUALLY ARRIVES.
   *
   * `member()` above builds `{ organizationId, role }`, which nothing ever
   * sends. `GET /auth/profile` (auth.controller.ts) re-projects every
   * membership to `{ id, role, joinedAt, organization: { id, name, slug } }`
   * — there is no flat `organizationId` on the wire, and the store's user
   * only ever comes from that endpoint.
   *
   * Matching on the flat key alone therefore found nothing for anybody:
   * `role` was null and `canManage` false for every user including owners,
   * which hid the spend-budget controls from the people who own the org.
   * The old fixture passed the whole time.
   */
  const profileMember = (organizationId: string, role: string) => ({
    id: 'm-' + organizationId,
    role,
    joinedAt: '2026-01-01T00:00:00.000Z',
    organization: { id: organizationId, name: 'Org ' + organizationId, slug: organizationId },
  })

  it('reads the role off the payload /auth/profile actually sends', () => {
    currentOrganization = { id: 'org-1' }
    user = { organizationMemberships: [profileMember('org-1', 'owner')] }
    const { result } = renderHook(() => useOrganizationRole())
    expect(result.current.role).toBe('owner')
    expect(result.current.canManage).toBe(true)
    expect(result.current.isOwner).toBe(true)
  })

  it('still picks the right org from the real payload when there are several', () => {
    currentOrganization = { id: 'org-2' }
    user = {
      organizationMemberships: [profileMember('org-1', 'owner'), profileMember('org-2', 'member')],
    }
    const { result } = renderHook(() => useOrganizationRole())
    expect(result.current.role).toBe('member')
    expect(result.current.canManage).toBe(false)
  })

  it('does not throw before the user or the organization has loaded', () => {
    const { result } = renderHook(() => useOrganizationRole())
    expect(result.current.canManage).toBe(false)
    expect(result.current.role).toBeNull()
  })
})

describe('useCanManageAgent', () => {
  beforeEach(() => {
    currentOrganization = { id: 'org-1' }
  })

  it('lets an admin or owner manage any agent, as the server does', () => {
    user = { id: 'u-admin', organizationMemberships: [member('org-1', 'admin')] }
    expect(renderHook(() => useCanManageAgent('u-someone-else')).result.current).toBe(true)
  })

  it('lets a member manage the agent they own, and no other', () => {
    user = { id: 'u-member', organizationMemberships: [member('org-1', 'member')] }
    expect(renderHook(() => useCanManageAgent('u-member')).result.current).toBe(true)
    expect(renderHook(() => useCanManageAgent('u-someone-else')).result.current).toBe(false)
    expect(renderHook(() => useCanManageAgent(null)).result.current).toBe(false)
  })
})