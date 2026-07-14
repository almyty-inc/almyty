import { SpendBudgetPeriod } from '../../entities/spend-budget.entity';

/** Time bucket granularities the spend aggregation can group by. */
export type SpendGranularity = 'day' | 'week' | 'month';

const GRANULARITIES: SpendGranularity[] = ['day', 'week', 'month'];

/** Whitelist a caller-supplied granularity (defends the date_trunc arg). */
export function normalizeGranularity(value: string | undefined): SpendGranularity {
  return GRANULARITIES.includes(value as SpendGranularity)
    ? (value as SpendGranularity)
    : 'day';
}

/**
 * Start (UTC) of the current period bucket containing `now`. Budgets
 * reset on this boundary — everything on or after it counts toward the
 * period-to-date total.
 */
export function startOfPeriod(period: SpendBudgetPeriod, now: Date = new Date()): Date {
  if (period === 'day') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  // 'month'
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
