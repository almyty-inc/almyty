import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'

import { render } from '@/test/setup'
import { HostedEnvironmentsTab } from '../hosted-environments-tab'
import { capacityLines, sizeLine, type HostedCapacityView } from '../hosted-capacity'

vi.mock('@/lib/api', () => ({
  environmentsApi: { list: vi.fn(), usage: vi.fn(), workspaces: vi.fn(), capacity: vi.fn() },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/store/organization', () => {
  const state = { currentOrganization: { id: 'o1', name: 'Org' } }
  return { useOrganizationStore: (select?: any) => (select ? select(state) : state) }
})
vi.mock('@/store/auth', () => {
  const state = { user: { id: 'me' } }
  return { useAuthStore: (select?: any) => (select ? select(state) : state) }
})

import { environmentsApi } from '@/lib/api'

const list = environmentsApi.list as ReturnType<typeof vi.fn>
const usage = environmentsApi.usage as ReturnType<typeof vi.fn>
const capacity = environmentsApi.capacity as ReturnType<typeof vi.fn>
const SETTINGS = { images: ['standard'], idleTimeoutMinutes: { min: 5, max: 120, default: 15 }, suspendedRetention: { keepDays: 30 } }

const PRO: HostedCapacityView = {
  plan: 'pro',
  hostedEnvironments: true,
  billed: true,
  machinesRunning: { used: 1, limit: 2 },
  workspacesKept: { used: 3, limit: 10 },
  minutesThisMonth: {
    used: 2490,
    ceiling: null,
    byClass: [
      { resourceClass: 'large', used: 30, included: 0 },
      { resourceClass: 'small', used: 2460, included: 2400 },
    ],
  },
  alwaysOnHosted: { used: 2, limit: 3 },
}

describe('hosted plan capacity, in plain words', () => {
  it('says what is used and what the limit is for each number', () => {
    expect(capacityLines(PRO).map((l) => l.text)).toEqual([
      'Machines running now: 1 of 2',
      'Workspaces kept: 3 of 10',
      'Large machines: 30m used this month (none included, 30m over, billed by the minute)',
      'Small machines: 41h used this month (40h included, 1h over, billed by the minute)',
      'Always-on agents living on a hosted machine: 2 of 3',
    ])
  })

  it('names a monthly ceiling and limits with none', () => {
    const lines = capacityLines({ ...PRO, alwaysOnHosted: { used: 1, limit: null }, minutesThisMonth: { used: 60, ceiling: 600, byClass: [] } })
    expect(lines.map((l) => l.text)).toContain("Monthly limit: 1h of 10h used. Machines don't start once it is reached.")
    expect(lines.map((l) => l.text)).toContain('Always-on agents living on a hosted machine: 1, no limit')
  })

  it('does not say billed where nothing is billed, and shows minutes alone without an allowance', () => {
    expect(sizeLine({ resourceClass: 'small', used: 90, included: 60 }, false)).toBe('Small machines: 1h 30m used this month (1h included, 30m over)')
    expect(sizeLine({ resourceClass: 'small', used: 90, included: null }, true)).toBe('Small machines: 1h 30m used this month')
    expect(sizeLine({ resourceClass: 'small', used: 30, included: 60 }, true)).toBe('Small machines: 30m used of 1h included this month')
  })

  it('names the sizes the plan allows, the price a minute of overage and the monthly spending limit', () => {
    const view: HostedCapacityView = {
      ...PRO,
      resourceClasses: ['small', 'medium'],
      minutesThisMonth: {
        used: 2520,
        ceiling: null,
        byClass: [
          { resourceClass: 'medium', used: 60, included: 0, usdPerMinute: 0.002 },
          { resourceClass: 'small', used: 2460, included: 2400, usdPerMinute: 0.001 },
        ],
      },
      spendThisMonth: { usd: 0.18, ceilingUsd: 50 },
    }
    expect(capacityLines(view).map((l) => l.text)).toEqual([
      'Machines running now: 1 of 2',
      'Workspaces kept: 3 of 10',
      'Machine sizes: Small and Medium',
      'Medium machines: 1h used this month (none included, 1h over, billed at $0.002 a minute)',
      'Small machines: 41h used this month (40h included, 1h over, billed at $0.001 a minute)',
      "Monthly spending limit: $0.18 of $50.00 used beyond the included hours. Machines don't start once it is reached.",
      'Always-on agents living on a hosted machine: 2 of 3',
    ])
    // No dollar ceiling, every size allowed: neither line.
    const open = capacityLines({ ...view, resourceClasses: null, spendThisMonth: { usd: 0, ceilingUsd: null } }).map((l) => l.key)
    expect(open).not.toContain('sizes')
    expect(open).not.toContain('spend')
  })
})

describe('the Hosted tab shows the plan capacity', () => {
  beforeEach(() => {
    list.mockReset()
    usage.mockReset()
    capacity.mockReset()
    usage.mockResolvedValue({ from: '', to: '', environments: [], organization: null })
  })

  it('above the environments', async () => {
    list.mockResolvedValue({ success: true, data: [{ id: 'e1', name: 'app', visibility: 'private', image: { base: 'standard' }, egress: { allowHosts: [] }, mine: null }], enabled: true, settings: SETTINGS })
    capacity.mockResolvedValue(PRO)
    render(<HostedEnvironmentsTab />)
    expect(await screen.findByText('What your Pro plan includes')).toBeInTheDocument()
    expect(screen.getByTestId('hosted-capacity-machines')).toHaveTextContent('Machines running now: 1 of 2')
  })

  it('on a plan without hosted machines: says so, points to plans, and offers no form', async () => {
    list.mockResolvedValue({ success: true, data: [], enabled: true, settings: SETTINGS })
    capacity.mockResolvedValue({ ...PRO, plan: 'free', hostedEnvironments: false })
    render(<HostedEnvironmentsTab />)
    expect(await screen.findByText('Hosted machines are not part of the Free plan.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'see plans' })).toHaveAttribute('href', '/settings/billing')
    expect(screen.queryByRole('button', { name: /New environment/ })).toBeNull()
  })
})
