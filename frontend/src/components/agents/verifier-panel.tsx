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
import type { Agent } from '@/types'

type Verify = NonNullable<NonNullable<Agent['agentConfig']>['verify']>

/** Provider id -> its name, from the org's providers (the list answers bare or wrapped). */
export function useProviderNames(): (id?: string) => string {
  const { data } = useQuery<any>({ ...llmProvidersQuery })
  const list: any[] = Array.isArray(data) ? data : data?.providers || []
  const byId = new Map<string, any>(list.map((p: any) => [p.id, p]))
  return (id?: string) => {
    const p = id ? byId.get(id) : undefined
    return p ? p.name || p.type : id ? 'provider' : '—'
  }
}

export function VerifierPanelList({ verify }: { verify: Verify }) {
  const nameOf = useProviderNames()
  return (
    <div className="space-y-1" data-testid="verifier-panel-list">
      {(verify.checkers || []).map((c, i) => (
        <div key={i} className="flex items-center gap-2 text-sm rounded border bg-background px-2 py-1">
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
      <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
      Verifier panel
      {children}
    </div>
  )
}
