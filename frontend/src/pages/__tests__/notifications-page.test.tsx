import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '@/test/setup'
import { NotificationsPage } from '../notifications'

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

function notification(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'budget.alert',
    title,
    body: null,
    link: null,
    createdAt: new Date().toISOString(),
    readAt: null,
    ...overrides,
  }
}

describe('NotificationsPage', () => {
  beforeEach(() => {
    mockedList.mockReset()
    mockedMarkRead.mockReset()
    mockedMarkAllRead.mockReset()
    mockedMarkRead.mockResolvedValue({})
    mockedMarkAllRead.mockResolvedValue({})
  })

  it('renders the list and paginates through pages', async () => {
    mockedList.mockImplementation((params: { page?: number } = {}) =>
      Promise.resolve({
        notifications:
          params.page === 2
            ? [notification('n-21', 'Second page item')]
            : [notification('n-1', 'First page item')],
        total: 25,
        unreadCount: 2,
      }),
    )

    render(<NotificationsPage />)

    expect(await screen.findByText('First page item')).toBeInTheDocument()
    expect(screen.getByText(/page 1 of 2/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    await waitFor(() =>
      expect(mockedList).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, limit: 20 }),
      ),
    )
    expect(await screen.findByText('Second page item')).toBeInTheDocument()
    expect(screen.getByText(/page 2 of 2/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled()
  })

  it('requests unread only when the filter is toggled', async () => {
    mockedList.mockResolvedValue({
      notifications: [notification('n-1', 'Unread item')],
      total: 1,
      unreadCount: 1,
    })

    render(<NotificationsPage />)
    await screen.findByText('Unread item')

    fireEvent.click(screen.getByRole('switch', { name: /unread only/i }))

    await waitFor(() =>
      expect(mockedList).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, unreadOnly: true }),
      ),
    )
  })

  it('marks an unread item read on click and supports mark all read', async () => {
    mockedList.mockResolvedValue({
      notifications: [notification('n-1', 'Unread item')],
      total: 1,
      unreadCount: 1,
    })

    render(<NotificationsPage />)
    await screen.findByText('Unread item')

    fireEvent.click(screen.getByText('Unread item').closest('button') as HTMLButtonElement)
    await waitFor(() => expect(mockedMarkRead).toHaveBeenCalledWith('n-1'))

    fireEvent.click(screen.getByRole('button', { name: /mark all read/i }))
    await waitFor(() => expect(mockedMarkAllRead).toHaveBeenCalledTimes(1))
  })

  it('shows an empty state when there are no notifications', async () => {
    mockedList.mockResolvedValue({ notifications: [], total: 0, unreadCount: 0 })

    render(<NotificationsPage />)

    expect(await screen.findByText('No notifications yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /mark all read/i })).toBeDisabled()
  })
})
