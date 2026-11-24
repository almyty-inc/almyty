import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '@/test/setup'
import { HostedCapacityCard, limitsFromDraft, type HostedCapacityView } from '../hosted-capacity'

vi.mock('@/lib/api', () => ({
  environmentsApi: { capacity: vi.fn(), setLimits: vi.fn() },
}))
const role = vi.hoisted(() => ({ current: 'admin' }))
vi.mock('@/store/organization', () => {
  const state = { currentOrganization: { id: 'o1', name: 'Org' } }
  return { useOrganizationStore: (select?: any) => (select ? select(state) : state) }
})
vi.mock('@/store/auth', () => ({
  useAuthStore: (select?: any) => {
    const state = { user: { id: 'me', organizationMemberships: [{ organization: { id: 'o1' }, role: role.current }] } }
    return select ? select(state) : state
  },
}))

import { environmentsApi } from '@/lib/api'

const setLimits = environmentsApi.setLimits as ReturnType<typeof vi.fn>

const PLAN = { maxConcurrentRunners: 2, maxWorkspaces: 10, monthlyCeilingUsd: 50 }
const NONE = { maxConcurrentRunners: null, maxWorkspaces: null, monthlyCeilingUsd: null }

const PRO: HostedCapacityView = {
  plan: 'pro',
  hostedEnvironments: true,
  billed: true,
  machinesRunning: { used: 1, limit: 2 },
  workspacesKept: { used: 3, limit: 10 },
  minutesThisMonth: { used: 0, ceiling: null, byClass: [] },
  spendThisMonth: { usd: 4, ceilingUsd: 50 },
  alwaysOnHosted: { used: 0, limit: null },
  ownLimits: { available: true, plan: PLAN, own: NONE },
}

describe('lowering hosted limits on the Hosted tab', () => {
  beforeEach(() => {
    setLimits.mockReset()
    role.current = 'admin'
  })

  it('lets an admin lower limits inline, next to the used-of-limit lines', async () => {
    setLimits.mockResolvedValue({ available: true, plan: PLAN, own: { ...NONE, maxConcurrentRunners: 1 } })
    render(<HostedCapacityCard capacity={PRO} />)
    fireEvent.click(screen.getByRole('button', { name: 'Lower limits' }))

    const machines = screen.getByTestId('hosted-limit-maxConcurrentRunners')
    expect(screen.getByTestId('hosted-capacity-machines')).toContainElement(machines)
    expect(machines).toHaveValue(2)
    expect(screen.getByTestId('hosted-capacity-spend')).toContainElement(screen.getByTestId('hosted-limit-monthlyCeilingUsd'))
    expect(screen.getByText('Your plan allows up to $50.00.')).toBeInTheDocument()

    fireEvent.change(machines, { target: { value: '1' } })
    fireEvent.change(screen.getByTestId('hosted-limit-monthlyCeilingUsd'), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // The plan's own number (10 workspaces) follows the plan.
    await waitFor(() => expect(setLimits).toHaveBeenCalledWith({ maxConcurrentRunners: 1, maxWorkspaces: null, monthlyCeilingUsd: 20 }))
  })

  it('will not save a raise above the plan', () => {
    render(<HostedCapacityCard capacity={PRO} />)
    fireEvent.click(screen.getByRole('button', { name: 'Lower limits' }))
    fireEvent.change(screen.getByTestId('hosted-limit-maxWorkspaces'), { target: { value: '11' } })
    expect(screen.getByText('Your plan allows up to 10. You can only lower it.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(setLimits).not.toHaveBeenCalled()
  })

  it('offers nothing to a member, or where the install has no plan', () => {
    role.current = 'member'
    const { unmount } = render(<HostedCapacityCard capacity={{ ...PRO, ownLimits: { available: true, plan: PLAN, own: { ...NONE, maxWorkspaces: 4 } } }} />)
    expect(screen.queryByRole('button', { name: 'Lower limits' })).toBeNull()
    expect(screen.getByTestId('hosted-capacity-lowered')).toHaveTextContent('Your organization has set some of these lower than the plan allows.')
    unmount()
    role.current = 'owner'
    render(<HostedCapacityCard capacity={{ ...PRO, ownLimits: { available: false, plan: NONE, own: NONE } }} />)
    expect(screen.queryByRole('button', { name: 'Lower limits' })).toBeNull()
  })

  it('puts the organization back on the plan limits', async () => {
    setLimits.mockResolvedValue({ available: true, plan: PLAN, own: NONE })
    render(<HostedCapacityCard capacity={{ ...PRO, ownLimits: { available: true, plan: PLAN, own: { ...NONE, maxWorkspaces: 4 } } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Lower limits' }))
    expect(screen.getByTestId('hosted-limit-maxWorkspaces')).toHaveValue(4)
    fireEvent.click(screen.getByRole('button', { name: "Use the plan's limits" }))
    await waitFor(() => expect(setLimits).toHaveBeenCalledWith(NONE))
  })

  it('reads a draft: empty or the plan number follows the plan, fractions and cents are checked', () => {
    expect(limitsFromDraft({ maxConcurrentRunners: '', maxWorkspaces: '10', monthlyCeilingUsd: '12.50' }, PLAN)).toEqual({
      limits: { maxConcurrentRunners: null, maxWorkspaces: null, monthlyCeilingUsd: 12.5 },
      errors: {},
    })
    expect(limitsFromDraft({ maxConcurrentRunners: '1.5', maxWorkspaces: '-1', monthlyCeilingUsd: '1.234' }, PLAN).errors).toEqual({
      maxConcurrentRunners: 'Enter a whole number, 0 or more.',
      maxWorkspaces: 'Enter a whole number, 0 or more.',
      monthlyCeilingUsd: 'Enter an amount in dollars, 0 or more.',
    })
    // No plan limit: any number is the organization's own.
    expect(limitsFromDraft({ maxConcurrentRunners: '', maxWorkspaces: '', monthlyCeilingUsd: '900' }, { ...PLAN, monthlyCeilingUsd: null }).limits.monthlyCeilingUsd).toBe(900)
  })
})
