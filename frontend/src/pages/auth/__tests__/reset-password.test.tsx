import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ResetPasswordPage } from '../reset-password'
import { authApi } from '@/lib/api'

// The global test setup mocks react-router-dom's useSearchParams to always
// return empty; override it here with a controllable token so we can drive
// the missing-token vs. token-present paths, while keeping Link/Routes real.
const ctl = vi.hoisted(() => ({ token: '' }))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useSearchParams: () => [new URLSearchParams(ctl.token ? `token=${ctl.token}` : ''), vi.fn()],
  }
})
vi.mock('@/lib/api', () => ({ authApi: { resetPassword: vi.fn() } }))

// Mirrors App.tsx's /auth/* subtree so the regression exercises real routing.
function AuthSubtree() {
  return (
    <Routes>
      <Route path="login" element={<div>LOGIN PAGE</div>} />
      <Route path="reset-password" element={<ResetPasswordPage />} />
      <Route path="*" element={<Navigate to="/auth/login" replace />} />
    </Routes>
  )
}

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ctl.token = ''
  })

  it('REGRESSION: /auth/reset-password resolves to the page, NOT a login redirect', () => {
    ctl.token = 'abc'
    render(
      <MemoryRouter initialEntries={['/auth/reset-password?token=abc']}>
        <Routes><Route path="/auth/*" element={<AuthSubtree />} /></Routes>
      </MemoryRouter>,
    )
    expect(screen.queryByText('LOGIN PAGE')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /reset your password/i })).toBeInTheDocument()
  })

  it('submits matching passwords and calls resetPassword with the token', async () => {
    ;(authApi.resetPassword as any).mockResolvedValue({ success: true })
    ctl.token = 'good-token'
    const user = userEvent.setup()
    render(<MemoryRouter><ResetPasswordPage /></MemoryRouter>)

    await user.type(screen.getByLabelText('New password'), 'supersecret1')
    await user.type(screen.getByLabelText(/confirm new password/i), 'supersecret1')
    await user.click(screen.getByRole('button', { name: /reset password/i }))

    await waitFor(() =>
      expect(authApi.resetPassword).toHaveBeenCalledWith('good-token', 'supersecret1'),
    )
    expect(screen.getByText(/password has been updated/i)).toBeInTheDocument()
  })

  it('shows a validation error and does NOT call the API when passwords mismatch', async () => {
    ctl.token = 'good-token'
    const user = userEvent.setup()
    render(<MemoryRouter><ResetPasswordPage /></MemoryRouter>)

    await user.type(screen.getByLabelText('New password'), 'supersecret1')
    await user.type(screen.getByLabelText(/confirm new password/i), 'different2')
    await user.click(screen.getByRole('button', { name: /reset password/i }))

    await waitFor(() =>
      expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument(),
    )
    expect(authApi.resetPassword).not.toHaveBeenCalled()
  })

  it('shows the invalid-link error state when the token is missing', () => {
    ctl.token = ''
    render(<MemoryRouter><ResetPasswordPage /></MemoryRouter>)
    expect(screen.getByText(/invalid reset link/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /request a new link/i })).toBeInTheDocument()
  })
})
