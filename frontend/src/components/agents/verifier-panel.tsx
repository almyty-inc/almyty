/**
 * An autonomous agent's verifier panel, read-only: the reviewers that check
 * every final answer, each with its provider and model. The agent's
 * overview and its edit page both show it with this, so they describe the
 * same agent. It is changed on the overview (Configure verification).
 */
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { llmProvidersQuery } from '@/lib/llm-providers-query'
import { pluralized } from '@/lib/utils'
import { providerTypeLabels } from '@/components/llm-providers/provider-type-config'
import type { Agent } from '@/types'

type Verify = NonNullable<NonNullable<Agent['agentConfig']>['verify']>

/** How the reviewers' verdicts combine, in words a person reads. */
export const VERIFY_POLICY_LABELS: Record<string, string> = {
  any_fail_blocks: 'Any reviewer can block',
  all_pass: 'All reviewers must pass',
  majority: 'Most reviewers decide',
}

/** When the reviewers check, in words a person reads. */
export const VERIFY_TRIGGER_LABELS: Record<string, string> = {
  on_final_output: 'the final answer',
  every_n_steps: 'every few steps',
  on_tool_result: 'each tool result',
}

/** A policy value as a label; an unknown value is shown as words, never as a raw id. */
export function verifyPolicyLabel(policy?: string): string {
  const p = policy || 'any_fail_blocks'
  return VERIFY_POLICY_LABELS[p] ?? p.replace(/_/g, ' ')
}

/** The triggers as one sentence: "Checks the final answer and each tool result". */
export function verifyTriggersLabel(triggers: string[], everyNSteps?: number): string {
  const parts = triggers.map((t) =>
    t === 'every_n_steps' && everyNSteps ? `every ${pluralized(everyNSteps, 'step')}` : VERIFY_TRIGGER_LABELS[t] ?? t.replace(/_/g, ' '),
  )
  if (parts.length === 0) return ''
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `Checks ${list}`
}

/**
 * Provider id -> the vendor a person recognises ("OpenAI"), from the org's
 * providers (the list answers bare or wrapped). Not the connection's own
 * name: that is free text and often names a model ("OpenAI · GPT-4o") that
 * is not the one a role runs, so the role's model is shown beside it instead.
 */
export function useProviderNames(): (id?: string) => string {
  const { data } = useQuery<any>({ ...llmProvidersQuery })
  const list: any[] = Array.isArray(data) ? data : data?.providers || []
  const byId = new Map<string, any>(list.map((p: any) => [p.id, p]))
  return (id?: string) => {
    const p = id ? byId.get(id) : undefined
    if (!p) return id ? 'provider' : '—'
    return (providerTypeLabels as Record<string, string>)[p.type] || p.name || p.type
  }
}

export function VerifierPanelList({ verify }: { verify: Verify }) {
  const nameOf = useProviderNames()
  return (
    <div className="space-y-1" data-testid="verifier-panel-list">
      {(verify.checkers || []).map((c, i) => (
        <div key={i} className="flex items-center gap-2 text-sm rounded border bg-background dark:bg-muted/40 px-2 py-1">
          <span className="text-foreground">{c.name || `Reviewer ${i + 1}`}</span>
          <Badge variant="secondary" className="text-[10px]">{nameOf(c.providerId)}</Badge>
          {c.model && <span className="font-mono text-[11px] text-muted-foreground">{c.model}</span>}
        </div>
      ))}
    </div>
  )
}

export function VerifierPanelHeading({ children }: { children?: ReactNode }) {
  return (
    <div className="text-xs font-medium text-muted-foreground mb-1.5 flex flex-wrap items-center gap-1.5">
      <ShieldCheck className="h-3.5 w-3.5 text-success" />
      Verifier panel
      {children}
    </div>
  )
}
