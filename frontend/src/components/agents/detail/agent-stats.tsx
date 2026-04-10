/**
 * Summary stat cards displayed at the top of the agent detail page:
 * total executions, success rate, avg execution time, total cost.
 */
import React from 'react'
import {
  Activity,
  CheckCircle2,
  Clock,
  DollarSign,
} from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import type { Agent } from '@/types'

interface AgentStatsProps {
  agent: Agent
}

export function AgentStats({ agent }: AgentStatsProps) {
  const successRate = agent.totalExecutions > 0
    ? ((agent.successfulExecutions / agent.totalExecutions) * 100).toFixed(1)
    : '0'

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Total Executions</span>
          </div>
          <div className="text-2xl font-bold mt-1">{agent.totalExecutions}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <span className="text-sm text-muted-foreground">Success Rate</span>
          </div>
          <div className="text-2xl font-bold mt-1">{successRate}%</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Avg Execution Time</span>
          </div>
          <div className="text-2xl font-bold mt-1">
            {agent.averageExecutionTime > 0
              ? `${(agent.averageExecutionTime / 1000).toFixed(1)}s`
              : '--'}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Total Cost</span>
          </div>
          <div className="text-2xl font-bold mt-1">
            {agent.totalCost > 0 ? `$${agent.totalCost.toFixed(4)}` : '--'}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
