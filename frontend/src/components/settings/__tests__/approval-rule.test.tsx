import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderAtRoute } from '../../../test/render-at-route'
import type { ApprovalPolicy } from '../../../lib/api'
import { describeAmountRule, numericFields } from '../../../lib/approval-rules'

/**
 * Amount rules, free for everyone: on /settings/approvals/rules/new a person
 * chooses the tool by its readable name, then the number among its inputs,
 * then the comparison and the amount, and the page says the rule back:
 * "Ask before “Create refund” when amount is over 500". The policy page
 * no longer carries it; it keeps the team picker and hides Priority under
 * Advanced.
 */
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('../../../hooks/use-entitlement', async () => {
  const actual = await vi.importActual<any>('../../../hooks/use-entitlement')
  const has = (f: string) => f === 'approval_policy'
  return {
    ...actual,
    useEntitlement: (feature?: string) =>
      feature === undefined
        ? { entitlements: ['approval_policy'], has, isLoading: false, edition: 'enterprise', limit: () => -1 }
        : { enabled: has(feature), isLoading: false, edition: 'enterprise' },
    useEntitlements: () => ({ entitlements: ['approval_policy'], has, isLoading: false, edition: 'enterprise', limit: () => -1 }),
  }
})

vi.mock('../../../lib/api', () => ({
  approvalPoliciesApi: { list: vi.fn(), getById: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  approvalRulesApi: { list: vi.fn(), getById: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  toolsApi: { getAll: vi.fn() },
  organizationsApi: { getTeams: vi.fn() },
}))
vi.mock('../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1' } }),
}))
const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))

import { approvalPoliciesApi, approvalRulesApi, organizationsApi, toolsApi } from '../../../lib/api'
import { ApprovalRulePage } from '../../../pages/approval-rule'
import { ApprovalPolicyPage } from '../../../pages/approval-policy'

const rules = approvalRulesApi as unknown as Record<string, ReturnType<typeof vi.fn>>
const policies = approvalPoliciesApi as unknown as Record<string, ReturnType<typeof vi.fn>>

const REFUND = {
  id: 'tool-refund',
  name: 'northwind_orders_create_refund',
  api: { name: 'Northwind Orders' },
  operation: { name: 'Create refund' },
  parameters: {
    type: 'object',
    properties: {
      order: { type: 'string' },
      amount: { type: 'number', description: 'Refund total' },
      detail: { type: 'object', properties: { fee: { type: 'integer' } } },
    },
  },
}
const LOOKUP = { id: 'tool-lookup', name: 'order_lookup', parameters: { type: 'object', properties: { order: { type: 'string' } } } }

const NEW = { path: '/settings/approvals/rules/new', paths: ['/settings/approvals'] }
const EDIT = { path: '/settings/approvals/rules/:ruleId', url: '/settings/approvals/rules/r1', paths: ['/settings/approvals'] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(toolsApi.getAll).mockResolvedValue([REFUND, LOOKUP] as any)
  vi.mocked(organizationsApi.getTeams).mockResolvedValue([{ id: 'team-fin', name: 'Finance', isDefault: false }] as any)
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

const pick = async (user: ReturnType<typeof userEvent.setup>, combobox: string, option: string | RegExp) => {
  await user.click(screen.getByRole('combobox', { name: combobox }))
  await user.click(await screen.findByRole('option', { name: option }))
}

describe('the amount rule, in plain words', () => {
  it('reads like a sentence', () => {
    expect(describeAmountRule({ toolName: '“Create refund”', argument: 'amount', op: 'gt', amount: 500 })).toBe(
      'Ask before “Create refund” when amount is over 500',
    )
    expect(describeAmountRule({ toolName: 'issue_refund', argument: 'amount', op: 'gte', amount: 1500 })).toBe(
      'Ask before issue_refund when amount is 1,500 or more',
    )
  })

  it("offers only the tool's numbers, nested ones included", () => {
    expect(numericFields(REFUND).map((f) => f.path)).toEqual(['amount', 'detail.fee'])
    expect(numericFields(LOOKUP)).toEqual([])
  })
})

describe('/settings/approvals/rules/new', () => {
  it('asks before refunds over 500: the tool by its readable name, the number, the comparison, the amount', async () => {
    const user = userEvent.setup()
    rules.create.mockResolvedValue({ id: 'new' })
    renderAtRoute(<ApprovalRulePage />, NEW)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Refunds over 500' } })
    await waitFor(() => expect(toolsApi.getAll).toHaveBeenCalled())
    await user.click(screen.getByRole('combobox', { name: 'Tool' }))
    // The readable name leads; the API name is there, small, below it.
    const option = await screen.findByRole('option', { name: /Create refund/ })
    expect(within(option).getByText('northwind_orders_create_refund')).toHaveClass('text-xs')
    await user.click(option)
    expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveTextContent('Create refund')
    expect(screen.getByRole('combobox', { name: 'Tool' })).not.toHaveTextContent('northwind_orders_create_refund')

    await pick(user, 'The number', /^amount/)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '500' } })
    expect(screen.getByTestId('amount-rule-summary')).toHaveTextContent('Ask before “Create refund” when amount is over 500')
    expect(screen.getByTestId('amount-rule-summary')).toHaveTextContent('A call at or under the amount runs without asking.')

    await user.click(screen.getByRole('button', { name: /Create rule/i }))
    await waitFor(() => expect(rules.create).toHaveBeenCalledTimes(1))
    expect(rules.create.mock.calls[0][0]).toEqual({
      name: 'Refunds over 500',
      teamId: null,
      enabled: true,
      trigger: { kind: 'tool_amount', toolId: 'tool-refund', argument: 'amount', op: 'gt', amount: 500 },
    })
    expect(policies.create).not.toHaveBeenCalled()
  })

  it('scopes a rule to one team with the team picker used everywhere else', async () => {
    const user = userEvent.setup()
    rules.create.mockResolvedValue({ id: 'new' })
    renderAtRoute(<ApprovalRulePage />, NEW)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Finance refunds' } })
    await waitFor(() => expect(organizationsApi.getTeams).toHaveBeenCalled())
    await user.click(await screen.findByRole('radio', { name: /One team/ }))
    await waitFor(() => expect(toolsApi.getAll).toHaveBeenCalled())
    await pick(user, 'Tool', /Create refund/)
    await pick(user, 'The number', /^amount/)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '500' } })
    await user.click(screen.getByRole('button', { name: /Create rule/i }))
    await waitFor(() => expect(rules.create).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-fin' })))
  })

  it('says a tool with no number cannot carry the rule', async () => {
    const user = userEvent.setup()
    renderAtRoute(<ApprovalRulePage />, NEW)
    await waitFor(() => expect(toolsApi.getAll).toHaveBeenCalled())
    await pick(user, 'Tool', /Order lookup/)
    expect(screen.getByText(/“Order lookup” takes no number/)).toBeInTheDocument()
  })

  it('will not save without the amount', async () => {
    const user = userEvent.setup()
    renderAtRoute(<ApprovalRulePage />, NEW)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } })
    await waitFor(() => expect(toolsApi.getAll).toHaveBeenCalled())
    await pick(user, 'Tool', /Create refund/)
    await pick(user, 'The number', /^amount/)
    await user.click(screen.getByRole('button', { name: /Create rule/i }))
    expect(await screen.findByText('Enter an amount of 0 or more')).toBeInTheDocument()
    expect(rules.create).not.toHaveBeenCalled()
  })

  it('opens a saved rule as it was, and saves it back', async () => {
    const user = userEvent.setup()
    const saved: ApprovalPolicy = {
      id: 'r1', organizationId: 'org-1', name: 'Big refunds', description: null, teamId: null, match: [],
      steps: [{ name: 'Approval', approverRole: '*', minApprovals: 1 }], priority: 0, enabled: true,
      trigger: { kind: 'tool_amount', toolId: 'tool-refund', toolName: 'northwind_orders_create_refund', argument: 'amount', op: 'gte', amount: 1500 },
      createdAt: '', updatedAt: '',
    }
    rules.getById.mockResolvedValue(saved)
    rules.update.mockResolvedValue(saved)
    renderAtRoute(<ApprovalRulePage />, EDIT)
    expect(await screen.findByTestId('amount-rule-summary')).toHaveTextContent('Ask before “Create refund” when amount is 1,500 or more')
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '2000' } })
    await user.click(screen.getByRole('button', { name: /Save changes/i }))
    await waitFor(() =>
      expect(rules.update).toHaveBeenCalledWith('r1', expect.objectContaining({
        trigger: { kind: 'tool_amount', toolId: 'tool-refund', argument: 'amount', op: 'gte', amount: 2000 },
      })),
    )
  })
})

describe('/settings/approvals/policies/new (Business)', () => {
  it('picks the team with the team picker, not an ID box, and keeps Priority under Advanced in plain words', async () => {
    const user = userEvent.setup()
    policies.create.mockResolvedValue({ id: 'p' })
    renderAtRoute(<ApprovalPolicyPage />, { path: '/settings/approvals/policies/new', paths: ['/settings/approvals'] })
    expect(screen.queryByLabelText(/Team ID/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Priority')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Advanced/ }))
    expect(screen.getByText(/the one with the higher number decides who signs off/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Finance sign-off' } })
    await waitFor(() => expect(organizationsApi.getTeams).toHaveBeenCalled())
    await user.click(await screen.findByRole('radio', { name: /One team/ }))
    fireEvent.change(screen.getByLabelText('Step 1 name'), { target: { value: 'Finance' } })
    await user.click(screen.getByRole('button', { name: /Create policy/i }))
    await waitFor(() => expect(policies.create).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-fin' })))
    expect(policies.create.mock.calls[0][0].trigger).toBeUndefined()
  })
})
