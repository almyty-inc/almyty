/**
 * What an autonomous agent runs on, read-only: its strategy in a sentence
 * and each role with the model or agent that fills it. Editing happens on
 * the agent's edit page, where the roles and the strategy live.
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bot, Cpu, Pencil } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { asProviderList, useProviderList } from '@/components/model-picker'
import {
  PURPOSE_LABELS,
  STRATEGY_DESCRIPTIONS,
  STRATEGY_LABELS,
  modelsFromAgent,
  roleIsUsed,
} from '@/components/agents/builder/agent-models'
import { agentsApi } from '@/lib/api'
import { ROUTING_OBJECTIVE_LABELS } from '@/types/models'
import type { AgentModelRole, AgentModels } from '@/types/agent-models'

export interface AutonomousModelsSummaryProps {
  agentId: string
  models?: AgentModels | null
  /** Read when an agent has no models yet: its one model is then the main role. */
  modelConfig?: Record<string, any> | null
}

export function AutonomousModelsSummary({ agentId, models, modelConfig }: AutonomousModelsSummaryProps) {
  const current = modelsFromAgent({ models, modelConfig })
  const hasAgentRole = current.roles.some((r) => r.kind === 'agent')
  const providers = asProviderList(useProviderList().data)
  const agentsQuery = useQuery({
    queryKey: ['agents-list'],
    queryFn: () => agentsApi.getAll(),
    enabled: hasAgentRole,
  })
  const agents: Array<{ id: string; name: string }> = Array.isArray(agentsQuery.data)
    ? agentsQuery.data
    : (agentsQuery.data as any)?.data || []

  const filledBy = (role: AgentModelRole): string => {
    if (role.kind === 'agent') {
      const agent = agents.find((a) => a.id === role.agentId)
      return agent ? `Agent: ${agent.name}` : role.agentId ? 'Another agent' : 'No agent chosen'
    }
    if (role.routing) {
      const objective = role.routing.objective
      return `Routed by policy${objective ? ` (${ROUTING_OBJECTIVE_LABELS[objective]?.toLowerCase() ?? objective})` : ''}`
    }
    if (!role.providerId) return 'No model chosen'
    const provider = providers.find((p) => p.id === role.providerId)
    const providerName = provider?.name ?? 'Provider'
    return role.model ? `${providerName} / ${role.model}` : `${providerName}, default model`
  }

  return (
    <Card data-testid="autonomous-models-summary">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Models</CardTitle>
          <CardDescription>
            <span className="font-medium text-foreground" data-testid="summary-strategy">
              {STRATEGY_LABELS[current.strategy]}
              {current.strategy === 'best_of_n' ? ` (N = ${current.candidates ?? 3})` : ''}
            </span>
            {': '}
            {STRATEGY_DESCRIPTIONS[current.strategy]}
          </CardDescription>
        </div>
        <Link
          to={`/agents/${agentId}/edit`}
          className="inline-flex shrink-0 items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit models
        </Link>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-md border">
          {current.roles.map((role) => (
            <li key={role.key} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-testid={`summary-role-${role.key}`}>
              {role.kind === 'agent' ? (
                <Bot className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
              ) : (
                <Cpu className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
              )}
              <span className="font-medium">{role.name}</span>
              <Badge variant="outline" className="text-[10px]">{PURPOSE_LABELS[role.purpose] ?? role.purpose}</Badge>
              {!roleIsUsed(current.strategy, role) && (
                <span className="text-[11px] text-muted-foreground">not used by {STRATEGY_LABELS[current.strategy]}</span>
              )}
              <span className="flex-1" />
              <span className="font-mono text-xs text-muted-foreground">{filledBy(role)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
