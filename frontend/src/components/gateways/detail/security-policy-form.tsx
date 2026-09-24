/**
 * SecurityPolicyForm -- one tool's security policy on a gateway, edited
 * in place under the tool's row in the gateway's tool list.
 *
 * Captures allowed/blocked domains, methods, max response size and the
 * require-HTTPS toggle for one gateway-tool binding, and hands the policy
 * to the page, which persists it via updateToolConfig.
 */
import React, { useState } from 'react'

import { Field, InlineFormActions } from '@/components/layout/form-page'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

export interface SecurityPolicyFormProps {
  /** Distinguishes the ids when several rows are open. */
  idPrefix?: string
  initialPolicy: any
  onSave: (policy: any) => void
  onCancel: () => void
  isSaving: boolean
}

export function SecurityPolicyForm({
  idPrefix = 'policy',
  initialPolicy,
  onSave,
  onCancel,
  isSaving,
}: SecurityPolicyFormProps) {
  const initial = {
    allowedDomains: initialPolicy?.allowedDomains?.join(', ') || '',
    blockedDomains: initialPolicy?.blockedDomains?.join(', ') || '',
    allowedMethods: initialPolicy?.allowedHttpMethods?.join(', ') || '',
    maxResponseSize: initialPolicy?.maxResponseSizeBytes?.toString() || '',
    requireHttps: !!initialPolicy?.requireHttps,
  }
  const [allowedDomains, setAllowedDomains] = useState(initial.allowedDomains)
  const [blockedDomains, setBlockedDomains] = useState(initial.blockedDomains)
  const [allowedMethods, setAllowedMethods] = useState(initial.allowedMethods)
  const [maxResponseSize, setMaxResponseSize] = useState(initial.maxResponseSize)
  const [requireHttps, setRequireHttps] = useState(initial.requireHttps)
  const [sizeError, setSizeError] = useState<string | undefined>()

  // An edited policy asks before a navigation throws it away. Not while it
  // is being saved: the row closes itself once the save lands, and Cancel
  // closes it too, so neither asks.
  const edited =
    allowedDomains !== initial.allowedDomains ||
    blockedDomains !== initial.blockedDomains ||
    allowedMethods !== initial.allowedMethods ||
    maxResponseSize !== initial.maxResponseSize ||
    requireHttps !== initial.requireHttps
  const guard = useLeaveGuard(edited && !isSaving)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const size = maxResponseSize.trim()
    if (size && !(Number.isInteger(Number(size)) && Number(size) > 0)) {
      setSizeError('Enter a whole number of bytes, or leave it empty.')
      return
    }
    setSizeError(undefined)
    const policy: any = {}
    if (allowedDomains.trim()) policy.allowedDomains = allowedDomains.split(',').map((d: string) => d.trim()).filter(Boolean)
    if (blockedDomains.trim()) policy.blockedDomains = blockedDomains.split(',').map((d: string) => d.trim()).filter(Boolean)
    if (allowedMethods.trim()) policy.allowedHttpMethods = allowedMethods.split(',').map((m: string) => m.trim().toUpperCase()).filter(Boolean)
    if (size) policy.maxResponseSizeBytes = parseInt(size, 10)
    policy.requireHttps = requireHttps
    onSave(Object.keys(policy).length > 1 || requireHttps ? policy : null)
  }

  const id = (name: string) => `${idPrefix}-${name}`

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-4" aria-label="Security policy">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id={id('allowed-domains')} label="Allowed domains" hint="Comma-separated. Leave empty to allow all.">
          <Input
            placeholder="api.example.com, cdn.example.com"
            value={allowedDomains}
            onChange={(e) => setAllowedDomains(e.target.value)}
          />
        </Field>
        <Field id={id('blocked-domains')} label="Blocked domains" hint="Comma-separated.">
          <Input
            placeholder="internal.corp, admin.example.com"
            value={blockedDomains}
            onChange={(e) => setBlockedDomains(e.target.value)}
          />
        </Field>
        <Field id={id('allowed-methods')} label="Allowed HTTP methods" hint="Comma-separated. Leave empty to allow all methods.">
          <Input placeholder="GET, POST" value={allowedMethods} onChange={(e) => setAllowedMethods(e.target.value)} />
        </Field>
        <Field
          id={id('max-response-size')}
          label="Max response size (bytes)"
          hint="Maximum response body size. Default: 10MB."
          error={sizeError}
        >
          <Input
            type="number"
            placeholder="10485760"
            value={maxResponseSize}
            onChange={(e) => setMaxResponseSize(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor={id('require-https')}>Require HTTPS</Label>
          <p className="text-xs text-muted-foreground">Block HTTP requests, enforce HTTPS only</p>
        </div>
        <Switch id={id('require-https')} checked={requireHttps} onCheckedChange={setRequireHttps} />
      </div>
      <InlineFormActions onCancel={onCancel} submitLabel="Save policy" submitting={isSaving} />
      {guard.element}
    </form>
  )
}
