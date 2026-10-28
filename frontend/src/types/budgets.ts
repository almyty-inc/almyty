/**
 * The spend-budget contract, read off the backend rather than invented.
 *
 * Source of truth:
 *   backend/src/entities/spend-budget.entity.ts    columns
 *   backend/src/entities/spend-alert.entity.ts     alert rows
 *   backend/src/modules/budgets/budgets.service.ts PERIODS / BEHAVIORS / validate()
 *   backend/src/modules/budgets/budgets.controller.ts  routes + RBAC
 *
 * `llmProviderId` exists on the row but is deliberately not offered
 * anywhere in the UI. `BudgetsService.validate()` answers 400 for any
 * payload carrying one, because no spend table records which LLM provider
 * a run was billed to -- a provider-scoped ceiling would be measured
 * against org-wide spend. A budget is scoped either to the whole
 * organization (agentId null) or to exactly one agent.
 */
export type SpendBudgetPeriod = 'day' | 'month'
export type SpendBudgetBehavior = 'warn_log' | 'reject'

/** PERIODS in budgets.service.ts. Anything else is a 400. */
export const BUDGET_PERIODS: SpendBudgetPeriod[] = ['day', 'month']
/** BEHAVIORS in budgets.service.ts. Anything else is a 400. */
export const BUDGET_BEHAVIORS: SpendBudgetBehavior[] = ['warn_log', 'reject']

/** validate(): softThresholdPct must be an integer in [1, 100]. */
export const SOFT_THRESHOLD_MIN = 1
export const SOFT_THRESHOLD_MAX = 100
/** The entity default, applied by create() when the field is omitted. */
export const SOFT_THRESHOLD_DEFAULT = 80

export interface SpendBudget {
  id: string
  organizationId: string
  agentId: string | null
  llmProviderId: string | null
  periodType: SpendBudgetPeriod
  limitCents: number
  behavior: SpendBudgetBehavior
  softThresholdPct: number
  active: boolean
  createdAt: string
  updatedAt: string
}

export type SpendAlertLevel = 'soft' | 'hard'

export interface SpendAlert {
  id: string
  budgetId: string
  organizationId: string
  agentId: string | null
  llmProviderId: string | null
  level: SpendAlertLevel
  periodType: SpendBudgetPeriod
  periodStart: string
  spentCents: number
  limitCents: number
  at: string
}

/** The body POST /budgets and PATCH /budgets/:id accept (CreateBudgetDto). */
export interface BudgetPayload {
  agentId: string | null
  periodType: SpendBudgetPeriod
  limitCents: number
  behavior: SpendBudgetBehavior
  softThresholdPct: number
  active: boolean
}

export const PERIOD_LABELS: Record<SpendBudgetPeriod, string> = {
  day: 'Per day',
  month: 'Per month',
}

export const BEHAVIOR_LABELS: Record<SpendBudgetBehavior, string> = {
  warn_log: 'Warn only',
  reject: 'Block new runs',
}

/**
 * What the choice actually does to someone's agents. `reject` is the one
 * that needs spelling out: it is the only setting in the product that can
 * stop scheduled work without anybody touching the agent.
 */
export const BEHAVIOR_CONSEQUENCES: Record<SpendBudgetBehavior, string> = {
  warn_log:
    'Runs carry on past the limit. almyty records an alert and emails the organization owners and admins, once per period.',
  reject:
    'New runs in scope are refused once period-to-date spend reaches the limit -- scheduled agents, chat replies and API calls all stop until the period rolls over.',
}

/** Dollar string -> integer cents, or null when it is not a usable amount. */
export function dollarsToCents(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const dollars = Number(trimmed)
  if (!Number.isFinite(dollars)) return null
  const cents = Math.round(dollars * 100)
  if (cents <= 0) return null
  return cents
}

export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2)
}

/**
 * An amount in cents (fractions allowed) as dollars. Under a dollar it
 * keeps up to four decimals, so a model call's fraction of a cent on a
 * one-cent budget reads $0.0042, not $0.00.
 */
export function formatBudgetCents(cents: number): string {
  const dollars = (Number.isFinite(cents) ? cents : 0) / 100
  if (Math.abs(dollars) >= 1 || dollars === 0) return `$${dollars.toFixed(2)}`
  const [whole, frac = ''] = dollars.toFixed(4).replace(/0+$/, '').split('.')
  return `$${whole}.${frac.padEnd(2, '0')}`
}

/** The share of a budget spent: "<1%" for any spend under one percent, never 100% below the limit. */
export function formatBudgetShare(spentCents: number, limitCents: number): string {
  if (!(limitCents > 0)) return '0%'
  const share = (spentCents / limitCents) * 100
  if (spentCents > 0 && share < 1) return '<1%'
  return `${Math.min(999, share < 100 ? Math.floor(share) : Math.round(share))}%`
}
