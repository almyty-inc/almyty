import { useState, type FormEvent } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { JsonSchemaForm, schemaDefaults, type SchemaFormValues } from '@/components/ui/json-schema-form'
import type { AdapterRefusal, CreateModelDeploymentBody, ModelAdapter } from '@/types/deployments'
import { EMPTY_DESIRED, buildHostBody, type DesiredFormValues } from './host-body'

/**
 * "Qwen/Qwen3-0.6B", or a pasted huggingface.co link, as the `hf://`
 * reference the server reads. Anything already carrying a scheme is left
 * as it is.
 */
export function huggingFaceRef(input: string): string {
  const raw = input.trim()
  if (!raw) return ''
  if (raw.includes('://') && !/^https?:\/\//i.test(raw)) return raw
  const repo = raw.replace(/^https?:\/\/(www\.)?huggingface\.co\//i, '').replace(/\/+$/, '')
  return `hf://${repo}`
}

export interface StartModelFormProps {
  adapter: ModelAdapter
  /** The provider's connected account, when it has one: it supplies the cloud's secrets. */
  credentialId?: string
  onSubmit: (body: CreateModelDeploymentBody) => void
  onCancel?: () => void
  submitting?: boolean
  refusal?: AdapterRefusal | null
}

/**
 * Start an open model on this provider's cloud account. One question up
 * front, which model; where the weights come from, region, size and the
 * cloud's own settings wait under Advanced.
 */
export function StartModelForm({ adapter, credentialId, onSubmit, onCancel, submitting, refusal }: StartModelFormProps) {
  const [repo, setRepo] = useState('')
  const [weights, setWeights] = useState('')
  const [desired, setDesired] = useState<DesiredFormValues>(EMPTY_DESIRED)
  const [config, setConfig] = useState<SchemaFormValues>(() => schemaDefaults(adapter.configSchema))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [advanced, setAdvanced] = useState(false)

  const regions = adapter.capabilities.regions ?? []
  const set = (key: keyof DesiredFormValues, value: string) => setDesired((prev) => ({ ...prev, [key]: value }))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const model = weights.trim() || huggingFaceRef(repo)
    const result = buildHostBody({ adapter, model, desired, config, credentialId: credentialId ?? '', budgetId: '' })
    if (!result.ok) {
      const next = { ...result.errors }
      if (next.model && !weights.trim() && !repo.trim()) next.model = 'Say which model to start'
      setErrors(next)
      // Anything wrong beyond the model lives under Advanced: open it.
      if (Object.keys(next).some((k) => k !== 'model')) setAdvanced(true)
      return
    }
    setErrors({})
    onSubmit(result.body)
  }

  const configErrors: Record<string, string> = {}
  for (const [k, v] of Object.entries(errors)) if (k.startsWith('config.')) configErrors[k.slice('config.'.length)] = v

  return (
    <form onSubmit={submit} className="space-y-4" noValidate aria-label="Start a model">
      <div>
        <Label htmlFor="start-model-repo">Which model?</Label>
        <Input
          id="start-model-repo"
          className="mt-1"
          value={repo}
          onChange={(e) => {
            setRepo(e.target.value)
            setErrors((prev) => ({ ...prev, model: '' }))
          }}
          placeholder="Qwen/Qwen3-0.6B"
          disabled={!!weights.trim()}
          aria-invalid={!!errors.model}
        />
        <p className="mt-1 text-xs text-muted-foreground">A Hugging Face repository. The newest revision is used and pinned.</p>
        {errors.model && (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {errors.model}
          </p>
        )}
        {refusal && (
          <p className="mt-1 text-xs text-destructive" role="alert" data-testid="start-model-refusal">
            {refusal.message}
            {refusal.accepts.length > 0 ? ` It takes: ${refusal.accepts.join(', ')}.` : ''}
          </p>
        )}
      </div>

      <div className="rounded-lg border border-dashed">
        <button type="button" className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-medium" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
          {advanced ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
          Advanced
        </button>
        {advanced && (
          <div className="space-y-4 px-3 pb-3">
            <div>
              <Label htmlFor="start-model-weights">Weights from a bucket instead</Label>
              <Input id="start-model-weights" className="mt-1" value={weights} onChange={(e) => setWeights(e.target.value)} placeholder="s3://bucket/path@sha256:..., gs://..., file://..." />
              <p className="mt-1 text-xs text-muted-foreground">Leave empty to use the Hugging Face repository above.</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="start-model-region">Region</Label>
                {regions.length > 0 ? (
                  <select
                    id="start-model-region"
                    className="mt-1 flex h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                    value={desired.region}
                    onChange={(e) => set('region', e.target.value)}
                  >
                    <option value="">Cloud chooses</option>
                    {regions.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input id="start-model-region" className="mt-1" value={desired.region} onChange={(e) => set('region', e.target.value)} placeholder="Cloud chooses" />
                )}
              </div>
              <div>
                <Label htmlFor="start-model-hardware">Hardware</Label>
                <Input id="start-model-hardware" className="mt-1" value={desired.hardware} onChange={(e) => set('hardware', e.target.value)} placeholder="Cloud default, e.g. a10g, l4" />
              </div>
              <NumberField id="start-model-replicas" label="Copies" value={desired.replicas} onChange={(v) => set('replicas', v)} error={errors.replicas} hint="Billed per copy per hour." />
              <NumberField
                id="start-model-min"
                label="Min copies"
                value={desired.minScale}
                onChange={(v) => set('minScale', v)}
                error={errors.minScale}
                hint={adapter.capabilities.scaleToZero ? '0 lets it sleep when idle, and stop billing.' : undefined}
              />
              <NumberField id="start-model-max" label="Max copies" value={desired.maxScale} onChange={(v) => set('maxScale', v)} error={errors.maxScale} />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Cloud settings</p>
              <JsonSchemaForm schema={adapter.configSchema} value={config} onChange={setConfig} errors={configErrors} mode="create" hideSecrets={!!credentialId} />
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          {submitting ? 'Starting...' : 'Start'}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

function NumberField({ id, label, value, onChange, error, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; error?: string; hint?: string }) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} className="mt-1" type="number" min={0} step={1} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Cloud default" aria-invalid={!!error} />
      {hint && !error && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
