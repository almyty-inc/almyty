import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { JsonSchemaForm, schemaDefaults, schemaWithoutSecretRequirements, secretPropertyKeys, stripSecretValues, validateSchemaValues, type SchemaFormValues } from '@/components/ui/json-schema-form'
import { ConnectAccountButton } from '@/components/connections/connect-sheet'
import { ConnectedChip } from '@/components/connections/connected-chip'
import { ConnectionSelect } from '@/components/connections/connection-select'
import type { Connection } from '@/types/connections'
import { budgetsApi, credentialsApi } from '@/lib/api'
import { formatCents, matchAdapters, parseModelRef, schemeOf } from '@/lib/deployments-api'
import { cloudName, readableModelName } from '@/lib/model-hosting'
import { useOrganizationStore } from '@/store/organization'
import type { VaultCredential } from '@/types/usage'
import type { AdapterRefusal, CreateModelDeploymentBody, ModelAdapter, PrivacyTier, SpendBudgetSummary } from '@/types/deployments'
import { ModelSourceField } from './model-source-field'
import { CloudPicker } from './cloud-picker'

export interface HostModelFormProps {
  /** Hosting integrations this server has; `custom-endpoint` is filtered out by the picker. */
  adapters: ModelAdapter[]
  onSubmit: (body: CreateModelDeploymentBody) => void
  onCancel?: () => void
  submitting?: boolean
  /** Preselect a model source, e.g. hosting again what a model already runs. */
  initialModel?: string
  /** What the server said when it refused the last submit. */
  refusal?: AdapterRefusal | null
  /** Rendered before the buttons, e.g. a Back button. */
  footerStart?: ReactNode
}

export interface DesiredFormValues {
  hardware: string
  replicas: string
  minScale: string
  maxScale: string
  quantization: string
  region: string
  privacyTier: '' | PrivacyTier
}

const EMPTY_DESIRED: DesiredFormValues = { hardware: '', replicas: '1', minScale: '', maxScale: '', quantization: '', region: '', privacyTier: 'private_cloud' }

const SELECT_CLASS =
  'flex h-9 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50'

export interface HostFormState {
  adapter: ModelAdapter | null
  /** Where the model is. This is the whole model configuration. */
  model: string
  /** What to call it in the Models list. Defaults to the repository name. */
  name?: string
  /** Architecture family, when the cloud checks it and the source carries none. */
  base?: string
  desired: DesiredFormValues
  config: SchemaFormValues
  credentialId: string
  budgetId: string
  /** A connected account from the Connections layer, instead of a vault credential. */
  connectionId?: string
}

export type HostBuildResult = { ok: true; body: CreateModelDeploymentBody } | { ok: false; errors: Record<string, string> }

/**
 * Turn the form into the POST /model-deployments body, or the field errors
 * that stop it.
 *
 * The model source is configuration: nothing has to be registered first.
 * A Hugging Face repository may be named without a commit; the server pins
 * it to the exact revision before anything starts. Compatibility is checked
 * here too, with the integration's own `modelSchemes`, so the common
 * refusal never costs a round trip.
 */
export function buildHostBody(state: HostFormState): HostBuildResult {
  const errors: Record<string, string> = {}
  if (!state.adapter) errors.adapter = 'Pick the cloud that runs it'

  const model = (state.model ?? '').trim()
  const parsed = model ? parseModelRef(model) : null
  if (!model) {
    errors.model = 'Say which model to run'
  } else if (parsed && !parsed.ok) {
    errors.model = parsed.error
  } else if (parsed && parsed.ok && state.adapter) {
    const match = matchAdapters([state.adapter], parsed.value.scheme)[0]
    if (match && !match.ok && match.reason) errors.model = match.reason
  }

  const desired: CreateModelDeploymentBody['desired'] = {}
  const int = (key: keyof DesiredFormValues, label: string, min: number) => {
    const raw = state.desired[key].trim()
    if (raw === '') return undefined
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min) {
      errors[key] = `${label} must be a whole number of at least ${min}`
      return undefined
    }
    return n
  }
  const replicas = int('replicas', 'Copies', 0)
  const minScale = int('minScale', 'Min copies', 0)
  const maxScale = int('maxScale', 'Max copies', 0)
  if (replicas !== undefined) desired.replicas = replicas
  if (minScale !== undefined) desired.minScale = minScale
  if (maxScale !== undefined) desired.maxScale = maxScale
  if (minScale !== undefined && maxScale !== undefined && minScale > maxScale) errors.maxScale = 'Max copies must be at least min copies'
  if (state.desired.hardware.trim()) desired.hardware = state.desired.hardware.trim()
  if (state.desired.region.trim()) desired.region = state.desired.region.trim()
  if (state.desired.quantization.trim()) desired.quantization = state.desired.quantization.trim()
  if (state.desired.privacyTier) desired.privacyTier = state.desired.privacyTier

  // A connection (a picked credential or one made in the connect sheet)
  // supplies the integration's secrets: they are neither required nor sent,
  // so the backend never sees PROVIDER_CONFIG_INLINE_SECRET from this form.
  const connectionId = state.credentialId || state.connectionId || ''
  const schema = connectionId ? schemaWithoutSecretRequirements(state.adapter?.configSchema) : state.adapter?.configSchema
  const config = validateSchemaValues(schema, state.config, { mode: 'create' })
  for (const [k, v] of Object.entries(config.errors)) errors[`config.${k}`] = v

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const body: CreateModelDeploymentBody = { providerType: state.adapter!.key, model: parsed && parsed.ok ? parsed.value.raw : model }
  if (state.name?.trim()) body.name = state.name.trim()
  if (state.base?.trim()) body.base = state.base.trim()
  if (Object.keys(desired).length > 0) body.desired = desired
  const providerConfig = connectionId ? stripSecretValues(state.adapter?.configSchema, config.value) : config.value
  if (Object.keys(providerConfig).length > 0) body.providerConfig = providerConfig
  if (connectionId) body.credentialId = connectionId
  if (state.budgetId) body.budgetId = state.budgetId
  return { ok: true, body }
}

/** True when the integration's form has x-secret fields the user would otherwise paste. */
export function adapterHasSecrets(adapter: ModelAdapter | null): boolean {
  return !!adapter && secretPropertyKeys(adapter.configSchema).length > 0
}

export function describeBudget(b: SpendBudgetSummary): string {
  const scope = b.agentId ? 'one agent' : b.llmProviderId ? 'one provider' : 'whole org'
  return `${formatCents(b.limitCents)} per ${b.periodType} (${scope}, ${b.behavior === 'reject' ? 'hard stop' : 'warn'})`
}

/**
 * Host a model on your own cloud account. Say which model, pick the cloud,
 * size it and cap its spend; almyty starts it there, reports its state and
 * hourly cost on the model, and stops it when told or when the cap is hit.
 */
export function HostModelForm({ adapters, onSubmit, onCancel, submitting, initialModel, refusal, footerStart }: HostModelFormProps) {
  const { currentOrganization } = useOrganizationStore()
  const [adapterKey, setAdapterKey] = useState<string>('')
  const [model, setModel] = useState<string>(initialModel ?? '')
  const [name, setName] = useState<string>('')
  const [base, setBase] = useState<string>('')
  const [desired, setDesired] = useState<DesiredFormValues>(EMPTY_DESIRED)
  const [config, setConfig] = useState<SchemaFormValues>({})
  const [credentialId, setCredentialId] = useState('')
  const [connection, setConnection] = useState<Connection | null>(null)
  const [budgetId, setBudgetId] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [moreOpen, setMoreOpen] = useState(false)

  const adapter = useMemo(() => adapters.find((a) => a.key === adapterKey) ?? null, [adapters, adapterKey])
  const scheme = schemeOf(model)

  const { data: credentials = [] } = useQuery<VaultCredential[]>({
    queryKey: ['credentials', currentOrganization?.id],
    queryFn: async () => {
      const d = await credentialsApi.getAll()
      return Array.isArray(d) ? d : []
    },
    enabled: !!currentOrganization,
  })
  const { data: budgets = [] } = useQuery<SpendBudgetSummary[]>({
    queryKey: ['budgets', currentOrganization?.id],
    queryFn: async () => {
      const d = await budgetsApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!currentOrganization,
  })

  const pickAdapter = (key: string) => {
    setAdapterKey(key)
    const next = adapters.find((a) => a.key === key)
    setConfig(schemaDefaults(next?.configSchema))
    setDesired((prev) => ({ ...prev, region: next && next.capabilities.regions.length > 0 && !next.capabilities.regions.includes(prev.region) ? '' : prev.region }))
    setErrors((prev) => ({ ...prev, adapter: '', model: '' }))
  }

  const changeModel = (value: string) => {
    setModel(value)
    setErrors((prev) => ({ ...prev, model: '' }))
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const result = buildHostBody({ adapter, model, name, base, desired, config, credentialId, budgetId, connectionId: connection?.id })
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    onSubmit(result.body)
  }

  const configErrors = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(errors)) if (k.startsWith('config.')) out[k.slice('config.'.length)] = v
    return out
  }, [errors])

  const setDesiredField = (key: keyof DesiredFormValues, value: string) => setDesired((prev) => ({ ...prev, [key]: value }))
  const regions = adapter?.capabilities.regions ?? []
  const usingConnection = !!credentialId || !!connection
  const cloud = adapter ? cloudName(adapter) : null

  return (
    <form onSubmit={handleSubmit} className="space-y-6" noValidate>
      <ModelSourceField value={model} onChange={changeModel} adapters={adapters} adapter={adapter} error={errors.model} />

      <div className="space-y-1.5">
        <Label htmlFor="host-name">
          Name <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input id="host-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={model.trim() ? readableModelName(model) : 'Shown in the Models list and in agents'} />
      </div>

      <CloudPicker adapters={adapters} scheme={scheme} value={adapterKey} onSelect={pickAdapter} error={errors.adapter} refusal={refusal} />

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{cloud ? `Your ${cloud} account` : 'Your cloud account'}</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="host-credential">Saved credential</Label>
            <select id="host-credential" className={SELECT_CLASS} value={credentialId} onChange={(e) => setCredentialId(e.target.value)} disabled={!!connection}>
              <option value="">None</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.type})
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">Handed to your cloud per call, never stored with the model.</p>
          </div>
          <div className="space-y-1.5">
            {connection ? (
              <ConnectedChip connection={connection} onClear={() => setConnection(null)} />
            ) : (
              <>
                <ConnectionSelect
                  id="host-connection"
                  kind="deployment"
                  preferConnectorKey={adapter ? `deploy-${adapter.key}` : undefined}
                  value=""
                  onChange={(next) => {
                    if (!next) return
                    setConnection(next)
                    setCredentialId('')
                  }}
                />
                <ConnectAccountButton
                  kind="deployment"
                  onConnected={(next) => {
                    setConnection(next)
                    setCredentialId('')
                  }}
                />
              </>
            )}
          </div>
        </div>
        {adapter ? (
          <>
            <JsonSchemaForm schema={adapter.configSchema} value={config} onChange={setConfig} errors={configErrors} mode="create" hideSecrets={usingConnection} />
            {adapterHasSecrets(adapter) && (
              <p className="text-xs text-muted-foreground" data-testid="host-secret-hint">
                {usingConnection
                  ? 'The connected account supplies the secret fields; they are left out of this request.'
                  : 'Recommended: connect the account instead of pasting its secret here, so it is stored once and can be rotated.'}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Pick a cloud to see its settings.</p>
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Size and spend</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumberField id="host-replicas" label="Copies" value={desired.replicas} onChange={(v) => setDesiredField('replicas', v)} error={errors.replicas} hint="Billed per copy per hour. 0 creates it stopped." />
          <div className="space-y-1.5">
            <Label htmlFor="host-hardware">Hardware</Label>
            <Input id="host-hardware" value={desired.hardware} onChange={(e) => setDesiredField('hardware', e.target.value)} placeholder="Cloud default, e.g. a10g, l4" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="host-budget">Spending cap</Label>
            <select id="host-budget" className={SELECT_CLASS} value={budgetId} onChange={(e) => setBudgetId(e.target.value)}>
              <option value="">None</option>
              {budgets
                .filter((b) => b.active)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {describeBudget(b)}
                  </option>
                ))}
            </select>
            <p className="text-xs text-muted-foreground">Reaching the cap stops the model, and billing with it.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="host-region">Region</Label>
            {regions.length > 0 ? (
              <select id="host-region" className={SELECT_CLASS} value={desired.region} onChange={(e) => setDesiredField('region', e.target.value)}>
                <option value="">Cloud chooses</option>
                {regions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            ) : (
              <Input id="host-region" value={desired.region} onChange={(e) => setDesiredField('region', e.target.value)} placeholder="Cloud chooses" />
            )}
          </div>
        </div>
      </fieldset>

      <div className="rounded-lg border border-dashed">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-medium"
          onClick={() => setMoreOpen((prev) => !prev)}
          aria-expanded={moreOpen}
        >
          {moreOpen ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
          More options
        </button>
        {moreOpen && (
          <div className="grid grid-cols-1 gap-3 px-3 pb-3 sm:grid-cols-2">
            <NumberField id="host-min-scale" label="Min copies" value={desired.minScale} onChange={(v) => setDesiredField('minScale', v)} error={errors.minScale} placeholder="Cloud default" />
            <NumberField id="host-max-scale" label="Max copies" value={desired.maxScale} onChange={(v) => setDesiredField('maxScale', v)} error={errors.maxScale} placeholder="Cloud default" />
            <div className="space-y-1.5">
              <Label htmlFor="host-quantization">Quantization</Label>
              <Input id="host-quantization" value={desired.quantization} onChange={(e) => setDesiredField('quantization', e.target.value)} placeholder="As published, e.g. int4" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="host-privacy-tier">Privacy</Label>
              <select id="host-privacy-tier" className={SELECT_CLASS} value={desired.privacyTier} onChange={(e) => setDesiredField('privacyTier', e.target.value as DesiredFormValues['privacyTier'])}>
                <option value="private_cloud">Private cloud</option>
                <option value="local">Local</option>
                <option value="public">Public</option>
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="host-base">Model family</Label>
              <Input id="host-base" value={base} onChange={(e) => setBase(e.target.value)} placeholder="e.g. qwen3-14b" />
              <p className="text-xs text-muted-foreground">Only needed when your cloud checks the architecture and the source does not say.</p>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {footerStart && <div className="sm:mr-auto">{footerStart}</div>}
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={submitting || adapters.length === 0}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {submitting ? 'Starting...' : 'Host model'}
        </Button>
      </div>
    </form>
  )
}

function NumberField({ id, label, value, onChange, error, placeholder, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; error?: string; placeholder?: string; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min={0} step={1} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </div>
  )
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {children}
    </p>
  )
}
