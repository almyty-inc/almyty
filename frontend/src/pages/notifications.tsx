import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Bell, CheckCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { notificationsApi } from '@/lib/api'
import type { NotificationListResult } from '@/types/notification'
import { NotificationItem } from '@/components/notifications/notification-item'
import {
  useMarkAllNotificationsRead,
  useOpenNotification,
} from '@/components/notifications/use-notification-actions'

const PAGE_SIZE = 20

export function NotificationsPage() {
  const [page, setPage] = useState(1)
  const [unreadOnly, setUnreadOnly] = useState(false)

  useEffect(() => {
    document.title = 'Notifications | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  const { data, isLoading } = useQuery<NotificationListResult>({
    queryKey: ['notifications', 'list', { page, unreadOnly }],
    queryFn: () =>
      notificationsApi.list({
        page,
        limit: PAGE_SIZE,
        unreadOnly: unreadOnly || undefined,
      }),
  })

  const notifications = data?.notifications ?? []
  const total = data?.total ?? 0
  const unreadCount = data?.unreadCount ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const markAll = useMarkAllNotificationsRead()
  const openNotification = useOpenNotification()

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-violet-500 to-cyan-400 bg-clip-text text-transparent">
            Notifications
          </h1>
          <p className="text-muted-foreground">
            Everything that happened across your organization
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="unread-only"
              checked={unreadOnly}
              onCheckedChange={(checked) => {
                setUnreadOnly(checked)
                setPage(1)
              }}
            />
            <Label htmlFor="unread-only" className="text-sm text-muted-foreground">
              Unread only
            </Label>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending || unreadCount === 0}
          >
            <CheckCheck className="h-4 w-4" />
            Mark all read
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-2">
          {isLoading ? (
            <div className="space-y-2 p-2" aria-label="Loading notifications">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : notifications.length === 0 ? (
            <EmptyState
              icon={Bell}
              title={unreadOnly ? 'No unread notifications' : 'No notifications yet'}
              description={
                unreadOnly
                  ? 'You have read everything.'
                  : 'Activity from agents, approvals, and your account will show up here.'
              }
            />
          ) : (
            <div className="divide-y divide-border/40">
              {notifications.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  onSelect={openNotification}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {total > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
            <span className="ml-2">({total} total)</span>
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
