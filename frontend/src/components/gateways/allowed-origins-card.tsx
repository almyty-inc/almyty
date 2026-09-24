import React, { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

/**
 * The sites allowed to call a public chat surface from the browser.
 *
 * Mirrors backend/src/modules/gateways/channels/surface-origins.ts: exact
 * origins only (scheme, host, port), no wildcards, stored in the form the
 * browser sends in `Origin`. The server validates again on save; this copy
 * only makes the mistake visible before the round trip.
 */
export const MAX_ALLOWED_ORIGINS = 50

export function parseOrigin(input: string): { origin: string } | { error: string } {
  const value = input.trim()
  if (!value) return { error: 'Enter an origin, for example https://www.example.com.' }
  if (value.includes('*')) {
    return { error: 'Wildcards are not supported. List each site, for example https://www.example.com.' }
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { error: 'Use the form https://www.example.com.' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'Only http and https sites can embed the chat.' }
  }
  if (url.username || url.password) return { error: 'An origin cannot contain a user name or password.' }
  if (url.pathname !== '/' || url.search || url.hash || /[?#]/.test(value) || /^[a-z]+:\/\/[^/]+\/./i.test(value)) {
    return { error: `Use the origin only, without a path: ${url.origin}` }
  }
  return { origin: url.origin }
}

export function allowedOriginsFrom(configuration: Record<string, any> | null | undefined): string[] {
  const raw = configuration?.allowedOrigins
  return Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : []
}

export interface AllowedOriginsCardProps {
  gateway: { id: string; type: string; configuration?: Record<string, any> | null }
}

export function AllowedOriginsCard({ gateway }: AllowedOriginsCardProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const saved = allowedOriginsFrom(gateway.configuration)
  const [origins, setOrigins] = useState<string[]>(saved)
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)

  const dirty = draft.trim() !== '' || JSON.stringify(origins) !== JSON.stringify(saved)

  const save = useMutation({
    mutationFn: () =>
      // Merge, never replace: the configuration also carries the widget or
      // hosted-chat settings and channel credentials.
      gatewaysApi.update(gateway.id, {
        configuration: { ...(gateway.configuration ?? {}), allowedOrigins: origins },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway', gateway.id] })
      success('Allowed sites saved', origins.length ? 'Listed sites can now use this chat.' : 'Only this chat’s own address can use it now.')
    },
    onError: (err: any) => errorNotif('Could not save allowed sites', getApiErrorMessage(err, 'Please try again.')),
  })

  const guard = useLeaveGuard(dirty && !save.isPending)

  const add = () => {
    const parsed = parseOrigin(draft)
    if ('error' in parsed) {
      setDraftError(parsed.error)
      return
    }
    if (origins.length >= MAX_ALLOWED_ORIGINS) {
      setDraftError(`At most ${MAX_ALLOWED_ORIGINS} sites.`)
      return
    }
    if (!origins.includes(parsed.origin)) setOrigins([...origins, parsed.origin])
    setDraft('')
    setDraftError(null)
  }

  const what = gateway.type === 'hosted_chat' ? 'this chat app' : 'this widget'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Allowed sites</CardTitle>
        <CardDescription>
          Websites whose pages may call {what} from the browser. Enter each site exactly, for example
          https://www.example.com. Sites not listed get no answer; with an empty list only {what}&rsquo;s
          own address can use it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {origins.length > 0 ? (
          <ul className="space-y-1.5" aria-label="Allowed sites">
            {origins.map((origin) => (
              <li key={origin} className="flex items-center justify-between rounded-md border px-3 py-1.5">
                <code className="truncate font-mono text-sm">{origin}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${origin}`}
                  onClick={() => setOrigins(origins.filter((o) => o !== origin))}
                >
                  <X className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No sites listed. Same-origin only.</p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor={`allowed-origin-${gateway.id}`}>Add a site</Label>
          <div className="flex gap-2">
            <Input
              id={`allowed-origin-${gateway.id}`}
              value={draft}
              placeholder="https://www.example.com"
              aria-invalid={!!draftError}
              onChange={(e) => {
                setDraft(e.target.value)
                setDraftError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add()
                }
              }}
            />
            <Button type="button" variant="outline" onClick={add}>
              <Plus className="mr-1 h-4 w-4" />
              Add
            </Button>
          </div>
          {draftError && (
            <p role="alert" className="text-sm text-destructive">
              {draftError}
            </p>
          )}
        </div>

        <div className="flex justify-end">
          <Button type="button" onClick={() => save.mutate()} disabled={save.isPending || JSON.stringify(origins) === JSON.stringify(saved)}>
            {save.isPending ? 'Saving...' : 'Save allowed sites'}
          </Button>
        </div>
      </CardContent>
      {guard.element}
    </Card>
  )
}
