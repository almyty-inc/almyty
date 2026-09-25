/**
 * "How they work together": the strategy an autonomous agent's roles run
 * in. One radio card per strategy the engine implements (the list is
 * checked against the backend by a source guard), each with one plain
 * sentence and a small diagram of the flow. Single, Cascade and Best of N
 * are up front; the rest wait under "More ways".
 *
 * Under each card, only what is missing: "Add a drafter and a checker".
 * When the chosen strategy is missing a role, the card offers to add it;
 * Save stays blocked until it is filled.
 */
import { Fragment } from 'react'
import { ArrowRight, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { AgentModels, AutonomousStrategyKey, RolePurpose } from '@/types/agent-models'
import {
  AUTONOMOUS_STRATEGY_KEYS,
  BEST_OF_N_DEFAULT,
  BEST_OF_N_MAX,
  BEST_OF_N_MIN,
  PRIMARY_STRATEGY_KEYS,
  STRATEGY_DESCRIPTIONS,
  STRATEGY_LABELS,
  missingSlotCounts,
  missingSlotsAction,
  missingSlotsSentence,
  newRole,
} from './agent-models'

/** A box in a strategy's diagram: the role purpose it stands for, and what it says. */
interface Box {
  purpose: RolePurpose
  text: string
}

/** The flow of each strategy, left to right, in plain words. */
const FLOWS: Record<AutonomousStrategyKey, Box[]> = {
  single: [{ purpose: 'main', text: 'Main model does it all' }],
  cascade: [
    { purpose: 'drafter', text: 'Cheap model answers' },
    { purpose: 'checker', text: 'Checker double-checks' },
    { purpose: 'main', text: 'Main model fixes it if needed' },
  ],
  best_of_n: [
    { purpose: 'main', text: 'Main model writes several answers' },
    { purpose: 'checker', text: 'Checker picks the best' },
  ],
  panel: [
    { purpose: 'main', text: 'Main model answers' },
    { purpose: 'panelist', text: 'Others answer too' },
    { purpose: 'checker', text: 'One answer is written from all' },
  ],
  explore_extract_patch: [
    { purpose: 'explorer', text: 'Helpers look around' },
    { purpose: 'summariser', text: 'Findings summed up' },
    { purpose: 'main', text: 'Main model does the task' },
    { purpose: 'checker', text: 'Checker checks' },
  ],
}

export interface StrategyChoiceProps {
  models: AgentModels
  onChange: (next: AgentModels) => void
}

export function StrategyChoice({ models, onChange }: StrategyChoiceProps) {
  const missingSentence = missingSlotsSentence(models)
  const missing = missingSlotCounts(models)
  const primary = AUTONOMOUS_STRATEGY_KEYS.filter((k) => PRIMARY_STRATEGY_KEYS.includes(k))
  const more = AUTONOMOUS_STRATEGY_KEYS.filter((k) => !PRIMARY_STRATEGY_KEYS.includes(k))

  const addMissing = (purpose: RolePurpose) => {
    const need = missing.find((m) => m.purpose === purpose)?.missing ?? 1
    let roles = models.roles
    for (let i = 0; i < need; i++) roles = [...roles, newRole(roles, purpose)]
    onChange({ ...models, roles })
  }

  const option = (key: AutonomousStrategyKey) => (
    <StrategyOption key={key} strategy={key} models={models} onChange={onChange} />
  )

  return (
    <Card data-testid="strategy-card">
      <CardHeader>
        <CardTitle className="text-base">How they work together</CardTitle>
        <CardDescription className="text-xs">Pick how the models share the work.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div role="radiogroup" aria-label="How the roles work together" className="grid grid-cols-1 gap-2">
          {primary.map(option)}
          {more.length > 0 && (
            <Disclosure title="More ways" defaultOpen={more.includes(models.strategy)} className="text-sm" bodyClassName="space-y-2 px-3 py-3">
              {more.map(option)}
            </Disclosure>
          )}
        </div>

        {missingSentence && (
          <div
            data-testid="missing-slots"
            className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 space-y-2"
          >
            <p className="text-xs text-amber-800 dark:text-amber-300">{missingSentence}.</p>
            <div className="flex flex-wrap gap-2">
              {missing.map(({ purpose }) => (
                <Button key={purpose} type="button" variant="outline" size="sm" onClick={() => addMissing(purpose)}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Add {purpose}
                </Button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StrategyOption({ strategy: key, models, onChange }: { strategy: AutonomousStrategyKey; models: AgentModels; onChange: (next: AgentModels) => void }) {
  const selected = models.strategy === key
  const needs = missingSlotsAction({ strategy: key, roles: models.roles })
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      data-testid={`strategy-option-${key}`}
      data-strategy-key={key}
      onClick={() => !selected && onChange({ ...models, strategy: key })}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (!selected) onChange({ ...models, strategy: key })
        }
      }}
      className={cn(
        'rounded-md border p-3 cursor-pointer transition-colors space-y-2 text-left',
        selected ? 'border-violet-600 dark:border-violet-500 bg-violet-500/5' : 'hover:bg-muted/50',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'h-3.5 w-3.5 rounded-full border shrink-0',
            selected ? 'border-violet-600 dark:border-violet-500 border-4' : 'border-muted-foreground/50',
          )}
        />
        <span className="text-sm font-medium">{STRATEGY_LABELS[key]}</span>
        {key === 'explore_extract_patch' && (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Experimental</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{STRATEGY_DESCRIPTIONS[key]}</p>
      <FlowDiagram strategy={key} models={models} />
      {needs && (
        <p className="text-[11px] text-muted-foreground" data-testid={`strategy-needs-${key}`}>
          {needs}
        </p>
      )}
      {selected && key === 'best_of_n' && (
        <div className="flex items-center gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
          <Label htmlFor="best-of-n-candidates" className="text-xs">Candidates (N)</Label>
          <Input
            id="best-of-n-candidates"
            type="number"
            min={BEST_OF_N_MIN}
            max={BEST_OF_N_MAX}
            className="h-8 w-20 text-xs"
            value={models.candidates ?? BEST_OF_N_DEFAULT}
            onChange={(e) => onChange({ ...models, candidates: Number(e.target.value) })}
          />
          <span className="text-[11px] text-muted-foreground">
            {BEST_OF_N_MIN} to {BEST_OF_N_MAX}
          </span>
        </div>
      )}
    </div>
  )
}

function FlowDiagram({ strategy, models }: { strategy: AutonomousStrategyKey; models: AgentModels }) {
  const boxes = FLOWS[strategy]
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-hidden data-testid={`strategy-flow-${strategy}`}>
      {boxes.map((box, i) => {
        const filled = models.roles.some((r) => r.purpose === box.purpose)
        return (
          <Fragment key={i}>
            {i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />}
            <span
              className={cn(
                'rounded border px-1.5 py-0.5 text-[11px]',
                filled
                  ? 'border-cyan-600/50 dark:border-cyan-400/50 bg-cyan-500/5'
                  : 'border-dashed border-muted-foreground/40 text-muted-foreground',
              )}
            >
              {box.text}
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}
