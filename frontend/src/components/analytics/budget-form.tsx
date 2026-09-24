/**
 * BudgetForm -- create or edit one spend budget, as a page
 * (/analytics/budgets/new, /analytics/budgets/:budgetId/edit).
 *
 * The fields and their rules come straight from
 * `backend/src/modules/budgets/budgets.service.ts` (CreateBudgetDto +
 * `validate()`): a positive integer `limitCents`, a `periodType` from
 * PERIODS, a `behavior` from BEHAVIORS, and a `softThresholdPct` integer
 * between 1 and 100.
 *
 * There is deliberately no provider picker. `validate()` answers 400 for
 * any payload carrying `llmProviderId`, because spend is not attributed
 * per LLM provider -- such a budget would be a ceiling measured against
 * org-wide spend. Scope is therefore a two-way choice: the whole
 * organization, or one agent.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { Wallet } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { agentsApi, budgetsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import {
  BEHAVIOR_CONSEQUENCES,
  BEHAVIOR_LABELS,
  BUDGET_BEHAVIORS,
  BUDGET_PERIODS,
  PERIOD_LABELS,
  SOFT_THRESHOLD_DEFAULT,
  SOFT_THRESHOLD_MAX,
  SOFT_THRESHOLD_MIN,
  centsToDollars,
  dollarsToCents,
  formatBudgetCents,
  type BudgetPayload,
  type SpendBudget,
  type SpendBudgetBehavior,
  type SpendBudgetPeriod,
} from '@/types/budgets'

export const BUDGETS_PATH = '/analytics/budgets'

export interface BudgetAgentOption {
  id: string
  name: string
}

export interface BudgetFormProps {
  /** The budget being edited, or null when creating one. */
  budget: SpendBudget | null
  agents: BudgetAgentOption[]
  isSaving: boolean
  /** Resolves once saved; the form then returns to the budgets list. */
  onSubmit: (data: BudgetPayload) => unknown
}

type Scope = 'organization' | 'agent'

interface FormErrors {
  limit?: string
  softThresholdPct?: string
  agentId?: string
}

export function BudgetForm({ budget, agents, isSaving, onSubmit }: BudgetFormProps) {
  // Seeded once from the row: the page mounts this only after the budget
  // it edits has loaded.
  const initial = useMemo(
    () => ({
      scope: (budget?.agentId ? 'agent' : 'organization') as Scope,
      agentId: budget?.agentId ?? '',
      periodType: budget?.periodType ?? ('month' as SpendBudgetPeriod),
      limit: budget ? centsToDollars(budget.limitCents) : '',
      behavior: budget?.behavior ?? ('warn_log' as SpendBudgetBehavior),
      softThresholdPct: String(budget?.softThresholdPct ?? SOFT_THRESHOLD_DEFAULT),
      active: budget?.active ?? true,
    }),
    [budget],
  )
  const [scope, setScope] = useState<Scope>(initial.scope)
  const [agentId, setAgentId] = useState(initial.agentId)
  const [periodType, setPeriodType] = useState<SpendBudgetPeriod>(initial.periodType)
  const [limit, setLimit] = useState(initial.limit)
  const [behavior, setBehavior] = useState<SpendBudgetBehavior>(initial.behavior)
  const [softThresholdPct, setSoftThresholdPct] = useState(initial.softThresholdPct)
  const [active, setActive] = useState(initial.active)
  const [errors, setErrors] = useState<FormErrors>({})

  const dirty =
    scope !== initial.scope ||
    agentId !== initial.agentId ||
    periodType !== initial.periodType ||
    limit !== initial.limit ||
    behavior !== initial.behavior ||
    softThresholdPct !== initial.softThresholdPct ||
    active !== initial.active
  const guard = useLeaveGuard(dirty)

  const limitCents = dollarsToCents(limit)
  const pct = Number(softThresholdPct)
  const softCents =
    limitCents !== null && Number.isInteger(pct) && pct >= SOFT_THRESHOLD_MIN && pct <= SOFT_THRESHOLD_MAX
      ? Math.floor((limitCents * pct) / 100)
      : null

  const handleSubmit = async () => {
    const next: FormErrors = {}
    if (limitCents === null) {
      next.limit = 'Enter a limit greater than $0.00.'
    }
    if (!Number.isInteger(pct) || pct < SOFT_THRESHOLD_MIN || pct > SOFT_THRESHOLD_MAX) {
      next.softThresholdPct = `Enter a whole number between ${SOFT_THRESHOLD_MIN} and ${SOFT_THRESHOLD_MAX}.`
    }
    if (scope === 'agent' && !agentId) {
      next.agentId = 'Choose the agent this budget applies to.'
    }
    setErrors(next)
    if (Object.keys(next).length > 0) return

    try {
      await onSubmit({
        // null, never undefined: PATCH only clears the scope when the field
        // is present, and `agentId: undefined` would be dropped by JSON.
        agentId: scope === 'agent' ? agentId : null,
        periodType,
        limitCents: limitCents as number,
        behavior,
        softThresholdPct: pct,
        active,
      })
    } catch {
      // The mutation's onError has already said why; stay on the form.
      return
    }
    guard.leave(BUDGETS_PATH)
  }

  return (
    <FormPage
      title={budget ? 'Edit spend budget' : 'New spend budget'}
      description="A ceiling on what agent runs may cost over a rolling period. Spend is counted per organization and per agent, so a budget covers either the whole organization or one agent."
      back={{ to: BUDGETS_PATH, label: 'Budgets' }}
      guard={guard}
      onSubmit={handleSubmit}
      submitLabel={budget ? 'Save budget' : 'Create budget'}
      submitting={isSaving}
      width="narrow"
    >
      <FormSection title="Scope">
        <Field id="budget-scope" label="Applies to">
          <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
            <SelectTrigger id="budget-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="organization">The whole organization</SelectItem>
              <SelectItem value="agent">A single agent</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {scope === 'agent' && (
          <Field id="budget-agent" label="Agent" required error={errors.agentId}>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger id="budget-agent">
                <SelectValue placeholder="Choose an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </FormSection>

      <FormSection title="Limit">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="budget-limit" label="Limit (USD)" required error={errors.limit}>
            <Input
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              placeholder="100.00"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </Field>
          <Field id="budget-period" label="Period">
            <Select value={periodType} onValueChange={(v) => setPeriodType(v as SpendBudgetPeriod)}>
              <SelectTrigger id="budget-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BUDGET_PERIODS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PERIOD_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {/* Behaviour -- the consequence is spelled out, not left to the label */}
        <div className="space-y-1.5">
          <Label htmlFor="budget-behavior">When the limit is reached</Label>
          <Select value={behavior} onValueChange={(v) => setBehavior(v as SpendBudgetBehavior)}>
            <SelectTrigger id="budget-behavior">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BUDGET_BEHAVIORS.map((b) => (
                <SelectItem key={b} value={b}>
                  {BEHAVIOR_LABELS[b]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p
            data-testid="budget-behavior-consequence"
            className={
              behavior === 'reject'
                ? 'text-xs text-amber-700 dark:text-amber-400'
                : 'text-xs text-muted-foreground'
            }
          >
            {BEHAVIOR_CONSEQUENCES[behavior]}
          </p>
        </div>

        <Field id="budget-soft-threshold" label="Warn at (% of limit)" error={errors.softThresholdPct}>
          <Input
            type="number"
            min={SOFT_THRESHOLD_MIN}
            max={SOFT_THRESHOLD_MAX}
            step="1"
            value={softThresholdPct}
            onChange={(e) => setSoftThresholdPct(e.target.value)}
          />
        </Field>
        {!errors.softThresholdPct && (
          <p data-testid="budget-soft-preview" className="text-xs text-muted-foreground">
            {softCents !== null && limitCents !== null
              ? `An early alert fires at ${formatBudgetCents(softCents)} of ${formatBudgetCents(limitCents)}. Runs are never blocked at this point.`
              : 'An early alert fires before the limit is reached. Runs are never blocked at this point.'}
          </p>
        )}
      </FormSection>

      <FormSection>
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="budget-active" className="text-sm font-medium">
              Enforce this budget
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Turn off to keep the budget on record without it affecting any run.
            </p>
          </div>
          <Switch id="budget-active" checked={active} onCheckedChange={setActive} />
        </div>
      </FormSection>
    </FormPage>
  )
}

/** The agents a budget can be scoped to, as {id, name}. */
export function useBudgetAgents(enabled: boolean): BudgetAgentOption[] {
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.getAll(),
    enabled,
  })
  return useMemo(() => {
    const raw = (agentsQuery.data as any)?.data ?? agentsQuery.data ?? []
    return (Array.isArray(raw) ? raw : []).map((a: any) => ({ id: a.id, name: a.name ?? a.id }))
  }, [agentsQuery.data])
}

/**
 * The page: /analytics/budgets/new creates, /analytics/budgets/:budgetId/edit
 * edits. The edit form waits for its row so it seeds from real numbers.
 */
export function BudgetFormPage() {
  const { budgetId } = useParams<{ budgetId?: string }>()
  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id
  const enabled = !!currentOrganization
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()
  const agents = useBudgetAgents(enabled)

  const budgetsQuery = useQuery<SpendBudget[]>({
    queryKey: ['budgets', orgId],
    queryFn: async () => {
      const d = await budgetsApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: enabled && !!budgetId,
  })

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
      await invalidate()
    },
    onError: (err: unknown) => error('Failed to create budget', getApiErrorMessage(err, 'Please try again.')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: BudgetPayload }) => budgetsApi.update(id, data),
    onSuccess: async () => {
      success('Budget updated', 'Changes saved.')
      await invalidate()
    },
    onError: (err: unknown) => error('Failed to update budget', getApiErrorMessage(err, 'Please try again.')),
  })

  const isSaving = createMutation.isPending || updateMutation.isPending

  if (!budgetId) {
    return (
      <BudgetForm
        budget={null}
        agents={agents}
        isSaving={isSaving}
        onSubmit={(data) => createMutation.mutateAsync(data)}
      />
    )
  }

  if (budgetsQuery.isLoading || (!budgetsQuery.data && !budgetsQuery.isError)) {
    return (
      <div className="flex h-32 items-center justify-center">
        <LoadingSpinner size="md" />
      </div>
    )
  }
  if (budgetsQuery.isError) {
    return <QueryError error={budgetsQuery.error} onRetry={() => budgetsQuery.refetch()} title="Couldn't load the budget" />
  }
  const budget = budgetsQuery.data?.find((b) => b.id === budgetId) ?? null
  if (!budget) {
    return (
      <EmptyState
        variant="panel"
        icon={Wallet}
        title="Budget not found"
        description="It may have been deleted. The budgets list shows the ones that exist."
      />
    )
  }
  return (
    <BudgetForm
      key={budget.id}
      budget={budget}
      agents={agents}
      isSaving={isSaving}
      onSubmit={(data) => updateMutation.mutateAsync({ id: budget.id, data })}
    />
  )
}
