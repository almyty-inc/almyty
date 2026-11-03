/**
 * "When a service tells it something changed" on the always-on page: the
 * agent's push wakes, each with its health (the way connections show it),
 * its address and setup steps, and a form to add one inline -- from a
 * preset the server sends (Google Calendar, Gmail) or described by hand
 * for any service that pushes. Saved on its own, not with the page.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SecretInput } from '@/components/ui/secret-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { ConnectionHealthBadge } from '@/components/connections/health-badge'
import { Field } from '@/components/layout/form-page'
import { getApiErrorMessage } from '@/lib/api-error'
import { formatWakeTime } from '@/lib/always-on'
import {
  describePushWake,
  pushWakeHealth,
  pushWakesApi,
  type PushSetupStep,
  type PushWakeInput,
  type PushWakePreset,
  type PushWakeView,
} from '@/lib/push-wakes'
import { useNotifications } from '@/store/app'
import { pluralized } from '@/lib/utils'
import { CustomPushWakeForm } from './custom-push-wake-form'
import { customCallsTools, customNeedsSecret, emptyCustomForm, specFromCustomForm, type CustomPushForm } from './custom-push-wake'

const CUSTOM = '__custom__'
const NO_API = '__none__'

function SetupSteps({ steps }: { steps: PushSetupStep[] }) {
  if (!steps.length) return null
  return (
    <ol className="list-decimal space-y-3 pl-5 text-sm" data-testid="push-wake-setup">
      {steps.map((s, i) => (
        <li key={i} className="space-y-1">
          <p>{s.text}</p>
          {s.consolePath && <p className="text-xs text-muted-foreground">In the console: {s.consolePath}</p>}
          {s.command && <CopyField value={s.command} label="Command" />}
        </li>
      ))}
    </ol>
  )
}

/** The preset's setup steps before it is saved: the address is not known yet, so commands say so. */
function previewSteps(preset: PushWakePreset, settings: Record<string, string>): PushSetupStep[] {
  const fill = (text: string) =>
    text
      .replace(/\{\{\s*endpoint\.url\s*\}\}/g, '<the address shown after you save>')
      .replace(/\{\{\s*settings\.([A-Za-z0-9_]+)\s*\}\}/g, (_m, key: string) => settings[key] || `<${key}>`)
  return preset.setup.map((s) => ({ ...s, ...(s.command ? { command: fill(s.command) } : {}) }))
}

function PushWakeRow({ agentId, view }: { agentId: string; view: PushWakeView }) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const { confirm, dialog } = useConfirm()
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['agent-push-wakes', agentId] })
  const resubscribe = useMutation({
    mutationFn: () => pushWakesApi.resubscribe(agentId, view.id),
    onSuccess: async () => {
      success('Subscribed again', view.name)
      await refresh()
    },
    onError: (err: unknown) => errorNotif('Could not subscribe', getApiErrorMessage(err, 'Please try again.')),
  })
  const remove = useMutation({
    mutationFn: () => pushWakesApi.remove(agentId, view.id),
    onSuccess: async (out) => {
      success('Removed', out?.error ? `Stopping it at the service failed: ${out.error}` : view.name)
      await refresh()
      await queryClient.invalidateQueries({ queryKey: ['agent-always-on', agentId] })
    },
    onError: (err: unknown) => errorNotif('Could not remove it', getApiErrorMessage(err, 'Please try again.')),
  })
  const subscribes = !!(view.spec as any)?.subscribe
  const [wait, setWait] = useState(String(view.debounceSeconds))
  const saveWait = useMutation({
    mutationFn: () => {
      const seconds = Number(wait)
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) throw new Error('The wait is a whole number of seconds, 0 to 3600.')
      return pushWakesApi.update(agentId, view.id, { debounceSeconds: seconds })
    },
    onSuccess: async () => {
      success('Saved', view.name)
      await refresh()
    },
    onError: (err: unknown) => errorNotif('Could not save the wait', getApiErrorMessage(err, 'Please try again.')),
  })
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="push-wake-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{view.name}</span>
        <ConnectionHealthBadge health={pushWakeHealth(view)} />
        {view.apiName && <span className="text-xs text-muted-foreground">through {view.apiName}</span>}
        {view.sharedWith > 0 && (
          <span className="text-xs text-muted-foreground" data-testid="push-wake-shared">
            shared with {pluralized(view.sharedWith, 'other agent')}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {subscribes && (
            <Button type="button" variant="outline" size="sm" disabled={resubscribe.isPending} onClick={() => resubscribe.mutate()}>
              Subscribe again
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            onClick={async () => {
              if (await confirm({ title: `Remove "${view.name}"?`, description: 'It stops the subscription at the service, and the agent no longer wakes when it changes.', confirmLabel: 'Remove', destructive: true })) {
                remove.mutate()
              }
            }}
          >
            Remove
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{describePushWake(view, formatWakeTime)}</p>
      {view.health.error && (
        <p className="text-xs text-destructive" data-testid="push-wake-error">
          {view.health.error}
        </p>
      )}
      <Disclosure title="Address and setup" summary={`${pluralized(view.pushCount, 'push', 'pushes')} so far`}>
        <Field id={`push-wake-url-${view.id}`} label="Where the service sends pushes">
          <CopyField id={`push-wake-url-${view.id}`} value={view.endpointUrl} label="Push address" />
        </Field>
        <SetupSteps steps={view.setup} />
        <div className="space-y-1">
          <Label htmlFor={`push-wake-wait-${view.id}`}>Wait before waking (seconds)</Label>
          <div className="flex items-center gap-2">
            <Input id={`push-wake-wait-${view.id}`} type="number" min={0} max={3600} className="w-32" value={wait} onChange={(e) => setWait(e.target.value)} />
            <Button type="button" variant="outline" size="sm" disabled={saveWait.isPending || wait === String(view.debounceSeconds)} onClick={() => saveWait.mutate()}>
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Changes within this window wake it once. It is the same for every agent on this subscription.</p>
        </div>
      </Disclosure>
      {dialog}
    </div>
  )
}

function AddPushWake({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const options = useQuery({ queryKey: ['agent-push-wake-options', agentId], queryFn: () => pushWakesApi.options(agentId) })
  const presets = options.data?.presets ?? []
  const [kind, setKind] = useState<string>('')
  const preset = presets.find((p) => p.key === kind) ?? null
  const custom = kind === CUSTOM
  const [apiId, setApiId] = useState('')
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [form, setForm] = useState<CustomPushForm>(emptyCustomForm)
  // "Edit as JSON": the spec as text, used instead of the form while it is open.
  const [json, setJson] = useState<string | null>(null)
  const [secret, setSecret] = useState('')
  const [debounce, setDebounce] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  // A preset is offered only on connections that have every tool it calls.
  const apis = useMemo(() => {
    const all = options.data?.apis ?? []
    return preset ? all.filter((a) => a.presets.includes(preset.key)) : all
  }, [options.data, preset])

  const parsedJson = useMemo(() => {
    if (json === null) return null
    try {
      return JSON.parse(json)
    } catch {
      return undefined
    }
  }, [json])
  const method = preset?.spec.verification.method ?? (json !== null ? parsedJson?.verification?.method : form.method)
  const needsSecret = custom
    ? json !== null
      ? method === 'hmac' || (method === 'shared_token' && parsedJson?.verification?.generated === false)
      : customNeedsSecret(form)
    : method === 'hmac'
  const callsTools = custom ? (json !== null ? !!(parsedJson?.subscribe || parsedJson?.changes || parsedJson?.stop) : customCallsTools(form)) : true

  const create = useMutation({
    mutationFn: (input: PushWakeInput) => pushWakesApi.create(agentId, input),
    onSuccess: async (view: PushWakeView) => {
      if (view.health.status === 'failed') errorNotif('Saved, but subscribing failed', view.health.error ?? 'See the error under it.')
      else success(view.sharedWith ? 'Joined the subscription another agent has' : 'Push wake added', view.name)
      await queryClient.invalidateQueries({ queryKey: ['agent-push-wakes', agentId] })
      await queryClient.invalidateQueries({ queryKey: ['agent-always-on', agentId] })
      onDone()
    },
    onError: (err: unknown) => setProblem(getApiErrorMessage(err, 'Please try again.')),
  })

  const submit = () => {
    setProblem(null)
    if (!kind) return setProblem('Choose what it should watch.')
    let spec: unknown = null
    if (custom) {
      if (json !== null) {
        if (parsedJson === undefined) return setProblem('The JSON is not valid.')
        spec = parsedJson
      } else {
        const built = specFromCustomForm(form)
        if (!built.spec) return setProblem(built.error ?? 'Something is missing.')
        spec = built.spec
      }
    }
    if (callsTools && !apiId) return setProblem('Choose the connection it subscribes with.')
    for (const f of preset?.fields ?? []) {
      if (f.required && !(settings[f.key] ?? '').trim()) return setProblem(`Enter ${f.label.toLowerCase()}.`)
    }
    if (needsSecret && !secret.trim()) return setProblem(method === 'hmac' ? 'Enter the signing key the service gave you.' : 'Enter the value the service sends.')
    const seconds = debounce.trim() === '' ? null : Number(debounce)
    if (seconds !== null && !(Number.isInteger(seconds) && seconds >= 0 && seconds <= 3600)) return setProblem('The wait is a whole number of seconds, 0 to 3600.')
    create.mutate({
      ...(preset ? { presetKey: preset.key, settings } : { spec, name: form.name.trim() || null }),
      ...(callsTools && apiId ? { apiId } : {}),
      ...(needsSecret ? { secret: secret.trim() } : {}),
      debounceSeconds: seconds,
    })
  }

  // Asked for right under how a push is proven (inside the custom form), else after the fields.
  const secretField = (
    <Field id="push-wake-secret" label={method === 'hmac' ? 'Signing key' : 'Shared value'} hint="Kept in Credentials, never shown again.">
      <SecretInput id="push-wake-secret" value={secret} onChange={(e) => setSecret(e.target.value)} />
    </Field>
  )

  return (
    <div className="space-y-4 rounded-md border p-4" data-testid="push-wake-add">
      <Field id="push-wake-kind" label="Watch">
        <Select
          value={kind}
          onValueChange={(v) => {
            setKind(v)
            setApiId('')
            setProblem(null)
            const p = presets.find((x) => x.key === v)
            setSettings(Object.fromEntries((p?.fields ?? []).filter((f) => f.default).map((f) => [f.key, f.default!])))
          }}
        >
          <SelectTrigger id="push-wake-kind">
            <SelectValue placeholder="Choose what it watches" />
          </SelectTrigger>
          <SelectContent>
            {presets.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.description}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM}>Another service that pushes changes</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {kind && (preset || custom) && (
        <Field
          id="push-wake-api"
          label="Connection"
          hint={
            preset
              ? 'Its sign-in subscribes and reads what changed. Only connections with every tool it needs are listed. Agents on the same connection share one subscription.'
              : 'The API whose tools the steps below call. Not needed when the service is set up by hand.'
          }
        >
          {apis.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="push-wake-no-api">
              {preset?.apiHint ?? 'Connect the service under APIs first.'} <Link className="underline" to="/apis">APIs</Link>
            </p>
          ) : (
            <Select value={custom ? apiId || NO_API : apiId} onValueChange={(v) => setApiId(v === NO_API ? '' : v)}>
              <SelectTrigger id="push-wake-api">
                <SelectValue placeholder="Choose a connection" />
              </SelectTrigger>
              <SelectContent>
                {custom && <SelectItem value={NO_API}>None: the service is set up by hand</SelectItem>}
                {apis.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      )}

      {preset && (
        <>
          <SetupSteps steps={previewSteps(preset, settings)} />
          {preset.fields.map((f) => (
            <Field key={f.key} id={`push-wake-field-${f.key}`} label={f.label} hint={f.help}>
              <Input
                id={`push-wake-field-${f.key}`}
                placeholder={f.placeholder}
                value={settings[f.key] ?? ''}
                onChange={(e) => setSettings((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            </Field>
          ))}
        </>
      )}

      {custom && json === null && (
        <CustomPushWakeForm
          agentId={agentId}
          apiId={apiId}
          addressPrefix={options.data?.addressPrefix ?? ''}
          form={form}
          onChange={setForm}
          secretField={needsSecret ? secretField : null}
        />
      )}
      {custom && (
        <Disclosure
          title="Edit as JSON"
          summary={json === null ? 'For a field the form does not have' : 'The JSON is used instead of the form'}
          defaultOpen={json !== null}
          testId="push-wake-json"
        >
          {json === null ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const built = specFromCustomForm(form)
                setJson(JSON.stringify(built.spec ?? { verification: { method: form.method, headerName: form.headerName }, summary: form.summary }, null, 2))
              }}
            >
              Use JSON instead of the form
            </Button>
          ) : (
            <>
              <Textarea aria-label="Push wake JSON" rows={12} className="font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} />
              <Button type="button" variant="ghost" size="sm" onClick={() => setJson(null)}>
                Back to the form (drops the JSON)
              </Button>
            </>
          )}
        </Disclosure>
      )}

      {kind && needsSecret && !(custom && json === null) && secretField}

      {kind && (
        <Field id="push-wake-debounce" label="Wait before waking (seconds)" hint="Changes within this window wake it once.">
          <Input
            id="push-wake-debounce"
            type="number"
            min={0}
            max={3600}
            className="w-32"
            placeholder={String(preset?.debounceSeconds ?? 10)}
            value={debounce}
            onChange={(e) => setDebounce(e.target.value)}
          />
        </Field>
      )}

      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" onClick={submit} disabled={create.isPending || !kind}>
          {create.isPending ? 'Saving…' : 'Save and subscribe'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export function PushWakesSection({ agentId }: { agentId: string }) {
  const list = useQuery({ queryKey: ['agent-push-wakes', agentId], queryFn: () => pushWakesApi.list(agentId) })
  const [adding, setAdding] = useState(false)
  return (
    <div className="space-y-2" data-testid="push-wakes">
      <p className="text-sm font-medium">When a service tells it something changed</p>
      <p className="text-xs text-muted-foreground">
        It wakes within seconds of a change instead of at its next timer. Each push is checked before anything happens.
      </p>
      {(list.data ?? []).map((v) => (
        <PushWakeRow key={v.id} agentId={agentId} view={v} />
      ))}
      {adding ? (
        <AddPushWake agentId={agentId} onDone={() => setAdding(false)} />
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
          Add a service
        </Button>
      )}
    </div>
  )
}
