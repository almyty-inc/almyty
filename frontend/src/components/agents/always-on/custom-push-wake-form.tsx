/**
 * The form for a service almyty has no preset for (custom-push-wake.ts):
 * how a push proves it came from the service, and the optional steps --
 * subscribe, renew, stop, read what changed -- each as one of the
 * connection's tools with its arguments.
 */
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { CopyField } from '@/components/ui/copy-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Field } from '@/components/layout/form-page'
import { VERIFY_LABELS, pushWakesApi, type PushVerifyMethod } from '@/lib/push-wakes'
import { ARG_PARTS, type ArgPart, type ArgRow, type CustomPushForm, type PairRow, type StepForm } from './custom-push-wake'

function PairRows({
  id,
  label,
  hint,
  rows,
  onChange,
  namePlaceholder,
  valuePlaceholder,
}: {
  id: string
  label: string
  hint?: string
  rows: PairRow[]
  onChange: (rows: PairRow[]) => void
  namePlaceholder: string
  valuePlaceholder: string
}) {
  const set = (i: number, patch: Partial<PairRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="space-y-2" data-testid={id}>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...rows, { name: '', value: '' }])}>
          <Plus className="mr-1 h-3 w-3" />
          Add
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input aria-label={`${label} ${i + 1} name`} placeholder={namePlaceholder} value={row.name} onChange={(e) => set(i, { name: e.target.value })} className="min-w-0 flex-1" />
          <Input aria-label={`${label} ${i + 1} value`} placeholder={valuePlaceholder} value={row.value} onChange={(e) => set(i, { value: e.target.value })} className="min-w-0 flex-1 font-mono text-xs" />
          <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      ))}
    </div>
  )
}

function ArgRows({ id, rows, onChange }: { id: string; rows: ArgRow[]; onChange: (rows: ArgRow[]) => void }) {
  const set = (i: number, patch: Partial<ArgRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="space-y-2" data-testid={`${id}-args`}>
      <div className="flex items-center justify-between">
        <Label>Arguments</Label>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...rows, { part: 'query', name: '', value: '' }])}>
          <Plus className="mr-1 h-3 w-3" />
          Add argument
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Values may use {'{{endpoint.url}}'}, {'{{secret}}'}, {'{{uuid}}'}, {'{{state.cursor}}'}, {'{{page}}'} and {'{{settings.…}}'}. A body name with dots nests.
      </p>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Select value={row.part} onValueChange={(v) => set(i, { part: v as ArgPart })}>
            <SelectTrigger className="w-28" aria-label={`Argument ${i + 1} goes in`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ARG_PARTS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input aria-label={`Argument ${i + 1} name`} placeholder="name" value={row.name} onChange={(e) => set(i, { name: e.target.value })} className="min-w-0 flex-1" />
          <Input aria-label={`Argument ${i + 1} value`} placeholder="value or {{template}}" value={row.value} onChange={(e) => set(i, { value: e.target.value })} className="min-w-0 flex-1 font-mono text-xs" />
          <Button type="button" variant="ghost" size="icon" aria-label={`Remove argument ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      ))}
    </div>
  )
}

/** One optional step: a checkbox, then the tool it calls and its arguments, then whatever else the step needs. */
function Step({
  id,
  title,
  description,
  value,
  onChange,
  tools,
  noConnection,
  children,
}: {
  id: string
  title: string
  description: string
  value: StepForm
  onChange: (patch: Partial<StepForm>) => void
  tools: Array<{ value: string; label: string; hint?: string }>
  noConnection: boolean
  children?: ReactNode
}) {
  return (
    <div className="space-y-3 rounded-md border p-3" data-testid={`custom-step-${id}`}>
      <div className="flex items-start gap-3">
        <Checkbox id={`custom-step-${id}-on`} checked={value.on} onCheckedChange={(v) => onChange({ on: v === true })} />
        <div>
          <Label htmlFor={`custom-step-${id}-on`} className="text-sm font-medium">
            {title}
          </Label>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {value.on && (
        <div className="space-y-3 pl-7">
          {noConnection ? (
            <p className="text-sm text-muted-foreground">Choose the connection above first; its tools are listed here.</p>
          ) : (
            <Field id={`custom-step-${id}-tool`} label="Tool">
              <SearchableSelect
                id={`custom-step-${id}-tool`}
                value={value.operation || null}
                onChange={(operation) => onChange({ operation })}
                options={tools}
                placeholder="Choose a tool of the connection"
                searchPlaceholder="Search tools"
                testId={`custom-step-${id}-tool`}
              />
            </Field>
          )}
          <ArgRows id={`custom-step-${id}`} rows={value.args} onChange={(args) => onChange({ args })} />
          {children}
        </div>
      )}
    </div>
  )
}

export function CustomPushWakeForm({
  agentId,
  apiId,
  addressPrefix,
  form,
  onChange,
  secretField,
}: {
  agentId: string
  apiId: string
  addressPrefix: string
  form: CustomPushForm
  onChange: (form: CustomPushForm) => void
  /** The key or shared value field, shown right under how a push is proven when it needs one. */
  secretField?: ReactNode
}) {
  const operations = useQuery({
    queryKey: ['agent-push-wake-operations', agentId, apiId],
    queryFn: () => pushWakesApi.operations(agentId, apiId),
    enabled: !!apiId,
  })
  const tools = (operations.data ?? []).map((o) => ({ value: o.operationId, label: o.operationId, hint: [o.method, o.path].filter(Boolean).join(' ') || undefined }))
  const set = (patch: Partial<CustomPushForm>) => onChange({ ...form, ...patch })
  const noConnection = !apiId

  return (
    <div className="space-y-4" data-testid="custom-push-wake-form">
      <Field id="push-wake-name" label="Name">
        <Input id="push-wake-name" placeholder="Orders service" value={form.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field id="push-wake-address" label="Where the service sends pushes" hint="The last part is made when you save. A step can pass it on as {{endpoint.url}}.">
        <CopyField id="push-wake-address" value={`${addressPrefix}<made when you save>`} label="Push address" />
      </Field>

      <Field id="push-wake-method" label="How a push proves it came from the service">
        <Select value={form.method} onValueChange={(v) => set({ method: v as PushVerifyMethod })}>
          <SelectTrigger id="push-wake-method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(VERIFY_LABELS) as PushVerifyMethod[]).map((m) => (
              <SelectItem key={m} value={m}>
                {VERIFY_LABELS[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {form.method !== 'oidc_jwt' && (
        <Field id="push-wake-header" label={form.method === 'hmac' ? 'Signature header' : 'Header'}>
          <Input id="push-wake-header" value={form.headerName} onChange={(e) => set({ headerName: e.target.value })} />
        </Field>
      )}
      {form.method === 'shared_token' && (
        <div className="flex items-start gap-3">
          <Checkbox id="push-wake-generated" checked={form.generated} onCheckedChange={(v) => set({ generated: v === true })} />
          <div>
            <Label htmlFor="push-wake-generated" className="text-sm font-normal">
              almyty makes the value
            </Label>
            <p className="text-xs text-muted-foreground">The subscribe step hands it to the service as {'{{secret}}'}. Untick it to paste the value the service gave you.</p>
          </div>
        </div>
      )}
      {form.method === 'hmac' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="push-wake-algorithm" label="Algorithm">
            <Select value={form.algorithm} onValueChange={(v) => set({ algorithm: v as CustomPushForm['algorithm'] })}>
              <SelectTrigger id="push-wake-algorithm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sha256">SHA-256</SelectItem>
                <SelectItem value="sha512">SHA-512</SelectItem>
                <SelectItem value="sha1">SHA-1</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="push-wake-encoding" label="Encoding">
            <Select value={form.encoding} onValueChange={(v) => set({ encoding: v as CustomPushForm['encoding'] })}>
              <SelectTrigger id="push-wake-encoding">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hex">hex</SelectItem>
                <SelectItem value="base64">base64</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="push-wake-prefix" label="Before the signature" hint='For example "sha256=". Empty when there is nothing.'>
            <Input id="push-wake-prefix" value={form.prefix} onChange={(e) => set({ prefix: e.target.value })} />
          </Field>
          <Field id="push-wake-timestamp" label="Time header (optional)" hint="Older pushes are refused when the service sends one.">
            <Input id="push-wake-timestamp" value={form.timestampHeader} onChange={(e) => set({ timestampHeader: e.target.value })} />
          </Field>
          <Field id="push-wake-signed" label="What is signed" hint="{{body}} is the body as sent; {{headers.name}} a header." className="sm:col-span-2">
            <Input id="push-wake-signed" className="font-mono text-xs" value={form.signedContent} onChange={(e) => set({ signedContent: e.target.value })} />
          </Field>
        </div>
      )}
      {form.method === 'oidc_jwt' && (
        <div className="space-y-4">
          <Field id="push-wake-issuers" label="Issuer" hint="Several are separated by commas.">
            <Input id="push-wake-issuers" placeholder="https://accounts.example.com" value={form.issuers} onChange={(e) => set({ issuers: e.target.value })} />
          </Field>
          <Field id="push-wake-jwks" label="Signing keys (JWKS address)">
            <Input id="push-wake-jwks" placeholder="https://accounts.example.com/.well-known/jwks.json" value={form.jwksUrl} onChange={(e) => set({ jwksUrl: e.target.value })} />
          </Field>
          <Field id="push-wake-audience" label="Audience" hint="Empty: the push address.">
            <Input id="push-wake-audience" value={form.audience} onChange={(e) => set({ audience: e.target.value })} />
          </Field>
          <PairRows id="push-wake-claims" label="Required claims" rows={form.claims} onChange={(claims) => set({ claims })} namePlaceholder="email" valuePlaceholder="push@service.example" />
        </div>
      )}

      {secretField}

      <p className="text-sm font-medium">Steps, all optional</p>
      <Step
        id="subscribe"
        title="Subscribe"
        description="A call that asks the service to start sending to the address."
        value={form.subscribe}
        onChange={(patch) => set({ subscribe: { ...form.subscribe, ...patch } })}
        tools={tools}
        noConnection={noConnection}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="custom-subscribe-expires" label="Where the answer says when it ends" hint="Path like expiration.">
            <Input id="custom-subscribe-expires" value={form.subscribe.expiresAtPath} onChange={(e) => set({ subscribe: { ...form.subscribe, expiresAtPath: e.target.value } })} />
          </Field>
          <Field id="custom-subscribe-cursor" label="Where it gives a starting position" hint="Optional.">
            <Input id="custom-subscribe-cursor" value={form.subscribe.cursorPath} onChange={(e) => set({ subscribe: { ...form.subscribe, cursorPath: e.target.value } })} />
          </Field>
        </div>
        <PairRows
          id="custom-subscribe-keep"
          label="Keep from the answer"
          hint="Read later as {{state.subscription.name}}, for example to stop it."
          rows={form.subscribe.keep}
          onChange={(keep) => set({ subscribe: { ...form.subscribe, keep } })}
          namePlaceholder="hookId"
          valuePlaceholder="hook.id"
        />
      </Step>

      <div className="space-y-3 rounded-md border p-3" data-testid="custom-step-renew">
        <div className="flex items-start gap-3">
          <Checkbox id="custom-step-renew-on" checked={form.renew.on} onCheckedChange={(v) => set({ renew: { ...form.renew, on: v === true } })} />
          <div>
            <Label htmlFor="custom-step-renew-on" className="text-sm font-medium">
              Renew
            </Label>
            <p className="text-xs text-muted-foreground">Subscribe again before the service stops sending.</p>
          </div>
        </div>
        {form.renew.on && (
          <div className="grid grid-cols-1 gap-4 pl-7 sm:grid-cols-2">
            <Field id="custom-renew-every" label="Every (minutes)">
              <Input id="custom-renew-every" type="number" min={1} value={form.renew.everyMinutes} onChange={(e) => set({ renew: { ...form.renew, everyMinutes: e.target.value } })} />
            </Field>
            <Field id="custom-renew-before" label="Before it ends (minutes)">
              <Input id="custom-renew-before" type="number" min={1} value={form.renew.beforeExpiryMinutes} onChange={(e) => set({ renew: { ...form.renew, beforeExpiryMinutes: e.target.value } })} />
            </Field>
            <div className="flex items-center gap-3 sm:col-span-2">
              <Checkbox id="custom-renew-stop" checked={form.renew.stopPrevious} onCheckedChange={(v) => set({ renew: { ...form.renew, stopPrevious: v === true } })} />
              <Label htmlFor="custom-renew-stop" className="text-sm font-normal">
                Stop the subscription it replaces
              </Label>
            </div>
          </div>
        )}
      </div>

      <Step
        id="stop"
        title="Stop"
        description="A call that stops the subscription when it is removed."
        value={form.stop}
        onChange={(patch) => set({ stop: { ...form.stop, ...patch } })}
        tools={tools}
        noConnection={noConnection}
      />

      <Step
        id="changes"
        title="Read what changed"
        description="A call that lists the changes since the last position, so the agent is told which items changed."
        value={form.changes}
        onChange={(patch) => set({ changes: { ...form.changes, ...patch } })}
        tools={tools}
        noConnection={noConnection}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="custom-changes-items" label="Where the answer lists them" hint="Path like items[*].">
            <Input id="custom-changes-items" value={form.changes.itemsPath} onChange={(e) => set({ changes: { ...form.changes, itemsPath: e.target.value } })} />
          </Field>
          <Field id="custom-changes-cursor" label="Where it gives the next position">
            <Input id="custom-changes-cursor" value={form.changes.cursorPath} onChange={(e) => set({ changes: { ...form.changes, cursorPath: e.target.value } })} />
          </Field>
          <Field id="custom-changes-page" label="Where it gives the next page" hint="Optional; passed on as {{page}}.">
            <Input id="custom-changes-page" value={form.changes.nextPagePath} onChange={(e) => set({ changes: { ...form.changes, nextPagePath: e.target.value } })} />
          </Field>
          <Field id="custom-changes-reset" label="Statuses that start over" hint="Optional, like 410.">
            <Input id="custom-changes-reset" value={form.changes.resetOnStatus} onChange={(e) => set({ changes: { ...form.changes, resetOnStatus: e.target.value } })} />
          </Field>
        </div>
        <PairRows
          id="custom-changes-item"
          label="What the agent is told about each"
          hint="Field names, and where each is in an item. Ids, names and times; never whole bodies."
          rows={form.changes.item}
          onChange={(item) => set({ changes: { ...form.changes, item } })}
          namePlaceholder="title"
          valuePlaceholder="title"
        />
      </Step>

      <Field id="push-wake-summary" label="The line the wake shows" hint="{{count}}, {{last.field}} and {{name}} are filled in.">
        <Input id="push-wake-summary" className="font-mono text-xs" value={form.summary} onChange={(e) => set({ summary: e.target.value })} />
      </Field>
    </div>
  )
}
