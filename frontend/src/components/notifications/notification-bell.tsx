import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bell, CheckCheck } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { notificationsApi } from '@/lib/api'
import type { NotificationListResult } from '@/types/notification'
import { NotificationItem } from './notification-item'
import {
  useMarkAllNotificationsRead,
  useOpenNotification,
} from './use-notification-actions'

const BELL_PAGE_SIZE = 15
const POLL_INTERVAL_MS = 30_000

/**
 * Header notification bell: unread badge + dropdown inbox.
 *
 * The panel is a hand-rolled popover (button + absolutely positioned
 * card, outside-click and Escape to close) rather than a Radix
 * DropdownMenu — the panel holds interactive rows and buttons, which
 * fight menu-item keyboard semantics.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  const { data, isLoading } = useQuery<NotificationListResult>({
    queryKey: ['notifications', 'bell'],
    queryFn: () => notificationsApi.list({ page: 1, limit: BELL_PAGE_SIZE }),
    refetchInterval: POLL_INTERVAL_MS,
  })

  const notifications = data?.notifications ?? []
  const unreadCount = data?.unreadCount ?? 0

  const markAll = useMarkAllNotificationsRead()
  const openNotification = useOpenNotification(() => setOpen(false))

  // Close on outside click / Escape while the panel is open.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="relative" ref={containerRef}>
      <Button
        variant="ghost"
        size="icon"
        className="relative text-muted-foreground hover:text-foreground"
        aria-label={
          unreadCount > 0
            ? `Notifications, ${unreadCount} unread`
            : 'Notifications'
        }
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute right-0.5 top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-50 mt-2 w-96 max-w-[calc(100vw-2rem)] rounded-md border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all read
              </Button>
            )}
          </div>

          <div className={cn('max-h-96 overflow-y-auto p-1')}>
            {isLoading ? (
              <div className="space-y-2 p-2" aria-label="Loading notifications">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : notifications.length === 0 ? (
              <EmptyState
                icon={Bell}
                title="You're all caught up"
                description="New notifications will show up here."
                className="py-8"
              />
            ) : (
              notifications.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  onSelect={openNotification}
                />
              ))
            )}
          </div>

          <div className="border-t p-1">
            <Button
              variant="ghost"
              className="h-8 w-full text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setOpen(false)
                navigate('/notifications')
              }}
            >
              View all notifications
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
