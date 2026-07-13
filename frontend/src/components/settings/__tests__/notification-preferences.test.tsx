import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '@/test/setup'
import { NotificationPreferences } from '../notification-preferences'

vi.mock('@/lib/api', () => ({
  notificationsApi: {
    list: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
  },
}))

import { notificationsApi } from '@/lib/api'

const mockedGetPreferences = notificationsApi.getPreferences as ReturnType<typeof vi.fn>
const mockedUpdatePreferences = notificationsApi.updatePreferences as ReturnType<typeof vi.fn>

const basePreferences = {
  matrix: {
    'approval.pending': { inApp: true, email: true },
    'run.failed': { inApp: true, email: false },
    'security.sso_install': { inApp: true, email: true },
  },
  defaults: {
    'approval.pending': { inApp: true, email: true },
    'run.failed': { inApp: true, email: true },
    'security.sso_install': { inApp: true, email: true, locked: true },
  },
}

describe('NotificationPreferences', () => {
  beforeEach(() => {
    mockedGetPreferences.mockReset()
    mockedUpdatePreferences.mockReset()
    mockedUpdatePreferences.mockResolvedValue(basePreferences.matrix)
  })

  it('renders one row per event type from the fetched data', async () => {
    mockedGetPreferences.mockResolvedValue(basePreferences)

    render(<NotificationPreferences />)

    expect(await screen.findByText('Approval requested')).toBeInTheDocument()
    expect(screen.getByText('Run failed')).toBeInTheDocument()
    expect(screen.getByText('SSO change')).toBeInTheDocument()
    // Types absent from the payload are not rendered
    expect(screen.queryByText('Budget alert')).not.toBeInTheDocument()

    // Current values come from the matrix
    expect(
      screen.getByRole('checkbox', { name: 'Run failed email notifications' }),
    ).not.toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: 'Run failed in-app notifications' }),
    ).toBeChecked()
  })

  it('PUTs the full updated matrix when a checkbox is toggled', async () => {
    const updatedMatrix = {
      ...basePreferences.matrix,
      'run.failed': { inApp: false, email: false },
    }
    // First fetch returns the base state; the refetch after the PUT
    // settles returns the merged result, like the real backend.
    mockedGetPreferences
      .mockResolvedValueOnce(basePreferences)
      .mockResolvedValue({ ...basePreferences, matrix: updatedMatrix })

    render(<NotificationPreferences />)
    await screen.findByText('Run failed')

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Run failed in-app notifications' }),
    )

    await waitFor(() =>
      expect(mockedUpdatePreferences).toHaveBeenCalledWith(updatedMatrix),
    )

    // Optimistic update flips the checkbox immediately and the
    // refetched state keeps it off.
    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: 'Run failed in-app notifications' }),
      ).not.toBeChecked(),
    )
  })

  it('renders locked email rows as disabled with the always-emailed note', async () => {
    mockedGetPreferences.mockResolvedValue(basePreferences)

    render(<NotificationPreferences />)
    await screen.findByText('SSO change')

    const lockedEmail = screen.getByRole('checkbox', {
      name: 'SSO change email notifications',
    })
    expect(lockedEmail).toBeDisabled()
    expect(lockedEmail).toBeChecked()

    // Exactly one locked row in the fixture -> exactly one note
    expect(screen.getAllByText('Security notices are always emailed')).toHaveLength(1)
  })

  it('does not render the always-emailed note when defaults carry no locks', async () => {
    mockedGetPreferences.mockResolvedValue({
      matrix: { 'approval.pending': { inApp: true, email: true } },
      defaults: { 'approval.pending': { inApp: true, email: true } },
    })

    render(<NotificationPreferences />)
    await screen.findByText('Approval requested')

    expect(
      screen.queryByText('Security notices are always emailed'),
    ).not.toBeInTheDocument()
  })

  it('offers a per-row reset to default when the value differs', async () => {
    mockedGetPreferences.mockResolvedValue(basePreferences)

    render(<NotificationPreferences />)
    await screen.findByText('Run failed')

    // approval.pending matches its default -> no reset affordance
    expect(
      screen.queryByRole('button', { name: 'Reset Approval requested to default' }),
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Reset Run failed to default' }),
    )

    await waitFor(() =>
      expect(mockedUpdatePreferences).toHaveBeenCalledWith({
        ...basePreferences.matrix,
        'run.failed': { inApp: true, email: true },
      }),
    )
  })
})
