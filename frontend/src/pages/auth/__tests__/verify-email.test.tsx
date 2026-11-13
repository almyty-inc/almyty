import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { VerifyEmailPage } from '../verify-email'
import { authApi } from '@/lib/api'

// The global test setup mocks react-router-dom's useSearchParams to always
// return empty; override it here with a controllable token so we can drive
// the page's verify/success/error paths, while keeping Link/Routes real.
const ctl = vi.hoisted(() => ({ token: '' }))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useSearchParams: () => [new URLSearchParams(ctl.token ? `token=${ctl.token}` : ''), vi.fn()],
  }
})
vi.mock('@/lib/api', () => ({ authApi: { verifyEmail: vi.fn(), resendVerificationByEmail: vi.fn() } }))

// Mirrors App.tsx's /auth/* subtree so the regression exercises real routing.
function AuthSubtree() {
  return (
    <Routes>
      <Route path="login" element={<div>LOGIN PAGE</div>} />
      <Route path="verify-email" element={<VerifyEmailPage />} />
      <Route path="*" element={<Navigate to="/auth/login" replace />} />
    </Routes>
  )
}

describe('VerifyEmailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ctl.token = ''
  })

  it('REGRESSION: /auth/verify-email resolves to the verify page, NOT a login redirect', async () => {
    ;(authApi.verifyEmail as any).mockResolvedValue({ success: true })
    ctl.token = 'abc'
    render(
      <MemoryRouter initialEntries={['/auth/verify-email?token=abc']}>
        <Routes><Route path="/auth/*" element={<AuthSubtree />} /></Routes>
      </MemoryRouter>,
    )
    // The bug: this route fell through the catch-all to the login redirect.
    expect(screen.queryByText('LOGIN PAGE')).not.toBeInTheDocument()
    await waitFor(() => expect(authApi.verifyEmail).toHaveBeenCalledWith('abc'))
  })

  // Signing in needs a confirmed address, so "Go to dashboard" only bounced
  // a signed-out person to the sign-in page. Success leads there directly.
  it('shows success and leads to sign-in when the token verifies', async () => {
    ;(authApi.verifyEmail as any).mockResolvedValue({ success: true })
    ctl.token = 'good'
    render(<MemoryRouter><VerifyEmailPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/Email confirmed/i)).toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/login')
  })

  // The failure page was a dead end ("Invalid verification token", "Back to
  // app") for someone who cannot sign in to ask for a new link.
  it('explains a bad link plainly and sends a new one from the page', async () => {
    ;(authApi.verifyEmail as any).mockRejectedValue({
      response: { status: 400, data: { message: 'Invalid verification token' } },
    })
    ;(authApi.resendVerificationByEmail as any).mockResolvedValue({ success: true })
    ctl.token = 'stale'
    const user = userEvent.setup()
    render(<MemoryRouter><VerifyEmailPage /></MemoryRouter>)

    await waitFor(() => expect(screen.getByRole('heading', { name: /this link didn.t work/i })).toBeInTheDocument())
    expect(screen.queryByText(/invalid verification token/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /back to app/i })).not.toBeInTheDocument()

    await user.type(screen.getByLabelText(/email address/i), 'dana@example.com')
    await user.click(screen.getByRole('button', { name: /send a new link/i }))
    await waitFor(() => expect(authApi.resendVerificationByEmail).toHaveBeenCalledWith('dana@example.com'))
    expect(screen.getByText(/a new link is on its way/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveAttribute('href', '/auth/login')
  })

  it('offers a new link without calling the API when the token is missing', async () => {
    ctl.token = ''
    render(<MemoryRouter><VerifyEmailPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole('heading', { name: /this link didn.t work/i })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /send a new link/i })).toBeInTheDocument()
    expect(authApi.verifyEmail).not.toHaveBeenCalled()
  })
})