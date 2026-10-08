import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { render } from '../../test/setup'
import { ApprovalsPage } from '../approvals'
import { approvalsApi } from '../../lib/api'

// Regression for #119: approvalsApi.list() goes through apiGet which
// already extracts the {success, data} envelope, so the resolved
// value IS the array. The page used to read query.data?.data and
// always got undefined, rendering "No pending approvals" even when
// /approvals returned rows. This test feeds a flat array (the real
// shape after extractData) and asserts the row renders.

vi.mock('../../lib/api', () => ({
  approvalsApi: {
    list: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
  },
}))

vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({}),
    useLocation: () => ({ pathname: '/approvals', search: '', hash: '', state: null }),
  }
})

describe('ApprovalsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the email a held Gmail send would send, not its base64', async () => {
    const raw = btoa('To: jonas.weber@bluefin.example\r\nSubject: Route planning at Bluefin Couriers\r\n\r\nHi Jonas, would a short call next week help?').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    ;(approvalsApi.list as any).mockResolvedValue([
      {
        id: 'a-mail', organizationId: 'org-1', teamId: null, visibility: 'org', runId: 'run-mail', agentId: 'agent-mail',
        toolCallId: null, reason: 'Ask before "gmail.users.messages.send" (it is on the ask-first list).',
        payload: { tool: 'Gmail gmail users messages send', parameters: { userId: 'me', raw } },
        status: 'pending', decidedBy: null, decidedAt: null, decisionReason: null, expiresAt: null, createdAt: new Date().toISOString(),
      },
    ])

    render(<ApprovalsPage />)

    const preview = await screen.findByTestId('approval-email-preview')
    expect(within(preview).getByText('jonas.weber@bluefin.example')).toBeInTheDocument()
    expect(within(preview).getByText('Route planning at Bluefin Couriers')).toBeInTheDocument()
    expect(within(preview).getByText('Hi Jonas, would a short call next week help?')).toBeInTheDocument()
  })

  it('renders a pending approval from a flat array (post-extractData shape)', async () => {
    ;(approvalsApi.list as any).mockResolvedValue([
      {
        id: 'a-1',
        organizationId: 'org-1',
        teamId: null,
        visibility: 'org',
        runId: 'run-abc12345-1111-2222-3333-444455556666',
        agentId: 'agent-1234-5678-9abc-def0-12345',
        toolCallId: null,
        reason: 'Delete the production database',
        payload: null,
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        expiresAt: null,
        createdAt: new Date().toISOString(),
      },
    ])

    render(<ApprovalsPage />)

    await waitFor(() => {
      expect(screen.getByText('Delete the production database')).toBeInTheDocument()
    })
    expect(screen.queryByText('No pending approvals')).not.toBeInTheDocument()
  })

  it('labels a private agent\'s request private, not org', async () => {
    ;(approvalsApi.list as any).mockResolvedValue([
      {
        id: 'a-p', organizationId: 'org-1', teamId: null, visibility: 'private', runId: 'run-p', agentId: 'agent-p',
        toolCallId: null, reason: 'Pay the rent', payload: null, status: 'pending', decidedBy: null, decidedAt: null,
        decisionReason: null, expiresAt: null, createdAt: new Date().toISOString(),
      },
    ])
    render(<ApprovalsPage />)
    await screen.findByText('Pay the rent')
    expect(screen.getByText('private')).toBeInTheDocument()
    expect(screen.queryByText('org')).not.toBeInTheDocument()
  })

  it("names the agent that asked, and says so when the agent was deleted", async () => {
    const base = {
      organizationId: 'org-1', teamId: null, visibility: 'org', toolCallId: null, payload: null, status: 'pending',
      decidedBy: null, decidedAt: null, decisionReason: null, expiresAt: null, createdAt: new Date().toISOString(),
    }
    ;(approvalsApi.list as any).mockResolvedValue([
      { ...base, id: 'a-n', runId: 'run-n', agentId: 'agent-named-1234', agentName: 'Invoice helper', reason: 'Send the invoice' },
      { ...base, id: 'a-d', runId: 'run-d', agentId: 'agent-gone-5678', agentName: null, reason: 'Close the account' },
    ])
    render(<ApprovalsPage />)
    await screen.findByText('Send the invoice')
    expect(screen.getByRole('link', { name: 'Invoice helper' })).toHaveAttribute('href', '/agents/agent-named-1234')
    expect(screen.getByText('Deleted agent')).toBeInTheDocument()
    expect(screen.queryByText(/^agent agent-/)).not.toBeInTheDocument()
  })

  it('shows the empty state when the list is empty', async () => {
    ;(approvalsApi.list as any).mockResolvedValue([])
    render(<ApprovalsPage />)
    await waitFor(() => {
      expect(screen.getByText('No pending approvals')).toBeInTheDocument()
    })
  })

  it('decides inline in the row, not in a dialog', async () => {
    const row = {
      id: 'a-2',
      organizationId: 'org-1',
      teamId: null,
      visibility: 'org',
      runId: 'run-2',
      agentId: 'agent-2222-3333',
      toolCallId: null,
      reason: 'Send the invoice email',
      payload: null,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    }
    ;(approvalsApi.list as any).mockResolvedValue([row])
    ;(approvalsApi.reject as any).mockResolvedValue({})
    render(<ApprovalsPage />)

    fireEvent.click(await screen.findByRole('button', { name: /Reject/ }))
    const form = screen.getByRole('form', { name: 'Reject this action' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(form).getByText(/cannot be resumed/)).toBeInTheDocument()

    fireEvent.change(within(form).getByLabelText('Note (optional)'), { target: { value: 'Wrong customer' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(approvalsApi.reject).toHaveBeenCalledWith('a-2', 'Wrong customer'))
    expect(approvalsApi.approve).not.toHaveBeenCalled()
  })

  it('Cancel closes the inline decision without deciding', async () => {
    ;(approvalsApi.list as any).mockResolvedValue([
      {
        id: 'a-3', organizationId: 'o', teamId: null, visibility: 'org', runId: 'r-3',
        agentId: 'agent-3333', toolCallId: null, reason: 'Pay the bill', payload: null,
        status: 'pending', decidedBy: null, decidedAt: null, decisionReason: null,
        expiresAt: null, createdAt: new Date().toISOString(),
      },
    ])
    render(<ApprovalsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }))
    expect(screen.getByRole('form', { name: 'Approve this action' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(approvalsApi.approve).not.toHaveBeenCalled()
  })
})
