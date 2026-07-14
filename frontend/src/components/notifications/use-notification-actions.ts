import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'

import { notificationsApi } from '@/lib/api'
import type { AppNotification, NotificationListResult } from '@/types/notification'

// All notification list caches (bell + paginated page) share the
// ['notifications', ...] key prefix so optimistic updates below can
// patch every mounted view at once with setQueriesData.
export const NOTIFICATIONS_QUERY_PREFIX = ['notifications'] as const

function markReadInCache(
  data: NotificationListResult | undefined,
  ids: 'all' | string,
): NotificationListResult | undefined {
  if (!data) return data
  const now = new Date().toISOString()
  let marked = 0
  const notifications = data.notifications.map((n) => {
    if (n.readAt || (ids !== 'all' && n.id !== ids)) return n
    marked += 1
    return { ...n, readAt: now }
  })
  const unreadCount =
    ids === 'all' ? 0 : Math.max(0, data.unreadCount - marked)
  return { ...data, notifications, unreadCount }
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATIONS_QUERY_PREFIX })
      queryClient.setQueriesData<NotificationListResult>(
        { queryKey: NOTIFICATIONS_QUERY_PREFIX },
        (data) => markReadInCache(data, id),
      )
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_PREFIX }),
  })
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATIONS_QUERY_PREFIX })
      queryClient.setQueriesData<NotificationListResult>(
        { queryKey: NOTIFICATIONS_QUERY_PREFIX },
        (data) => markReadInCache(data, 'all'),
      )
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_PREFIX }),
  })
}

/**
 * Shared click behavior: mark unread items read, then follow the
 * notification link (SPA navigate for internal paths, full page
 * load for absolute URLs).
 */
export function useOpenNotification(onNavigate?: () => void) {
  const navigate = useNavigate()
  const markRead = useMarkNotificationRead()

  return (notification: AppNotification) => {
    if (!notification.readAt) {
      markRead.mutate(notification.id)
    }
    if (notification.link) {
      onNavigate?.()
      if (/^https?:\/\//.test(notification.link)) {
        window.location.assign(notification.link)
      } else {
        navigate(notification.link)
      }
    }
  }
}
