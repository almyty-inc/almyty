import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Bell, CheckCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { PageHeader } from '@/components/layout/page-header'
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

  const { data, isLoading, isError, error, refetch } = useQuery<NotificationListResult>({
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
      <PageHeader
        title="Notifications"
        description="Everything that happened across your organization"
        actions={
          <>
            <div className="flex items-center gap-2 pr-2">
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
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending || unreadCount === 0}
            >
              <CheckCheck className="mr-2 h-4 w-4" />
              Mark all read
            </Button>
          </>
        }
      />

      {isError ? (
        <QueryError error={error} onRetry={() => refetch()} title="Couldn't load notifications" />
      ) : (
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
              variant="inline"
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
      )}

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
