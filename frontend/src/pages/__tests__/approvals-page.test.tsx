import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

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

  it('shows the empty state when the list is empty', async () => {
    ;(approvalsApi.list as any).mockResolvedValue([])
    render(<ApprovalsPage />)
    await waitFor(() => {
      expect(screen.getByText('No pending approvals')).toBeInTheDocument()
    })
  })
})
