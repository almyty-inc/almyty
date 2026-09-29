import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { agentAppsApi, formatCents, type AppSpendStatus } from '@/lib/agent-apps'

export interface AppSpendNoticeProps {
  slug: string
  /** Opens the app's Settings, where the limits are changed. */
  onChangeLimit: () => void
}

/** "Spent today $1.20 of $5 · this month $3.40 of $50", or what is known of it. */
export function spendLine(status: AppSpendStatus): string {
  const part = (label: string, spent: number, cap: number | null) =>
    cap != null ? `${label} ${formatCents(spent)} of ${formatCents(cap)}` : `${label} ${formatCents(spent)}`
  return `Spent ${part('today', status.todayCents, status.caps.dailyCents)} · ${part('this month', status.monthCents, status.caps.monthlyCents)}`
}

/**
 * What the app has spent against its whole-app limits, on the app page.
 *
 * When a limit is reached every visitor on every place is told the app has
 * reached its limit, so the owner has to see it here first, in the same
 * words, with the way to change it one click away.
 */
export function AppSpendNotice({ slug, onChangeLimit }: AppSpendNoticeProps) {
  const { data: status } = useQuery({
    queryKey: ['agent-app-spend', slug],
    queryFn: () => agentAppsApi.spend(slug),
    enabled: !!slug,
    refetchInterval: 60_000,
  })

  if (!status) return null

  if (status.reached) {
    const when = status.reached === 'day' ? 'today' : 'this month'
    const resets = status.reached === 'day' ? 'at midnight UTC' : 'on the first of next month (UTC)'
    return (
      <Card className="border-destructive p-4" data-testid="app-spend-reached" role="status">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertTriangle className="h-4 w-4" />
          This app has reached its spend limit for {when}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Visitors are told &ldquo;This app has reached its limit for {when}&rdquo; until it
          resets {resets}. {spendLine(status)}.
        </p>
        <Button variant="outline" size="sm" className="mt-3" onClick={onChangeLimit}>
          Change the limit
        </Button>
      </Card>
    )
  }

  return (
    <p className="text-xs text-muted-foreground" data-testid="app-spend">
      {spendLine(status)}
    </p>
  )
}
