import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderAtRoute } from '../../../test/render-at-route'

/**
 * The spend budget pages: /analytics/budgets/new and
 * /analytics/budgets/:budgetId/edit. What used to be a dialog on the
 * Budgets tab, driven end to end through the real router.
 */
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

const notify = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))

vi.mock('@/lib/api', () => ({
  budgetsApi: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
  agentsApi: { getAll: vi.fn() },
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Acme' } }),
}))
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

import { budgetsApi, agentsApi } from '@/lib/api'
import { AnalyticsBudgetPage } from '../../../pages/analytics-budget'

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

beforeEach(() => {
  vi.clearAllMocks()
  fn(agentsApi.getAll).mockResolvedValue([{ id: 'a1', name: 'Nightly Sync' }])
  fn(budgetsApi.list).mockResolvedValue([orgBudget])
})

const NEW = { path: '/analytics/budgets/new', paths: ['/analytics/budgets'] }
const EDIT = { path: '/analytics/budgets/:budgetId/edit', url: '/analytics/budgets/b-org/edit', paths: ['/analytics/budgets'] }

describe('/analytics/budgets/new', () => {
  it('creates a budget with the payload the service accepts and returns to the tab', async () => {
    fn(budgetsApi.create).mockResolvedValue({ ...orgBudget })
    const user = userEvent.setup()
    renderAtRoute(<AnalyticsBudgetPage />, NEW)

    expect(screen.getByRole('heading', { name: 'New spend budget' })).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Limit \(USD\)/), '50')
    await user.click(screen.getByRole('button', { name: /create budget/i }))

    await waitFor(() =>
      expect(budgetsApi.create).toHaveBeenCalledWith({
        agentId: null,
        periodType: 'month',
        limitCents: 5000,
        behavior: 'warn_log',
        softThresholdPct: 80,
        active: true,
      }),
    )
    expect(await screen.findByText('at /analytics/budgets')).toBeInTheDocument()
    expect(notify.success).toHaveBeenCalledWith('Budget created', expect.any(String))
  })

  it('shows the backend reason for a refused create and stays on the form', async () => {
    fn(budgetsApi.create).mockRejectedValue({
      response: { data: { error: { message: 'Provider-scoped budgets are not supported.' } } },
    })
    const user = userEvent.setup()
    renderAtRoute(<AnalyticsBudgetPage />, NEW)

    await user.type(screen.getByLabelText(/Limit \(USD\)/), '50')
    await user.click(screen.getByRole('button', { name: /create budget/i }))

    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith('Failed to create budget', 'Provider-scoped budgets are not supported.'),
    )
    expect(screen.getByRole('heading', { name: 'New spend budget' })).toBeInTheDocument()
    expect(screen.queryByText('at /analytics/budgets')).not.toBeInTheDocument()
  })

  it('focuses the limit when it is missing', async () => {
    const user = userEvent.setup()
    renderAtRoute(<AnalyticsBudgetPage />, NEW)
    await user.click(screen.getByRole('button', { name: /create budget/i }))
    expect(await screen.findByText(/greater than \$0\.00/i)).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/Limit \(USD\)/)))
    expect(budgetsApi.create).not.toHaveBeenCalled()
  })
})

describe('/analytics/budgets/:budgetId/edit', () => {
  it('seeds from the row and saves through PATCH, carrying the row id', async () => {
    fn(budgetsApi.update).mockResolvedValue({ ...orgBudget })
    const user = userEvent.setup()
    renderAtRoute(<AnalyticsBudgetPage />, EDIT)

    const limit = await screen.findByLabelText(/Limit \(USD\)/)
    expect(limit).toHaveValue(100)
    await user.clear(limit)
    await user.type(limit, '250')
    await user.click(screen.getByRole('button', { name: /save budget/i }))

    await waitFor(() =>
      expect(budgetsApi.update).toHaveBeenCalledWith('b-org', expect.objectContaining({ limitCents: 25000, agentId: null })),
    )
    expect(await screen.findByText('at /analytics/budgets')).toBeInTheDocument()
  })

  it('says so when the budget no longer exists', async () => {
    renderAtRoute(<AnalyticsBudgetPage />, { ...EDIT, url: '/analytics/budgets/gone/edit' })
    expect(await screen.findByText('Budget not found')).toBeInTheDocument()
  })
})
