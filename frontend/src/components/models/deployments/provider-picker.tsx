import { useMemo, useState } from 'react'
import { Ban, Check } from 'lucide-react'

import { matchAdapters, adapterSchemes, schemePrefix } from '@/lib/deployments-api'
import { cn } from '@/lib/utils'
import type { AdapterRefusal, ModelAdapter, ModelScheme } from '@/types/deployments'

export interface ProviderPickerProps {
  adapters: ModelAdapter[]
  /** The scheme the typed model reference opens with, or null while it is empty. */
  scheme: ModelScheme | null
  value: string
  onSelect: (key: string) => void
  error?: string
  /** What the server said when it refused this combination. */
  refusal?: AdapterRefusal | null
}

/**
 * Who can run this model. The verdict comes from each adapter's own
 * `modelSchemes`, so a provider that cannot read the source is never
 * offered, and the ones that are hidden say why. With no model named yet
 * every provider is offered and picking one narrows the source field
 * instead: the filter runs in both directions.
 */
export function ProviderPicker({ adapters, scheme, value, onSelect, error, refusal }: ProviderPickerProps) {
  const [showBlocked, setShowBlocked] = useState(false)
  const matches = useMemo(() => matchAdapters(adapters, scheme), [adapters, scheme])
  const runnable = matches.filter((m) => m.ok)
  const blocked = matches.filter((m) => !m.ok)
  // A provider picked before the model was named can end up unable to run
  // it. It leaves the list, so say where it went rather than let it vanish.
  const droppedSelection = value ? blocked.find((m) => m.adapter.key === value) : undefined

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Who runs it</legend>
      <p className="text-xs text-muted-foreground">
        {scheme
          ? runnable.length
            ? `${runnable.length} of ${matches.length} providers can run a ${schemePrefix(scheme)} model.`
            : `No configured provider can run a ${schemePrefix(scheme)} model.`
          : 'Every provider on this server. Pick one and the source field narrows to what it reads.'}
      </p>

      {adapters.length === 0 ? (
        <p className="text-sm text-muted-foreground">No deployment providers are registered on this server.</p>
      ) : runnable.length === 0 && !showBlocked ? (
        <p className="text-sm text-muted-foreground" data-testid="no-runnable-providers">
          Change the model reference, or connect a provider that reads it.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Provider">
          {runnable.map((m) => (
            <AdapterCard key={m.adapter.key} adapter={m.adapter} selected={m.adapter.key === value} onSelect={() => onSelect(m.adapter.key)} />
          ))}
        </div>
      )}

      {droppedSelection && (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="dropped-selection">
          {droppedSelection.adapter.displayName} is no longer on offer: {droppedSelection.reason}. Pick another provider, or change the model.
        </p>
      )}

      {blocked.length > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => setShowBlocked((prev) => !prev)}
            aria-expanded={showBlocked}
          >
            {showBlocked ? 'Hide' : 'Show'} the {blocked.length} {blocked.length === 1 ? 'provider' : 'providers'} that cannot run this model
          </button>
          {showBlocked && (
            <ul className="space-y-1" data-testid="blocked-providers">
              {blocked.map((m) => (
                <li key={m.adapter.key} className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  <Ban className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  <span>
                    <span className="font-medium text-foreground/70">{m.adapter.displayName}</span> {m.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {refusal && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs" data-testid="adapter-refusal">
          <p className="text-destructive">{refusal.message}</p>
          {refusal.accepts.length > 0 && (
            <p className="mt-1 text-muted-foreground">
              It accepts {refusal.accepts.join(', ')}.
            </p>
          )}
        </div>
      )}

      {error && (
        <p id="deploy-adapter-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  )
}

function AdapterCard({ adapter, selected, onSelect }: { adapter: ModelAdapter; selected: boolean; onSelect: () => void }) {
  const caps = adapter.capabilities
  const tags = [
    ...adapterSchemes(adapter).map(schemePrefix),
    caps.serverless ? 'serverless' : null,
    caps.dedicated ? 'dedicated' : null,
    caps.scaleToZero ? 'scale to zero' : null,
    caps.lora !== 'none' ? `lora: ${caps.lora}` : null,
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
