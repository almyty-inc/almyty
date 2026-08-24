import React from 'react'
import { ShieldCheck } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
 * The editable part of an agent's run limits.
 *
 * Everything here is a ceiling the agent may lower, never raise: the
 * resolver takes the smallest value across the operator's environment
 * floor, the organization, the agent and the run. Leaving a field empty
 * means "inherit", which is why nothing is pre-filled with a number that
 * would silently become this agent's own ceiling.
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

export interface RunLimitsSectionProps {
  value: RunLimitsConfig
  onChange: (next: RunLimitsConfig) => void
  /**
   * Ceilings already in force above this agent, shown as the inherited
   * value so an operator can see what "empty" actually means here.
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

export function RunLimitsSection({ value, onChange, inherited }: RunLimitsSectionProps) {
  const set = <K extends keyof RunLimitsConfig>(key: K, next: RunLimitsConfig[K]) =>
    onChange({ ...value, [key]: next })

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
        <p className="text-xs text-muted-foreground">
          Ceilings for a single run. Leave a field empty to inherit it. An agent can only tighten
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
            <Label htmlFor="run-limit-cost">Cost cap (cents)</Label>
            <Input
              id="run-limit-cost"
              inputMode="numeric"
              value={value.maxCostCents ?? ''}
              placeholder={placeholder(inherited?.maxCostCents)}
              onChange={(e) => set('maxCostCents', numberOrNull(e.target.value))}
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
      </CardContent>
    </Card>
  )
}
