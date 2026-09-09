import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { PoliciesTable } from '../policies-table'
import { connectionPoliciesApi } from '../../../lib/connections-governance-api'
import { connectorsApi } from '../../../lib/connections-api'
import type { ConnectionPolicy } from '@/types/connections-governance'

vi.mock('../../../lib/connections-governance-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-governance-api')>('../../../lib/connections-governance-api')
  return {
    ...actual,
    connectionPoliciesApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  }
})

vi.mock('../../../lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-api')>('../../../lib/connections-api')
  return { ...actual, connectorsApi: { list: vi.fn(), create: vi.fn() } }
})

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))

function policy(overrides: Partial<ConnectionPolicy> = {}): ConnectionPolicy {
  return {
    id: 'p1',
    kind: 'connector_allowlist',
    name: 'Approved vendors',
    rule: { connectorKeys: ['openai', 'anthropic'], owners: ['org'] },
    enabled: true,
    createdBy: 'u1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('PoliciesTable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(connectorsApi.list).mockResolvedValue([
      { key: 'openai', kind: 'inference', displayName: 'OpenAI', connect: [] },
      { key: 'anthropic', kind: 'inference', displayName: 'Anthropic', connect: [] },
    ])
    vi.mocked(connectionPoliciesApi.list).mockResolvedValue([
      policy(),
      policy({ id: 'p2', kind: 'expiry_rule', name: null, rule: { maxAgeDays: 90, warnDays: 7, enforce: true }, enabled: false }),
      policy({ id: 'p3', kind: 'scope_rule', name: null, rule: { principalKinds: ['agent'], environments: ['production'], requireOwner: 'org', approvedConnectorsOnly: true } }),
    ])
  })

  it('renders each policy with a kind badge, the rule in words and its enabled state', async () => {
    render(<PoliciesTable />)
    const row1 = await screen.findByTestId('policy-row-p1')
    expect(within(row1).getByTestId('policy-kind-badge')).toHaveAttribute('data-kind', 'connector_allowlist')
    expect(row1).toHaveTextContent('Approved vendors')
    await waitFor(() => expect(within(row1).getByTestId('policy-summary')).toHaveTextContent('Organization connections may only use OpenAI, Anthropic'))
    expect(within(row1).getByRole('switch', { name: 'Disable Approved vendors' })).toHaveAttribute('aria-checked', 'true')

    const row2 = screen.getByTestId('policy-row-p2')
    expect(within(row2).getByTestId('policy-kind-badge')).toHaveTextContent('Expiry rule')
    expect(within(row2).getByTestId('policy-summary')).toHaveTextContent('Secrets expire after 90 days, warning 7 days ahead, grants are revoked on expiry')
    expect(within(row2).getByRole('switch', { name: 'Enable Expiry rule' })).toHaveAttribute('aria-checked', 'false')

    expect(within(screen.getByTestId('policy-row-p3')).getByTestId('policy-summary')).toHaveTextContent('Agents in production may only use organization connections from approved connectors')
  })

  it('toggles enabled through PATCH', async () => {
    vi.mocked(connectionPoliciesApi.update).mockResolvedValue(policy({ enabled: false }))
    render(<PoliciesTable />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Disable Approved vendors' }))
    await waitFor(() => expect(connectionPoliciesApi.update).toHaveBeenCalledWith('p1', { enabled: false }))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Policy disabled', expect.any(String)))
  })

  it('deletes after confirming', async () => {
    vi.mocked(connectionPoliciesApi.remove).mockResolvedValue(undefined)
    render(<PoliciesTable />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Approved vendors' }))
    expect(await screen.findByText('Delete Approved vendors?')).toBeInTheDocument()
    expect(connectionPoliciesApi.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(connectionPoliciesApi.remove).toHaveBeenCalledWith('p1'))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Policy deleted', expect.any(String)))
  })

  it('opens the edit dialog with the kind fixed and the stored values', async () => {
    render(<PoliciesTable />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Approved vendors' }))
    expect(await screen.findByRole('heading', { name: 'Edit policy' })).toBeInTheDocument()
    const kind = screen.getByLabelText('Kind') as HTMLSelectElement
    expect(kind.value).toBe('connector_allowlist')
    expect(kind).toBeDisabled()
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Approved vendors')
    expect(screen.getByTestId('connector-chip-openai')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Organization connections' })).toHaveAttribute('aria-checked', 'true')
  })

  it('shows the empty state with an add action', async () => {
    vi.mocked(connectionPoliciesApi.list).mockResolvedValue([])
    render(<PoliciesTable />)
    expect(await screen.findByText('No policies yet')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add policy' }).length).toBeGreaterThanOrEqual(1)
  })
})
