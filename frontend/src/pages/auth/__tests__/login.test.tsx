import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { LoginPage } from '../login'
import { authApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth'

vi.mock('@/lib/api', () => ({
  authApi: { resendVerificationByEmail: vi.fn() },
}))

const loginMock = vi.fn()
vi.mock('@/store/auth', () => ({
  useAuthStore: vi.fn(),
}))

const navigateMock = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<any>('react-router-dom')
  return { ...actual, useNavigate: () => navigateMock }
})

const successMock = vi.fn()
const errorMock = vi.fn()
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: successMock, error: errorMock }),
}))

function makeVerifiedError() {
  return {
    response: { data: { error: { code: 'EMAIL_NOT_VERIFIED', message: 'Please verify your email address before signing in.', email: 'unverified@example.com' } } },
  }
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(useAuthStore as any).mockReturnValue({ login: loginMock, isLoading: false })
  })

  it('renders the verify-required state and resends when login returns EMAIL_NOT_VERIFIED', async () => {
    loginMock.mockRejectedValue(makeVerifiedError())
    ;(authApi.resendVerificationByEmail as any).mockResolvedValue({ success: true })
    const user = userEvent.setup()

    render(<MemoryRouter><LoginPage /></MemoryRouter>)

    await user.type(screen.getByLabelText(/email/i), 'unverified@example.com')
    await user.type(screen.getByLabelText(/password/i), 'Password123!')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    // Verify-required UI replaces the form.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /please verify your email/i })).toBeInTheDocument(),
    )
    expect(screen.getByText(/unverified@example.com/)).toBeInTheDocument()
    // No token was granted, so no navigation to the dashboard.
    expect(navigateMock).not.toHaveBeenCalled()

    // Resend wires to the unauthenticated resend endpoint.
    await user.click(screen.getByRole('button', { name: /resend verification email/i }))
    await waitFor(() =>
      expect(authApi.resendVerificationByEmail).toHaveBeenCalledWith('unverified@example.com'),
    )
    // Neutral confirmation after resend.
    expect(screen.getByText(/re-sent the verification link/i)).toBeInTheDocument()
  })

  it('logs in normally on success and does not show the verify prompt', async () => {
    loginMock.mockResolvedValue(undefined)
    const user = userEvent.setup()

    render(<MemoryRouter><LoginPage /></MemoryRouter>)

    await user.type(screen.getByLabelText(/email/i), 'ok@example.com')
    await user.type(screen.getByLabelText(/password/i), 'Password123!')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => expect(loginMock).toHaveBeenCalledWith('ok@example.com', 'Password123!'))
    expect(navigateMock).toHaveBeenCalledWith('/dashboard')
    expect(screen.queryByRole('heading', { name: /please verify your email/i })).not.toBeInTheDocument()
  })

  it('shows a generic error for invalid credentials (not the verify prompt)', async () => {
    loginMock.mockRejectedValue({ response: { data: { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } } } })
    const user = userEvent.setup()

    render(<MemoryRouter><LoginPage /></MemoryRouter>)

    await user.type(screen.getByLabelText(/email/i), 'bad@example.com')
    await user.type(screen.getByLabelText(/password/i), 'WrongPass1!')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => expect(screen.getByText(/invalid credentials/i)).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: /please verify your email/i })).not.toBeInTheDocument()
  })
})
