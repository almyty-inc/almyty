import React, { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'

import { Field, FormSection } from '@/components/layout/form-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DnsRecords } from '@/components/ui/dns-records'
import { Input } from '@/components/ui/input'
import { gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

/**
 * A web chat on a domain the owner has. The domain is a field of the
 * channel page, saved with it; once saved, the two DNS records to publish
 * and the check are shown here. The domain is served only after the TXT
 * record proves control.
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

export const customDomainKey = (gatewayId: string) => ['gateway-custom-domain', gatewayId]

const STATUS_LABEL: Record<CustomDomainView['status'], string> = {
  pending_verification: 'Waiting for DNS',
  verifying: 'Checking',
  verified: 'Verified',
  failed: 'Not verified',
  active: 'Live',
}

export interface CustomDomainFieldProps {
  gatewayId: string
  /** The saved domain, or null when there is none. */
  domain: CustomDomainView | null | undefined
  value: string
  onChange: (value: string) => void
  error?: string
}

export function CustomDomainField({ gatewayId, domain, value, onChange, error }: CustomDomainFieldProps) {
  const queryClient = useQueryClient()
  const [checkError, setCheckError] = useState<string | null>(null)
  const key = customDomainKey(gatewayId)

  const verify = useMutation({
    mutationFn: () => gatewaysApi.verifyCustomDomain(gatewayId),
    onSuccess: (next: CustomDomainView) => {
      queryClient.setQueryData(key, next)
      setCheckError(null)
    },
    onError: (err) => {
      setCheckError(getApiErrorMessage(err, 'Please try again.'))
      void queryClient.invalidateQueries({ queryKey: key })
    },
  })

  const changed = value.trim().toLowerCase() !== (domain?.hostname ?? '')
  const id = `custom-domain-${gatewayId}`

  return (
    <FormSection
      title="Custom domain"
      description="Serve this web chat on a domain you own. It goes live only after the DNS check passes."
    >
      <Field
        id={id}
        label="Domain"
        hint={
          domain
            ? 'A new domain has to pass the DNS check again. Clear it to stop serving this one.'
            : 'For example chat.example.com. Optional.'
        }
        error={error}
      >
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="chat.example.com"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      {domain && !changed && (
        <div className="space-y-3" data-testid="custom-domain-status">
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-sm">{domain.hostname}</code>
            <Badge variant={domain.status === 'active' ? 'default' : 'secondary'}>{STATUS_LABEL[domain.status]}</Badge>
          </div>
          {domain.status !== 'active' && (
            <p className="text-sm text-muted-foreground">
              Add these records at your DNS provider, then check. DNS changes can take a few minutes to appear.
            </p>
          )}
          <DnsRecords records={[domain.records.txt, domain.records.cname]} />
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
          {domain.status === 'active' && (
            <p className="text-xs text-muted-foreground">
              Keep the TXT record in place. It is checked daily, and a domain whose record is gone for three checks in a
              row stops being served.
            </p>
          )}
          <div>
            <Button type="button" variant="outline" onClick={() => verify.mutate()} disabled={verify.isPending}>
              {verify.isPending ? 'Checking...' : domain.status === 'active' ? 'Check again' : 'Check DNS'}
            </Button>
          </div>
          {checkError && (
            <p role="alert" className="text-sm text-destructive">
              {checkError}
            </p>
          )}
        </div>
      )}
      {changed && value.trim() && <p className="text-xs text-muted-foreground">Save to get the DNS records for it.</p>}
    </FormSection>
  )
}
