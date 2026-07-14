import { cn, formatRelativeTime } from '@/lib/utils'
import type { AppNotification } from '@/types/notification'
import { getNotificationPresentation } from './presentation'

interface NotificationItemProps {
  notification: AppNotification
  onSelect?: (notification: AppNotification) => void
}

/**
 * One notification row — shared between the bell dropdown and the
 * /notifications page so both surfaces stay visually identical.
 */
export function NotificationItem({ notification, onSelect }: NotificationItemProps) {
  const pres = getNotificationPresentation(notification.type)
  const Icon = pres.icon
  const unread = !notification.readAt

  return (
    <button
      type="button"
      onClick={() => onSelect?.(notification)}
      data-unread={unread || undefined}
      className={cn(
        'w-full flex items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent',
        unread && 'bg-primary/5',
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', pres.accentClass)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'truncate text-sm text-foreground',
              unread && 'font-medium',
            )}
          >
            {notification.title}
          </span>
          {unread && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-primary"
              aria-label="Unread"
            />
          )}
        </div>
        {notification.body && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {notification.body}
          </p>
        )}
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatRelativeTime(notification.createdAt)}
        </p>
      </div>
    </button>
  )
}
