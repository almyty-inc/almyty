import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ApprovalPoliciesSettings } from '../approval-policies-settings'
import type { ApprovalPolicy } from '../../../lib/api'

// Mock the entitlement hook so we can flip the gate on/off per test. Both
// EntitlementGate and UpgradePrompt read through this hook.
const entitlementState = { granted: false }
vi.mock('../../../hooks/use-entitlement', async () => {
  const actual = await vi.importActual<any>('../../../hooks/use-entitlement')
  return {
    ...actual,
    useEntitlement: (feature?: string) => {
      const entitlements = entitlementState.granted ? ['approval_policy'] : []
      const has = (f: string) => entitlements.includes(f)
      if (feature === undefined) {
        return { entitlements, has, isLoading: false, edition: 'enterprise', limit: () => -1 }
      }
      return { enabled: has(feature), isLoading: false, edition: 'enterprise' }
    },
    useEntitlements: () => ({
      entitlements: entitlementState.granted ? ['approval_policy'] : [],
      has: (f: string) => (entitlementState.granted ? ['approval_policy'] : []).includes(f),
      isLoading: false,
      edition: 'enterprise',
      limit: () => -1,
    }),
  }
})

vi.mock('../../../lib/api', () => ({
  approvalPoliciesApi: {
    list: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

const notify = { success: vi.fn(), error: vi.fn() }
vi.mock('../../../store/app', () => ({
  useNotifications: () => notify,
}))

import { approvalPoliciesApi } from '../../../lib/api'

const mockedList = approvalPoliciesApi.list as ReturnType<typeof vi.fn>
const mockedCreate = approvalPoliciesApi.create as ReturnType<typeof vi.fn>
const mockedUpdate = approvalPoliciesApi.update as ReturnType<typeof vi.fn>
const mockedDelete = approvalPoliciesApi.delete as ReturnType<typeof vi.fn>

const samplePolicy: ApprovalPolicy = {
  id: 'p1',
  organizationId: 'org1',
  name: 'Refunds over $1,000',
  description: 'High-value refunds need two sign-offs',
  teamId: null,
  match: [{ attr: 'amount', op: 'gt', value: 1000 }],
  steps: [
    { name: 'finance', approverRole: 'finance', minApprovals: 1 },
    { name: 'manager', approverRole: 'admin', minApprovals: 1 },
  ],
  priority: 10,
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

describe('ApprovalPoliciesSettings', () => {
  beforeEach(() => {
    entitlementState.granted = false
    mockedList.mockReset()
    mockedCreate.mockReset()
    mockedUpdate.mockReset()
    mockedDelete.mockReset()
    notify.success.mockReset()
    notify.error.mockReset()
  })

  it('renders the UpgradePrompt and makes no policy calls when ungranted', async () => {
    render(<ApprovalPoliciesSettings />)

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Upgrade to Business/i })).toBeInTheDocument()
    })
    // The lock title is shown; the manager UI is not.
    expect(screen.getAllByText('Approval Policies').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByRole('button', { name: /New Policy/i })).not.toBeInTheDocument()
    expect(mockedList).not.toHaveBeenCalled()
  })

  it('lists policies when the entitlement is granted', async () => {
    entitlementState.granted = true
    mockedList.mockResolvedValue([samplePolicy])

    render(<ApprovalPoliciesSettings />)

    await waitFor(() => {
      expect(screen.getByText('Refunds over $1,000')).toBeInTheDocument()
    })
    expect(mockedList).toHaveBeenCalled()
    // Match summary + step count rendered.
    expect(screen.getByText(/amount gt 1000/i)).toBeInTheDocument()
    expect(screen.getByText('Enabled')).toBeInTheDocument()
  })

  // Creating and editing are pages now (approval-policy-form.test.tsx drives
  // the POST and PATCH); the list links there.
  it('links New policy to the create page', async () => {
    entitlementState.granted = true
    mockedList.mockResolvedValue([])

    render(<ApprovalPoliciesSettings />)

    await waitFor(() => {
      expect(screen.getByText(/No approval policies yet/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: /New policy/i })).toHaveAttribute(
      'href',
      '/settings/approvals/policies/new',
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('links each row to its own edit page', async () => {
    entitlementState.granted = true
    mockedList.mockResolvedValue([samplePolicy])

    render(<ApprovalPoliciesSettings />)

    await waitFor(() => expect(screen.getByText('Refunds over $1,000')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /Edit Refunds over \$1,000/i })).toHaveAttribute(
      'href',
      '/settings/approvals/policies/p1',
    )
  })

  it('deletes a policy via DELETE after confirmation', async () => {
    entitlementState.granted = true
    mockedList.mockResolvedValue([samplePolicy])
    mockedDelete.mockResolvedValue({ success: true })

    render(<ApprovalPoliciesSettings />)

    await waitFor(() => expect(screen.getByText('Refunds over $1,000')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /Delete Refunds over \$1,000/i }))

    const alert = await screen.findByRole('alertdialog')
    fireEvent.click(within(alert).getByRole('button', { name: /^Delete policy$/i }))

    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith('p1'))
  })
})
