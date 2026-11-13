import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { RegisterPage, TERMS_URL, PRIVACY_URL } from '../auth/register'
import { authApi } from '@/lib/api'

const ctl = vi.hoisted(() => ({
  search: '',
  navigate: vi.fn(),
  register: vi.fn(),
  captcha: false,
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => ctl.navigate,
    useSearchParams: () => [new URLSearchParams(ctl.search), vi.fn()],
  }
})
vi.mock('@/store/auth', () => ({
  useAuthStore: () => ({ register: ctl.register, isLoading: false }),
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/lib/api', () => ({
  apiPost: vi.fn(),
  authApi: { resendVerificationByEmail: vi.fn() },
  referralsApi: { attribute: vi.fn().mockResolvedValue({}) },
}))
vi.mock('@/components/auth/captcha-widget', () => ({
  CaptchaWidget: () => <div>Verify you are human</div>,
  isCaptchaEnabled: () => ctl.captcha,
}))

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('First name'), 'Dana')
  await user.type(screen.getByLabelText('Last name'), 'Lind')
  await user.type(screen.getByLabelText('Email address'), 'dana@example.com')
  await user.type(screen.getByLabelText('Organization name'), 'Lind Labs')
  await user.type(screen.getByLabelText('Password'), 'Secret123')
  await user.type(screen.getByLabelText('Confirm password'), 'Secret123')
  await user.click(screen.getByLabelText(/I agree to the/))
}

describe('RegisterPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ctl.search = ''
    ctl.captcha = false
    ctl.register.mockResolvedValue({ email: 'dana@example.com' })
  })

  // Accepting them is required, so they have to be readable: they were
  // plain text with nowhere to go.
  it('links Terms of Service and Privacy Policy to the website, in a new tab', () => {
    render(<RegisterPage />)

    const terms = screen.getByRole('link', { name: 'Terms of Service' })
    const privacy = screen.getByRole('link', { name: 'Privacy Policy' })
    expect(TERMS_URL).toBe('https://almyty.com/terms')
    expect(PRIVACY_URL).toBe('https://almyty.com/privacy')
    expect(terms).toHaveAttribute('href', TERMS_URL)
    expect(privacy).toHaveAttribute('href', PRIVACY_URL)
    for (const link of [terms, privacy]) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link.getAttribute('rel')).toMatch(/noopener/)
    }
    expect(document.querySelector('a[href="#"]')).toBeNull()
  })

  it('still requires the consent checkbox, and names the same documents when it is missing', async () => {
    const user = userEvent.setup()
    render(<RegisterPage />)
    expect(screen.getByLabelText(/I agree to the/)).toBeInstanceOf(HTMLInputElement)

    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Accept the Terms of Service and Privacy Policy to continue')).toBeInTheDocument()
    expect(ctl.register).not.toHaveBeenCalled()
  })

  it('says what the organization name is', () => {
    render(<RegisterPage />)
    expect(screen.getByLabelText('Organization name')).toHaveAccessibleDescription(
      "Your team's workspace in almyty. You can rename it later.",
    )
  })

  it('shows the password rules before the password breaks them', () => {
    render(<RegisterPage />)
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(
      'At least 8 characters, with an uppercase letter, a lowercase letter and a number.',
    )
  })

  it('asks for an email address rather than calling an empty one invalid', async () => {
    const user = userEvent.setup()
    render(<RegisterPage />)
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Enter your email address')).toBeInTheDocument()
    expect(screen.queryByText('Invalid email address')).not.toBeInTheDocument()
  })

  // Sign-up used to send the new user to /dashboard on a cookie that worked
  // until it expired; the next sign-in was then refused because the address
  // was never confirmed. Now the page says to check the email, with a resend.
  it('shows "check your email" with a resend after sign-up, not the dashboard', async () => {
    ;(authApi.resendVerificationByEmail as any).mockResolvedValue({ success: true })
    const user = userEvent.setup()
    render(<RegisterPage />)

    await fillValidForm(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument()
    expect(screen.getByText('dana@example.com')).toBeInTheDocument()
    expect(ctl.navigate).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/login')

    await user.click(screen.getByRole('button', { name: 'Send a new link' }))
    await waitFor(() => expect(authApi.resendVerificationByEmail).toHaveBeenCalledWith('dana@example.com'))
    expect(screen.getByText(/a new link is on its way/)).toBeInTheDocument()
  })

  it('brings an invited person back to the invitation after they sign in', async () => {
    ctl.search = 'invite=tok-1'
    const user = userEvent.setup()
    render(<RegisterPage />)

    await fillValidForm(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    const signIn = await screen.findByRole('link', { name: 'Sign in' })
    expect(signIn).toHaveAttribute(
      'href',
      `/auth/login?returnTo=${encodeURIComponent('/invite/accept?token=tok-1')}`,
    )
  })

  it('says an unticked human check under the check itself', async () => {
    ctl.captcha = true
    const user = userEvent.setup()
    render(<RegisterPage />)

    await fillValidForm(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Tick “Verify you are human” above to continue.')
    expect(ctl.register).not.toHaveBeenCalled()
  })
})