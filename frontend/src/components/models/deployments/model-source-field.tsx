import { useMemo, type ReactNode } from 'react'
import { AlertCircle, Check } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MODEL_SCHEMES, SCHEME_META, adapterSchemes, describeModelRef, parseModelRef, schemeOf, schemePrefix } from '@/lib/deployments-api'
import { cn } from '@/lib/utils'
import type { ModelAdapter, ModelScheme } from '@/types/deployments'

export interface ModelSourceFieldProps {
  value: string
  onChange: (value: string) => void
  /** Every adapter this server has, so the chips can offer every source somebody can run. */
  adapters: ModelAdapter[]
  /** The provider already picked, if any: then only its own sources are offered. */
  adapter: ModelAdapter | null
  error?: string
  disabled?: boolean
}

/**
 * The first question the deploy flow asks: where is the model? The answer
 * is the whole model configuration, so nothing has to be registered first.
 * The chips write an example of each shape the server can actually run,
 * and the reference is parsed as it is typed with the same grammar the
 * backend uses.
 */
export function ModelSourceField({ value, onChange, adapters, adapter, error, disabled }: ModelSourceFieldProps) {
  const offered = useMemo<ModelScheme[]>(() => {
    if (adapter) return adapterSchemes(adapter)
    const seen = new Set<ModelScheme>()
    for (const a of adapters) for (const s of adapterSchemes(a)) seen.add(s)
    // Nothing configured yet: still show the whole grammar rather than an empty row.
    return seen.size ? MODEL_SCHEMES.filter((s) => seen.has(s)) : MODEL_SCHEMES
  }, [adapter, adapters])

  const parsed = value.trim() ? parseModelRef(value) : null
  const scheme = schemeOf(value)
  const artifacts = offered.filter((s) => SCHEME_META[s].kind === 'artifact')
  const platforms = offered.filter((s) => SCHEME_META[s].kind === 'provider')

  return (
    <div className="space-y-2">
      <Label htmlFor="deploy-model">Where is the model?</Label>
      <p className="text-xs text-muted-foreground">
        A Hugging Face repository, or a model you already uploaded to a platform. almyty runs it through the provider; the weights never pass through us.
      </p>
      <Input
        id="deploy-model"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="hf://org/repo@sha"
        spellCheck={false}
        autoComplete="off"
        className="font-mono text-sm"
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={error ? 'deploy-model-error' : 'deploy-model-parsed'}
      />

      <div className="space-y-1.5" data-testid="model-source-chips">
        {artifacts.length > 0 && <SchemeRow title="Point at the weights" schemes={artifacts} active={scheme} onPick={onChange} disabled={disabled} />}
        {platforms.length > 0 && <SchemeRow title="Already on a platform" schemes={platforms} active={scheme} onPick={onChange} disabled={disabled} />}
      </div>

      {adapter && (
        <p className="text-xs text-muted-foreground" data-testid="adapter-accepts">
          {offered.length
            ? `${adapter.displayName} accepts ${offered.map(schemePrefix).join(', ')}.`
            : `${adapter.displayName} does not say which sources it reads.`}
        </p>
      )}

      {error ? (
        <FieldNote id="deploy-model-error" tone="error">
          {error}
        </FieldNote>
      ) : parsed && !parsed.ok ? (
        <FieldNote id="deploy-model-parsed" tone="error">
          {parsed.error}
        </FieldNote>
      ) : parsed && parsed.ok ? (
        <FieldNote id="deploy-model-parsed" tone="ok">
          {describeModelRef(parsed.value)}
        </FieldNote>
      ) : (
        <p id="deploy-model-parsed" className="text-xs text-muted-foreground">
          Nothing has to be registered first. Paste the reference and pick a provider that can run it.
        </p>
      )}
    </div>
  )
}

function SchemeRow({ title, schemes, active, onPick, disabled }: { title: string; schemes: ModelScheme[]; active: ModelScheme | null; onPick: (value: string) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</span>
      {schemes.map((s) => {
        const meta = SCHEME_META[s]
        return (
          <button
            key={s}
            type="button"
            disabled={disabled}
            title={`${meta.hint} Example: ${meta.example}`}
            onClick={() => onPick(meta.example)}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-50',
              active === s ? 'border-violet-500/60 bg-violet-500/10 text-violet-600 dark:text-violet-400' : 'border-border text-muted-foreground',
            )}
          >
            {meta.label}
          </button>
        )
      })}
    </div>
  )
}

function FieldNote({ id, tone, children }: { id: string; tone: 'ok' | 'error'; children: ReactNode }) {
  const Icon = tone === 'ok' ? Check : AlertCircle
  return (
    <p
      id={id}
      role={tone === 'error' ? 'alert' : undefined}
      className={cn('flex items-start gap-1.5 text-xs', tone === 'ok' ? 'text-cyan-600 dark:text-cyan-400' : 'text-destructive')}
    >
      <Icon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}
