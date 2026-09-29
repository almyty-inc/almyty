/**
 * The API's key, on its page: how tools send it and where it comes from,
 * with "Replace key" (or "Add a key") and "Remove". One card for what used
 * to be two ("Authentication" and "Upstream credentials"): both were the
 * same secret.
 */
import { forwardRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryError } from '@/components/ui/query-error'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import type { ApiKeyView } from '@/types/api-connect'

import { ApiKeyForm, keySentAs } from '../api-key-form'

export const apiKeyQueryKey = (apiId: string) => ['api-key', apiId] as const

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString()
}

/** Where the key comes from, in words. */
export function keySource(view: ApiKeyView): string {
  if (view.source === 'connection' && view.connection) {
    return `From ${view.connection.name}${view.connection.accountLabel ? ` (${view.connection.accountLabel})` : ''}`
  }
  if (view.source === 'oauth') return 'From a sign-in'
  if (view.source === 'key') return 'A pasted key, stored encrypted. It is not shown again.'
  return view.type === 'none' ? 'This API is called without a key.' : 'No key yet. Calls go out without one.'
}

export const ApiKeyCard = forwardRef<HTMLDivElement, { apiId: string; apiName: string; editing?: boolean; onEditingChange?: (editing: boolean) => void }>(
  function ApiKeyCard({ apiId, apiName, editing: editingProp, onEditingChange }, ref) {
    const queryClient = useQueryClient()
    const { success, error } = useNotifications()
    const { confirm, dialog } = useConfirm()
    const [editingState, setEditingState] = useState(false)
    const editing = editingProp ?? editingState
    const setEditing = onEditingChange ?? setEditingState

    const keyQuery = useQuery({ queryKey: apiKeyQueryKey(apiId), queryFn: () => apisApi.getKey(apiId), enabled: !!apiId })

    const remove = useMutation({
      mutationFn: () => apisApi.removeKey(apiId),
      onSuccess: (next) => {
        queryClient.setQueryData(apiKeyQueryKey(apiId), next)
        queryClient.invalidateQueries({ queryKey: ['api', apiId] })
        success('Key removed', `${apiName} is now called without a key.`)
      },
      onError: (err) => error('Could not remove the key', getApiErrorMessage(err, 'Please try again.')),
    })

    const view = keyQuery.data
    const hasKey = !!view?.source

    return (
      <Card ref={ref} id="api-key">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <KeyRound className="h-4 w-4" aria-hidden />
            Key
          </CardTitle>
          <CardDescription>What tools send when they call {apiName}.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {keyQuery.isError ? (
            <QueryError error={keyQuery.error} onRetry={() => keyQuery.refetch()} title="Couldn't load the key" />
          ) : !view ? (
            <Skeleton className="h-10 w-full" />
          ) : editing ? (
            <ApiKeyForm
              apiId={apiId}
              apiName={apiName}
              view={view}
              returnTo={`/apis/${apiId}`}
              onCancel={() => setEditing(false)}
              onSaved={(next) => {
                queryClient.setQueryData(apiKeyQueryKey(apiId), next)
                queryClient.invalidateQueries({ queryKey: ['api', apiId] })
                setEditing(false)
                success('Key saved', `Tools calling ${apiName} send it from now on.`)
              }}
            />
          ) : (
            <div className="space-y-1 text-sm" data-testid="api-key-summary">
              {view.type !== 'none' && <p>{keySentAs(view)}</p>}
              <p className="text-muted-foreground">
                {keySource(view)}
                {view.credential?.lastUsedAt && ` Last used ${formatDate(view.credential.lastUsedAt)}.`}
              </p>
              <p className="flex flex-wrap gap-x-3 pt-1">
                <button type="button" className="text-primary hover:underline" onClick={() => setEditing(true)}>
                  {hasKey ? 'Replace key' : 'Add a key'}
                </button>
                {hasKey && (
                  <button
                    type="button"
                    className="text-destructive hover:underline disabled:opacity-50"
                    disabled={remove.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'Remove this key?',
                        description: `Tools calling ${apiName} stop sending it. How it is sent is kept, so adding one back is one paste.`,
                        confirmLabel: 'Remove key',
                        destructive: true,
                      })
                      if (ok) remove.mutate()
                    }}
                  >
                    Remove
                  </button>
                )}
              </p>
            </div>
          )}
        </CardContent>
        {dialog}
      </Card>
    )
  },
)
