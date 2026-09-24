import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { ProfileTab } from '../settings'
import { authApi } from '../../lib/api'

// Changing the login address needs the current password (the server
// refuses without it); the profile form asks for it only then.

vi.mock('../../lib/api', () => ({
  authApi: { getProfile: vi.fn(), updateProfile: vi.fn() },
}))

vi.mock('../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

const PROFILE = {
  id: 'u1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  createdAt: '2026-01-01T00:00:00.000Z',
  isActive: true,
  emailVerified: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(authApi.getProfile).mockResolvedValue(PROFILE as any)
  vi.mocked(authApi.updateProfile).mockResolvedValue({} as any)
})

describe('profile email change', () => {
  it('a name-only edit sends no password and asks for none', async () => {
    const user = userEvent.setup()
    render(<ProfileTab />)
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }))
    expect(screen.queryByLabelText('Current password')).toBeNull()
    await user.clear(screen.getByLabelText('First Name'))
    await user.type(screen.getByLabelText('First Name'), 'Augusta')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(authApi.updateProfile).toHaveBeenCalledWith({ name: 'Augusta Lovelace', email: 'ada@example.com' }),
    )
  })

  it('a new email asks for the current password and will not save without it', async () => {
    const user = userEvent.setup()
    render(<ProfileTab />)
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }))
    await user.clear(screen.getByLabelText('Email Address'))
    await user.type(screen.getByLabelText('Email Address'), 'new@example.com')

    expect(screen.getByLabelText('Current password')).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Enter your current password/)).toBeInTheDocument()
    expect(authApi.updateProfile).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('Current password'), 'hunter2!')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(authApi.updateProfile).toHaveBeenCalledWith({
        name: 'Ada Lovelace',
        email: 'new@example.com',
        currentPassword: 'hunter2!',
      }),
    )
  })
})
