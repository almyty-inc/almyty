import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { OrchestratorSettings, type OrchestratorConfigView } from './orchestrator-settings'
import { RolesPanel, type AgentRoleView, type ResolvedRoleView } from './roles-panel'
import { StrategyPicker, type StrategyView } from './strategy-picker'

/**
 * How this agent runs: which model fills each role, what shape the work
 * takes, and whether anything chooses that shape for you.
 *
 * The three layers are on one tab deliberately. They are separate layers
 * because each is configurable alone, but the questions a person actually
 * asks are adjacent: which model, in what shape, chosen by whom. Splitting
 * them across three tabs would make the relationship harder to see, not
 * easier.
 *
 * See docs/design/layers.md, L4 to L6.
 */
const ORCHESTRATOR_DEFAULTS: OrchestratorConfigView = {
  enabled: false,
  roleKey: 'orchestrator',
  timeoutMs: 2000,
  fallbackStrategyKey: 'single',
}

export function ExecutionTab({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient()
  const [selectedStrategy, setSelectedStrategy] = useState<string>()
  const [orchestrator, setOrchestrator] = useState<OrchestratorConfigView>(ORCHESTRATOR_DEFAULTS)

  const rolesQuery = useQuery({
    queryKey: ['agent-roles', agentId],
    queryFn: async () => (await api.get(`/agents/${agentId}/roles`)).data.data as AgentRoleView[],
  })

  const strategiesQuery = useQuery({
    queryKey: ['strategies'],
    queryFn: async () => (await api.get('/strategies')).data.data as StrategyView[],
  })

  // Asked for, not assumed: resolving a role can call the router, so it
  // happens when someone wants to see the answer rather than on render.
  const resolve = useMutation({
    mutationFn: async () => (await api.post(`/agents/${agentId}/roles/resolve`, {})).data.data as ResolvedRoleView[],
  })

  const toggleBinding = useMutation({
    mutationFn: async ({ role, next }: { role: AgentRoleView; next: 'pinned' | 'resolved' }) => {
      const binding =
        next === 'pinned'
          ? { mode: 'pinned' as const, modelId: resolve.data?.find((r) => r.key === role.key)?.modelId ?? '' }
          : { mode: 'resolved' as const, policy: { objective: 'cheapest' } }
      return (await api.post(`/agents/${agentId}/roles`, { ...role, binding })).data.data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-roles', agentId] }),
  })

  const roles = rolesQuery.data ?? []
  const strategies = strategiesQuery.data ?? []

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Roles</CardTitle>
          <CardDescription>
            Which model fills each job in this agent. Changing model is a binding change here, not an edit to the graph.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RolesPanel
            roles={roles}
            resolved={resolve.data}
            loading={rolesQuery.isLoading}
            error={rolesQuery.isError ? getApiErrorMessage(rolesQuery.error, 'Could not read this agent\'s roles') : undefined}
            onToggleBinding={(key, next) => {
              const role = roles.find((r) => r.key === key)
              if (role) toggleBinding.mutate({ role, next })
            }}
          />
          {roles.some((r) => r.binding.mode === 'resolved') && (
            <button
              type="button"
              data-testid="resolve-roles"
              className="mt-3 text-xs text-primary underline-offset-2 hover:underline"
              onClick={() => resolve.mutate()}
            >
              {resolve.isPending ? 'Resolving...' : 'Show what each role resolves to now'}
            </button>
          )}
          {resolve.isError && (
            <p data-testid="resolve-error" className="mt-2 text-xs text-red-600 dark:text-red-400">
              {getApiErrorMessage(resolve.error, 'Could not resolve roles')}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Strategy</CardTitle>
          <CardDescription>The shape of the work. A strategy never names a model; roles do that.</CardDescription>
        </CardHeader>
        <CardContent>
          <StrategyPicker
            strategies={strategies}
            selectedKey={selectedStrategy}
            availableRoles={roles.map((r) => r.key)}
            loading={strategiesQuery.isLoading}
            error={strategiesQuery.isError ? getApiErrorMessage(strategiesQuery.error, 'Could not read the strategies') : undefined}
            onSelect={setSelectedStrategy}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Orchestrator</CardTitle>
          <CardDescription>Optional. Lets a small model pick the strategy per request.</CardDescription>
        </CardHeader>
        <CardContent>
          <OrchestratorSettings
            config={orchestrator}
            strategyKeys={strategies.map((s) => s.key)}
            roleKeys={roles.map((r) => r.key)}
            onChange={setOrchestrator}
          />
        </CardContent>
      </Card>
    </div>
  )
}
