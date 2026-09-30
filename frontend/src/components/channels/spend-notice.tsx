import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { agentChannelsApi, formatCents, type SpendStatus } from '@/lib/agent-channels'
import { channelKeys } from './channel-page-loader'

/** "Spent today $1.20 of $5 · this month $3.40 of $50", or what is known of it. */
export function spendLine(status: SpendStatus): string {
  const part = (label: string, spent: number, cap: number | null) =>
    cap != null ? `${label} ${formatCents(spent)} of ${formatCents(cap)}` : `${label} ${formatCents(spent)}`
  return `Spent ${part('today', status.todayCents, status.caps.dailyCents)} · ${part('this month', status.monthCents, status.caps.monthlyCents)}`
}

/**
 * What the agent's channels have spent against their shared limits.
 *
 * When a limit is reached every visitor on those channels is told it has
 * reached its limit, so the owner sees it here first, in the same words.
 */
export function SpendNotice({ agentId }: { agentId: string }) {
  const { data } = useQuery({
    queryKey: channelKeys.spend(agentId),
    queryFn: () => agentChannelsApi.spend(agentId),
    enabled: !!agentId,
    refetchInterval: 60_000,
  })
  const status = data?.agent
  if (!status) return null

  if (status.reached) {
    const when = status.reached === 'day' ? 'today' : 'this month'
    const resets = status.reached === 'day' ? 'at midnight UTC' : 'on the first of next month (UTC)'
    return (
      <Card className="border-destructive p-4" data-testid="spend-reached" role="status">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertTriangle className="h-4 w-4" />
          The spend limit for {when} is reached
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Visitors are told it has reached its limit for {when} until it resets {resets}. {spendLine(status)}. Raise the limit
          under Advanced below.
        </p>
      </Card>
    )
  }

  return (
    <p className="text-xs text-muted-foreground" data-testid="spend">
      {spendLine(status)}
    </p>
  )
}
