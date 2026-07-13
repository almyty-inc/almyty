import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { notificationsApi } from '@/lib/api'
import { getNotificationPresentation } from '@/components/notifications/presentation'
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationChannelPreference,
  type NotificationPreferenceMatrix,
  type NotificationPreferencesResult,
} from '@/types/notification'

const PREFERENCES_QUERY_KEY = ['notification-preferences'] as const

/**
 * A channel is locked when the backend's defaults (or the merged
 * matrix entry) say so — e.g. security notices that are always
 * emailed. Render-only: we never hardcode which types are locked.
 * The defaults are checked even when a matrix override exists —
 * a lock is a policy, not a user preference.
 */
function isEmailLocked(
  entry?: NotificationChannelPreference,
  fallback?: NotificationChannelPreference,
): boolean {
  return !!(
    entry?.locked ||
    entry?.emailLocked ||
    fallback?.locked ||
    fallback?.emailLocked
  )
}

function effectivePreference(
  matrix: NotificationPreferenceMatrix,
  defaults: NotificationPreferenceMatrix,
  type: string,
): NotificationChannelPreference {
  return matrix[type] ?? defaults[type] ?? { inApp: true, email: true }
}

export function NotificationPreferences() {
  const queryClient = useQueryClient()

  const { data, isLoading, isError, refetch } = useQuery<NotificationPreferencesResult>({
    queryKey: PREFERENCES_QUERY_KEY,
    queryFn: () => notificationsApi.getPreferences(),
  })

  const matrix = data?.matrix ?? {}
  const defaults = data?.defaults ?? {}

  // Known types first (stable, curated order), then anything new the
  // backend started sending that this build does not know about yet.
  const knownTypes = NOTIFICATION_EVENT_TYPES.filter(
    (type) => type in matrix || type in defaults,
  )
  const extraTypes = Object.keys({ ...defaults, ...matrix }).filter(
    (type) => !(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(type),
  )
  const rowTypes = [...knownTypes, ...extraTypes]

  const updateMutation = useMutation({
    mutationFn: (nextMatrix: NotificationPreferenceMatrix) =>
      notificationsApi.updatePreferences(nextMatrix),
    onMutate: async (nextMatrix) => {
      await queryClient.cancelQueries({ queryKey: PREFERENCES_QUERY_KEY })
      const previous = queryClient.getQueryData<NotificationPreferencesResult>(
        PREFERENCES_QUERY_KEY,
      )
      if (previous) {
        queryClient.setQueryData<NotificationPreferencesResult>(PREFERENCES_QUERY_KEY, {
          ...previous,
          matrix: nextMatrix,
        })
      }
      return { previous }
    },
    onError: (_error, _next, context) => {
      if (context?.previous) {
        queryClient.setQueryData(PREFERENCES_QUERY_KEY, context.previous)
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY }),
  })

  const setChannel = (type: string, channel: 'inApp' | 'email', value: boolean) => {
    const current = effectivePreference(matrix, defaults, type)
    updateMutation.mutate({
      ...matrix,
      [type]: { inApp: current.inApp, email: current.email, [channel]: value },
    })
  }

  const resetToDefault = (type: string) => {
    const fallback = defaults[type]
    if (!fallback) return
    updateMutation.mutate({
      ...matrix,
      [type]: { inApp: fallback.inApp, email: fallback.email },
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification Preferences</CardTitle>
        <CardDescription>
          Choose how you want to be notified for each kind of event
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2" aria-label="Loading preferences">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : isError ? (
          <div className="py-8 text-center">
            <p className="mb-3 text-sm text-muted-foreground">
              Failed to load notification preferences.
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : rowTypes.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No configurable notifications available.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Notification</TableHead>
                <TableHead className="w-20 text-center">In-app</TableHead>
                <TableHead className="w-20 text-center">Email</TableHead>
                <TableHead className="w-12" aria-label="Actions" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rowTypes.map((type) => {
                const pres = getNotificationPresentation(type)
                const Icon = pres.icon
                const current = effectivePreference(matrix, defaults, type)
                const fallback = defaults[type]
                const emailLocked = isEmailLocked(matrix[type], fallback)
                const differsFromDefault =
                  !!fallback &&
                  (current.inApp !== fallback.inApp ||
                    (!emailLocked && current.email !== fallback.email))

                return (
                  <TableRow key={type}>
                    <TableCell>
                      <div className="flex items-start gap-3">
                        <Icon
                          className={cn('mt-0.5 h-4 w-4 shrink-0', pres.accentClass)}
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">{pres.label}</p>
                          {pres.description && (
                            <p className="text-xs text-muted-foreground">{pres.description}</p>
                          )}
                          {emailLocked && (
                            <p className="mt-0.5 text-xs text-cyan-600 dark:text-cyan-400">
                              Security notices are always emailed
                            </p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <Checkbox
                        aria-label={`${pres.label} in-app notifications`}
                        checked={current.inApp}
                        onCheckedChange={(checked) =>
                          setChannel(type, 'inApp', checked === true)
                        }
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Checkbox
                        aria-label={`${pres.label} email notifications`}
                        checked={emailLocked ? true : current.email}
                        disabled={emailLocked}
                        onCheckedChange={(checked) =>
                          setChannel(type, 'email', checked === true)
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      {differsFromDefault && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          aria-label={`Reset ${pres.label} to default`}
                          title="Reset to default"
                          onClick={() => resetToDefault(type)}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
