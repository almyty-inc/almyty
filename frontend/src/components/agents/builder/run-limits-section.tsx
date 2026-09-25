import React, { useState } from 'react'
import { ShieldCheck } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * An agent's run limits: one plain line up front, the fields under
 * Advanced.
 *
 * Every run already has limits without anyone typing a number: the
 * server's defaults (DEFAULT_RUN_LIMITS in backend run-limits.ts), lowered
 * by whatever the organization set. The line says what they are ("Stops
 * after 50 steps, $1 or 15 minutes"), so most people never open the
 * fields. Everything in them is a ceiling the agent may lower, never
 * raise: the resolver takes the smallest value across the operator's
 * environment floor, the organization, the agent and the run. An empty
 * field means "inherit", which is why nothing is pre-filled with a number
 * that would silently become this agent's own ceiling.
 */

export interface RunLimitsConfig {
  maxSteps?: number | null
  maxTokens?: number | null
  maxCostCents?: number | null
  maxDurationMs?: number | null
  maxToolCalls?: number | null
  truncationPolicy?: 'drop_oldest' | 'summarise' | 'fail'
  toolErrorRetries?: number | null
  toolErrorFeedback?: 'full' | 'summarised' | 'suppressed'
}

/**
 * What the server applies when nobody set a limit. Mirrors
 * DEFAULT_RUN_LIMITS in backend/src/modules/agents/run-limits.ts; a test
 * reads that file so the two cannot drift.
 */
export const DEFAULT_RUN_LIMITS = {
  maxSteps: 50,
  maxCostCents: 100,
  maxDurationMs: 15 * 60 * 1000,
} as const

export interface RunLimitsSectionProps {
  value: RunLimitsConfig
  onChange: (next: RunLimitsConfig) => void
  /**
   * Ceilings already in force above this agent (the organization's
   * defaults), shown as the inherited value so "empty" is legible.
   */
  inherited?: {
    maxSteps?: number
    maxCostCents?: number
    maxDurationMs?: number
    maxTokens?: number
  }
}

const numberOrNull = (raw: string): number | null => {
  const value = Number(raw)
  return raw.trim() === '' || !Number.isFinite(value) || value <= 0 ? null : Math.floor(value)
}

const dollarsToCents = (raw: string): number | null => {
  const value = Number(raw)
  return raw.trim() === '' || !Number.isFinite(value) || value <= 0 ? null : Math.round(value * 100)
}

export const formatDollars = (cents: number) =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`

export const formatDuration = (ms: number) => {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = minutes / 60
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

type Headline = 'maxSteps' | 'maxCostCents' | 'maxDurationMs'

/** The limit a run will actually get for one key: the smallest one set, else the default. */
export function effectiveLimit(
  key: Headline,
  value: RunLimitsConfig,
  inherited?: RunLimitsSectionProps['inherited'],
): number {
  const set = [value[key], inherited?.[key]].filter((n): n is number => typeof n === 'number' && n > 0)
  return set.length ? Math.min(...set) : DEFAULT_RUN_LIMITS[key]
}

/** "Stops after 50 steps, $1 or 15 minutes, whichever comes first." */
export function runLimitsSummary(value: RunLimitsConfig, inherited?: RunLimitsSectionProps['inherited']): string {
  const steps = effectiveLimit('maxSteps', value, inherited)
  const cost = effectiveLimit('maxCostCents', value, inherited)
  const time = effectiveLimit('maxDurationMs', value, inherited)
  return `Stops after ${steps} step${steps === 1 ? '' : 's'}, ${formatDollars(cost)} or ${formatDuration(time)}, whichever comes first.`
}

export function RunLimitsSection({ value, onChange, inherited }: RunLimitsSectionProps) {
  const set = <K extends keyof RunLimitsConfig>(key: K, next: RunLimitsConfig[K]) =>
    onChange({ ...value, [key]: next })

  // The cost field is typed in dollars and kept as text while typing, so
  // "1." does not snap back to "1" before the cents arrive.
  const [costText, setCostText] = useState(value.maxCostCents ? String(value.maxCostCents / 100) : '')

  const placeholder = (n?: number) => (n === undefined ? 'Inherited' : `Inherited: ${n}`)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          Run limits
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm" data-testid="run-limits-summary">{runLimitsSummary(value, inherited)}</p>

        <Disclosure title="Advanced" summary="Change steps, cost, time and error handling">
          <p className="text-xs text-muted-foreground">
            Limits for a single run. Leave a field empty to inherit it. An agent can only tighten
            what your organization and your deployment already allow, never raise it.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="run-limit-steps">Max steps</Label>
              <Input
                id="run-limit-steps"
                inputMode="numeric"
                value={value.maxSteps ?? ''}
                placeholder={placeholder(inherited?.maxSteps)}
                onChange={(e) => set('maxSteps', numberOrNull(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                How many times the agent may loop before the run is stopped.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="run-limit-cost">Spending cap ($)</Label>
              <Input
                id="run-limit-cost"
                inputMode="decimal"
                value={costText}
                placeholder={
                  inherited?.maxCostCents ? `Inherited: ${formatDollars(inherited.maxCostCents)}` : 'Inherited'
                }
                onChange={(e) => {
                  setCostText(e.target.value)
                  set('maxCostCents', dollarsToCents(e.target.value))
                }}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="run-limit-tokens">Token budget</Label>
              <Input
                id="run-limit-tokens"
                inputMode="numeric"
                value={value.maxTokens ?? ''}
                placeholder={placeholder(inherited?.maxTokens)}
                onChange={(e) => set('maxTokens', numberOrNull(e.target.value))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="run-limit-wallclock">Timeout (seconds)</Label>
              <Input
                id="run-limit-wallclock"
                inputMode="numeric"
                value={value.maxDurationMs ? Math.round(value.maxDurationMs / 1000) : ''}
                placeholder={
                  inherited?.maxDurationMs
                    ? `Inherited: ${Math.round(inherited.maxDurationMs / 1000)}`
                    : 'Inherited'
                }
                onChange={(e) => {
                  const seconds = numberOrNull(e.target.value)
                  set('maxDurationMs', seconds === null ? null : seconds * 1000)
                }}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="run-limit-tool-calls">Max tool calls</Label>
              <Input
                id="run-limit-tool-calls"
                inputMode="numeric"
                value={value.maxToolCalls ?? ''}
                placeholder="Inherited"
                onChange={(e) => set('maxToolCalls', numberOrNull(e.target.value))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="run-limit-retries">Tool error retries</Label>
              <Input
                id="run-limit-retries"
                inputMode="numeric"
                value={value.toolErrorRetries ?? ''}
                placeholder="Inherited"
                onChange={(e) => set('toolErrorRetries', numberOrNull(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                A tool that sets its own retry count still wins over this.
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="run-limit-truncation">When the context budget runs out</Label>
              <Select
                value={value.truncationPolicy ?? 'drop_oldest'}
                onValueChange={(v) => set('truncationPolicy', v as RunLimitsConfig['truncationPolicy'])}
              >
                <SelectTrigger id="run-limit-truncation">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="drop_oldest">Drop the oldest turns</SelectItem>
                  <SelectItem value="summarise">Summarise the older turns</SelectItem>
                  <SelectItem value="fail">Stop the run</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="run-limit-feedback">When a tool call fails</Label>
              <Select
                value={value.toolErrorFeedback ?? 'full'}
                onValueChange={(v) =>
                  set('toolErrorFeedback', v as RunLimitsConfig['toolErrorFeedback'])
                }
              >
                <SelectTrigger id="run-limit-feedback">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Show the agent the full error</SelectItem>
                  <SelectItem value="summarised">Show a one-line summary</SelectItem>
                  <SelectItem value="suppressed">Only say that it failed</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Summarise or suppress when a tool's errors may echo request data back.
              </p>
            </div>
          </div>
        </Disclosure>
      </CardContent>
    </Card>
  )
}
