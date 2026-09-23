/**
 * /credentials/access-keys/new -- generate an access key for a gateway or
 * an agent, then show it exactly once.
 *
 * The key is only ever in this page's memory: after "Done" (or any other
 * way off the page) it is gone, and the list shows its prefix only.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, KeyRound } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { accessKeysApi, agentsApi, gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/store/app'

export const SCOPE_OPTIONS = ['read', 'write', 'execute', 'admin']
const LIST_PATH = '/credentials/access-keys'

interface AccessKeyForm {
  name: string
  resourceType: 'gateway' | 'agent'
  resourceId: string
  scopes: string[]
}

const EMPTY: AccessKeyForm = { name: '', resourceType: 'gateway', resourceId: '', scopes: ['read'] }

export function GenerateAccessKeyForm() {
  const qc = useQueryClient()
  const notify = useNotifications()
  const navigate = useNavigate()
  const [form, setForm] = useState<AccessKeyForm>(EMPTY)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)

  const dirty = !generatedKey && (form.name !== '' || form.resourceId !== '')
  const guard = useLeaveGuard(dirty)

  const { data: gatewaysRaw } = useQuery({ queryKey: ['gateways'], queryFn: () => gatewaysApi.getAll() })
  const gateways: any[] = Array.isArray(gatewaysRaw) ? gatewaysRaw : (gatewaysRaw as any)?.gateways || []
  const { data: agentsRaw } = useQuery({ queryKey: ['agents'], queryFn: () => agentsApi.getAll() })
  const agents: any[] = Array.isArray(agentsRaw) ? agentsRaw : (agentsRaw as any)?.agents || []
  const resources = form.resourceType === 'gateway' ? gateways : agents

  const createMut = useMutation({
    mutationFn: (data: any) => accessKeysApi.create(data),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ['access-keys'] })
      setGeneratedKey(data?.key || data?.accessKey || 'Key generated')
      notify.success('Access key created', 'Copy it now -- it is not shown again.')
    },
    onError: (err) => notify.error('Could not generate the key', getApiErrorMessage(err, 'No key was created.')),
  })

  const toggleScope = (s: string) =>
    setForm((f) => ({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s] }))

  const submit = () => {
    const next: Record<string, string> = {}
    if (!form.name.trim()) next.name = 'Give the key a name'
    if (!form.resourceId) next.resourceId = `Choose the ${form.resourceType} this key is for`
    setErrors(next)
    if (Object.keys(next).length > 0) return
    const payload: Record<string, unknown> = { name: form.name, scopes: form.scopes }
    if (form.resourceType === 'gateway') payload.gatewayId = form.resourceId
    else payload.agentId = form.resourceId
    createMut.mutate(payload)
  }

  if (generatedKey) {
    return (
      <FormPage
        title="Key generated"
        description="Copy this key now. It will not be shown again."
        back={{ to: LIST_PATH, label: 'Access keys' }}
        width="narrow"
      >
        <FormSection>
          <Field id="generated-access-key" label={form.name || 'Access key'}>
            <CopyField value={generatedKey} label="Access key" />
          </Field>
          <p className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400" role="note">
            <KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
            You won't see this key again. Store it somewhere safe before you leave this page.
          </p>
          <div className="flex justify-end">
            <Button type="button" onClick={() => navigate(LIST_PATH)}>Done</Button>
          </div>
        </FormSection>
      </FormPage>
    )
  }

  return (
    <FormPage
      title="Generate access key"
      description="An access key lets a script or another service call one of your gateways or agents."
      back={{ to: LIST_PATH, label: 'Access keys' }}
      guard={guard}
      onSubmit={submit}
      submitLabel="Generate key"
      submitting={createMut.isPending}
      width="narrow"
    >
      <FormSection>
        <Field id="access-key-name" label="Name" required error={errors.name}>
          <Input
            placeholder="e.g. Production key"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="access-key-resource-type" label="Resource type">
            <Select
              value={form.resourceType}
              onValueChange={(v: 'gateway' | 'agent') => setForm((f) => ({ ...f, resourceType: v, resourceId: '' }))}
            >
              <SelectTrigger id="access-key-resource-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="gateway">Gateway</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field
            id="access-key-resource"
            label={form.resourceType === 'gateway' ? 'Gateway' : 'Agent'}
            required
            error={errors.resourceId}
            hint={resources.length === 0 ? (form.resourceType === 'gateway' ? 'No gateways yet. Create one first.' : 'No agents yet. Create one first.') : undefined}
          >
            <Select value={form.resourceId} onValueChange={(v) => setForm((f) => ({ ...f, resourceId: v }))}>
              <SelectTrigger id="access-key-resource"><SelectValue placeholder="Select..." /></SelectTrigger>
              <SelectContent>
                {resources.length === 0 && (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    {form.resourceType === 'gateway' ? 'No gateways yet.' : 'No agents yet.'}
                  </div>
                )}
                {resources.map((r: any) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field id="access-key-scopes" label="Scopes" hint="What the key may do on that resource.">
          <div className="mt-1 flex flex-wrap gap-2" role="group" aria-label="Scopes">
            {SCOPE_OPTIONS.map((scope) => (
              <button
                key={scope}
                type="button"
                aria-pressed={form.scopes.includes(scope)}
                onClick={() => toggleScope(scope)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  form.scopes.includes(scope)
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-muted-foreground hover:border-primary/50',
                )}
              >
                {form.scopes.includes(scope) && <CheckCircle2 className="mr-1 inline h-3 w-3" />}
                {scope}
              </button>
            ))}
          </div>
        </Field>
      </FormSection>
    </FormPage>
  )
}
