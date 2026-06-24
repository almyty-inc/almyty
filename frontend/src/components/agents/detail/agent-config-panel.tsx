/**
 * Models & Verification panel for the agent detail Overview. Surfaces the
 * thing that makes almyty autonomous agents distinctive: ONE agent driven by a
 * primary LLM, with a verifier panel of OTHER LLMs (different vendors) checking
 * every answer — plus the failure-memory constraints and memory config. This is
 * the multi-LLM-in-one-agent story, which previously lived only in the DB.
 */
import { useQuery } from '@tanstack/react-query'
import { Cpu, ShieldCheck, ShieldAlert, Repeat, Brain } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { llmProvidersApi } from '@/lib/api'
import type { Agent } from '@/types'

export function AgentConfigPanel({ agent }: { agent: Agent }) {
  const { data: providers } = useQuery<any[]>({
    queryKey: ['llm-providers'],
    queryFn: () => llmProvidersApi.getAll(),
  })
  const provMap = new Map<string, any>((providers || []).map((p: any) => [p.id, p]))
  const vendorOf = (id?: string) => (id && provMap.get(id)?.type) || id || ''
  const labelOf = (id?: string) => {
    const p = id ? provMap.get(id) : undefined
    return p ? p.name || p.type : id ? 'provider' : '—'
  }

  const mc = agent.modelConfig || {}
  const verify = agent.agentConfig?.verify
  const constraints = agent.agentConfig?.constraints
  const memory = agent.memoryConfig

  // Distinct vendors across primary + verifier checkers = the headline number.
  const vendors = new Set<string>()
  if (mc.providerId) vendors.add(vendorOf(mc.providerId))
  if (verify?.enabled) (verify.checkers || []).forEach((c) => c.providerId && vendors.add(vendorOf(c.providerId)))
  const multiVendor = vendors.size > 1

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Cpu className="h-4 w-4 text-primary" /> Models &amp; Verification
          </CardTitle>
          <Badge variant="outline" className="capitalize">{agent.mode} mode</Badge>
        </div>
        {multiVendor && (
          <CardDescription className="text-xs">
            {vendors.size} LLM vendors collaborating inside this one agent — a primary model plus a
            cross-vendor verifier panel.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Primary model */}
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1.5">Primary model</div>
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="secondary" className="text-[10px]">{labelOf(mc.providerId)}</Badge>
            <span className="font-mono text-xs">{mc.model || '—'}</span>
            {typeof mc.temperature === 'number' && (
              <span className="text-xs text-muted-foreground">· temp {mc.temperature}</span>
            )}
          </div>
        </div>

        {/* Verifier panel */}
        {verify?.enabled && (
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1.5 flex flex-wrap items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              Verifier panel
              <Badge variant="outline" className="text-[10px]">{verify.policy || 'any_fail_blocks'}</Badge>
              {verify.maxReviseLoops != null && (
                <Badge variant="outline" className="text-[10px] gap-1">
                  <Repeat className="h-3 w-3" />
                  {verify.maxReviseLoops} revisions
                </Badge>
              )}
            </div>
            <div className="space-y-1">
              {(verify.checkers || []).map((c, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-sm rounded border bg-background px-2 py-1"
                >
                  <span className="text-foreground">{c.name || `Reviewer ${i + 1}`}</span>
                  <Badge variant="secondary" className="text-[10px]">{labelOf(c.providerId)}</Badge>
                  {c.model && <span className="font-mono text-[11px] text-muted-foreground">{c.model}</span>}
                </div>
              ))}
            </div>
            {verify.triggers && verify.triggers.length > 0 && (
              <div className="text-[10px] text-muted-foreground mt-1.5">
                Triggers: {verify.triggers.join(', ')}
                {verify.everyNSteps ? ` (every ${verify.everyNSteps} steps)` : ''}
              </div>
            )}
          </div>
        )}

        {/* Feature chips */}
        {(constraints?.enabled || memory?.enabled) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {constraints?.enabled && (
              <Badge variant="outline" className="text-[10px] gap-1">
                <ShieldAlert className="h-3 w-3" />
                Constraints{constraints.autoLearn ? ' · auto-learn' : ''}
              </Badge>
            )}
            {memory?.enabled && (
              <Badge variant="outline" className="text-[10px] gap-1">
                <Brain className="h-3 w-3" />
                Memory{memory.autoSave ? ' · auto-save' : ''}
              </Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
