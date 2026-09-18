import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../../test/setup'
import { BudgetDialog } from '../budget-dialog'
import type { SpendBudget } from '@/types/budgets'

/**
 * The create/edit form for a spend budget.
 *
 * Everything asserted here is a rule the backend already enforces in
 * `BudgetsService.validate()` -- a positive limit, a soft threshold in
 * [1, 100], and a scope that is the organization or one agent and never a
 * provider. A form that can produce a payload the service answers 400 for
 * is a form that wastes a round trip to say what it already knew.
 */
const budget = (over: Partial<SpendBudget> = {}): SpendBudget => ({
  id: 'b1',
  organizationId: 'org-1',
  agentId: null,
  llmProviderId: null,
  periodType: 'month',
  limitCents: 10_000,
  behavior: 'warn_log',
  softThresholdPct: 80,
  active: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
})

const agents = [
  { id: 'a1', name: 'Nightly Sync' },
  { id: 'a2', name: 'Support Bot' },
]

function setup(props: Partial<React.ComponentProps<typeof BudgetDialog>> = {}) {
  const onSubmit = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <BudgetDialog
      open
      onOpenChange={onOpenChange}
      budget={null}
      agents={agents}
      isSaving={false}
      onSubmit={onSubmit}
      {...props}
    />,
  )
  return { onSubmit, onOpenChange }
}

// Radix Select uses pointer-capture + scrollIntoView, absent in jsdom.
beforeEach(() => {
  if (!Element.prototype.hasPointerCapture)
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

describe('the spend budget dialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends dollars as the integer cents the DTO takes, org-wide by default', async () => {
    const user = userEvent.setup()
    const { onSubmit } = setup()

    await user.type(screen.getByLabelText('Limit (USD)'), '12.34')
    await user.click(screen.getByRole('button', { name: /create budget/i }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        agentId: null,
        periodType: 'month',
        limitCents: 1234,
        behavior: 'warn_log',
        softThresholdPct: 80,
        active: true,
      }),
    )
  })

  it('refuses a limit of zero rather than letting the backend say no', async () => {
    const user = userEvent.setup()
    const { onSubmit } = setup()

    await user.type(screen.getByLabelText('Limit (USD)'), '0')
    await user.click(screen.getByRole('button', { name: /create budget/i }))

    expect(await screen.findByText(/greater than \$0\.00/i)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps the soft threshold inside the 1-100 the service accepts', async () => {
    const user = userEvent.setup()
    const { onSubmit } = setup()

    await user.type(screen.getByLabelText('Limit (USD)'), '50')
    const pct = screen.getByLabelText(/warn at/i)
    await user.clear(pct)
    await user.type(pct, '150')
    await user.click(screen.getByRole('button', { name: /create budget/i }))

    expect(await screen.findByText(/whole number between 1 and 100/i)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('says what blocking actually does, because it stops runs nobody touched', async () => {
    const user = userEvent.setup()
    setup()

    // Warn is the default and must not read like a control.
    expect(screen.getByTestId('budget-behavior-consequence')).toHaveTextContent(
      /Runs carry on past the limit/i,
    )

    await user.click(screen.getByRole('combobox', { name: /when the limit is reached/i }))
    await user.click(await screen.findByText('Block new runs'))

    await waitFor(() =>
      expect(screen.getByTestId('budget-behavior-consequence')).toHaveTextContent(
        /scheduled agents, chat replies and API calls all stop/i,
      ),
    )
  })

  it('names the amount the early alert fires at, not just the percentage', async () => {
    const user = userEvent.setup()
    setup()

    await user.type(screen.getByLabelText('Limit (USD)'), '200')

    await waitFor(() =>
      expect(screen.getByTestId('budget-soft-preview')).toHaveTextContent(
        '$160.00 of $200.00',
      ),
    )
  })

  it('offers no provider scope, because the service refuses a provider budget', () => {
    setup()
    expect(screen.queryByText(/provider/i)).not.toBeInTheDocument()
  })

  it('will not submit an agent-scoped budget with no agent chosen', async () => {
    const user = userEvent.setup()
    const { onSubmit } = setup()

    await user.type(screen.getByLabelText('Limit (USD)'), '25')
    await user.click(screen.getByRole('combobox', { name: /applies to/i }))
    await user.click(await screen.findByText('A single agent'))
    await user.click(screen.getByRole('button', { name: /create budget/i }))

    expect(await screen.findByText(/Choose the agent this budget applies to/i)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('scopes to the chosen agent', async () => {
    const user = userEvent.setup()
    const { onSubmit } = setup()

    await user.type(screen.getByLabelText('Limit (USD)'), '25')
    await user.click(screen.getByRole('combobox', { name: /applies to/i }))
    await user.click(await screen.findByText('A single agent'))
    await user.click(await screen.findByRole('combobox', { name: /^agent$/i }))
    await user.click(await screen.findByText('Support Bot'))
    await user.click(screen.getByRole('button', { name: /create budget/i }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'a2', limitCents: 2500 }),
      ),
    )
  })

  it('seeds the form from the budget being edited', async () => {
    setup({
      budget: budget({ limitCents: 4550, periodType: 'day', behavior: 'reject', softThresholdPct: 60, agentId: 'a1' }),
    })

    expect(screen.getByLabelText('Limit (USD)')).toHaveValue(45.5)
    expect(screen.getByLabelText(/warn at/i)).toHaveValue(60)
    expect(screen.getByRole('button', { name: /save budget/i })).toBeInTheDocument()
    expect(screen.getByTestId('budget-behavior-consequence')).toHaveTextContent(
      /New runs in scope are refused/i,
    )
  })
})
