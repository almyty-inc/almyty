/**
 * SecurityPolicyForm — inline form for editing per-tool security policy on a gateway.
 *
 * Used by GatewayDetailPage's "Security Policy" dialog to capture allowed/blocked
 * domains, methods, max response size, and the require-HTTPS toggle for a specific
 * gateway-tool binding before persisting via updateToolConfig.
 */
import React, { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export interface SecurityPolicyFormProps {
  initialPolicy: any
  onSave: (policy: any) => void
  isSaving: boolean
}

export function SecurityPolicyForm({ initialPolicy, onSave, isSaving }: SecurityPolicyFormProps) {
  const [allowedDomains, setAllowedDomains] = useState(initialPolicy?.allowedDomains?.join(', ') || '')
  const [blockedDomains, setBlockedDomains] = useState(initialPolicy?.blockedDomains?.join(', ') || '')
  const [allowedMethods, setAllowedMethods] = useState(initialPolicy?.allowedHttpMethods?.join(', ') || '')
  const [maxResponseSize, setMaxResponseSize] = useState(initialPolicy?.maxResponseSizeBytes?.toString() || '')
  const [requireHttps, setRequireHttps] = useState(initialPolicy?.requireHttps || false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const policy: any = {}
    if (allowedDomains.trim()) policy.allowedDomains = allowedDomains.split(',').map((d: string) => d.trim()).filter(Boolean)
    if (blockedDomains.trim()) policy.blockedDomains = blockedDomains.split(',').map((d: string) => d.trim()).filter(Boolean)
    if (allowedMethods.trim()) policy.allowedHttpMethods = allowedMethods.split(',').map((m: string) => m.trim().toUpperCase()).filter(Boolean)
    if (maxResponseSize.trim()) policy.maxResponseSizeBytes = parseInt(maxResponseSize, 10)
    policy.requireHttps = requireHttps
    onSave(Object.keys(policy).length > 1 || requireHttps ? policy : null)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="allowed-domains">Allowed Domains</Label>
        <Input
          id="allowed-domains"
          placeholder="api.example.com, cdn.example.com"
          value={allowedDomains}
          onChange={(e) => setAllowedDomains(e.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1">Comma-separated list of allowed target domains. Leave empty to allow all.</p>
      </div>
      <div>
        <Label htmlFor="blocked-domains">Blocked Domains</Label>
        <Input
          id="blocked-domains"
          placeholder="internal.corp, admin.example.com"
          value={blockedDomains}
          onChange={(e) => setBlockedDomains(e.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1">Comma-separated list of blocked domains.</p>
      </div>
      <div>
        <Label htmlFor="allowed-methods">Allowed HTTP Methods</Label>
        <Input
          id="allowed-methods"
          placeholder="GET, POST"
          value={allowedMethods}
          onChange={(e) => setAllowedMethods(e.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1">Comma-separated. Leave empty to allow all methods.</p>
      </div>
      <div>
        <Label htmlFor="max-response-size">Max Response Size (bytes)</Label>
        <Input
          id="max-response-size"
          type="number"
          placeholder="10485760"
          value={maxResponseSize}
          onChange={(e) => setMaxResponseSize(e.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1">Maximum response body size. Default: 10MB.</p>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="require-https">Require HTTPS</Label>
          <p className="text-xs text-muted-foreground">Block HTTP requests, enforce HTTPS only</p>
        </div>
        <Switch id="require-https" checked={requireHttps} onCheckedChange={setRequireHttps} />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Save Policy'}
        </Button>
      </div>
    </form>
  )
}
