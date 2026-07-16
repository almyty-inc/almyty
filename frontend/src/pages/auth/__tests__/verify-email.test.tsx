import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'

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
vi.mock('@/lib/api', () => ({ authApi: { verifyEmail: vi.fn() } }))

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

  it('shows success + a dashboard link when the token verifies', async () => {
    ;(authApi.verifyEmail as any).mockResolvedValue({ success: true })
    ctl.token = 'good'
    render(<MemoryRouter><VerifyEmailPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/Email verified/i)).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument()
  })

  it('shows the upstream error message when the token is invalid/expired', async () => {
    ;(authApi.verifyEmail as any).mockRejectedValue({
      response: { data: { message: 'This verification link has expired.' } },
    })
    ctl.token = 'stale'
    render(<MemoryRouter><VerifyEmailPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/Verification failed/i)).toBeInTheDocument())
    expect(screen.getByText(/has expired/i)).toBeInTheDocument()
  })

  it('errors without calling the API when the token is missing', async () => {
    ctl.token = ''
    render(<MemoryRouter><VerifyEmailPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/Verification failed/i)).toBeInTheDocument())
    expect(authApi.verifyEmail).not.toHaveBeenCalled()
  })
})
