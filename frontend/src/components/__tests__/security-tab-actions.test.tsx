import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { SecurityTab } from '../SecurityTab'
import { authApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  authApi: { resendVerification: vi.fn(), changePassword: vi.fn(), getProfile: vi.fn() },
}))

/**
 * Buttons on the Security tab either work or are not there.
 *
 * Two sat here with no onClick at all. "Send Verification" did nothing
 * while the identical action in the top banner worked, so anyone who had
 * dismissed the banner could never resend. "Revoke All Other Sessions"
 * did nothing under the promise "This will sign you out of all other
 * devices" — the worst kind, because someone who suspects a compromise
 * clicks it and believes they have acted. There is no endpoint behind it,
 * so it is gone rather than faked.
 */
describe('the Security tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(authApi.resendVerification as any).mockResolvedValue({})
    ;(authApi.getProfile as any).mockResolvedValue({ id: 'u1', hasPassword: true })
  })

  it('actually sends a verification email, and says it did', async () => {
    render(<SecurityTab />)

    fireEvent.click(screen.getByTestId('send-verification'))

    await waitFor(() => expect(authApi.resendVerification).toHaveBeenCalled())
    expect(await screen.findByTestId('verification-sent')).toBeInTheDocument()
  })

  it('says why when sending fails, instead of looking like it worked', async () => {
    ;(authApi.resendVerification as any).mockRejectedValue({
      response: { data: { message: 'Too many requests. Try again in a minute.' } },
    })
    render(<SecurityTab />)

    fireEvent.click(screen.getByTestId('send-verification'))

    expect(await screen.findByTestId('verification-error')).toHaveTextContent('Too many requests')
  })

  it('does not offer to revoke other sessions, because it cannot', () => {
    render(<SecurityTab />)

    expect(screen.queryByText(/Revoke All Other Sessions/i)).not.toBeInTheDocument()
    // And says what to do instead, rather than going quiet on the subject.
    expect(screen.getByText(/change your password/i)).toBeInTheDocument()
  })

  // "Password strength: Good, last changed recently" was hardcoded for
  // everyone. A stored password's strength is never known, and when it
  // last changed is not recorded, so neither is shown.
  it('says nothing about password strength or age it does not know', async () => {
    render(<SecurityTab />)
    await waitFor(() => expect(authApi.getProfile).toHaveBeenCalled())

    expect(screen.queryByText(/password strength/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/last changed/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^good$/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('no-password')).not.toBeInTheDocument()
  })

  it('keeps the made-up status out of the source too', () => {
    const source = readFileSync(join(__dirname, '..', 'SecurityTab.tsx'), 'utf8')
    expect(source).not.toMatch(/Password strength/i)
    expect(source).not.toMatch(/Last changed recently/i)
  })

  it('says when there is no password, for an account made by single sign-on', async () => {
    ;(authApi.getProfile as any).mockResolvedValue({ id: 'u1', hasPassword: false })
    render(<SecurityTab />)

    expect(await screen.findByTestId('no-password')).toHaveTextContent(/None set/)
  })
})
