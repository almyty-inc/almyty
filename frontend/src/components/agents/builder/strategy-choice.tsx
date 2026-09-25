/**
 * "How they work together": the strategy an autonomous agent's roles run
 * in. One radio card per strategy the engine implements (the list is
 * checked against the backend by a source guard), each with a small
 * diagram of the flow and the slots it needs, filled or missing.
 *
 * When the chosen strategy is missing a slot, the card says which in a
 * sentence and offers to add each one; Save stays blocked until they are
 * filled.
 */
import { Fragment } from 'react'
import { ArrowRight, Check, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { AgentModels, AutonomousStrategyKey, RolePurpose } from '@/types/agent-models'
import {
  AUTONOMOUS_STRATEGY_KEYS,
  BEST_OF_N_DEFAULT,
  BEST_OF_N_MAX,
  BEST_OF_N_MIN,
  PURPOSE_LABELS,
  STRATEGY_DESCRIPTIONS,
  STRATEGY_LABELS,
  STRATEGY_OPTIONAL,
  STRATEGY_SLOTS,
  missingSlotCounts,
  missingSlotsSentence,
  newRole,
} from './agent-models'

/** A box in a strategy's diagram: the role purpose it stands for, and what it says. */
interface Box {
  purpose: RolePurpose
  text: string
}

/** The flow of each strategy, left to right. */
const FLOWS: Record<AutonomousStrategyKey, Box[]> = {
  single: [{ purpose: 'main', text: 'Main runs every step' }],
  cascade: [
    { purpose: 'drafter', text: 'Drafter takes the step' },
    { purpose: 'checker', text: 'Checker tries to refute' },
    { purpose: 'main', text: 'Main redoes it if refuted' },
  ],
  best_of_n: [
    { purpose: 'main', text: 'Main answers, then writes N-1 more' },
    { purpose: 'checker', text: 'Checker picks the best' },
  ],
  panel: [
    { purpose: 'main', text: 'Main works the task' },
    { purpose: 'panelist', text: 'Each panelist answers' },
    { purpose: 'checker', text: 'Checker (or main) writes the agreed answer' },
  ],
  explore_extract_patch: [
    { purpose: 'explorer', text: 'Explorers gather in parallel' },
    { purpose: 'summariser', text: 'Summariser writes a brief' },
    { purpose: 'main', text: 'Main does the task' },
    { purpose: 'checker', text: 'Checker verifies' },
  ],
}

export interface StrategyChoiceProps {
  models: AgentModels
  onChange: (next: AgentModels) => void
}

export function StrategyChoice({ models, onChange }: StrategyChoiceProps) {
  const missingSentence = missingSlotsSentence(models)
  const missing = missingSlotCounts(models)

  const addMissing = (purpose: RolePurpose) => {
    const need = missing.find((m) => m.purpose === purpose)?.missing ?? 1
    let roles = models.roles
    for (let i = 0; i < need; i++) roles = [...roles, newRole(roles, purpose)]
    onChange({ ...models, roles })
  }

  return (
    <Card data-testid="strategy-card">
      <CardHeader>
        <CardTitle className="text-base">How they work together</CardTitle>
        <CardDescription className="text-xs">
          The shape each request takes. Teammates are offered to the main role as helpers in every shape.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div role="radiogroup" aria-label="How the roles work together" className="grid grid-cols-1 gap-2">
          {AUTONOMOUS_STRATEGY_KEYS.map((key) => {
            const selected = models.strategy === key
            return (
              <div
                key={key}
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
                <NeedsLine strategy={key} models={models} />
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
          })}
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

function NeedsLine({ strategy, models }: { strategy: AutonomousStrategyKey; models: AgentModels }) {
  const slots = Object.entries(STRATEGY_SLOTS[strategy]) as Array<[RolePurpose, number]>
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" data-testid={`strategy-needs-${strategy}`}>
      <span className="text-muted-foreground">Needs:</span>
      {slots.map(([purpose, min]) => {
        const have = models.roles.filter((r) => r.purpose === purpose).length
        const ok = have >= min
        return (
          <span
            key={purpose}
            data-slot={purpose}
            data-filled={ok}
            className={cn('inline-flex items-center gap-1', ok ? 'text-foreground' : 'text-muted-foreground')}
          >
            {ok ? (
              <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ) : (
              <span className="h-2.5 w-2.5 rounded-full border border-dashed border-muted-foreground" aria-hidden />
            )}
            {min > 1 ? `${min}+ ${PURPOSE_LABELS[purpose].toLowerCase()}s` : PURPOSE_LABELS[purpose].toLowerCase()}
            <span className="sr-only">{ok ? '(filled)' : '(missing)'}</span>
          </span>
        )
      })}
      {STRATEGY_OPTIONAL[strategy].map((purpose) => (
        <span key={purpose} className="text-muted-foreground">
          Optional: {PURPOSE_LABELS[purpose].toLowerCase()}
          {strategy === 'panel' && purpose === 'checker' ? ' as the judge' : ''}
        </span>
      ))}
    </div>
  )
}
