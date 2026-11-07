import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'

import { render } from '../../test/setup'
import { SecurityTab } from '../SecurityTab'
import { authApi } from '@/lib/api'
import { useAppStore } from '@/store/app'

vi.mock('@/lib/api', () => ({
  authApi: {
    resendVerification: vi.fn(),
    changePassword: vi.fn(),
    getProfile: vi.fn(),
    forgotPassword: vi.fn(),
    revokeOtherSessions: vi.fn(),
  },
}))

/**
 * Settings > Security > Active sessions > "Sign out other devices".
 *
 * One click and a one-line confirm, then a toast that says what happened.
 * The server re-issues this browser's httpOnly cookie, so the page never
 * sees or stores a token.
 */
describe('sign out other devices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ notifications: [] })
    ;(authApi.getProfile as any).mockResolvedValue({ id: 'u1', email: 'dana@example.com', hasPassword: true })
    ;(authApi.revokeOtherSessions as any).mockResolvedValue({ signedOut: 2, expiresIn: 86400 })
  })

  const toasts = () => useAppStore.getState().notifications

  it('asks once, then signs out the other devices and says how many', async () => {
    render(<SecurityTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out other devices' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Sign out other devices?')).toBeInTheDocument()
    expect(authApi.revokeOtherSessions).not.toHaveBeenCalled()

    fireEvent.click(within(confirm).getByRole('button', { name: 'Sign out other devices' }))

    await waitFor(() => expect(authApi.revokeOtherSessions).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(toasts()).toContainEqual(
        expect.objectContaining({
          type: 'success',
          title: 'Signed out of other devices',
          message: "Ended 2 other sessions. You're still signed in here.",
        }),
      ),
    )
  })

  it('does nothing when the confirm is cancelled', async () => {
    render(<SecurityTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out other devices' }))
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(authApi.revokeOtherSessions).not.toHaveBeenCalled()
  })

  it('says so when there was nothing else to sign out', async () => {
    ;(authApi.revokeOtherSessions as any).mockResolvedValue({ signedOut: 0, expiresIn: 86400 })
    render(<SecurityTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out other devices' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out other devices' }))

    await waitFor(() =>
      expect(toasts()).toContainEqual(
        expect.objectContaining({ message: "There were no other sessions. You're still signed in here." }),
      ),
    )
  })

  it('says why when it fails, instead of looking like it worked', async () => {
    ;(authApi.revokeOtherSessions as any).mockRejectedValue({
      response: { data: { message: 'Too many requests. Try again later.' } },
    })
    render(<SecurityTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out other devices' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out other devices' }))

    await waitFor(() =>
      expect(toasts()).toContainEqual(
        expect.objectContaining({ type: 'error', title: 'Could not sign out other devices', message: expect.stringContaining('Too many requests') }),
      ),
    )
  })

  it('is offered to an account without a password too, with wording that fits it', async () => {
    ;(authApi.getProfile as any).mockResolvedValue({ id: 'u1', email: 'dana@example.com', hasPassword: false })
    render(<SecurityTab />)
    await screen.findByTestId('no-password')

    expect(screen.getByRole('button', { name: 'Sign out other devices' })).toBeInTheDocument()
    const note = screen.getByTestId('sessions-note')
    expect(note).toHaveTextContent(/setting a password with the emailed link above also signs out every other device/i)
    expect(note).not.toHaveTextContent(/change your password|changing your password/i)
  })

  it('tells an account with a password that changing it does the same', async () => {
    render(<SecurityTab />)
    await screen.findByLabelText(/current password/i)

    expect(screen.getByTestId('sessions-note')).toHaveTextContent(/changing your password also signs out every other device/i)
  })

  it('no longer says signing out elsewhere is unsupported', async () => {
    render(<SecurityTab />)
    await waitFor(() => expect(authApi.getProfile).toHaveBeenCalled())

    expect(screen.queryByText(/can't sign out other devices/i)).not.toBeInTheDocument()
    const source = readFileSync(join(__dirname, '..', 'SecurityTab.tsx'), 'utf8')
    expect(source).not.toMatch(/sign out other devices from here yet/i)
  })

  it('never touches a token in the page', () => {
    const source = readFileSync(join(__dirname, '..', 'SecurityTab.tsx'), 'utf8')
    expect(source).not.toMatch(/localStorage|sessionStorage|accessToken|document\.cookie/)
  })
})
