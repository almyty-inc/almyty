import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { JsonSchemaForm, schemaDefaults, schemaWithoutSecretRequirements, secretPropertyKeys, stripSecretValues, validateSchemaValues, type SchemaFormValues } from '@/components/ui/json-schema-form'
import { ConnectAccountButton } from '@/components/connections/connect-sheet'
import { ConnectedChip } from '@/components/connections/connected-chip'
import { ConnectionSelect } from '@/components/connections/connection-select'
import type { Connection } from '@/types/connections'
import { budgetsApi, credentialsApi } from '@/lib/api'
import { formatCents, matchAdapters, parseModelRef, schemeOf } from '@/lib/deployments-api'
import { useOrganizationStore } from '@/store/organization'
import type { VaultCredential } from '@/types/usage'
import type { AdapterRefusal, CreateModelDeploymentBody, ModelAdapter, ModelVersion, PrivacyTier, SpendBudgetSummary } from '@/types/deployments'
import { ModelSourceField } from './model-source-field'
import { ProviderPicker } from './provider-picker'

export interface DeployDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  adapters: ModelAdapter[]
  /** Registered artifacts, for the operators who keep them. Never a prerequisite. */
  versions?: ModelVersion[]
  onSubmit: (body: CreateModelDeploymentBody) => void
  submitting?: boolean
  /** Preselect a registered version, e.g. from the Versions tab. */
  initialVersionId?: string
  /** Preselect a model reference, e.g. redeploying what a card already runs. */
  initialModel?: string
  /** What the server said when it refused the last submit. */
  refusal?: AdapterRefusal | null
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

const EMPTY_DESIRED: DesiredFormValues = { hardware: '', replicas: '1', minScale: '', maxScale: '', quantization: '', region: '', privacyTier: '' }

const SELECT_CLASS =
  'flex h-9 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50'

export interface DeployFormState {
  adapter: ModelAdapter | null
  /** Where the model is. This is the whole model configuration. */
  model: string
  /** Architecture family, when the provider checks it and the reference carries none. */
  base?: string
  /** The operator path: a registered artifact instead of a plain reference. */
  versionId?: string
  desired: DesiredFormValues
  config: SchemaFormValues
  credentialId: string
  budgetId: string
  /** A connected account from the Connections layer, instead of a vault credential. */
  connectionId?: string
}

export type DeployBuildResult = { ok: true; body: CreateModelDeploymentBody } | { ok: false; errors: Record<string, string> }

/**
 * Turn the form state into the POST /model-deployments body, or the field
 * errors that stop it.
 *
 * The model is configuration: a reference goes out as `model` and nothing
 * has to be registered first. A registered version is the other path, and
 * then the server reads the reference off the version row. Compatibility
 * is checked here too, with the adapter's own `modelSchemes`, so the
 * common refusal never costs a round trip.
 */
export function buildDeployBody(state: DeployFormState): DeployBuildResult {
  const errors: Record<string, string> = {}
  if (!state.adapter) errors.adapter = 'Pick a provider'

  const versionId = state.versionId ?? ''
  const model = (state.model ?? '').trim()
  const parsed = model ? parseModelRef(model) : null
  if (!versionId && !model) {
    errors.model = 'Say where the model is'
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
  const replicas = int('replicas', 'Replicas', 0)
  const minScale = int('minScale', 'Min scale', 0)
  const maxScale = int('maxScale', 'Max scale', 0)
  if (replicas !== undefined) desired.replicas = replicas
  if (minScale !== undefined) desired.minScale = minScale
  if (maxScale !== undefined) desired.maxScale = maxScale
  if (minScale !== undefined && maxScale !== undefined && minScale > maxScale) errors.maxScale = 'Max scale must be at least min scale'
  if (state.desired.hardware.trim()) desired.hardware = state.desired.hardware.trim()
  if (state.desired.region.trim()) desired.region = state.desired.region.trim()
  if (state.desired.quantization.trim()) desired.quantization = state.desired.quantization.trim()
  if (state.desired.privacyTier) desired.privacyTier = state.desired.privacyTier

  // A connection (a picked credential or one made in the connect sheet)
  // supplies the adapter's secrets: they are neither required nor sent, so
  // the backend never sees PROVIDER_CONFIG_INLINE_SECRET from this form.
  const connectionId = state.credentialId || state.connectionId || ''
  const schema = connectionId ? schemaWithoutSecretRequirements(state.adapter?.configSchema) : state.adapter?.configSchema
  const config = validateSchemaValues(schema, state.config, { mode: 'create' })
  for (const [k, v] of Object.entries(config.errors)) errors[`config.${k}`] = v

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const body: CreateModelDeploymentBody = { providerType: state.adapter!.key }
  if (versionId) {
    body.modelVersionId = versionId
  } else {
    body.model = parsed && parsed.ok ? parsed.value.raw : model
    if (state.base?.trim()) body.base = state.base.trim()
  }
  if (Object.keys(desired).length > 0) body.desired = desired
  const providerConfig = connectionId ? stripSecretValues(state.adapter?.configSchema, config.value) : config.value
  if (Object.keys(providerConfig).length > 0) body.providerConfig = providerConfig
  if (connectionId) body.credentialId = connectionId
  if (state.budgetId) body.budgetId = state.budgetId
  return { ok: true, body }
}

/** True when the adapter form has x-secret fields the user would otherwise paste. */
export function adapterHasSecrets(adapter: ModelAdapter | null): boolean {
  return !!adapter && secretPropertyKeys(adapter.configSchema).length > 0
}

export function describeBudget(b: SpendBudgetSummary): string {
  const scope = b.agentId ? 'one agent' : b.llmProviderId ? 'one provider' : 'whole org'
  return `${formatCents(b.limitCents)} per ${b.periodType} (${scope}, ${b.behavior === 'reject' ? 'hard stop' : 'warn'})`
}

export function DeployDialog({ open, onOpenChange, adapters, versions = [], onSubmit, submitting, initialVersionId, initialModel, refusal }: DeployDialogProps) {
  const { currentOrganization } = useOrganizationStore()
  const initialVersion = initialVersionId ? versions.find((v) => v.id === initialVersionId) : undefined
  const [adapterKey, setAdapterKey] = useState<string>('')
  const [model, setModel] = useState<string>(initialVersion?.registryUri ?? initialModel ?? '')
  const [base, setBase] = useState<string>('')
  const [versionId, setVersionId] = useState<string>(initialVersionId ?? '')
  const [desired, setDesired] = useState<DesiredFormValues>(EMPTY_DESIRED)
  const [config, setConfig] = useState<SchemaFormValues>({})
  const [credentialId, setCredentialId] = useState('')
  const [connection, setConnection] = useState<Connection | null>(null)
  const [budgetId, setBudgetId] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [trackOpen, setTrackOpen] = useState(false)

  const adapter = useMemo(() => adapters.find((a) => a.key === adapterKey) ?? null, [adapters, adapterKey])
  const version = useMemo(() => versions.find((v) => v.id === versionId) ?? null, [versions, versionId])
  const scheme = schemeOf(model)

  const { data: credentials = [] } = useQuery<VaultCredential[]>({
    queryKey: ['credentials', currentOrganization?.id],
    queryFn: async () => {
      const d = await credentialsApi.getAll()
      return Array.isArray(d) ? d : []
    },
    enabled: !!currentOrganization && open,
  })
  const { data: budgets = [] } = useQuery<SpendBudgetSummary[]>({
    queryKey: ['budgets', currentOrganization?.id],
    queryFn: async () => {
      const d = await budgetsApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!currentOrganization && open,
  })

  useEffect(() => {
    if (!open) return
    const preset = initialVersionId ? versions.find((v) => v.id === initialVersionId) : undefined
    setAdapterKey('')
    setModel(preset?.registryUri ?? initialModel ?? '')
    setBase('')
    setVersionId(initialVersionId ?? '')
    setDesired(EMPTY_DESIRED)
    setConfig({})
    setCredentialId('')
    setConnection(null)
    setBudgetId('')
    setErrors({})
    setTrackOpen(!!initialVersionId)
    // versions only seeds the preset reference; re-running on every refetch would wipe typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialVersionId, initialModel])

  const pickAdapter = (key: string) => {
    setAdapterKey(key)
    const next = adapters.find((a) => a.key === key)
    setConfig(schemaDefaults(next?.configSchema))
    setDesired((prev) => ({ ...prev, region: next && next.capabilities.regions.length > 0 && !next.capabilities.regions.includes(prev.region) ? '' : prev.region }))
    setErrors((prev) => ({ ...prev, adapter: '', model: '' }))
  }

  // Typing a reference by hand means this is no longer that registered version.
  const changeModel = (value: string) => {
    setModel(value)
    if (versionId && value !== version?.registryUri) setVersionId('')
    setErrors((prev) => ({ ...prev, model: '' }))
  }

  const pickVersion = (id: string) => {
    setVersionId(id)
    const picked = versions.find((v) => v.id === id)
    if (picked) setModel(picked.registryUri)
    setErrors((prev) => ({ ...prev, model: '' }))
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const result = buildDeployBody({ adapter, model, base, versionId, desired, config, credentialId, budgetId, connectionId: connection?.id })
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
  const quantizations = version?.quantizations ?? []
  const usingConnection = !!credentialId || !!connection

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Run a model</DialogTitle>
          <DialogDescription>
            Say where the model is and who should run it. Desired state is saved now; the reconcile loop talks to the provider.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-6" noValidate>
          <ModelSourceField value={model} onChange={changeModel} adapters={adapters} adapter={adapter} error={errors.model} />

          <ProviderPicker adapters={adapters} scheme={scheme} value={adapterKey} onSelect={pickAdapter} error={errors.adapter} refusal={refusal} />

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Desired state</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <NumberField id="deploy-replicas" label="Replicas" value={desired.replicas} onChange={(v) => setDesiredField('replicas', v)} error={errors.replicas} />
              <NumberField id="deploy-min-scale" label="Min scale" value={desired.minScale} onChange={(v) => setDesiredField('minScale', v)} error={errors.minScale} placeholder="provider default" />
              <NumberField id="deploy-max-scale" label="Max scale" value={desired.maxScale} onChange={(v) => setDesiredField('maxScale', v)} error={errors.maxScale} placeholder="provider default" />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="deploy-hardware">Hardware</Label>
                <Input id="deploy-hardware" value={desired.hardware} onChange={(e) => setDesiredField('hardware', e.target.value)} placeholder="e.g. a10g, l4, cpu" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="deploy-region">Region</Label>
                {regions.length > 0 ? (
                  <select id="deploy-region" className={SELECT_CLASS} value={desired.region} onChange={(e) => setDesiredField('region', e.target.value)}>
                    <option value="">Provider chooses</option>
                    {regions.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input id="deploy-region" value={desired.region} onChange={(e) => setDesiredField('region', e.target.value)} placeholder="provider chooses" />
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="deploy-quantization">Quantization</Label>
                {quantizations.length > 0 ? (
                  <select id="deploy-quantization" className={SELECT_CLASS} value={desired.quantization} onChange={(e) => setDesiredField('quantization', e.target.value)}>
                    <option value="">As stored</option>
                    {quantizations.map((q) => (
                      <option key={q} value={q}>
                        {q}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input id="deploy-quantization" value={desired.quantization} onChange={(e) => setDesiredField('quantization', e.target.value)} placeholder="as stored" />
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="deploy-privacy-tier">Privacy tier</Label>
                <select id="deploy-privacy-tier" className={SELECT_CLASS} value={desired.privacyTier} onChange={(e) => setDesiredField('privacyTier', e.target.value as DesiredFormValues['privacyTier'])}>
                  <option value="">Not set</option>
                  <option value="local">local</option>
                  <option value="private_cloud">private_cloud</option>
                  <option value="public">public</option>
                </select>
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{adapter ? `${adapter.displayName} configuration` : 'Provider configuration'}</legend>
            {adapter ? (
              <>
                <JsonSchemaForm schema={adapter.configSchema} value={config} onChange={setConfig} errors={configErrors} mode="create" hideSecrets={usingConnection} />
                {adapterHasSecrets(adapter) && (
                  <p className="text-xs text-muted-foreground" data-testid="deploy-secret-hint">
                    {usingConnection
                      ? 'The connection supplies the secret fields; they are left out of this request.'
                      : 'Recommended: connect the account below instead of pasting its secret here, so it is stored once and can be rotated.'}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Pick a provider to see its settings.</p>
            )}
          </fieldset>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="deploy-credential">Credential</Label>
              <select id="deploy-credential" className={SELECT_CLASS} value={credentialId} onChange={(e) => setCredentialId(e.target.value)} disabled={!!connection}>
                <option value="">None</option>
                {credentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.type})
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">Handed to the adapter per call, never stored on the deployment.</p>
              {connection ? (
                <ConnectedChip connection={connection} onClear={() => setConnection(null)} />
              ) : (
                <>
                  <ConnectionSelect
                    id="deploy-connection"
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
            <div className="space-y-1.5">
              <Label htmlFor="deploy-budget">Spend budget</Label>
              <select id="deploy-budget" className={SELECT_CLASS} value={budgetId} onChange={(e) => setBudgetId(e.target.value)}>
                <option value="">None</option>
                {budgets
                  .filter((b) => b.active)
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {describeBudget(b)}
                    </option>
                  ))}
              </select>
              <p className="text-xs text-muted-foreground">Reaching the budget scales the deployment to zero.</p>
            </div>
          </div>

          <div className="rounded-lg border border-dashed p-3">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 text-left text-sm font-medium"
              onClick={() => setTrackOpen((prev) => !prev)}
              aria-expanded={trackOpen}
            >
              {trackOpen ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
              Tracked artifact (optional)
            </button>
            {trackOpen && (
              <div className="mt-3 space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="deploy-version">Registered version</Label>
                  <select id="deploy-version" className={SELECT_CLASS} value={versionId} onChange={(e) => pickVersion(e.target.value)}>
                    <option value="">None, use the reference above</option>
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} ({v.base})
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Only for operators who keep their own artifact records. Most deployments never use one, and picking one just fills the reference above.
                  </p>
                </div>
                {!versionId && (
                  <div className="space-y-1.5">
                    <Label htmlFor="deploy-base">Architecture family</Label>
                    <Input id="deploy-base" value={base} onChange={(e) => setBase(e.target.value)} placeholder="e.g. qwen3-14b" />
                    <p className="text-xs text-muted-foreground">Only needed when the provider checks the architecture and the reference does not name one.</p>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || adapters.length === 0}>
              {submitting ? 'Deploying...' : 'Deploy'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function NumberField({ id, label, value, onChange, error, placeholder }: { id: string; label: string; value: string; onChange: (v: string) => void; error?: string; placeholder?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min={0} step={1} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
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
