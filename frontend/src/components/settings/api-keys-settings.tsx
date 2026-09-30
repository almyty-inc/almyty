/**
 * Settings > API keys: your own keys, for the CLI, scripts and anything
 * else that calls almyty as you. A table of them (only the first
 * characters of each), a new one made inline and shown once, and revoke
 * behind a one-line confirm. A key acts as you, with everything you may
 * do; keys that open one gateway or one agent are made on that gateway's
 * or agent's page instead.
 *
 * The full key lives in component state until "I've saved it" and never
 * anywhere else: not in a query cache, not in storage.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Copy, KeyRound, Plus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DataTable } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { QueryError } from '@/components/ui/query-error'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { Field, InlineFormActions } from '@/components/layout/form-page'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { authApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useCopySensitive } from '@/lib/clipboard'
import { formatDate, formatDateTime, formatRelativeTime } from '@/lib/utils'
import { useNotifications } from '@/store/app'

export const PERSONAL_API_KEYS_QUERY_KEY = ['auth', 'api-keys'] as const

export interface PersonalApiKey {
  id: string
  name: string
  keyPrefix: string
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

/** GET /auth/api-keys answers `{ apiKeys: [...] }`; take either shape. */
export function personalKeysOf(raw: unknown): PersonalApiKey[] {
  const rows = Array.isArray(raw) ? raw : (raw as any)?.apiKeys
  return Array.isArray(rows) ? rows : []
}

/** The expiry as a person reads it: a date, "Expired", or "Never". */
export function expiryLabel(expiresAt: string | null | undefined, now = Date.now()): string {
  if (!expiresAt) return 'Never'
  return Date.parse(expiresAt) <= now ? 'Expired' : formatDate(expiresAt)
}

/** A date input's `YYYY-MM-DD` as the end of that day, in ISO; blank is no expiry. */
export function expiresAtFromDate(value: string): string | undefined {
  if (!value) return undefined
  const end = new Date(`${value}T23:59:59`)
  return Number.isNaN(end.getTime()) ? undefined : end.toISOString()
}

export function ApiKeysSettings() {
  const queryClient = useQueryClient()
  const notify = useNotifications()
  const copySensitive = useCopySensitive()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const guard = useLeaveGuard((creating && name !== '') || generatedKey !== null)

  const keysQuery = useQuery({ queryKey: PERSONAL_API_KEYS_QUERY_KEY, queryFn: () => authApi.listApiKeys() })
  const keys = useMemo(() => personalKeysOf(keysQuery.data), [keysQuery.data])

  const create = useMutation({
    mutationFn: (body: { name: string; expiresAt?: string }) => authApi.createApiKey(body),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: PERSONAL_API_KEYS_QUERY_KEY })
      // POST /auth/api-keys answers the whole key this once, as apiKey.
      setGeneratedKey(typeof data?.apiKey === 'string' ? data.apiKey : null)
      setCreating(false)
      setName('')
      setExpiresOn('')
    },
    onError: (err) => notify.error('Could not make the key', getApiErrorMessage(err, 'No key was made.')),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => authApi.revokeApiKey(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PERSONAL_API_KEYS_QUERY_KEY })
      notify.success('Key revoked', 'It stops working right away.')
    },
    onError: (err) => notify.error('Could not revoke the key', getApiErrorMessage(err, 'Please try again.')),
  })

  const columns = useMemo<ColumnDef<PersonalApiKey, any>[]>(() => [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      accessorKey: 'keyPrefix',
      header: 'Key',
      cell: ({ row }) => <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{row.original.keyPrefix}...</code>,
    },
    {
      accessorKey: 'createdAt',
      header: 'Created',
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground" title={formatDateTime(row.original.createdAt)}>
          {formatDate(row.original.createdAt)}
        </span>
      ),
    },
    {
      accessorKey: 'lastUsedAt',
      header: 'Last used',
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground" title={row.original.lastUsedAt ? formatDateTime(row.original.lastUsedAt) : undefined}>
          {row.original.lastUsedAt ? formatRelativeTime(row.original.lastUsedAt) : 'Never'}
        </span>
      ),
    },
    {
      accessorKey: 'expiresAt',
      header: 'Expires',
      cell: ({ row }) => {
        const label = expiryLabel(row.original.expiresAt)
        return label === 'Expired'
          ? <Badge variant="destructive">Expired</Badge>
          : <span className="text-sm text-muted-foreground">{label}</span>
      },
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={revoke.isPending}
            aria-label={`Revoke ${row.original.name}`}
            onClick={async (e) => {
              e.stopPropagation()
              const ok = await confirm({
                title: `Revoke ${row.original.name}?`,
                description: 'It stops working right away. Anything still using it is refused.',
                confirmLabel: 'Revoke key',
                destructive: true,
              })
              if (ok) revoke.mutate(row.original.id)
            }}
          >
            Revoke
          </Button>
        </div>
      ),
    },
  ], [confirm, revoke])

  return (
    <div className="space-y-6">
      <Card data-testid="personal-api-keys">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-4 w-4" aria-hidden />
                API keys
              </CardTitle>
              <CardDescription>
                Keys the CLI, a script or another service uses to call almyty as you. A key can do everything you can.
              </CardDescription>
            </div>
            {!creating && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  setGeneratedKey(null)
                  setNameError(null)
                  setCreating(true)
                }}
              >
                <Plus className="h-4 w-4" aria-hidden />
                New key
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {creating && (
            <form
              noValidate
              aria-label="New API key"
              className="space-y-4 rounded-lg border bg-muted/30 p-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (!name.trim()) {
                  setNameError('Give the key a name.')
                  return
                }
                create.mutate({ name: name.trim(), expiresAt: expiresAtFromDate(expiresOn) })
              }}
            >
              <Field id="personal-api-key-name" label="Name" required error={nameError} hint="So you can tell keys apart later, e.g. Laptop or CI. The key is shown once.">
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (nameError) setNameError(null)
                  }}
                  placeholder="e.g. Laptop"
                  autoComplete="off"
                  className="sm:max-w-sm"
                />
              </Field>
              <Field id="personal-api-key-expires" label="Expires" hint="Leave it blank for a key that does not expire.">
                <Input
                  type="date"
                  value={expiresOn}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setExpiresOn(e.target.value)}
                  className="sm:max-w-[12rem]"
                />
              </Field>
              <InlineFormActions onCancel={() => setCreating(false)} submitLabel="Make key" submitting={create.isPending} />
            </form>
          )}

          {generatedKey && (
            <div data-testid="generated-api-key" className="space-y-3 rounded-lg border border-amber-400/60 bg-amber-50 p-4 dark:bg-amber-950/30">
              <p className="text-sm font-medium">Your new key</p>
              <div className="flex min-w-0 items-stretch gap-2">
                <code className="flex min-w-0 flex-1 items-center break-all select-all rounded-lg border bg-muted px-3 py-2 font-mono text-xs" data-sensitive-text>{generatedKey}</code>
                <Button type="button" variant="outline" size="icon" aria-label="Copy API key" onClick={() => copySensitive(generatedKey, 'API key')}>
                  <Copy className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              <p className="text-sm text-amber-800 dark:text-amber-300">Copy it now. You won&apos;t see it again: after this, only its first characters are shown.</p>
              <div className="flex justify-end">
                <Button type="button" size="sm" variant="outline" onClick={() => setGeneratedKey(null)}>
                  I&apos;ve saved it
                </Button>
              </div>
            </div>
          )}

          {keysQuery.isError ? (
            <QueryError error={keysQuery.error as Error} onRetry={() => keysQuery.refetch()} title="Couldn't load your API keys" />
          ) : (
            <DataTable
              columns={columns}
              data={keys}
              loading={keysQuery.isLoading}
              hideSelectionCount
              hideColumnsButton
              hidePaginationWhenSinglePage
              emptyState={
                <EmptyState
                  icon={KeyRound}
                  title="No API keys yet"
                  description="Make one for the CLI or a script. Signing in with the CLI makes one for you too."
                />
              }
            />
          )}
        </CardContent>
      </Card>
      {confirmDialog}
      {guard.element}
    </div>
  )
}
