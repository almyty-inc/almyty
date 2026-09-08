import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { JsonSchemaForm, schemaDefaults, validateSchemaValues, type SchemaFormValues } from '@/components/ui/json-schema-form'
import { ConnectAccountButton } from '@/components/connections/connect-sheet'
import { ConnectedChip } from '@/components/connections/connected-chip'
import type { Connection } from '@/types/connections'
import { budgetsApi, credentialsApi } from '@/lib/api'
import { formatCents } from '@/lib/deployments-api'
import { cn } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import type { VaultCredential } from '@/types/usage'
import type { CreateModelDeploymentBody, ModelAdapter, ModelVersion, PrivacyTier, SpendBudgetSummary } from '@/types/deployments'

export interface DeployDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  adapters: ModelAdapter[]
  versions: ModelVersion[]
  onSubmit: (body: CreateModelDeploymentBody) => void
  submitting?: boolean
  /** Preselect a version, e.g. from the Versions tab. */
  initialVersionId?: string
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
  versionId: string
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
 * errors that stop it. Pure so it is testable without the dialog.
 */
export function buildDeployBody(state: DeployFormState): DeployBuildResult {
  const errors: Record<string, string> = {}
  if (!state.adapter) errors.adapter = 'Pick an adapter'
  if (!state.versionId) errors.versionId = 'Pick a version'

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

  const config = validateSchemaValues(state.adapter?.configSchema, state.config, { mode: 'create' })
  for (const [k, v] of Object.entries(config.errors)) errors[`config.${k}`] = v

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const body: CreateModelDeploymentBody = {
    modelVersionId: state.versionId,
    providerType: state.adapter!.key,
  }
  if (Object.keys(desired).length > 0) body.desired = desired
  if (Object.keys(config.value).length > 0) body.providerConfig = config.value
  if (state.credentialId) body.credentialId = state.credentialId
  if (state.connectionId) body.connectionId = state.connectionId
  if (state.budgetId) body.budgetId = state.budgetId
  return { ok: true, body }
}

export function describeBudget(b: SpendBudgetSummary): string {
  const scope = b.agentId ? 'one agent' : b.llmProviderId ? 'one provider' : 'whole org'
  return `${formatCents(b.limitCents)} per ${b.periodType} (${scope}, ${b.behavior === 'reject' ? 'hard stop' : 'warn'})`
}

export function DeployDialog({ open, onOpenChange, adapters, versions, onSubmit, submitting, initialVersionId }: DeployDialogProps) {
  const { currentOrganization } = useOrganizationStore()
  const [adapterKey, setAdapterKey] = useState<string>('')
  const [versionId, setVersionId] = useState<string>(initialVersionId ?? '')
  const [desired, setDesired] = useState<DesiredFormValues>(EMPTY_DESIRED)
  const [config, setConfig] = useState<SchemaFormValues>({})
  const [credentialId, setCredentialId] = useState('')
  const [connection, setConnection] = useState<Connection | null>(null)
  const [budgetId, setBudgetId] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const adapter = useMemo(() => adapters.find((a) => a.key === adapterKey) ?? null, [adapters, adapterKey])
  const version = useMemo(() => versions.find((v) => v.id === versionId) ?? null, [versions, versionId])

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
    setAdapterKey('')
    setVersionId(initialVersionId ?? '')
    setDesired(EMPTY_DESIRED)
    setConfig({})
    setCredentialId('')
    setConnection(null)
    setBudgetId('')
    setErrors({})
  }, [open, initialVersionId])

  const pickAdapter = (key: string) => {
    setAdapterKey(key)
    const next = adapters.find((a) => a.key === key)
    setConfig(schemaDefaults(next?.configSchema))
    setDesired((prev) => ({ ...prev, region: next && next.capabilities.regions.length > 0 && !next.capabilities.regions.includes(prev.region) ? '' : prev.region }))
    setErrors({})
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const result = buildDeployBody({ adapter, versionId, desired, config, credentialId, budgetId, connectionId: connection?.id })
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Deploy a version</DialogTitle>
          <DialogDescription>Pick where the weights run. Desired state is saved now; the reconcile loop talks to the provider.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-6" noValidate>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Adapter</legend>
            {adapters.length === 0 ? (
              <p className="text-sm text-muted-foreground">No deployment adapters are registered on this server.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Adapter">
                {adapters.map((a) => (
                  <AdapterCard key={a.key} adapter={a} selected={a.key === adapterKey} onSelect={() => pickAdapter(a.key)} />
                ))}
              </div>
            )}
            {errors.adapter && <FieldError id="deploy-adapter-error">{errors.adapter}</FieldError>}
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="deploy-version">Version</Label>
            <select id="deploy-version" className={SELECT_CLASS} value={versionId} onChange={(e) => setVersionId(e.target.value)} aria-invalid={!!errors.versionId} aria-describedby={errors.versionId ? 'deploy-version-error' : undefined}>
              <option value="">Select a registry version</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.base})
                </option>
              ))}
            </select>
            {versions.length === 0 && <p className="text-xs text-muted-foreground">Register a version on the Versions tab first.</p>}
            {errors.versionId && <FieldError id="deploy-version-error">{errors.versionId}</FieldError>}
          </div>

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
            <legend className="text-sm font-medium">{adapter ? `${adapter.displayName} configuration` : 'Adapter configuration'}</legend>
            {adapter ? (
              <JsonSchemaForm schema={adapter.configSchema} value={config} onChange={setConfig} errors={configErrors} mode="create" />
            ) : (
              <p className="text-sm text-muted-foreground">Pick an adapter to see its settings.</p>
            )}
          </fieldset>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="deploy-credential">Credential</Label>
              <select id="deploy-credential" className={SELECT_CLASS} value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
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
                <ConnectAccountButton
                  kind="deployment"
                  onConnected={(next) => {
                    setConnection(next)
                    setCredentialId('')
                  }}
                />
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

function AdapterCard({ adapter, selected, onSelect }: { adapter: ModelAdapter; selected: boolean; onSelect: () => void }) {
  const caps = adapter.capabilities
  const tags = [
    caps.serverless ? 'serverless' : null,
    caps.dedicated ? 'dedicated' : null,
    caps.scaleToZero ? 'scale to zero' : null,
    caps.lora !== 'none' ? `lora: ${caps.lora}` : null,
    caps.architectures === 'any' ? 'any architecture' : `${caps.architectures.length} architectures`,
    caps.regions.length > 0 ? `${caps.regions.length} regions` : null,
  ].filter((t): t is string => !!t)
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'rounded-lg border p-3 text-left transition-colors hover:bg-accent',
        selected ? 'border-primary bg-primary/5 ring-1 ring-primary/40' : 'border-border',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{adapter.displayName}</span>
        {selected && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
      </div>
      <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{adapter.key}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        {tags.map((t) => (
          <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {t}
          </span>
        ))}
      </div>
    </button>
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
