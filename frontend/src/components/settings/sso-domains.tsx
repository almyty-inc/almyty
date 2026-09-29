import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Globe } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DnsRecords } from '@/components/ui/dns-records'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ssoApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

export interface OrgDomainView {
  id: string
  domain: string
  status: 'pending' | 'verified' | 'failed'
  verifiedAt: string | null
  lastCheckedAt: string | null
  lastError: string | null
  record: { type: 'TXT'; name: string; value: string }
}

const STATUS_LABEL: Record<OrgDomainView['status'], string> = {
  pending: 'Waiting for DNS',
  verified: 'Verified',
  failed: 'Not verified',
}

const KEY = ['sso-domains']

/**
 * The email domains single sign-on may create accounts for. Add a domain,
 * publish the TXT record shown, then check. Everything is inline.
 */
export function SsoDomains() {
  const queryClient = useQueryClient()
  const { data: domains = [], isLoading } = useQuery<OrgDomainView[]>({
    queryKey: KEY,
    queryFn: () => ssoApi.listDomains(),
  })
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY })
  const onFail = (err: unknown) => setError(getApiErrorMessage(err, 'Please try again.'))

  const add = useMutation({
    mutationFn: () => ssoApi.addDomain(draft.trim()),
    onSuccess: async () => {
      setDraft('')
      setError(null)
      await refresh()
    },
    onError: onFail,
  })
  const verify = useMutation({
    mutationFn: (id: string) => ssoApi.verifyDomain(id),
    onSuccess: async () => {
      setError(null)
      await refresh()
    },
    onError: async (err) => {
      onFail(err)
      await refresh()
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => ssoApi.removeDomain(id),
    onSuccess: async () => {
      setConfirmRemove(null)
      setError(null)
      await refresh()
    },
    onError: onFail,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-primary" /> Email domains
        </CardTitle>
        <CardDescription>
          Single sign-on creates accounts only for addresses on a domain you have verified, for example
          people@example.com once example.com is verified. People at other addresses need an invitation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : domains.length === 0 ? (
          <p className="text-sm text-muted-foreground">No domains yet.</p>
        ) : (
          <ul className="space-y-4">
            {domains.map((d) => (
              <li key={d.id} className="space-y-3 rounded-lg border p-4" aria-label={d.domain}>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-sm">{d.domain}</code>
                  <Badge variant={d.status === 'verified' ? 'default' : 'secondary'}>{STATUS_LABEL[d.status]}</Badge>
                </div>
                {d.status === 'verified' ? (
                  <p className="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
                    <Check className="h-4 w-4" /> Verified. Keep the TXT record in place.
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Add this record at your DNS provider, then check. DNS changes can take a few minutes to appear.
                    </p>
                    <DnsRecords records={[d.record]} />
                  </>
                )}
                {d.lastError && d.status !== 'verified' && (
                  <p role="status" className="text-sm text-amber-600 dark:text-amber-400">
                    {d.lastError}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {d.status !== 'verified' && (
                    <Button
                      type="button"
                      onClick={() => verify.mutate(d.id)}
                      disabled={verify.isPending && verify.variables === d.id}
                    >
                      {verify.isPending && verify.variables === d.id ? 'Checking...' : 'Check DNS'}
                    </Button>
                  )}
                  {confirmRemove === d.id ? (
                    <span className="flex items-center gap-2 text-sm">
                      Remove {d.domain}?
                      <Button type="button" variant="destructive" size="sm" onClick={() => remove.mutate(d.id)} disabled={remove.isPending}>
                        Remove
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(null)}>
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <Button type="button" variant="ghost" onClick={() => setConfirmRemove(d.id)}>
                      Remove domain
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            add.mutate()
          }}
        >
          <Label htmlFor="sso-domain-new">Add a domain</Label>
          <div className="flex gap-2">
            <Input
              id="sso-domain-new"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="example.com"
            />
            <Button type="submit" variant="outline" disabled={add.isPending || !draft.trim()}>
              {add.isPending ? 'Adding...' : 'Add domain'}
            </Button>
          </div>
        </form>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
