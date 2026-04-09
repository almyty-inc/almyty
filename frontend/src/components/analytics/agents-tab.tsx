import React, { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Bot, CheckCircle2, Clock, XCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { agentsApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import type { Agent, AgentExecution } from '@/types'

import { formatDate, formatMs, formatNumber } from './format'
import { StatCard } from './stat-card'

export function AgentsTab() {
  const { currentOrganization } = useOrganizationStore()

  const { data: agentsRaw, isLoading: loadingAgents } = useQuery({
    queryKey: ['analytics-agents', currentOrganization?.id],
    queryFn: async () => {
      const d = await agentsApi.getAll()
      const result = d?.agents || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization,
  })
  const agents: Agent[] = Array.isArray(agentsRaw) ? agentsRaw : []

  const { data: agentExecutionsMap } = useQuery({
    queryKey: [
      'analytics-agent-executions',
      currentOrganization?.id,
      agents.map((a) => a.id).join(','),
    ],
    queryFn: async () => {
      const map: Record<string, AgentExecution[]> = {}
      await Promise.all(
        agents.map(async (agent) => {
          try {
            const d = await agentsApi.getExecutions(agent.id, { limit: 50 })
            map[agent.id] = Array.isArray(d) ? d : d?.executions || []
          } catch {
            map[agent.id] = []
          }
        }),
      )
      return map
    },
    enabled: !!currentOrganization && agents.length > 0,
  })

  const agentStats = useMemo(() => {
    if (!agents.length) return null
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    let total24h = 0
    let total7d = 0
    let totalSuccess = 0
    let totalExecs = 0
    let totalTime = 0
    let timedExecs = 0
    const perAgent: Array<{
      agent: Agent
      executions24h: number
      executions7d: number
      successRate: number
      avgTime: number
      recentFailures: AgentExecution[]
    }> = []

    for (const agent of agents) {
      const executions = agentExecutionsMap?.[agent.id] || []
      let a24h = 0
      let a7d = 0
      let aSuccess = 0
      let aTime = 0
      let aTimed = 0
      const failures: AgentExecution[] = []

      for (const exec of executions) {
        const age = now - new Date(exec.createdAt).getTime()
        if (age < day) a24h++
        if (age < 7 * day) a7d++
        if (exec.status === 'completed') aSuccess++
        if (exec.status === 'failed' || exec.status === 'timeout') {
          failures.push(exec)
        }
        if (exec.executionTime > 0) {
          aTime += exec.executionTime
          aTimed++
        }
      }

      total24h += a24h
      total7d += a7d
      totalSuccess += agent.successfulExecutions
      totalExecs += agent.totalExecutions
      if (aTimed > 0) {
        totalTime += aTime
        timedExecs += aTimed
      }

      perAgent.push({
        agent,
        executions24h: a24h,
        executions7d: a7d,
        successRate:
          executions.length > 0
            ? Math.round((aSuccess / executions.length) * 100)
            : agent.totalExecutions > 0
              ? Math.round((agent.successfulExecutions / agent.totalExecutions) * 100)
              : 0,
        avgTime: aTimed > 0 ? aTime / aTimed : agent.averageExecutionTime,
        recentFailures: failures.slice(0, 3),
      })
    }

    perAgent.sort((a, b) => b.agent.totalExecutions - a.agent.totalExecutions)

    const allFailures = perAgent
      .flatMap((p) => p.recentFailures)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10)

    return {
      total24h,
      total7d,
      overallSuccessRate: totalExecs > 0 ? Math.round((totalSuccess / totalExecs) * 100) : 0,
      avgExecutionTime: timedExecs > 0 ? totalTime / timedExecs : 0,
      perAgent,
      recentFailures: allFailures,
    }
  }, [agents, agentExecutionsMap])

  if (loadingAgents) {
    return (
      <div className="flex items-center justify-center h-48">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (!agentStats || agents.length === 0) {
    return (
      <div className="text-center py-12">
        <Bot className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
        <p className="text-sm font-medium text-muted-foreground">No agent data yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Agent execution stats will appear here once agents are created and invoked.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Bot} label="Executions (24h)" value={formatNumber(agentStats.total24h)} />
        <StatCard icon={Bot} label="Executions (7d)" value={formatNumber(agentStats.total7d)} />
        <StatCard
          icon={CheckCircle2}
          label="Success Rate"
          value={`${agentStats.overallSuccessRate}%`}
          className={
            agentStats.overallSuccessRate >= 90
              ? ''
              : agentStats.overallSuccessRate >= 70
                ? 'border-yellow-200 bg-yellow-50/50'
                : 'border-red-200 bg-red-50/50'
          }
        />
        <StatCard
          icon={Clock}
          label="Avg Execution Time"
          value={formatMs(agentStats.avgExecutionTime)}
        />
      </div>

      {/* Top agents by usage */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Top Agents by Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground bg-muted">
                  <th className="px-4 py-3 font-medium">Agent</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Total Execs</th>
                  <th className="px-4 py-3 font-medium text-right">24h</th>
                  <th className="px-4 py-3 font-medium text-right">7d</th>
                  <th className="px-4 py-3 font-medium text-right">Success Rate</th>
                  <th className="px-4 py-3 font-medium text-right">Avg Time</th>
                  <th className="px-4 py-3 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {agentStats.perAgent.map(({ agent, executions24h, executions7d, successRate, avgTime }) => (
                  <tr key={agent.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-2.5">
                      <Link to={`/agents/${agent.id}`} className="font-medium hover:underline text-sm">
                        {agent.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge
                        variant={
                          agent.status === 'active'
                            ? 'success'
                            : agent.status === 'error'
                              ? 'destructive'
                              : 'secondary'
                        }
                        className="text-xs"
                      >
                        {agent.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium">
                      {agent.totalExecutions.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">{executions24h}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">{executions7d}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className={cn(
                          'font-medium',
                          successRate >= 90
                            ? 'text-green-600'
                            : successRate >= 70
                              ? 'text-yellow-600'
                              : 'text-red-600',
                        )}
                      >
                        {successRate}%
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">{formatMs(avgTime)}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">
                      {agent.totalCost > 0 ? `$${agent.totalCost.toFixed(4)}` : '--'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Recent Failures */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent Failures</CardTitle>
        </CardHeader>
        <CardContent>
          {agentStats.recentFailures.length === 0 ? (
            <div className="text-center py-6">
              <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No recent failures</p>
            </div>
          ) : (
            <div className="space-y-2">
              {agentStats.recentFailures.map((exec) => {
                const agentForExec = agents.find((a) => a.id === exec.agentId)
                return (
                  <div
                    key={exec.id}
                    className="flex items-start gap-3 p-3 rounded-lg border bg-red-50/30 dark:bg-red-950/20"
                  >
                    <XCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Link
                          to={`/agents/${exec.agentId}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {agentForExec?.name || exec.agentId.slice(0, 8)}
                        </Link>
                        <Badge variant="destructive" className="text-[10px]">
                          {exec.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">
                          {formatDate(exec.createdAt)}
                        </span>
                      </div>
                      {exec.error && (
                        <p className="text-xs text-red-600 dark:text-red-400 mt-1 truncate">
                          {exec.error}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
