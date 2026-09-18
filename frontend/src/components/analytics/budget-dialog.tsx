/**
 * BudgetDialog -- create or edit one spend budget.
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
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
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

export interface BudgetAgentOption {
  id: string
  name: string
}

export interface BudgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The budget being edited, or null when creating one. */
  budget: SpendBudget | null
  agents: BudgetAgentOption[]
  isSaving: boolean
  onSubmit: (data: BudgetPayload) => void
}

type Scope = 'organization' | 'agent'

interface FormErrors {
  limit?: string
  softThresholdPct?: string
  agentId?: string
}

export function BudgetDialog({
  open,
  onOpenChange,
  budget,
  agents,
  isSaving,
  onSubmit,
}: BudgetDialogProps) {
  const [scope, setScope] = useState<Scope>('organization')
  const [agentId, setAgentId] = useState('')
  const [periodType, setPeriodType] = useState<SpendBudgetPeriod>('month')
  const [limit, setLimit] = useState('')
  const [behavior, setBehavior] = useState<SpendBudgetBehavior>('warn_log')
  const [softThresholdPct, setSoftThresholdPct] = useState(String(SOFT_THRESHOLD_DEFAULT))
  const [active, setActive] = useState(true)
  const [errors, setErrors] = useState<FormErrors>({})

  // Reseed from the row every time the dialog opens, so editing one budget
  // and then creating another does not inherit the first one's numbers.
  useEffect(() => {
    if (!open) return
    setScope(budget?.agentId ? 'agent' : 'organization')
    setAgentId(budget?.agentId ?? '')
    setPeriodType(budget?.periodType ?? 'month')
    setLimit(budget ? centsToDollars(budget.limitCents) : '')
    setBehavior(budget?.behavior ?? 'warn_log')
    setSoftThresholdPct(String(budget?.softThresholdPct ?? SOFT_THRESHOLD_DEFAULT))
    setActive(budget?.active ?? true)
    setErrors({})
  }, [open, budget])

  const limitCents = dollarsToCents(limit)
  const pct = Number(softThresholdPct)
  const softCents =
    limitCents !== null && Number.isInteger(pct) && pct >= SOFT_THRESHOLD_MIN && pct <= SOFT_THRESHOLD_MAX
      ? Math.floor((limitCents * pct) / 100)
      : null

  const handleSubmit = () => {
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

    onSubmit({
      // null, never undefined: PATCH only clears the scope when the field
      // is present, and `agentId: undefined` would be dropped by JSON.
      agentId: scope === 'agent' ? agentId : null,
      periodType,
      limitCents: limitCents as number,
      behavior,
      softThresholdPct: pct,
      active,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{budget ? 'Edit spend budget' : 'New spend budget'}</DialogTitle>
          <DialogDescription>
            A ceiling on what agent runs may cost over a rolling period. Spend is
            counted per organization and per agent, so a budget covers either the
            whole organization or one agent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Scope */}
          <div className="space-y-2">
            <Label htmlFor="budget-scope">Applies to</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
              <SelectTrigger id="budget-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="organization">The whole organization</SelectItem>
                <SelectItem value="agent">A single agent</SelectItem>
              </SelectContent>
            </Select>
            {scope === 'agent' && (
              <div className="space-y-2 pt-2">
                <Label htmlFor="budget-agent">Agent</Label>
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
                {errors.agentId && (
                  <p className="text-xs text-red-600 dark:text-red-400">{errors.agentId}</p>
                )}
              </div>
            )}
          </div>

          {/* Limit + period */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="budget-limit">Limit (USD)</Label>
              <Input
                id="budget-limit"
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                placeholder="100.00"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
              {errors.limit && (
                <p className="text-xs text-red-600 dark:text-red-400">{errors.limit}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="budget-period">Period</Label>
              <Select
                value={periodType}
                onValueChange={(v) => setPeriodType(v as SpendBudgetPeriod)}
              >
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
            </div>
          </div>

          {/* Behaviour -- the consequence is spelled out, not left to the label */}
          <div className="space-y-2">
            <Label htmlFor="budget-behavior">When the limit is reached</Label>
            <Select
              value={behavior}
              onValueChange={(v) => setBehavior(v as SpendBudgetBehavior)}
            >
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

          {/* Soft threshold */}
          <div className="space-y-2">
            <Label htmlFor="budget-soft-threshold">Warn at (% of limit)</Label>
            <Input
              id="budget-soft-threshold"
              type="number"
              min={SOFT_THRESHOLD_MIN}
              max={SOFT_THRESHOLD_MAX}
              step="1"
              value={softThresholdPct}
              onChange={(e) => setSoftThresholdPct(e.target.value)}
            />
            {errors.softThresholdPct ? (
              <p className="text-xs text-red-600 dark:text-red-400">
                {errors.softThresholdPct}
              </p>
            ) : (
              <p data-testid="budget-soft-preview" className="text-xs text-muted-foreground">
                {softCents !== null && limitCents !== null
                  ? `An early alert fires at ${formatBudgetCents(softCents)} of ${formatBudgetCents(limitCents)}. Runs are never blocked at this point.`
                  : 'An early alert fires before the limit is reached. Runs are never blocked at this point.'}
              </p>
            )}
          </div>

          {/* Active */}
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="pr-4">
              <Label htmlFor="budget-active" className="text-sm font-medium">
                Enforce this budget
              </Label>
              <p className="text-xs text-muted-foreground mt-1">
                Turn off to keep the budget on record without it affecting any run.
              </p>
            </div>
            <Switch id="budget-active" checked={active} onCheckedChange={setActive} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isSaving ? 'Saving...' : budget ? 'Save budget' : 'Create budget'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
