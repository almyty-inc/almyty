/**
 * The models of one provider connection, ticked or not, and the switch
 * that says what a model the provider adds later does.
 *
 * Every model the key reaches is ticked by default. Untick a model to keep
 * it out of every model chooser and away from the router; untick all but
 * one to pin a key to that model ("this Hugging Face key serves Llama 70B
 * and nothing else"). The rule and the request body live in
 * lib/model-access.ts, the same rule the backend applies.
 *
 * Used on a connection's page and as the last step of adding a connection.
 */
import { useMemo, useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { InlineFormActions } from '@/components/layout/form-page'
import { AvailabilityBadge, availability, effectivePrice, formatContext, formatPrice } from '@/components/models/model-row'
import { llmProvidersApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { modelAccessBody, modelAccessOf, tickedModels, withSwitch, withTicked, type ModelAccess, type ModelAccessFields } from '@/lib/model-access'
import { textMatchesSearch } from '@/lib/model-search'
import { pluralized } from '@/lib/utils'
import type { ModelCard } from '@/types/models'

export interface AllowedModelsEditorProps {
  provider: ModelAccessFields & { id: string; name: string }
  /** The connection's model cards (GET /models?providerId=). */
  cards: ModelCard[]
  /** Called with the saved connection. */
  onSaved?: (provider: any) => void
  /** Present = a Cancel (or Skip) button next to Save. */
  onCancel?: () => void
  submitLabel?: string
  cancelLabel?: string
  /** Save even when nothing changed (the last step of adding a connection). */
  alwaysSubmittable?: boolean
}

function sameAccess(a: ModelAccess, b: ModelAccess): boolean {
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i])
  return a.allowNewModels === b.allowNewModels && eq([...a.hiddenModels].sort(), [...b.hiddenModels].sort()) && eq([...a.allowedModels].sort(), [...b.allowedModels].sort())
}

export function AllowedModelsEditor({ provider, cards, onSaved, onCancel, submitLabel = 'Save', cancelLabel = 'Cancel', alwaysSubmittable = false }: AllowedModelsEditorProps) {
  const saved = useMemo(() => modelAccessOf(provider), [provider])
  const [access, setAccess] = useState<ModelAccess>(saved)
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Models the provider still offers; one it stopped listing cannot be picked either way.
  const listed = useMemo(
    () => cards.filter((c) => c.status !== 'inactive').sort((a, b) => a.name.localeCompare(b.name)),
    [cards],
  )
  const retired = cards.length - listed.length
  const all = useMemo(() => listed.map((c) => c.vendorModelId), [listed])
  const ticked = useMemo(() => new Set(tickedModels(access, all)), [access, all])
  const shown = useMemo(() => listed.filter((c) => !search.trim() || textMatchesSearch(search, c.name, c.vendorModelId)), [listed, search])
  const dirty = !sameAccess(access, saved)

  const save = useMutation({
    mutationFn: (next: ModelAccess) => llmProvidersApi.update(provider.id, modelAccessBody(next)),
    onSuccess: (result) => {
      setError(null)
      onSaved?.(result)
    },
    onError: (e) => setError(getApiErrorMessage(e, 'The models were not saved.')),
  })

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...ticked, id] : [...ticked].filter((x) => x !== id)
    setAccess(withTicked(access, all, next))
    setError(null)
  }
  const setShown = (on: boolean) => {
    const ids = new Set(shown.map((c) => c.vendorModelId))
    const next = on ? [...new Set([...ticked, ...ids])] : [...ticked].filter((id) => !ids.has(id))
    setAccess(withTicked(access, all, next))
    setError(null)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (all.length > 0 && ticked.size === 0) {
      setError(access.allowNewModels ? 'Tick at least one model. To stop using this connection, remove it.' : 'Tick at least one model, or allow new models automatically.')
      return
    }
    // Nothing changed: nothing to send.
    if (!dirty) {
      onSaved?.(provider)
      return
    }
    save.mutate(access)
  }

  const allShownTicked = shown.length > 0 && shown.every((c) => ticked.has(c.vendorModelId))

  return (
    <form onSubmit={submit} className="space-y-4" aria-label={`Models of ${provider.name}`} data-testid="allowed-models-editor">
      <div className="flex items-start gap-3 rounded-lg border p-3">
        <Switch
          id={`allow-new-${provider.id}`}
          checked={access.allowNewModels}
          onCheckedChange={(on) => {
            setAccess(withSwitch(access, all, on))
            setError(null)
          }}
          aria-describedby={`allow-new-${provider.id}-hint`}
        />
        <div className="space-y-0.5">
          <Label htmlFor={`allow-new-${provider.id}`}>Allow new models automatically</Label>
          <p id={`allow-new-${provider.id}-hint`} className="text-xs text-muted-foreground">
            {access.allowNewModels
              ? 'Models the provider adds later are ticked and offered right away.'
              : 'Only the ticked models are offered. Models the provider adds later stay unticked until you tick them.'}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search models" aria-label="Search models" />
        </div>
        <span className="text-sm text-muted-foreground" data-testid="ticked-count">
          {ticked.size} of {pluralized(all.length, 'model')} ticked
        </span>
      </div>

      {listed.length === 0 ? (
        <p className="rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">
          This connection lists no models yet. Check it again once the provider has some.
        </p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    aria-label={allShownTicked ? 'Untick every model shown' : 'Tick every model shown'}
                    checked={allShownTicked}
                    onCheckedChange={(on) => setShown(on === true)}
                  />
                </TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="hidden sm:table-cell">Price per 1M tokens</TableHead>
                <TableHead className="hidden md:table-cell">Context</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((card) => {
                const on = ticked.has(card.vendorModelId)
                const price = effectivePrice(card)
                const state = availability({ ...card, allowed: on, selectable: on && card.validationStatus === 'passed' && card.status === 'active' })
                return (
                  <TableRow key={card.id} data-testid={`allowed-model-${card.vendorModelId}`} data-state={on ? 'checked' : 'unchecked'}>
                    <TableCell>
                      <Checkbox aria-label={`Allow ${card.name}`} checked={on} onCheckedChange={(v) => toggle(card.vendorModelId, v === true)} />
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{card.name}</span>
                        {card.isNew && <Badge variant="secondary">New</Badge>}
                      </div>
                      {card.vendorModelId !== card.name && <div className="truncate font-mono text-xs text-muted-foreground">{card.vendorModelId}</div>}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-xs tabular-nums sm:table-cell">{formatPrice(price)}</TableCell>
                    <TableCell className="hidden text-xs tabular-nums md:table-cell">{formatContext(card.contextLength)}</TableCell>
                    <TableCell>
                      <AvailabilityBadge value={state} />
                    </TableCell>
                  </TableRow>
                )
              })}
              {shown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                    No models match.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
      {retired > 0 && <p className="text-xs text-muted-foreground">{pluralized(retired, 'model')} the provider no longer offers {retired === 1 ? 'is' : 'are'} left out.</p>}

      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="allowed-models-error">
          {error}
        </p>
      )}
      {onCancel ? (
        <InlineFormActions onCancel={onCancel} cancelLabel={cancelLabel} submitLabel={submitLabel} submitting={save.isPending} submitDisabled={!dirty && !alwaysSubmittable} />
      ) : (
        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending || (!dirty && !alwaysSubmittable)}>
            {save.isPending ? 'Saving...' : submitLabel}
          </Button>
        </div>
      )}
    </form>
  )
}
