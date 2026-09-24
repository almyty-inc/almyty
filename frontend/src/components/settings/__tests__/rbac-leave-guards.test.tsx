/**
 * The custom-role and policy forms are inline in their cards; a half
 * written one asks before a navigation throws it away, a clean or
 * cancelled one does not.
 */
import { describe, it, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks, expectLeavesWithoutAsking } from '@/test/leave-guard'
import { RbacSettings } from '../rbac-settings'
import { apiGet, organizationsApi, rbacApi } from '@/lib/api'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
  rbacApi: {
    listRoles: vi.fn(),
    createRole: vi.fn(),
    updateRole: vi.fn(),
    deleteRole: vi.fn(),
    assignUser: vi.fn(),
    unassignUser: vi.fn(),
    getUserPermissions: vi.fn(),
    listPolicies: vi.fn(),
    createPolicy: vi.fn(),
    deletePolicy: vi.fn(),
  },
  organizationsApi: { getMembers: vi.fn() },
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Test Org' } }),
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
  vi.mocked(apiGet).mockResolvedValue({
    edition: 'enterprise',
    entitlements: ['advanced_rbac'],
    limits: {},
    expiresAt: null,
  } as any)
  vi.mocked(rbacApi.listRoles).mockResolvedValue([] as any)
  vi.mocked(rbacApi.listPolicies).mockResolvedValue([] as any)
  vi.mocked(organizationsApi.getMembers).mockResolvedValue([] as any)
})

const at = () => renderAtRoute(<RbacSettings />, { path: '/settings', paths: ['/elsewhere'] })

describe('custom role form', () => {
  it('asks while a role is half written', async () => {
    const { router } = at()
    fireEvent.click(await screen.findByRole('button', { name: /new role/i }))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'billing-auditor' } })
    await expectLeaveAsks(router)
  })

  it('leaves without asking after Cancel', async () => {
    const { router } = at()
    fireEvent.click(await screen.findByRole('button', { name: /new role/i }))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'billing-auditor' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expectLeavesWithoutAsking(router)
  })
})

describe('policy form', () => {
  it('asks while a policy is half written', async () => {
    const { router } = at()
    fireEvent.click(await screen.findByRole('button', { name: /new policy/i }))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'deny-exports' } })
    await expectLeaveAsks(router)
  })

  it('leaves an opened but empty policy form without asking', async () => {
    const { router } = at()
    fireEvent.click(await screen.findByRole('button', { name: /new policy/i }))
    await screen.findByLabelText('Name')
    await expectLeavesWithoutAsking(router)
  })
})
