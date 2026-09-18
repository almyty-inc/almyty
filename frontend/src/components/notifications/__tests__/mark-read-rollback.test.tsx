import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

import {
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  NOTIFICATIONS_QUERY_PREFIX,
} from '../use-notification-actions'
import { notificationsApi } from '../../../lib/api'
import type { NotificationListResult } from '@/types/notification'

// Both mark-read mutations wrote the cache in onMutate, returned no
// snapshot and had no onError. onSettled's invalidate usually repairs
// that -- but the failure mode that matters is the network or session
// being gone, and then the refetch fails too and the cache keeps a
// readAt nobody wrote and an unreadCount of zero, so the bell says
// nothing is waiting.

vi.mock('../../../lib/api', () => ({
  notificationsApi: {
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    list: vi.fn(),
  },
}))

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

const LIST: NotificationListResult = {
  notifications: [
    { id: 'n1', title: 'One', body: '', readAt: null, createdAt: '', type: 'x', link: null } as any,
    { id: 'n2', title: 'Two', body: '', readAt: null, createdAt: '', type: 'x', link: null } as any,
  ],
  unreadCount: 2,
} as NotificationListResult

function harness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  // Two mounted views over the same prefix, as the bell and the
  // notifications page are.
  queryClient.setQueryData([...NOTIFICATIONS_QUERY_PREFIX, 'bell'], LIST)
  queryClient.setQueryData([...NOTIFICATIONS_QUERY_PREFIX, 'page', 1], LIST)
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

const bell = (qc: QueryClient) =>
  qc.getQueryData<NotificationListResult>([...NOTIFICATIONS_QUERY_PREFIX, 'bell'])!
const page = (qc: QueryClient) =>
  qc.getQueryData<NotificationListResult>([...NOTIFICATIONS_QUERY_PREFIX, 'page', 1])!

describe('optimistic mark-read rolls back on failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The refetch onSettled fires also fails -- that is the whole point.
    vi.mocked(notificationsApi.list).mockRejectedValue(new Error('offline'))
  })

  it('puts every notification cache back when marking one read fails', async () => {
    let reject!: (e: unknown) => void
    vi.mocked(notificationsApi.markRead).mockReturnValue(
      new Promise((_res, rej) => {
        reject = rej
      }) as any,
    )
    const { queryClient, wrapper } = harness()
    const { result } = renderHook(() => useMarkNotificationRead(), { wrapper })

    result.current.mutate('n1')

    // The optimistic write lands on every mounted view while the call
    // is still in flight.
    await waitFor(() => expect(bell(queryClient).unreadCount).toBe(1))
    expect(page(queryClient).notifications[0].readAt).not.toBeNull()

    reject(new Error('offline'))

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(bell(queryClient).unreadCount).toBe(2)
    expect(bell(queryClient).notifications[0].readAt).toBeNull()
    expect(page(queryClient).unreadCount).toBe(2)
    expect(page(queryClient).notifications[0].readAt).toBeNull()
  })

  it('puts them back when marking all read fails', async () => {
    let reject!: (e: unknown) => void
    vi.mocked(notificationsApi.markAllRead).mockReturnValue(
      new Promise((_res, rej) => {
        reject = rej
      }) as any,
    )
    const { queryClient, wrapper } = harness()
    const { result } = renderHook(() => useMarkAllNotificationsRead(), { wrapper })

    result.current.mutate()

    await waitFor(() => expect(bell(queryClient).unreadCount).toBe(0))

    reject(new Error('offline'))

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(bell(queryClient).unreadCount).toBe(2)
    expect(bell(queryClient).notifications.every(n => n.readAt === null)).toBe(true)
    expect(page(queryClient).unreadCount).toBe(2)
  })

  it('keeps the optimistic write when the call succeeds', async () => {
    vi.mocked(notificationsApi.markRead).mockResolvedValue({} as any)
    const { queryClient, wrapper } = harness()
    const { result } = renderHook(() => useMarkNotificationRead(), { wrapper })

    result.current.mutate('n1')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(bell(queryClient).unreadCount).toBe(1)
    expect(bell(queryClient).notifications[0].readAt).not.toBeNull()
  })
})
