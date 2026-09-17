import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { render } from '../../test/setup'
import { RegisterPage } from '../auth/register'

vi.mock('@/store/auth', () => ({
  useAuthStore: () => ({ register: vi.fn(), isLoading: false }),
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/lib/api', () => ({
  apiPost: vi.fn(),
  referralsApi: { attribute: vi.fn().mockResolvedValue({}) },
}))
vi.mock('@/components/auth/captcha-widget', () => ({
  CaptchaWidget: () => null,
  isCaptchaEnabled: () => false,
}))

describe('RegisterPage terms and privacy', () => {
  /**
   * The consent checkbox is required to register, and the two documents it
   * names were <a href="#">: focus stops that jumped to the top of the page
   * and nothing else. There is no /terms or /privacy route in App.tsx, so
   * the honest rendering is plain text, not a link that goes nowhere.
   */
  it('does not offer Terms of Service or Privacy Policy as links', () => {
    render(<RegisterPage />)

    expect(screen.getByText('Terms of Service')).toBeInTheDocument()
    expect(screen.getByText('Privacy Policy')).toBeInTheDocument()

    expect(screen.queryByRole('link', { name: 'Terms of Service' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Privacy Policy' })).toBeNull()

    // And nothing anywhere on the page still points at the placeholder href.
    expect(document.querySelector('a[href="#"]')).toBeNull()
  })

  it('still requires the consent checkbox', () => {
    render(<RegisterPage />)
    expect(screen.getByLabelText(/I agree to the/)).toBeInstanceOf(HTMLInputElement)
  })
})
