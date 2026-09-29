/**
 * Who did what in an autonomous run, and what it cost.
 *
 * An autonomous agent's models are several roles (main, drafter, checker,
 * panelists...). The engine stamps each model-call step with the role that
 * made it, and the run's metadata with a cost line per role. These render
 * that: a role line on each step and a "Cost by role" table on the run.
 * Runs from before roles existed carry none of it and render as before.
 */
import { Bot, Cpu } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { PURPOSE_LABELS, STRATEGY_LABELS } from '@/components/agents/builder/agent-models'
import type { AgentRun, AgentRunStep } from '@/types'
import type { AutonomousStrategyKey, RoleCost, RolePurpose } from '@/types/agent-models'
import type { RouteAttribution } from '@/types/models'
import { RoutingAttribution } from './routing-attribution'

function purposeLabel(purpose: string): string {
  return PURPOSE_LABELS[purpose as RolePurpose] ?? purpose
}

function tokenCount(tokens: RoleCost['tokens'] | undefined): number {
  if (typeof tokens === 'number') return tokens
  if (tokens && typeof tokens === 'object') return (tokens.input || 0) + (tokens.output || 0)
  return 0
}

export function formatCost(cost: number | undefined): string {
  return typeof cost === 'number' && cost > 0 ? `$${cost.toFixed(4)}` : '--'
}

/** The model a step ran on: the routed card when the router chose, else the pinned model. */
export function stepModel(step: AgentRunStep): string | undefined {
  const out = step.output && typeof step.output === 'object' ? step.output : {}
  return out.routing?.vendorModelId || out.model || undefined
}

/** Steps whose meaning a sentence says better than their raw JSON. */
const SUMMARISED_TYPES = new Set(['judge', 'explore', 'extract_context', 'teammate_call'])

export function hasStepSummary(step: AgentRunStep): boolean {
  return SUMMARISED_TYPES.has(step.type)
}

function truncate(text: unknown, n = 160): string {
  const s = typeof text === 'string' ? text : text === undefined || text === null ? '' : JSON.stringify(text)
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** One sentence on what a step of the multi-model loop did, or null for an ordinary step. */
export function stepSummary(step: AgentRunStep): string | null {
  const out = step.output && typeof step.output === 'object' ? step.output : {}
  const input = step.input && typeof step.input === 'object' ? step.input : {}
  switch (step.type) {
    case 'llm_call':
      switch (out.status) {
        case 'drafted':
          return 'Drafted an answer for the checker'
        case 'escalated':
          return 'The draft failed the check; the main role redoes this step'
        case 'revising':
          return 'Revising after a failed check'
        case 'candidate':
          return typeof out.candidate === 'number' ? `Candidate ${out.candidate}` : 'Candidate answer'
        case 'panel_answer':
          return 'Panel answer'
        default:
          return null
      }
    case 'judge': {
      const n = typeof out.candidates === 'number' ? out.candidates : undefined
      if (out.strategy === 'panel') {
        const parts = [`Judged a panel${n ? ` of ${n}` : ''}`]
        if (typeof out.consensusReached === 'boolean') parts.push(out.consensusReached ? 'they agreed' : 'no consensus')
        if (typeof out.agreement === 'number') parts.push(`${Math.round(out.agreement * 100)}% agreement`)
        return parts.join(', ')
      }
      if (typeof out.picked === 'number') return `Picked candidate ${out.picked}${n ? ` of ${n}` : ''}`
      return n ? `Compared ${n} candidates` : 'Judged the candidates'
    }
    case 'explore': {
      const run = typeof input.childRunId === 'string' ? ` ${input.childRunId.slice(0, 8)}` : ''
      const status = out.status ? `: ${out.status}` : ''
      const preview = out.preview ? ` — ${truncate(out.preview)}` : ''
      return `Explorer run${run}${status}${preview}`
    }
    case 'extract_context':
      return out.brief ? `Brief: ${truncate(out.brief)}` : 'Wrote the brief'
    case 'teammate_call': {
      const who = typeof input.teammate === 'string' ? input.teammate : 'a teammate'
      return `Handed work to ${who}${out.preview ? ` — ${truncate(out.preview)}` : ''}`
    }
    default:
      return null
  }
}

/** The role and model that acted on a step, with its routing attribution when routed. */
export function StepRoleLine({ step }: { step: AgentRunStep }) {
  const role = step.role
  const model = stepModel(step)
  const routing = step.output && typeof step.output === 'object' ? (step.output.routing as RouteAttribution | undefined) : undefined
  if (!role && !model) return null
  return (
    <div className="space-y-0.5" data-testid="step-role">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {role && (
          <>
            {role.kind === 'agent' ? (
              <Bot className="h-3 w-3 text-muted-foreground" aria-hidden />
            ) : (
              <Cpu className="h-3 w-3 text-muted-foreground" aria-hidden />
            )}
            <span className="font-medium">{role.name}</span>
            <Badge variant="outline" className="text-[10px]">{purposeLabel(role.purpose)}</Badge>
          </>
        )}
        {model && !routing && <span className="font-mono text-muted-foreground">{model}</span>}
        {step.tokens && (step.tokens.input || step.tokens.output) ? (
          <span className="text-muted-foreground">
            {(step.tokens.input || 0).toLocaleString()} in / {(step.tokens.output || 0).toLocaleString()} out
          </span>
        ) : null}
      </div>
      {routing?.vendorModelId && <RoutingAttribution routing={routing} />}
    </div>
  )
}

/** The run's cost split by role, from `run.metadata.roleCosts`. Nothing for runs without it. */
export function RoleCostTable({ run }: { run: AgentRun }) {
  const roleCosts = run.metadata?.roleCosts as Record<string, RoleCost> | undefined
  const strategy = run.metadata?.strategy as AutonomousStrategyKey | undefined
  if (!roleCosts || typeof roleCosts !== 'object') return null
  const rows = Object.entries(roleCosts).sort(([, a], [, b]) => (b?.cost || 0) - (a?.cost || 0))
  if (rows.length === 0) return null
  return (
    <div data-testid="role-costs">
      <h4 className="mb-2 text-sm font-medium">
        Cost by role
        {strategy && (
          <span className="ml-2 text-xs font-normal text-muted-foreground" data-testid="run-strategy">
            {STRATEGY_LABELS[strategy] ?? strategy}
          </span>
        )}
      </h4>
      <div className="overflow-x-auto rounded border bg-background">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="px-2 py-1.5 text-left font-medium">Role</th>
              <th className="px-2 py-1.5 text-left font-medium">Purpose</th>
              <th className="px-2 py-1.5 text-right font-medium">Calls</th>
              <th className="px-2 py-1.5 text-right font-medium">Tokens</th>
              <th className="px-2 py-1.5 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, line]) => (
              <tr key={key} className="border-b last:border-0" data-testid={`role-cost-${key}`}>
                <td className="px-2 py-1.5 font-medium">{line?.name || key}</td>
                <td className="px-2 py-1.5">{purposeLabel(line?.purpose ?? '')}</td>
                <td className="px-2 py-1.5 text-right">{line?.calls ?? 0}</td>
                <td className="px-2 py-1.5 text-right">{tokenCount(line?.tokens).toLocaleString()}</td>
                <td className="px-2 py-1.5 text-right font-mono">{formatCost(line?.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
