import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { renderAtRoute } from '../../../test/render-at-route'
import type { ApprovalPolicy } from '../../../lib/api'

/**
 * /settings/approvals/policies/new and /settings/approvals/policies/:policyId:
 * the approval policy form that used to be a dialog on Settings > Approvals.
 */
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

const entitlementState = { granted: true }
vi.mock('../../../hooks/use-entitlement', async () => {
  const actual = await vi.importActual<any>('../../../hooks/use-entitlement')
  const state = () => (entitlementState.granted ? ['approval_policy'] : [])
  return {
    ...actual,
    useEntitlement: (feature?: string) => {
      const has = (f: string) => state().includes(f)
      if (feature === undefined) return { entitlements: state(), has, isLoading: false, edition: 'enterprise', limit: () => -1 }
      return { enabled: has(feature), isLoading: false, edition: 'enterprise' }
    },
    useEntitlements: () => ({
      entitlements: state(),
      has: (f: string) => state().includes(f),
      isLoading: false,
      edition: 'enterprise',
      limit: () => -1,
    }),
  }
})

vi.mock('../../../lib/api', () => ({
  approvalPoliciesApi: { list: vi.fn(), getById: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
}))

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))

import { approvalPoliciesApi } from '../../../lib/api'
import { ApprovalPolicyPage } from '../../../pages/approval-policy'

const mocked = approvalPoliciesApi as unknown as Record<string, ReturnType<typeof vi.fn>>

const samplePolicy: ApprovalPolicy = {
  id: 'p1',
  organizationId: 'org1',
  name: 'Refunds over $1,000',
  description: 'High-value refunds need two sign-offs',
  teamId: null,
  match: [{ attr: 'amount', op: 'gt', value: 1000 }],
  steps: [{ name: 'finance', approverRole: 'finance', minApprovals: 1 }],
  priority: 10,
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const NEW = { path: '/settings/approvals/policies/new', paths: ['/settings/approvals'] }
const EDIT = { path: '/settings/approvals/policies/:policyId', url: '/settings/approvals/policies/p1', paths: ['/settings/approvals'] }

beforeEach(() => {
  vi.clearAllMocks()
  entitlementState.granted = true
})

describe('/settings/approvals/policies/new', () => {
  it('creates a policy via POST with coerced match values and returns to the list', async () => {
    mocked.create.mockResolvedValue({ ...samplePolicy, id: 'new' })
    renderAtRoute(<ApprovalPolicyPage />, NEW)

    expect(screen.getByRole('heading', { name: 'New approval policy' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Deploy approvals' } })
    fireEvent.click(screen.getByRole('button', { name: /Add condition/i }))
    fireEvent.change(screen.getByLabelText('Condition 1 attribute'), { target: { value: 'amount' } })
    fireEvent.change(screen.getByLabelText('Condition 1 value'), { target: { value: '500' } })
    fireEvent.change(screen.getByLabelText('Step 1 name'), { target: { value: 'lead' } })
    fireEvent.click(screen.getByRole('button', { name: /Create policy/i }))

    await waitFor(() => expect(mocked.create).toHaveBeenCalledTimes(1))
    const payload = mocked.create.mock.calls[0][0]
    expect(payload.name).toBe('Deploy approvals')
    expect(payload.match).toEqual([{ attr: 'amount', op: 'eq', value: 500 }])
    expect(payload.steps).toEqual([{ name: 'lead', approverRole: '*', minApprovals: 1 }])
    expect(await screen.findByText('at /settings/approvals')).toBeInTheDocument()
  })

  it('shows the missing step name and focuses the name field first', async () => {
    renderAtRoute(<ApprovalPolicyPage />, NEW)
    fireEvent.click(screen.getByRole('button', { name: /Create policy/i }))

    expect(await screen.findByText('Name is required')).toBeInTheDocument()
    expect(screen.getByText('Step name is required')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')))
    expect(mocked.create).not.toHaveBeenCalled()
  })

  it('shows the upgrade prompt instead of the form without the entitlement', () => {
    entitlementState.granted = false
    renderAtRoute(<ApprovalPolicyPage />, NEW)
    expect(screen.queryByRole('button', { name: /Create policy/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Upgrade to Business/i })).toBeInTheDocument()
  })
})

describe('/settings/approvals/policies/:policyId', () => {
  it('seeds from the policy and saves via PATCH to its id', async () => {
    mocked.getById.mockResolvedValue(samplePolicy)
    mocked.update.mockResolvedValue(samplePolicy)
    renderAtRoute(<ApprovalPolicyPage />, EDIT)

    const name = await screen.findByLabelText('Name')
    expect(name).toHaveValue('Refunds over $1,000')
    expect(screen.getByLabelText('Condition 1 value')).toHaveValue('1000')
    fireEvent.change(name, { target: { value: 'Refunds over $2,000' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }))

    await waitFor(() => expect(mocked.update).toHaveBeenCalledTimes(1))
    expect(mocked.getById).toHaveBeenCalledWith('p1')
    expect(mocked.update.mock.calls[0][0]).toBe('p1')
    expect(mocked.update.mock.calls[0][1].name).toBe('Refunds over $2,000')
    expect(await screen.findByText('at /settings/approvals')).toBeInTheDocument()
  })

  it('stays on the form when the save is refused', async () => {
    mocked.getById.mockResolvedValue(samplePolicy)
    mocked.update.mockRejectedValue(new Error('nope'))
    renderAtRoute(<ApprovalPolicyPage />, EDIT)

    await screen.findByLabelText('Name')
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }))
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Failed to update policy', expect.any(String)))
    expect(screen.queryByText('at /settings/approvals')).not.toBeInTheDocument()
  })
})
