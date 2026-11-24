import { describe, it, expect } from 'vitest'

import { formatBudgetCents, formatBudgetShare } from '@/types/budgets'

/** A budget's spend reads as every cost does: "<$0.01" for a fraction of a cent, never "$0.0042". */
describe('budget amounts and shares', () => {
  it('shows two decimals, and "<$0.01" for a fraction of a cent', () => {
    expect(formatBudgetCents(0)).toBe('$0.00')
    expect(formatBudgetCents(0.42)).toBe('<$0.01')
    expect(formatBudgetCents(0.4)).toBe('<$0.01')
    expect(formatBudgetCents(0.8)).toBe('$0.01')
    expect(formatBudgetCents(1)).toBe('$0.01')
    expect(formatBudgetCents(2500)).toBe('$25.00')
    expect(formatBudgetCents(123450)).toBe('$1,234.50')
  })

  it('shows "<1%" for any spend under one percent and never 100% below the limit', () => {
    expect(formatBudgetShare(0, 1)).toBe('0%')
    expect(formatBudgetShare(0.004, 1)).toBe('<1%')
    expect(formatBudgetShare(0.82, 1)).toBe('82%')
    expect(formatBudgetShare(99.6, 100)).toBe('99%')
    expect(formatBudgetShare(2500, 10000)).toBe('25%')
  })
})
