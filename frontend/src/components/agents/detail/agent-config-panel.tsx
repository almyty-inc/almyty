/**
 * Models & verification panel for the agent detail Overview: the roles
 * the agent runs and how they work together (the same `models` its edit
 * page shows, read the same way), the verifier panel of other models that
 * checks every final answer, and the constraints and memory switches.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Cpu, ShieldAlert, Repeat, Brain, Settings2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { VerifyConfigEditor } from './verify-config-editor'
import { VerifierPanelHeading, VerifierPanelList, useProviderNames } from '@/components/agents/verifier-panel'
import { PURPOSE_LABELS, STRATEGY_LABELS, modelsFromAgent } from '@/components/agents/builder/agent-models'
import type { Agent } from '@/types'
import { llmProvidersQuery } from '@/lib/llm-providers-query'

export function AgentConfigPanel({ agent }: { agent: Agent }) {
  const [editingVerify, setEditingVerify] = useState(false)
  const { data: providersData } = useQuery<any>({
    ...llmProvidersQuery,
  })
  // getAll() may return a bare array or a { providers: [...] } envelope.
  const providers: any[] = Array.isArray(providersData)
    ? providersData
    : providersData?.providers || []
  const provMap = new Map<string, any>(providers.map((p: any) => [p.id, p]))
  const vendorOf = (id?: string) => (id && provMap.get(id)?.type) || id || ''
  const nameOf = useProviderNames()

  const models = modelsFromAgent(agent as Agent & { collaboration?: unknown })
  const verify = agent.agentConfig?.verify
  const constraints = agent.agentConfig?.constraints
  const memory = agent.memoryConfig

  // Distinct vendors across every role and every reviewer.
  const vendors = new Set<string>()
  for (const r of models.roles) if (r.kind === 'model' && r.providerId) vendors.add(vendorOf(r.providerId))
  if (verify?.enabled) (verify.checkers || []).forEach((c) => c.providerId && vendors.add(vendorOf(c.providerId)))
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Cpu className="h-4 w-4 text-primary" /> Models &amp; verification
          </CardTitle>
          <div className="flex items-center gap-2">
            {!editingVerify && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditingVerify(true)}>
                <Settings2 className="h-3.5 w-3.5" />
                Configure verification
              </Button>
            )}
            <Badge variant="outline" className="capitalize">{agent.mode} mode</Badge>
          </div>
        </div>
        {vendors.size > 1 && (
          <CardDescription className="text-xs">Uses models from {vendors.size} providers.</CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Edited in place, not in a modal. */}
        {editingVerify && <VerifyConfigEditor agent={agent} onDone={() => setEditingVerify(false)} />}
        {/* The roles, as the edit page shows them */}
        <div data-testid="overview-models">
          <div className="text-xs font-medium text-muted-foreground mb-1.5">
            Models <span className="font-normal">· {STRATEGY_LABELS[models.strategy]}</span>
          </div>
          <div className="space-y-1">
            {models.roles.map((r) => (
              <div key={r.key} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-foreground">{r.name}</span>
                {r.name !== PURPOSE_LABELS[r.purpose] && <span className="text-xs text-muted-foreground">{PURPOSE_LABELS[r.purpose]}</span>}
                {r.kind === 'agent' ? (
                  <Badge variant="secondary" className="text-[10px]">Another agent</Badge>
                ) : r.routing ? (
                  <Badge variant="secondary" className="text-[10px]">Automatic</Badge>
                ) : (
                  <>
                    <Badge variant="secondary" className="text-[10px]">{nameOf(r.providerId)}</Badge>
                    <span className="font-mono text-xs">{r.model || '—'}</span>
                  </>
                )}
                {typeof r.temperature === 'number' && <span className="text-xs text-muted-foreground">· temp {r.temperature}</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Verifier panel */}
        {verify?.enabled && (
          <div>
            <VerifierPanelHeading>
              <Badge variant="outline" className="text-[10px]">{verify.policy || 'any_fail_blocks'}</Badge>
              {verify.maxReviseLoops != null && (
                <Badge variant="outline" className="text-[10px] gap-1">
                  <Repeat className="h-3 w-3" />
                  {verify.maxReviseLoops} revisions
                </Badge>
              )}
            </VerifierPanelHeading>
            <VerifierPanelList verify={verify} />
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
