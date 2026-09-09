import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { modelsApi } from '@/lib/models-api'
import {
  MODEL_CAPABILITY_KEYS,
  MODEL_CAPABILITY_LABELS,
  MODEL_PRIVACY_TIERS,
  MODEL_PRIVACY_TIER_LABELS,
  ROUTING_OBJECTIVES,
  ROUTING_OBJECTIVE_LABELS,
  type ModelCapabilities,
  type ModelCard,
  type ModelPrivacyTier,
  type RoutingObjective,
  type RoutingPolicy,
} from '@/types/models'

export type RoutingCardOption = Pick<ModelCard, 'id' | 'name' | 'vendorModelId' | 'privacyTier' | 'region'>

interface RoutingPolicyEditorProps {
  value: RoutingPolicy
  onChange: (policy: RoutingPolicy) => void
  /** Selectable cards the chain and the pin may reference. */
  cards: RoutingCardOption[]
  cardsLoading?: boolean
}

const ANY = '__any__'

function cardLabel(card: RoutingCardOption | undefined, id: string): string {
  if (!card) return id
  return card.name === card.vendorModelId ? card.name : `${card.name} (${card.vendorModelId})`
}

/**
 * Edits an llm_call node's routing policy. Pure: everything it needs is a
 * prop, every change goes through onChange with the whole policy.
 */
export function RoutingPolicyEditor({ value, onChange, cards, cardsLoading }: RoutingPolicyEditorProps) {
  const [regionDraft, setRegionDraft] = useState('')
  const policy = value || {}
  const objective: RoutingObjective = policy.objective || 'cheapest'
  const regions = policy.regions || []
  const chain = policy.fallbackChain || []
  const caps: ModelCapabilities = policy.capabilities || {}
  const byId = new Map(cards.map((c) => [c.id, c]))

  const patch = (changes: Partial<RoutingPolicy>) => {
    const next: RoutingPolicy = { ...policy, ...changes }
    // Drop empty collections so the saved config stays minimal.
    if (next.regions && next.regions.length === 0) delete next.regions
    if (next.fallbackChain && next.fallbackChain.length === 0) delete next.fallbackChain
    if (next.capabilities && Object.keys(next.capabilities).length === 0) delete next.capabilities
    if (next.privacyTier === undefined) delete next.privacyTier
    if (next.pinnedModel === undefined || next.pinnedModel === '') delete next.pinnedModel
    if (next.budgetHeadroomCents === undefined || next.budgetHeadroomCents === null) delete next.budgetHeadroomCents
    onChange(next)
  }

  const addRegion = () => {
    const region = regionDraft.trim()
    if (!region) return
    if (!regions.includes(region)) patch({ regions: [...regions, region] })
    setRegionDraft('')
  }

  const moveChain = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= chain.length) return
    const next = [...chain]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    patch({ fallbackChain: next })
  }

  const chainCandidates = cards.filter((c) => !chain.includes(c.id))

  return (
    <div className="space-y-3" data-testid="routing-policy-editor">
      <div>
        <Label htmlFor="routing-objective">Objective</Label>
        <Select value={objective} onValueChange={(v) => patch({ objective: v as RoutingObjective })}>
          <SelectTrigger id="routing-objective" className="mt-1" aria-label="Objective">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROUTING_OBJECTIVES.map((o) => (
              <SelectItem key={o} value={o}>{ROUTING_OBJECTIVE_LABELS[o]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground mt-1">
          {objective === 'cheapest' && 'Lowest blended feed price among the cards that pass the filters.'}
          {objective === 'fastest' && 'Lowest measured p50 latency among the cards that pass the filters.'}
          {objective === 'pinned' && 'Always the pinned card; the fallback chain takes over when it fails.'}
        </p>
      </div>

      {objective === 'pinned' && (
        <div>
          <Label htmlFor="routing-pinned">Pinned card</Label>
          <Select value={policy.pinnedModel || ''} onValueChange={(v) => patch({ pinnedModel: v })}>
            <SelectTrigger id="routing-pinned" className="mt-1" aria-label="Pinned card">
              <SelectValue placeholder={cardsLoading ? 'Loading cards...' : cards.length ? 'Select card' : 'No selectable cards'} />
            </SelectTrigger>
            <SelectContent>
              {cards.map((c) => (
                <SelectItem key={c.id} value={c.id}>{cardLabel(c, c.id)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div>
        <Label htmlFor="routing-tier">Privacy tier ceiling</Label>
        <Select value={policy.privacyTier || ANY} onValueChange={(v) => patch({ privacyTier: v === ANY ? undefined : (v as ModelPrivacyTier) })}>
          <SelectTrigger id="routing-tier" className="mt-1" aria-label="Privacy tier ceiling">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any tier</SelectItem>
            {MODEL_PRIVACY_TIERS.map((tier) => (
              <SelectItem key={tier} value={tier}>{MODEL_PRIVACY_TIER_LABELS[tier]} or stricter</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor="routing-region">Regions</Label>
        <div className="flex gap-1 mt-1">
          <Input
            id="routing-region"
            className="h-8 text-xs"
            placeholder="eu-central, then Enter"
            value={regionDraft}
            onChange={(e) => setRegionDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                addRegion()
              }
            }}
          />
          <Button type="button" variant="outline" size="sm" className="h-8" onClick={addRegion}>Add</Button>
        </div>
        {regions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {regions.map((region) => (
              <span key={region} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]">
                {region}
                <button type="button" aria-label={`Remove region ${region}`} className="text-muted-foreground hover:text-foreground" onClick={() => patch({ regions: regions.filter((r) => r !== region) })}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground mt-1">Empty means any region.</p>
      </div>

      <div>
        <Label>Required capabilities</Label>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
          {MODEL_CAPABILITY_KEYS.map((key) => (
            <label key={key} className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                className="rounded"
                checked={!!caps[key]}
                aria-label={MODEL_CAPABILITY_LABELS[key]}
                onChange={(e) => {
                  const next = { ...caps }
                  if (e.target.checked) next[key] = true
                  else delete next[key]
                  patch({ capabilities: next })
                }}
              />
              {MODEL_CAPABILITY_LABELS[key]}
            </label>
          ))}
        </div>
      </div>

      <div>
        <Label htmlFor="routing-chain-add">Fallback chain</Label>
        {chain.length > 0 && (
          <ol className="mt-1 space-y-1">
            {chain.map((id, index) => (
              <li key={id} className="flex items-center gap-1 rounded border bg-background px-2 py-1 text-xs">
                <span className="text-muted-foreground font-mono w-4">{index + 1}.</span>
                <span className="truncate flex-1" title={cardLabel(byId.get(id), id)}>{cardLabel(byId.get(id), id)}</span>
                <button type="button" aria-label={`Move ${cardLabel(byId.get(id), id)} up`} className="text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={index === 0} onClick={() => moveChain(index, -1)}>
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button type="button" aria-label={`Move ${cardLabel(byId.get(id), id)} down`} className="text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={index === chain.length - 1} onClick={() => moveChain(index, 1)}>
                  <ArrowDown className="h-3 w-3" />
                </button>
                <button type="button" aria-label={`Remove ${cardLabel(byId.get(id), id)} from chain`} className="text-muted-foreground hover:text-foreground" onClick={() => patch({ fallbackChain: chain.filter((c) => c !== id) })}>
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ol>
        )}
        <Select value="" onValueChange={(v) => { if (v) patch({ fallbackChain: [...chain, v] }) }}>
          <SelectTrigger id="routing-chain-add" className="mt-1 h-8 text-xs" aria-label="Add card to fallback chain">
            <SelectValue placeholder={cardsLoading ? 'Loading cards...' : chainCandidates.length ? 'Add card...' : cards.length ? 'All cards in chain' : 'No selectable cards'} />
          </SelectTrigger>
          <SelectContent>
            {chainCandidates.map((c) => (
              <SelectItem key={c.id} value={c.id}>{cardLabel(c, c.id)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground mt-1">Tried in order when set; otherwise the objective orders the candidates.</p>
      </div>

      <div>
        <Label htmlFor="routing-budget">Budget headroom, cents</Label>
        <Input
          id="routing-budget"
          type="number"
          min={0}
          className="mt-1 h-8 text-xs"
          placeholder="No limit"
          value={policy.budgetHeadroomCents ?? ''}
          onChange={(e) => patch({ budgetHeadroomCents: e.target.value === '' ? undefined : Number(e.target.value) })}
        />
        <p className="text-[11px] text-muted-foreground mt-1">Skip cards whose estimated cost would exceed what is left of the budget.</p>
      </div>
    </div>
  )
}

/** Loads the selectable cards and renders the editor. */
export function RoutingPolicyField({ value, onChange }: { value: RoutingPolicy; onChange: (policy: RoutingPolicy) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['models', 'selectable'],
    queryFn: async () => {
      const rows = await modelsApi.list({ selectable: true })
      return Array.isArray(rows) ? rows : []
    },
    staleTime: 30_000,
  })
  return <RoutingPolicyEditor value={value} onChange={onChange} cards={data || []} cardsLoading={isLoading} />
}
