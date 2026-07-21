import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ForgotPasswordPage } from '../forgot-password'
import { authApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({ authApi: { forgotPassword: vi.fn() } }))

// Mirrors App.tsx's /auth/* subtree so the regression exercises real routing.
function AuthSubtree() {
  return (
    <Routes>
      <Route path="login" element={<div>LOGIN PAGE</div>} />
      <Route path="forgot-password" element={<ForgotPasswordPage />} />
      <Route path="*" element={<Navigate to="/auth/login" replace />} />
    </Routes>
  )
}

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('REGRESSION: /auth/forgot-password resolves to the page, NOT a login redirect', () => {
    render(
      <MemoryRouter initialEntries={['/auth/forgot-password']}>
        <Routes><Route path="/auth/*" element={<AuthSubtree />} /></Routes>
      </MemoryRouter>,
    )
    expect(screen.queryByText('LOGIN PAGE')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /forgot your password/i })).toBeInTheDocument()
  })

  it('submits the email and shows the neutral enumeration-safe sent state', async () => {
    ;(authApi.forgotPassword as any).mockResolvedValue({ success: true })
    const user = userEvent.setup()
    render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>)

    await user.type(screen.getByLabelText(/email/i), 'user@example.com')
    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    await waitFor(() =>
      expect(authApi.forgotPassword).toHaveBeenCalledWith('user@example.com'),
    )
    // Neutral message — must NOT reveal whether the account exists.
    expect(screen.getByText(/if an account exists/i)).toBeInTheDocument()
  })

  it('does not call the API when the email is invalid', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>)

    await user.type(screen.getByLabelText(/email/i), 'not-an-email')
    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    await waitFor(() =>
      expect(screen.getByText(/invalid email address/i)).toBeInTheDocument(),
    )
    expect(authApi.forgotPassword).not.toHaveBeenCalled()
  })
})
