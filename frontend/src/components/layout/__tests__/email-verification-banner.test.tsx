import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '@/test/setup'
import { EmailVerificationBanner } from '../email-verification-banner'

vi.mock('@/lib/api', () => ({
  authApi: {
    resendVerification: vi.fn(),
  },
}))

// Control the auth store user per test without touching the real
// persisted zustand store.
let currentUser: Record<string, unknown> | null = null
vi.mock('@/store/auth', () => ({
  useAuthStore: (selector: (state: { user: unknown }) => unknown) =>
    selector({ user: currentUser }),
}))

import { authApi } from '@/lib/api'

const mockedResend = authApi.resendVerification as ReturnType<typeof vi.fn>

const baseUser = {
  id: 'u-1',
  email: 'user@example.com',
  name: 'Test User',
}

describe('EmailVerificationBanner', () => {
  beforeEach(() => {
    mockedResend.mockReset()
    currentUser = null
  })

  it('shows the banner only when emailVerified is explicitly false', () => {
    currentUser = { ...baseUser, emailVerified: false }
    render(<EmailVerificationBanner />)

    expect(screen.getByText('Verify your email - check your inbox')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resend' })).toBeInTheDocument()
  })

  it('renders nothing when the user is verified', () => {
    currentUser = { ...baseUser, emailVerified: true }
    const { container } = render(<EmailVerificationBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the field is absent (backend has not shipped it)', () => {
    currentUser = { ...baseUser }
    const { container } = render(<EmailVerificationBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when no user is signed in', () => {
    currentUser = null
    const { container } = render(<EmailVerificationBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('resends the verification email and confirms', async () => {
    currentUser = { ...baseUser, emailVerified: false }
    mockedResend.mockResolvedValue({})

    render(<EmailVerificationBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Resend' }))

    await waitFor(() => expect(mockedResend).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Verification email sent')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resend' })).not.toBeInTheDocument()
  })

  it('can be dismissed', () => {
    currentUser = { ...baseUser, emailVerified: false }
    render(<EmailVerificationBanner />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(
      screen.queryByText('Verify your email - check your inbox'),
    ).not.toBeInTheDocument()
  })
})
