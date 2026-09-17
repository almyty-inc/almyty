import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { SecurityTab } from '../SecurityTab'
import { authApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  authApi: { resendVerification: vi.fn(), changePassword: vi.fn() },
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
})
