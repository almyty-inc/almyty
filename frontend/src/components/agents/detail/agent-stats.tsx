/**
 * Summary stat cards displayed at the top of the agent detail page:
 * total runs, completed, checks passed (an agent with a check only),
 * avg run time, total cost.
 *
 * "Run" is the one word for what a user starts and for the record it
 * leaves. The page used to say executions here, runs one tab over and
 * invocations in the dialog, for the same thing.
 */
import React from 'react'
import {
  Activity,
  CheckCircle2,
  Clock,
  DollarSign,
  ShieldCheck,
} from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import type { Agent } from '@/types'
import { pluralized } from '@/lib/utils'
import { CHECKS_PASSED_LABEL, COMPLETED_LABEL, checksPassed, completedPercent } from '@/lib/agent-run-numbers'

interface AgentStatsProps {
  agent: Agent
}

export function AgentStats({ agent }: AgentStatsProps) {
  const completed = completedPercent(agent)
  const checks = checksPassed(agent)

  return (
    <div className={`grid grid-cols-2 gap-4 ${checks ? 'md:grid-cols-5' : 'md:grid-cols-4'}`}>
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Total runs</span>
          </div>
          <div className="text-2xl font-bold mt-1">{agent.totalExecutions}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <span className="text-sm text-muted-foreground" title="Runs that finished, whether or not an answer was right">
              {COMPLETED_LABEL}
            </span>
          </div>
          <div className="text-2xl font-bold mt-1" data-testid="agent-stat-completed">
            {completed === null ? '--' : `${completed}%`}
          </div>
        </CardContent>
      </Card>
      {checks && (
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground" title="Of the runs whose answer was checked, the share whose check passed">
                {CHECKS_PASSED_LABEL}
              </span>
            </div>
            <div className="text-2xl font-bold mt-1" data-testid="agent-stat-checks-passed">
              {checks.percent === null ? '--' : `${checks.percent}%`}
            </div>
            {checks.checked > 0 && (
              <div className="text-xs text-muted-foreground">
                {checks.passed.toLocaleString('en-US')} of {pluralized(checks.checked, 'checked run')}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Avg run time</span>
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
            <span className="text-sm text-muted-foreground">Total cost</span>
          </div>
          <div className="text-2xl font-bold mt-1">
            {agent.totalCost > 0 ? `$${agent.totalCost.toFixed(4)}` : '--'}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
