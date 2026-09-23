/**
 * BudgetsTab -- see, create, edit and delete spend budgets, and read the
 * alerts they have fired.
 *
 * `POST/PATCH/DELETE /budgets` and `GET /budgets/alerts` had been complete
 * on the backend and reachable from nothing: only `GET /budgets/spend`
 * (the Cost tab) and `GET /budgets` (the deploy dialog's picker) were ever
 * called, so a spend ceiling could not be set from inside the product at
 * all. This is the control surface for them.
 *
 * It sits next to Cost rather than in Settings on purpose: a limit only
 * means anything beside the meter it caps, and both read the same
 * `/budgets` controller. Each row shows period-to-date spend against its
 * own limit, taken from the same `spend-summary` query the Cost tab uses,
 * so the two screens can never disagree.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, Pencil, Plus, Trash2, Wallet } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { agentsApi, budgetsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { formatDateTime } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import {
  BEHAVIOR_LABELS,
  PERIOD_LABELS,
  formatBudgetCents,
  type BudgetPayload,
  type SpendAlert,
  type SpendBudget,
  type SpendBudgetPeriod,
} from '@/types/budgets'

import { BudgetDialog, type BudgetAgentOption } from './budget-dialog'
import { TABLE_HEAD_CLASS as TH } from './constants'
import { useOrganizationRole } from '@/hooks/use-organization-role'

interface SpendSummary {
  totalCents: number
  byAgent: Array<{ agentId: string; spentCents: number; runCount: number }>
}

/** Period-to-date spend for whatever this budget is scoped to. */
function spentForBudget(
  budget: SpendBudget,
  summaries: Partial<Record<SpendBudgetPeriod, SpendSummary | undefined>>,
): number | null {
  const summary = summaries[budget.periodType]
  if (!summary) return null
  if (!budget.agentId) return summary.totalCents
  return summary.byAgent?.find((a) => a.agentId === budget.agentId)?.spentCents ?? 0
}

export function BudgetsTab() {
  const { currentOrganization } = useOrganizationStore()
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<SpendBudget | null>(null)
  // POST/PATCH/DELETE /budgets are @Roles('admin','owner'). Rendering the
  // controls to everyone meant a member clicked New and got a 403 -- an
  // action offered that could never work. The server still decides; this
  // only stops offering it.
  const { canManage } = useOrganizationRole()
  const [deleting, setDeleting] = useState<SpendBudget | null>(null)

  const orgId = currentOrganization?.id
  const enabled = !!currentOrganization

  const budgetsQuery = useQuery<SpendBudget[]>({
    queryKey: ['budgets', orgId],
    queryFn: async () => {
      const d = await budgetsApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled,
  })

  const alertsQuery = useQuery<SpendAlert[]>({
    queryKey: ['spend-alerts', orgId],
    queryFn: async () => {
      const d = await budgetsApi.getAlerts(50)
      return Array.isArray(d) ? d : []
    },
    enabled,
  })

  // Same keys the Cost tab uses, so the two surfaces share one cache and a
  // budget mutation refreshes both.
  const monthSpend = useQuery({
    queryKey: ['spend-summary', orgId, 'month'],
    queryFn: () => budgetsApi.getSpend('month', 'day'),
    enabled,
  })
  const daySpend = useQuery({
    queryKey: ['spend-summary', orgId, 'day'],
    queryFn: () => budgetsApi.getSpend('day', 'day'),
    enabled,
  })

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.getAll(),
    enabled,
  })

  const agents: BudgetAgentOption[] = useMemo(() => {
    const raw = (agentsQuery.data as any)?.data ?? agentsQuery.data ?? []
    return (Array.isArray(raw) ? raw : []).map((a: any) => ({
      id: a.id,
      name: a.name ?? a.id,
    }))
  }, [agentsQuery.data])

  const agentNames = useMemo(() => {
    const map: Record<string, string> = {}
    agents.forEach((a) => {
      map[a.id] = a.name
    })
    return map
  }, [agents])

  const summaries = useMemo(
    () => ({
      month: ((monthSpend.data as any)?.data ?? monthSpend.data) as SpendSummary | undefined,
      day: ((daySpend.data as any)?.data ?? daySpend.data) as SpendSummary | undefined,
    }),
    [monthSpend.data, daySpend.data],
  )

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['budgets'] }),
      queryClient.invalidateQueries({ queryKey: ['spend-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['spend-alerts'] }),
    ])
  }

  const createMutation = useMutation({
    mutationFn: (data: BudgetPayload) => budgetsApi.create(data),
    onSuccess: async () => {
      success('Budget created', 'It applies from the current period onward.')
      setDialogOpen(false)
      setEditing(null)
      await invalidate()
    },
    onError: (err: unknown) =>
      error('Failed to create budget', getApiErrorMessage(err, 'Please try again.')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: BudgetPayload }) =>
      budgetsApi.update(id, data),
    onSuccess: async () => {
      success('Budget updated', 'Changes saved.')
      setDialogOpen(false)
      setEditing(null)
      await invalidate()
    },
    onError: (err: unknown) =>
      error('Failed to update budget', getApiErrorMessage(err, 'Please try again.')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => budgetsApi.delete(id),
    onSuccess: async () => {
      success('Budget deleted', 'Runs in its scope are no longer capped by it.')
      setDeleting(null)
      await invalidate()
    },
    onError: (err: unknown) =>
      error('Failed to delete budget', getApiErrorMessage(err, 'Please try again.')),
  })

  const handleSubmit = (data: BudgetPayload) => {
    if (editing) updateMutation.mutate({ id: editing.id, data })
    else createMutation.mutate(data)
  }

  const openCreate = () => {
    setEditing(null)
    setDialogOpen(true)
  }

  const openEdit = (budget: SpendBudget) => {
    setEditing(budget)
    setDialogOpen(true)
  }

  const budgets = budgetsQuery.data ?? []

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card">
        <div className="px-4 py-3 border-b flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Spend budgets</h3>
          </div>
          {canManage && (
            <Button
              size="sm"
              className="h-7 text-xs bg-gradient-to-r from-violet-500 to-cyan-400 text-white hover:opacity-90"
              onClick={openCreate}
            >
              <Plus className="h-3 w-3 mr-1" /> New budget
            </Button>
          )}
        </div>

        {budgetsQuery.isLoading ? (
          <div className="flex items-center justify-center h-32">
            <LoadingSpinner size="md" />
          </div>
        ) : budgetsQuery.isError ? (
          // A failed list must not render as "no budgets": that reads as
          // "nothing is capping your spend", which is the opposite of what
          // an unknown answer means.
          <QueryError
            error={budgetsQuery.error}
            onRetry={() => budgetsQuery.refetch()}
            title="Couldn't load budgets"
            className="m-4"
          />
        ) : budgets.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="No spend budgets"
            description="Nothing caps what agent runs may cost. Set a budget to be warned at a threshold, or to stop new runs once a limit is reached."
            action={
              canManage ? (
                <Button size="sm" onClick={openCreate}>
                  <Plus className="h-4 w-4 mr-1" /> New budget
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left bg-muted">
                  <th className={TH}>Applies to</th>
                  <th className={`${TH} text-right`}>Limit</th>
                  <th className={TH}>Period</th>
                  <th className={TH}>On breach</th>
                  <th className={`${TH} w-56`}>Period to date</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {budgets.map((b) => {
                  const spent = spentForBudget(b, summaries)
                  const pctUsed =
                    spent === null ? null : Math.min(999, Math.round((spent / b.limitCents) * 100))
                  const overLimit = spent !== null && spent >= b.limitCents
                  const overSoft =
                    spent !== null && !overLimit && pctUsed !== null && pctUsed >= b.softThresholdPct
                  const barClass = overLimit
                    ? 'bg-red-500'
                    : overSoft
                      ? 'bg-amber-500'
                      : 'bg-gradient-to-r from-violet-500 to-cyan-400'
                  return (
                    <tr
                      key={b.id}
                      data-testid={`budget-row-${b.id}`}
                      className="border-b last:border-0 hover:bg-muted/30"
                    >
                      <td className="px-4 py-3 font-medium">
                        {b.agentId
                          ? agentNames[b.agentId] ?? b.agentId.slice(0, 8)
                          : 'Whole organization'}
                        {!b.active && (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            Not enforced
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {formatBudgetCents(b.limitCents)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {PERIOD_LABELS[b.periodType]}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={b.behavior === 'reject' ? 'warning' : 'secondary'}>
                          {BEHAVIOR_LABELS[b.behavior]}
                        </Badge>
                        <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                          {b.behavior === 'reject'
                            ? 'New runs are refused at the limit.'
                            : `Warns at ${b.softThresholdPct}%; runs continue.`}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        {spent === null ? (
                          <span className="text-xs text-muted-foreground">
                            Spend unavailable
                          </span>
                        ) : (
                          <div className="space-y-1">
                            <div className="h-2 rounded bg-muted overflow-hidden">
                              <div
                                className={`h-full ${barClass}`}
                                style={{ width: `${Math.min(100, pctUsed ?? 0)}%` }}
                              />
                            </div>
                            <span
                              data-testid={`budget-spent-${b.id}`}
                              className="text-xs text-muted-foreground"
                            >
                              {formatBudgetCents(spent)} of {formatBudgetCents(b.limitCents)}
                              {' '}({pctUsed}%)
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {canManage && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              aria-label="Edit budget"
                              onClick={() => openEdit(b)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-red-600 dark:text-red-400"
                              aria-label="Delete budget"
                              onClick={() => setDeleting(b)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AlertsCard
        query={alertsQuery}
        agentNames={agentNames}
      />

      <BudgetDialog
        open={dialogOpen}
        onOpenChange={(next) => {
          setDialogOpen(next)
          if (!next) setEditing(null)
        }}
        budget={editing}
        agents={agents}
        isSaving={createMutation.isPending || updateMutation.isPending}
        onSubmit={handleSubmit}
      />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this budget?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && (
                <>
                  {formatBudgetCents(deleting.limitCents)}{' '}
                  {PERIOD_LABELS[deleting.periodType].toLowerCase()} for{' '}
                  {deleting.agentId
                    ? agentNames[deleting.agentId] ?? 'one agent'
                    : 'the whole organization'}
                  . {deleting.behavior === 'reject'
                    ? 'Runs in its scope will no longer be stopped when spend reaches this limit.'
                    : 'Runs in its scope will no longer raise an alert when spend reaches this limit.'}{' '}
                  Alerts it already raised are kept.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete budget'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * The append-only breach log. `soft` means the early threshold was
 * crossed; `hard` means the limit itself was reached -- and whether that
 * stopped anything depends on the budget's behavior, so the row says so
 * rather than leaving "hard" to be interpreted.
 */
function AlertsCard({
  query,
  agentNames,
}: {
  query: {
    data?: SpendAlert[]
    isLoading: boolean
    isError: boolean
    error: unknown
    refetch: () => void
  }
  agentNames: Record<string, string>
}) {
  const alerts = query.data ?? []

  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <BellRing className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Recent budget alerts</h3>
      </div>

      {query.isLoading ? (
        <div className="flex items-center justify-center h-24">
          <LoadingSpinner size="md" />
        </div>
      ) : query.isError ? (
        <QueryError
          error={query.error}
          onRetry={() => query.refetch()}
          title="Couldn't load budget alerts"
          className="m-4"
        />
      ) : alerts.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">
          No budget has been breached. An alert is recorded at most once per
          period per threshold.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left bg-muted">
                <th className={TH}>When</th>
                <th className={TH}>Scope</th>
                <th className={TH}>Threshold</th>
                <th className={`${TH} text-right`}>Spend at breach</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                    {formatDateTime(a.at)}
                  </td>
                  <td className="px-4 py-3">
                    {a.agentId ? agentNames[a.agentId] ?? a.agentId.slice(0, 8) : 'Whole organization'}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={a.level === 'hard' ? 'destructive' : 'warning'}>
                      {a.level === 'hard' ? 'Limit reached' : 'Early warning'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right font-medium">
                    {formatBudgetCents(a.spentCents)} of {formatBudgetCents(a.limitCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
