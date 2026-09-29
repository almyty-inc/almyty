import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { AcceptInvitePage } from '../accept-invite'
import { apiGet, apiPost } from '@/lib/api'
import { useAuthStore } from '@/store/auth'

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))

let query = new URLSearchParams()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useSearchParams: () => [query, vi.fn()] }
})

const WAIT = { timeout: 10000 }

/**
 * The in-app invite notification links to the membership row, not to the
 * token (the backend keeps only the token's hash, and the notification
 * would otherwise hold a reusable secret). The page follows that link to
 * the invitee-only membership routes.
 */
describe('accepting an invite from the in-app notification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    query = new URLSearchParams({ membership: 'm-1' })
    ;(apiGet as any).mockResolvedValue({ organizationName: 'Acme', role: 'member', isExpired: false })
    ;(apiPost as any).mockResolvedValue({ organizationId: 'org-1', organizationName: 'Acme' })
    useAuthStore.setState({ user: { id: 'u-1', email: 'a@example.com' } as any, authChecked: true })
  })

  it('reads and accepts through the membership routes', async () => {
    render(<AcceptInvitePage />)

    fireEvent.click(await screen.findByRole('button', { name: /accept invitation/i }, WAIT))

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/invites/membership/m-1/accept', {}), WAIT)
    expect(apiGet).toHaveBeenCalledWith('/invites/membership/m-1')
  })

  it('still accepts an emailed token link through the token routes', async () => {
    query = new URLSearchParams({ token: 'emailed-token' })
    render(<AcceptInvitePage />)

    fireEvent.click(await screen.findByRole('button', { name: /accept invitation/i }, WAIT))

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/invites/emailed-token/accept', {}), WAIT)
  })
})
