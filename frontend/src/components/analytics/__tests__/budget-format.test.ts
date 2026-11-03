import { describe, it, expect } from 'vitest'

import { formatBudgetCents, formatBudgetShare } from '@/types/budgets'

/** A one-cent budget's spend reads as fractions of a cent and a real share, not "$0.00 (0%)". */
describe('budget amounts and shares', () => {
  it('keeps fractions of a cent under a dollar', () => {
    expect(formatBudgetCents(0)).toBe('$0.00')
    expect(formatBudgetCents(0.42)).toBe('$0.0042')
    expect(formatBudgetCents(0.8)).toBe('$0.008')
    expect(formatBudgetCents(1)).toBe('$0.01')
    expect(formatBudgetCents(2500)).toBe('$25.00')
  })

  it('shows "<1%" for any spend under one percent and never 100% below the limit', () => {
    expect(formatBudgetShare(0, 1)).toBe('0%')
    expect(formatBudgetShare(0.004, 1)).toBe('<1%')
    expect(formatBudgetShare(0.82, 1)).toBe('82%')
    expect(formatBudgetShare(99.6, 100)).toBe('99%')
    expect(formatBudgetShare(2500, 10000)).toBe('25%')
  })
})
