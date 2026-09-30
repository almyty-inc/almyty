import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderAtRoute } from '../../../test/render-at-route'
import type { ApprovalPolicy } from '../../../lib/api'
import { describeAmountRule, numericFields } from '../../../lib/approval-rules'

/**
 * An approval policy's amount rule on the policy page: choose the tool,
 * then the number among its inputs, then the comparison and the amount,
 * and the page says the rule back: "Ask before issue_refund when amount is
 * over 500".
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
  toolsApi: { getAll: vi.fn() },
}))
vi.mock('../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1' } }),
}))
const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))

import { approvalPoliciesApi, toolsApi } from '../../../lib/api'
import { ApprovalPolicyPage } from '../../../pages/approval-policy'

const mocked = approvalPoliciesApi as unknown as Record<string, ReturnType<typeof vi.fn>>

const REFUND = {
  id: 'tool-refund',
  name: 'issue_refund',
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

const NEW = { path: '/settings/approvals/policies/new', paths: ['/settings/approvals'] }
const EDIT = { path: '/settings/approvals/policies/:policyId', url: '/settings/approvals/policies/p1', paths: ['/settings/approvals'] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(toolsApi.getAll).mockResolvedValue([REFUND, LOOKUP] as any)
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
    expect(describeAmountRule({ toolName: 'issue_refund', argument: 'amount', op: 'gt', amount: 500 })).toBe(
      'Ask before issue_refund when amount is over 500',
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

describe('an approval policy with an amount rule', () => {
  it('asks before refunds over 500: tool, number, comparison, amount', async () => {
    const user = userEvent.setup()
    mocked.create.mockResolvedValue({ id: 'new' })
    renderAtRoute(<ApprovalPolicyPage />, NEW)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Refunds over 500' } })
    await pick(user, 'Ask for approval when', 'A tool is called with an amount over a limit')
    // The conditions are for requests an agent raises; this rule raises its own.
    expect(screen.queryByRole('button', { name: /Add condition/i })).not.toBeInTheDocument()

    await waitFor(() => expect(toolsApi.getAll).toHaveBeenCalled())
    await pick(user, 'Tool', 'issue_refund')
    await pick(user, 'The number', /^amount/)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '500' } })
    expect(screen.getByTestId('amount-rule-summary')).toHaveTextContent('Ask before issue_refund when amount is over 500')
    expect(screen.getByTestId('amount-rule-summary')).toHaveTextContent('A call at or under the amount runs without asking.')

    fireEvent.change(screen.getByLabelText('Step 1 name'), { target: { value: 'Finance' } })
    await user.click(screen.getByRole('button', { name: /Create policy/i }))

    await waitFor(() => expect(mocked.create).toHaveBeenCalledTimes(1))
    expect(mocked.create.mock.calls[0][0]).toMatchObject({
      name: 'Refunds over 500',
      match: [],
      trigger: { kind: 'tool_amount', toolId: 'tool-refund', argument: 'amount', op: 'gt', amount: 500 },
    })
  })

  it('says a tool with no number cannot carry the rule', async () => {
    const user = userEvent.setup()
    renderAtRoute(<ApprovalPolicyPage />, NEW)
    await pick(user, 'Ask for approval when', 'A tool is called with an amount over a limit')
    await waitFor(() => expect(toolsApi.getAll).toHaveBeenCalled())
    await pick(user, 'Tool', 'order_lookup')
    expect(screen.getByText(/order_lookup takes no number/)).toBeInTheDocument()
  })

  it('will not save without the amount', async () => {
    const user = userEvent.setup()
    renderAtRoute(<ApprovalPolicyPage />, NEW)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } })
    await pick(user, 'Ask for approval when', 'A tool is called with an amount over a limit')
    await waitFor(() => expect(toolsApi.getAll).toHaveBeenCalled())
    await pick(user, 'Tool', 'issue_refund')
    await pick(user, 'The number', /^amount/)
    fireEvent.change(screen.getByLabelText('Step 1 name'), { target: { value: 'Finance' } })
    await user.click(screen.getByRole('button', { name: /Create policy/i }))
    expect(await screen.findByText('Enter an amount of 0 or more')).toBeInTheDocument()
    expect(mocked.create).not.toHaveBeenCalled()
  })

  it('opens a saved rule as it was, and saves it back', async () => {
    const user = userEvent.setup()
    const saved: ApprovalPolicy = {
      id: 'p1',
      organizationId: 'org-1',
      name: 'Big refunds',
      description: null,
      teamId: null,
      match: [],
      steps: [{ name: 'Finance', approverRole: '*', minApprovals: 1 }],
      priority: 0,
      enabled: true,
      trigger: { kind: 'tool_amount', toolId: 'tool-refund', toolName: 'issue_refund', argument: 'amount', op: 'gte', amount: 1500 },
      createdAt: '',
      updatedAt: '',
    }
    mocked.getById.mockResolvedValue(saved)
    mocked.update.mockResolvedValue(saved)
    renderAtRoute(<ApprovalPolicyPage />, EDIT)
    expect(await screen.findByTestId('amount-rule-summary')).toHaveTextContent('Ask before issue_refund when amount is 1,500 or more')
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '2000' } })
    await user.click(screen.getByRole('button', { name: /Save changes/i }))
    await waitFor(() =>
      expect(mocked.update).toHaveBeenCalledWith('p1', expect.objectContaining({
        trigger: { kind: 'tool_amount', toolId: 'tool-refund', argument: 'amount', op: 'gte', amount: 2000 },
      })),
    )
  })
})
