import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useCopy } from '@/lib/clipboard'

/**
 * A hosted chat app on a domain the tenant owns. Set the hostname, publish
 * the two records shown, then check: the domain is served only after the
 * TXT record proves control. Everything is inline on the gateway page.
 */

export interface CustomDomainView {
  hostname: string
  status: 'pending_verification' | 'verifying' | 'verified' | 'failed' | 'active'
  verifiedAt: string | null
  lastCheckedAt: string | null
  lastError: string | null
  records: {
    txt: { type: 'TXT'; name: string; value: string }
    cname: { type: 'CNAME'; name: string; value: string }
  }
}

const STATUS_LABEL: Record<CustomDomainView['status'], string> = {
  pending_verification: 'Waiting for DNS',
  verifying: 'Checking',
  verified: 'Verified',
  failed: 'Not verified',
  active: 'Live',
}

export function CustomDomainCard({ gatewayId }: { gatewayId: string }) {
  const queryClient = useQueryClient()
  const copy = useCopy()
  const key = ['gateway-custom-domain', gatewayId]
  const { data: domain, isLoading } = useQuery<CustomDomainView | null>({
    queryKey: key,
    queryFn: () => gatewaysApi.getCustomDomain(gatewayId),
  })
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onDone = (next: CustomDomainView | null) => {
    queryClient.setQueryData(key, next)
    setError(null)
  }
  const onFail = (err: unknown) => setError(getApiErrorMessage(err, 'Please try again.'))

  const set = useMutation({
    mutationFn: () => gatewaysApi.setCustomDomain(gatewayId, draft.trim()),
    onSuccess: (next: CustomDomainView) => {
      onDone(next)
      setEditing(false)
      setDraft('')
    },
    onError: onFail,
  })
  const verify = useMutation({
    mutationFn: () => gatewaysApi.verifyCustomDomain(gatewayId),
    onSuccess: onDone,
    onError: (err) => {
      onFail(err)
      void queryClient.invalidateQueries({ queryKey: key })
    },
  })
  const remove = useMutation({
    mutationFn: () => gatewaysApi.removeCustomDomain(gatewayId),
    onSuccess: () => {
      onDone(null)
      setConfirmRemove(false)
    },
    onError: onFail,
  })

  const showForm = !domain || editing

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Custom domain</CardTitle>
        <CardDescription>
          Serve this chat app on a domain you own, for example chat.example.com. It goes live only after the DNS
          check below passes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            {domain && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-sm">{domain.hostname}</code>
                  <Badge variant={domain.status === 'active' ? 'default' : 'secondary'}>{STATUS_LABEL[domain.status]}</Badge>
                </div>
                {domain.status !== 'active' && (
                  <p className="text-sm text-muted-foreground">
                    Add these records at your DNS provider, then check. DNS changes can take a few minutes to appear.
                  </p>
                )}
                <div className="space-y-2" aria-label="DNS records">
                  {[domain.records.txt, domain.records.cname].map((record) => (
                    <div key={record.type} className="rounded-md border p-3 text-sm">
                      <div className="mb-1 text-xs font-medium text-muted-foreground">{record.type}</div>
                      <div className="grid gap-1 sm:grid-cols-[4rem_minmax(0,1fr)_auto] sm:items-center">
                        <span className="text-muted-foreground">Name</span>
                        <code className="break-all font-mono">{record.name}</code>
                        <Button type="button" variant="ghost" size="sm" aria-label={`Copy ${record.type} name`} onClick={() => copy(record.name, `${record.type} name`)}>
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <span className="text-muted-foreground">Value</span>
                        <code className="break-all font-mono">{record.value}</code>
                        <Button type="button" variant="ghost" size="sm" aria-label={`Copy ${record.type} value`} onClick={() => copy(record.value, `${record.type} value`)}>
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                {domain.lastError && domain.status !== 'active' && (
                  <p role="status" className="text-sm text-amber-600 dark:text-amber-400">
                    {domain.lastError}
                  </p>
                )}
                {domain.status === 'active' && (
                  <p className="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
                    <Check className="h-4 w-4" /> Verified. Visitors can reach this chat at https://{domain.hostname}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => verify.mutate()} disabled={verify.isPending}>
                    {verify.isPending ? 'Checking...' : domain.status === 'active' ? 'Check again' : 'Check DNS'}
                  </Button>
                  {!editing && (
                    <Button type="button" variant="outline" onClick={() => { setEditing(true); setDraft(domain.hostname) }}>
                      Change domain
                    </Button>
                  )}
                  {confirmRemove ? (
                    <span className="flex items-center gap-2 text-sm">
                      Stop serving {domain.hostname}?
                      <Button type="button" variant="destructive" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                        Remove
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <Button type="button" variant="ghost" onClick={() => setConfirmRemove(true)}>
                      Remove domain
                    </Button>
                  )}
                </div>
              </div>
            )}

            {showForm && (
              <form
                className="space-y-1.5"
                onSubmit={(e) => {
                  e.preventDefault()
                  set.mutate()
                }}
              >
                <Label htmlFor={`custom-domain-${gatewayId}`}>{domain ? 'New domain' : 'Domain'}</Label>
                {domain && (
                  <p className="text-xs text-muted-foreground">
                    A new domain has to be verified again; the current one stops being served when you save.
                  </p>
                )}
                <div className="flex gap-2">
                  <Input
                    id={`custom-domain-${gatewayId}`}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="chat.example.com"
                  />
                  <Button type="submit" disabled={set.isPending || !draft.trim()}>
                    {set.isPending ? 'Saving...' : 'Save domain'}
                  </Button>
                  {editing && (
                    <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            )}

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
