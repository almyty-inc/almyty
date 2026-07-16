import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../../test/setup'
import { RbacSettings } from '../rbac-settings'
import type { EntitlementSnapshot } from '../../../hooks/use-entitlement'

// Mock the whole api module. `apiGet` backs the entitlements query (via
// useEntitlement); rbacApi/organizationsApi back the surface itself.
vi.mock('../../../lib/api', () => ({
  apiGet: vi.fn(),
  rbacApi: {
    listRoles: vi.fn(),
    getRole: vi.fn(),
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
  organizationsApi: {
    getMembers: vi.fn(),
  },
}))

vi.mock('../../../store/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: { id: 'org-1', name: 'Test Org' },
  }),
}))

vi.mock('../../../store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

import { apiGet, rbacApi, organizationsApi } from '../../../lib/api'

const mockedApiGet = apiGet as unknown as ReturnType<typeof vi.fn>

const withoutRbac: EntitlementSnapshot = {
  edition: 'community',
  entitlements: ['agents', 'tools'],
  limits: {},
  expiresAt: null,
}

const withRbac: EntitlementSnapshot = {
  edition: 'enterprise',
  entitlements: ['agents', 'tools', 'advanced_rbac'],
  limits: {},
  expiresAt: null,
}

const sampleRole = {
  id: 'role-1',
  organizationId: 'org-1',
  name: 'release-manager',
  description: 'Ships releases',
  permissions: ['agents:read', 'tools:manage'],
  active: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const sampleMembers = [
  { id: 'user-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', role: 'admin' },
]

function mockEntitlements(snapshot: EntitlementSnapshot) {
  // apiGet is used both for entitlements and (via getUserPermissions) elsewhere,
  // but getUserPermissions is on rbacApi mock, so apiGet only serves entitlements here.
  mockedApiGet.mockResolvedValue(snapshot)
}

// Radix Select uses pointer-capture + scrollIntoView, absent in jsdom.
beforeEach(() => {
  if (!Element.prototype.hasPointerCapture)
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

describe('RbacSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(rbacApi.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue([sampleRole])
    ;(rbacApi.listPolicies as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(organizationsApi.getMembers as ReturnType<typeof vi.fn>).mockResolvedValue(sampleMembers)
  })

  it('renders the upgrade prompt and never hits /rbac/* without the entitlement', async () => {
    mockEntitlements(withoutRbac)
    render(<RbacSettings />)

    await waitFor(() =>
      expect(screen.getByText(/Advanced RBAC/i)).toBeInTheDocument(),
    )
    // Upgrade CTA present.
    expect(screen.getByText(/Upgrade to Business|View plans/i)).toBeInTheDocument()

    // The gated surface must not query the RBAC API at all.
    expect(rbacApi.listRoles).not.toHaveBeenCalled()
    expect(rbacApi.listPolicies).not.toHaveBeenCalled()
  })

  it('renders the roles table when the entitlement is granted', async () => {
    mockEntitlements(withRbac)
    render(<RbacSettings />)

    await waitFor(() => expect(rbacApi.listRoles).toHaveBeenCalled())
    expect(await screen.findByText('release-manager')).toBeInTheDocument()
    expect(screen.getByText('agents:read')).toBeInTheDocument()
  })

  it('creates a role via POST /rbac/roles', async () => {
    mockEntitlements(withRbac)
    ;(rbacApi.createRole as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...sampleRole,
      id: 'role-2',
      name: 'billing-auditor',
    })
    const user = userEvent.setup()
    render(<RbacSettings />)

    await screen.findByText('release-manager')
    await user.click(screen.getByRole('button', { name: /new role/i }))

    const nameInput = await screen.findByLabelText('Name')
    await user.type(nameInput, 'billing-auditor')
    await user.type(screen.getByLabelText('Permissions'), 'audit:read\naudit:export')

    await user.click(screen.getByRole('button', { name: /create role/i }))

    await waitFor(() => expect(rbacApi.createRole).toHaveBeenCalledTimes(1))
    expect(rbacApi.createRole).toHaveBeenCalledWith({
      name: 'billing-auditor',
      description: undefined,
      permissions: ['audit:read', 'audit:export'],
    })
  })

  it('deletes a role via DELETE /rbac/roles/:id', async () => {
    mockEntitlements(withRbac)
    ;(rbacApi.deleteRole as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RbacSettings />)

    await screen.findByText('release-manager')
    await user.click(screen.getByRole('button', { name: /delete release-manager/i }))

    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }))

    await waitFor(() => expect(rbacApi.deleteRole).toHaveBeenCalledWith('role-1'))
  })

  it('assigns a user to a role via POST /rbac/roles/:id/assignments', async () => {
    mockEntitlements(withRbac)
    ;(rbacApi.assignUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'assign-1',
    })
    const user = userEvent.setup()
    render(<RbacSettings />)

    await screen.findByText('release-manager')
    await user.click(screen.getByRole('button', { name: /assign users to release-manager/i }))

    // Pick the member from the select, then assign.
    await user.click(await screen.findByRole('combobox', { name: /select member/i }))
    await user.click(await screen.findByText(/Ada Lovelace/i))
    await user.click(screen.getByRole('button', { name: /^assign$/i }))

    await waitFor(() =>
      expect(rbacApi.assignUser).toHaveBeenCalledWith('role-1', 'user-1'),
    )
  })

  it('creates a policy via POST /rbac/policies', async () => {
    mockEntitlements(withRbac)
    ;(rbacApi.createPolicy as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'pol-1' })
    const user = userEvent.setup()
    render(<RbacSettings />)

    await screen.findByText('release-manager')
    await user.click(screen.getByRole('button', { name: /new policy/i }))

    await user.type(await screen.findByLabelText('Name'), 'deny-prod')
    await user.click(screen.getByRole('button', { name: /create policy/i }))

    await waitFor(() => expect(rbacApi.createPolicy).toHaveBeenCalledTimes(1))
    const arg = (rbacApi.createPolicy as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.name).toBe('deny-prod')
    expect(arg.effect).toBe('allow')
    expect(arg.action).toBe('*')
  })
})
