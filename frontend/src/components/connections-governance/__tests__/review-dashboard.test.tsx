import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ReviewDashboard } from '../review-dashboard'
import { connectionsReviewApi } from '../../../lib/connections-governance-api'
import type { ReviewRow } from '@/types/connections-governance'

vi.mock('../../../lib/connections-governance-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-governance-api')>('../../../lib/connections-governance-api')
  return { ...actual, connectionsReviewApi: { list: vi.fn(), revokeGrants: vi.fn() } }
})

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))

function row(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    connection: {
      id: 'c1',
      name: "Jane's OpenAI key",
      connectorKey: 'openai',
      accountLabel: 'org-jane',
      owner: 'user',
      health: { status: 'valid', checkedAt: '2026-09-08T00:00:00.000Z', error: null },
      expiresAt: null,
      secretSetAt: '2026-08-01T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
    },
    owner: { id: 'u1', email: 'jane@acme.test', name: 'Jane Doe' },
    grants: [
      { id: 'g1', principalType: 'agent', principalId: 'a1', principalName: 'Support bot', environment: 'production', permission: 'use', budgetId: null, expiresAt: null, grantedBy: 'u2', createdAt: '2026-08-02T00:00:00.000Z' },
      { id: 'g2', principalType: 'workspace', principalId: 'w1', principalName: null, environment: null, permission: 'use', budgetId: null, expiresAt: null, grantedBy: 'u2', createdAt: '2026-08-02T00:00:00.000Z' },
    ],
    lastResolve: { at: '2026-09-07T12:00:00.000Z', userId: 'u1', agentId: 'a1', workspaceId: null, purpose: 'chat completion' },
    ...overrides,
  }
}

describe('ReviewDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(connectionsReviewApi.list).mockResolvedValue([row()])
  })

  it('lists user-scoped connections with owner, grants, environments and health, production first', async () => {
    render(<ReviewDashboard />)
    const r = await screen.findByTestId('review-row-c1')
    expect(connectionsReviewApi.list).toHaveBeenCalledWith('production')
    expect(r).toHaveTextContent("Jane's OpenAI key")
    expect(r).toHaveTextContent('Jane Doe')
    expect(r).toHaveTextContent('Support bot')
    expect(within(r).getByTestId('grant-environment')).toHaveTextContent('production')
    expect(r).toHaveTextContent('w1')
    expect(within(r).getByTestId('connection-health')).toHaveAttribute('data-status', 'valid')
    expect(r).toHaveTextContent('chat completion')
  })

  it('switches the environment filter', async () => {
    render(<ReviewDashboard />)
    await screen.findByTestId('review-row-c1')
    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'any' } })
    await waitFor(() => expect(connectionsReviewApi.list).toHaveBeenLastCalledWith('any'))
  })

  it('revokes the grants only after confirming', async () => {
    vi.mocked(connectionsReviewApi.revokeGrants).mockResolvedValue({ revoked: 2, grantIds: ['g1', 'g2'] })
    render(<ReviewDashboard />)
    fireEvent.click(await screen.findByRole('button', { name: "Revoke grants on Jane's OpenAI key" }))
    expect(await screen.findByText("Revoke grants on Jane's OpenAI key?")).toBeInTheDocument()
    expect(screen.getByText(/2 agent and workspace grants will be removed/)).toBeInTheDocument()
    expect(connectionsReviewApi.revokeGrants).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(screen.queryByText("Revoke grants on Jane's OpenAI key?")).not.toBeInTheDocument())
    expect(connectionsReviewApi.revokeGrants).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: "Revoke grants on Jane's OpenAI key" }))
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(connectionsReviewApi.revokeGrants).toHaveBeenCalledWith('c1'))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Grants revoked', "2 grants on Jane's OpenAI key removed."))
  })

  it('shows the empty state', async () => {
    vi.mocked(connectionsReviewApi.list).mockResolvedValue([])
    render(<ReviewDashboard />)
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument()
  })
})
