import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render } from '../../../test/setup'
import { ANALYTICS_TABS, getAnalyticsTab } from '../constants'

/**
 * The budgets management surface.
 *
 * `POST/PATCH/DELETE /budgets` and `GET /budgets/alerts` were reachable
 * from nothing in the product -- only the spend chart and the deploy
 * dialog's picker ever touched this controller -- so a spend ceiling
 * could not be set, changed or removed by a person at all. These tests
 * hold the wiring: that each verb is actually called, with the payload
 * `BudgetsService.validate()` accepts, and that a refusal reaches the
 * person as the backend's own reason.
 */
const notify = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  budgetsApi: {
    list: vi.fn(),
    getAlerts: vi.fn(),
    getSpend: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  agentsApi: { getAll: vi.fn() },
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Acme' } }),
}))

vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

// The mutation routes are @Roles('admin','owner') and the tab hides its
// controls for anyone else, so the default identity here is an admin.
// `role` is overridden in the member test below.
let role = 'admin'
vi.mock('@/store/auth', () => ({
  useAuthStore: (selector: any) =>
    selector({
      user: {
        id: 'user-1',
        organizationMemberships: [{ organizationId: 'org-1', role }],
      },
    }),
}))

import { budgetsApi, agentsApi } from '@/lib/api'
import { BudgetsTab } from '../budgets-tab'

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>

const orgBudget = {
  id: 'b-org',
  organizationId: 'org-1',
  agentId: null,
  llmProviderId: null,
  periodType: 'month' as const,
  limitCents: 10_000,
  behavior: 'warn_log' as const,
  softThresholdPct: 80,
  active: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

const agentBudget = {
  ...orgBudget,
  id: 'b-agent',
  agentId: 'a1',
  limitCents: 5_000,
  behavior: 'reject' as const,
}

const monthSummary = {
  period: 'month',
  from: '2026-09-01T00:00:00.000Z',
  totalCents: 2_500,
  timeseries: [],
  byAgent: [{ agentId: 'a1', spentCents: 4_800, runCount: 12 }],
}
const daySummary = { ...monthSummary, period: 'day', totalCents: 100, byAgent: [] }

function seed({
  budgets = [orgBudget, agentBudget],
  alerts = [] as unknown[],
}: { budgets?: unknown[]; alerts?: unknown[] } = {}) {
  fn(budgetsApi.list).mockResolvedValue(budgets)
  fn(budgetsApi.getAlerts).mockResolvedValue(alerts)
  fn(budgetsApi.getSpend).mockImplementation((period: string) =>
    Promise.resolve(period === 'day' ? daySummary : monthSummary),
  )
  fn(agentsApi.getAll).mockResolvedValue([{ id: 'a1', name: 'Nightly Sync' }])
}

// Radix Select / AlertDialog use pointer-capture + scrollIntoView, absent in jsdom.
beforeEach(() => {
  vi.clearAllMocks()
  if (!Element.prototype.hasPointerCapture)
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

describe('the budgets tab', () => {
  it('measures each budget against the spend its own scope actually has', async () => {
    seed()
    render(<BudgetsTab />)

    // Org-wide budget reads the period total.
    expect(await screen.findByTestId('budget-spent-b-org')).toHaveTextContent(
      '$25.00 of $100.00 (25%)',
    )
    // The agent-scoped one reads that agent's row, not the org total --
    // reading the org total here would show a near-breached budget as calm.
    expect(screen.getByTestId('budget-spent-b-agent')).toHaveTextContent(
      '$48.00 of $50.00 (96%)',
    )
    expect(screen.getByText('Nightly Sync')).toBeInTheDocument()
    expect(screen.getByText('Whole organization')).toBeInTheDocument()
  })

  it('says on the row that a blocking budget refuses runs', async () => {
    seed()
    render(<BudgetsTab />)

    const row = await screen.findByTestId('budget-row-b-agent')
    expect(within(row).getByText('Block new runs')).toBeInTheDocument()
    expect(within(row).getByText(/New runs are refused at the limit/i)).toBeInTheDocument()
  })

  // Creating and editing a budget are pages now (budget-form-page.test.tsx
  // drives them); the tab only links there.
  it('links New budget (header and empty state) to the create page', async () => {
    seed({ budgets: [] })
    render(<BudgetsTab />)

    await screen.findByText('No spend budgets')
    const links = screen.getAllByRole('link', { name: /new budget/i })
    expect(links).toHaveLength(2)
    for (const link of links) expect(link).toHaveAttribute('href', '/analytics/budgets/new')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('links each row to its own edit page, carrying the row id', async () => {
    seed({ budgets: [orgBudget] })
    render(<BudgetsTab />)

    expect(await screen.findByRole('link', { name: /edit budget/i })).toHaveAttribute(
      'href',
      '/analytics/budgets/b-org/edit',
    )
  })

  it('deletes only after confirming, and says what stops being enforced', async () => {
    seed({ budgets: [agentBudget] })
    fn(budgetsApi.delete).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<BudgetsTab />)

    await user.click(await screen.findByRole('button', { name: /delete budget/i }))
    expect(
      await screen.findByText(/no longer be stopped when spend reaches this limit/i),
    ).toBeInTheDocument()
    expect(budgetsApi.delete).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /^delete budget$/i }))
    await waitFor(() => expect(budgetsApi.delete).toHaveBeenCalledWith('b-agent'))
  })

  it('treats a failed list as unknown, not as "nothing caps your spend"', async () => {
    fn(budgetsApi.list).mockRejectedValue(new Error('boom'))
    fn(budgetsApi.getAlerts).mockResolvedValue([])
    fn(budgetsApi.getSpend).mockResolvedValue(monthSummary)
    fn(agentsApi.getAll).mockResolvedValue([])
    render(<BudgetsTab />)

    expect(await screen.findByText("Couldn't load budgets")).toBeInTheDocument()
    expect(screen.queryByText('No spend budgets')).not.toBeInTheDocument()
  })

  it('lists the breaches a budget has already recorded', async () => {
    seed({
      budgets: [orgBudget],
      alerts: [
        {
          id: '1',
          budgetId: 'b-org',
          organizationId: 'org-1',
          agentId: 'a1',
          llmProviderId: null,
          level: 'hard',
          periodType: 'month',
          periodStart: '2026-09-01T00:00:00.000Z',
          spentCents: 10_400,
          limitCents: 10_000,
          at: '2026-09-17T10:00:00.000Z',
        },
      ],
    })
    render(<BudgetsTab />)

    expect(await screen.findByText('Limit reached')).toBeInTheDocument()
    expect(screen.getByText('$104.00 of $100.00')).toBeInTheDocument()
  })

  it('explains an empty alert log rather than leaving a blank card', async () => {
    seed({ budgets: [orgBudget], alerts: [] })
    render(<BudgetsTab />)

    expect(await screen.findByText(/No budget has been breached/i)).toBeInTheDocument()
  })
})

/**
 * The bug being fixed here was not a broken component -- it was a
 * complete one nothing rendered. A passing component suite says nothing
 * about whether a person can reach the surface, so this reads the page
 * and the tab registry directly.
 */
describe('the budgets tab is reachable', () => {
  const analyticsPage = readFileSync(
    join(__dirname, '..', '..', '..', 'pages', 'analytics.tsx'),
    'utf8',
  )

  it('is a real analytics route', () => {
    expect(ANALYTICS_TABS).toContain('budgets')
    expect(getAnalyticsTab('/analytics/budgets')).toBe('budgets')
    // The neighbouring cost route must not be captured by the new one.
    expect(getAnalyticsTab('/analytics/cost')).toBe('cost')
  })

  it('is rendered and listed by the analytics page', () => {
    expect(analyticsPage).toMatch(/\{tab === 'budgets' && <BudgetsTab \/>\}/)
    expect(analyticsPage).toMatch(/key: 'budgets', label: 'Budgets'/)
  })

  it('is linked from the cost tab, where the spend it caps is shown', () => {
    const costTab = readFileSync(join(__dirname, '..', 'cost-tab.tsx'), 'utf8')
    expect(costTab).toContain('/analytics/budgets')
  })
})

describe('a member sees the budgets but not the controls', () => {
  beforeEach(() => {
    role = 'member'
  })
  afterEach(() => {
    role = 'admin'
  })

  it('hides create, edit and delete rather than offering a guaranteed 403', async () => {
    render(<BudgetsTab />)
    // GET /budgets is member+, so the spend itself must still render. This
    // is about not offering an action that cannot work, not about hiding
    // the numbers.
    await waitFor(() => expect(screen.getByText(/spend budgets/i)).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: /new budget/i })).toBeNull()
    expect(screen.queryByLabelText('Edit budget')).toBeNull()
    expect(screen.queryByLabelText('Delete budget')).toBeNull()
  })
})
