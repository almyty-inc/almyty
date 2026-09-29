/**
 * Access keys for one agent, on the agent's page: the keys a script or
 * another service uses to call this agent, a way to make one (a name, shown
 * once), and Revoke. Gateways have the same thing in their Authentication
 * section. The keys API is for admins, so nobody else sees this.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { Field, InlineFormActions } from '@/components/layout/form-page'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { useOrganizationRole } from '@/hooks/use-organization-role'
import { accessKeysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useCopySensitive } from '@/lib/clipboard'
import { cn, formatDate } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import type { AccessKey } from '@/types'

export const ACCESS_KEYS_QUERY_KEY = ['access-keys'] as const
export const ACCESS_KEY_SCOPES = ['read', 'write', 'execute', 'admin']

/** The keys that belong to this agent, out of the organization's list. */
export function keysForAgent(raw: unknown, agentId: string): AccessKey[] {
  const rows: AccessKey[] = Array.isArray(raw) ? raw : (raw as any)?.keys || (raw as any)?.accessKeys || []
  return rows.filter((k: any) => (k.agent?.id ?? k.agentId) === agentId)
}

export function AgentAccessKeysSection({ agentId, agentName }: { agentId: string; agentName?: string }) {
  const { canManage } = useOrganizationRole()
  if (!canManage) return null
  return <AccessKeysCard agentId={agentId} agentName={agentName} />
}

function AccessKeysCard({ agentId, agentName }: { agentId: string; agentName?: string }) {
  const queryClient = useQueryClient()
  const notify = useNotifications()
  const copySensitive = useCopySensitive()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['read'])
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const guard = useLeaveGuard(creating && name !== '')

  const keysQuery = useQuery({ queryKey: ACCESS_KEYS_QUERY_KEY, queryFn: () => accessKeysApi.getAll() })
  const keys = keysForAgent(keysQuery.data, agentId)

  const create = useMutation({
    mutationFn: (body: { name: string; scopes: string[]; agentId: string }) => accessKeysApi.create(body),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ACCESS_KEYS_QUERY_KEY })
      // POST /access-keys answers the key once, as plainTextKey.
      setGeneratedKey(data?.plainTextKey ?? data?.key ?? null)
      setCreating(false)
      setName('')
    },
    onError: (err) => notify.error('Could not make the key', getApiErrorMessage(err, 'No key was made.')),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => accessKeysApi.revoke(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ACCESS_KEYS_QUERY_KEY })
      notify.success('Key revoked', 'It stops working right away.')
    },
    onError: (err) => notify.error('Could not revoke the key', getApiErrorMessage(err, 'Please try again.')),
  })

  const toggleScope = (s: string) => setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))

  return (
    <Card data-testid="agent-access-keys">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4" aria-hidden />
              Access keys
            </CardTitle>
            <CardDescription>Keys a script or another service uses to call {agentName || 'this agent'}.</CardDescription>
          </div>
          {!creating && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                setGeneratedKey(null)
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
            aria-label="New access key"
            className="space-y-4 rounded-lg border bg-muted/30 p-4"
            onSubmit={(e) => {
              e.preventDefault()
              create.mutate({ name: name.trim() || `${agentName || 'Agent'} key`, scopes, agentId })
            }}
          >
            <Field id="agent-access-key-name" label="Name" hint="So you can tell keys apart later, e.g. Production or CI. The key is shown once.">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Production" autoComplete="off" className="sm:max-w-sm" />
            </Field>
            <Disclosure title="Advanced">
              <div className="space-y-1.5">
                <Label>What the key may do</Label>
                <div className="flex flex-wrap gap-2" role="group" aria-label="What the key may do">
                  {ACCESS_KEY_SCOPES.map((scope) => (
                    <Button key={scope} type="button" size="sm" variant={scopes.includes(scope) ? 'default' : 'outline'} aria-pressed={scopes.includes(scope)} onClick={() => toggleScope(scope)}>
                      {scope}
                    </Button>
                  ))}
                </div>
              </div>
            </Disclosure>
            <InlineFormActions onCancel={() => setCreating(false)} submitLabel="Make key" submitting={create.isPending} />
          </form>
        )}

        {generatedKey && (
          <div data-testid="generated-access-key" className="space-y-3 rounded-lg border border-amber-400/60 bg-amber-50 p-4 dark:bg-amber-950/30">
            <p className="text-sm font-medium">Your new key</p>
            <div className="flex min-w-0 items-stretch gap-2">
              <code className="flex min-w-0 flex-1 items-center break-all select-all rounded-lg border bg-muted px-3 py-2 font-mono text-xs" data-sensitive-text>{generatedKey}</code>
              <Button type="button" variant="outline" size="icon" aria-label="Copy access key" onClick={() => copySensitive(generatedKey, 'Access key')}>
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
          <p className="text-sm text-destructive">{getApiErrorMessage(keysQuery.error, 'The keys could not be loaded.')}</p>
        ) : keys.length === 0 ? (
          !keysQuery.isLoading && <p className="text-sm text-muted-foreground">No keys yet.</p>
        ) : (
          <ul className="space-y-2" aria-label="Access keys">
            {keys.map((key) => (
              <li key={key.id} className={cn('flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2')}>
                <div className="flex min-w-0 items-center gap-3">
                  <code className="rounded bg-background px-2 py-1 font-mono text-xs">{key.keyPrefix}...</code>
                  <span className="truncate text-sm font-medium">{key.name}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{key.lastUsedAt ? `Last used ${formatDate(key.lastUsedAt)}` : 'Never used'}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={revoke.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'Revoke this key?',
                        description: `"${key.name}" stops working right away. Anything still using it is refused.`,
                        confirmLabel: 'Revoke key',
                        destructive: true,
                      })
                      if (ok) revoke.mutate(key.id)
                    }}
                  >
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {confirmDialog}
      {guard.element}
    </Card>
  )
}
