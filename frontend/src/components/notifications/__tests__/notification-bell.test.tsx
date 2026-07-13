import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '@/test/setup'
import { NotificationBell } from '../notification-bell'

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

const mockedList = notificationsApi.list as ReturnType<typeof vi.fn>
const mockedMarkRead = notificationsApi.markRead as ReturnType<typeof vi.fn>
const mockedMarkAllRead = notificationsApi.markAllRead as ReturnType<typeof vi.fn>

const unreadNotification = {
  id: 'n-1',
  type: 'run.failed',
  title: 'Run failed on weather-agent',
  body: 'Step 3 threw a timeout error.',
  link: '/agents/agent-1',
  createdAt: new Date().toISOString(),
  readAt: null,
}

const readNotification = {
  id: 'n-2',
  type: 'invite.received',
  title: 'You were invited to acme',
  body: null,
  link: null,
  createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  readAt: new Date().toISOString(),
}

function listPayload(overrides: Partial<{ notifications: any[]; total: number; unreadCount: number }> = {}) {
  return {
    notifications: [unreadNotification, readNotification],
    total: 2,
    unreadCount: 1,
    ...overrides,
  }
}

describe('NotificationBell', () => {
  beforeEach(() => {
    mockedList.mockReset()
    mockedMarkRead.mockReset()
    mockedMarkAllRead.mockReset()
    mockedMarkRead.mockResolvedValue({})
    mockedMarkAllRead.mockResolvedValue({})
  })

  it('renders the unread count badge', async () => {
    mockedList.mockResolvedValue(listPayload({ unreadCount: 3 }))

    render(<NotificationBell />)

    const badge = await screen.findByTestId('notification-badge')
    expect(badge).toHaveTextContent('3')
    expect(
      screen.getByRole('button', { name: 'Notifications, 3 unread' }),
    ).toBeInTheDocument()
  })

  it('caps the badge at 99+', async () => {
    mockedList.mockResolvedValue(listPayload({ unreadCount: 150 }))

    render(<NotificationBell />)

    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('99+')
  })

  it('opens the panel, lists notifications with unread highlight, and marks an item read on click', async () => {
    mockedList.mockResolvedValue(listPayload())

    render(<NotificationBell />)
    await screen.findByTestId('notification-badge')

    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))

    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument()
    expect(screen.getByText('Run failed on weather-agent')).toBeInTheDocument()
    expect(screen.getByText('You were invited to acme')).toBeInTheDocument()

    const unreadItem = screen
      .getByText('Run failed on weather-agent')
      .closest('button') as HTMLButtonElement
    expect(unreadItem).toHaveAttribute('data-unread', 'true')

    const readItem = screen
      .getByText('You were invited to acme')
      .closest('button') as HTMLButtonElement
    expect(readItem).not.toHaveAttribute('data-unread')

    fireEvent.click(unreadItem)
    await waitFor(() => expect(mockedMarkRead).toHaveBeenCalledWith('n-1'))
  })

  it('does not mark an already-read item read again', async () => {
    mockedList.mockResolvedValue(listPayload())

    render(<NotificationBell />)
    await screen.findByTestId('notification-badge')

    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    fireEvent.click(
      screen.getByText('You were invited to acme').closest('button') as HTMLButtonElement,
    )

    expect(mockedMarkRead).not.toHaveBeenCalled()
  })

  it('marks all read and clears the badge', async () => {
    mockedList
      .mockResolvedValueOnce(listPayload())
      .mockResolvedValue(
        listPayload({
          notifications: [
            { ...unreadNotification, readAt: new Date().toISOString() },
            readNotification,
          ],
          unreadCount: 0,
        }),
      )

    render(<NotificationBell />)
    await screen.findByTestId('notification-badge')

    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    fireEvent.click(screen.getByRole('button', { name: /mark all read/i }))

    await waitFor(() => expect(mockedMarkAllRead).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument(),
    )
  })

  it('shows an empty state when there are no notifications', async () => {
    mockedList.mockResolvedValue(listPayload({ notifications: [], total: 0, unreadCount: 0 }))

    render(<NotificationBell />)
    await waitFor(() => expect(mockedList).toHaveBeenCalled())

    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /mark all read/i })).not.toBeInTheDocument()
  })
})
