import { describe, it, expect } from 'vitest'
import { costTitle, costTitleCents, formatCost, formatCostCents, formatDuration } from '../format'

describe('formatCost', () => {
  it('shows two decimals from a cent up', () => {
    expect(formatCost(2.4665)).toBe('$2.47')
    expect(formatCost(0.25)).toBe('$0.25')
    expect(formatCost(0.01)).toBe('$0.01')
    expect(formatCost(0.005)).toBe('$0.01')
    expect(formatCost(1234.5)).toBe('$1,234.50')
  })

  it('says "<$0.01" for a fraction of a cent', () => {
    expect(formatCost(0.0042)).toBe('<$0.01')
    expect(formatCost(0.0049)).toBe('<$0.01')
    expect(formatCost(0.00001)).toBe('<$0.01')
  })

  it('says "--" for zero or no data, or what the caller asks for', () => {
    expect(formatCost(0)).toBe('--')
    expect(formatCost(null)).toBe('--')
    expect(formatCost(undefined)).toBe('--')
    expect(formatCost(Number.NaN)).toBe('--')
    expect(formatCost(0, { empty: '$0.00' })).toBe('$0.00')
  })

  it('keeps the sign of a negative amount', () => {
    expect(formatCost(-0.5)).toBe('-$0.50')
    expect(formatCost(-0.001)).toBe('-<$0.01')
  })

  it('reads cents the same way', () => {
    expect(formatCostCents(246.65)).toBe('$2.47')
    expect(formatCostCents(0.42)).toBe('<$0.01')
    expect(formatCostCents(2500)).toBe('$25.00')
    expect(formatCostCents(0)).toBe('--')
  })

  it('keeps the exact amount for the tooltip', () => {
    expect(costTitle(2.4665)).toBe('$2.4665')
    expect(costTitle(0.0004213)).toBe('$0.0004213')
    expect(costTitle(0.1 + 0.2)).toBe('$0.3')
    expect(costTitle(0)).toBeUndefined()
    expect(costTitle(undefined)).toBeUndefined()
    expect(costTitleCents(0.42)).toBe('$0.0042')
  })
})

describe('formatDuration', () => {
  it('uses tenths of a second under a second', () => {
    expect(formatDuration(400)).toBe('0.4s')
    expect(formatDuration(50)).toBe('0.1s')
    expect(formatDuration(30)).toBe('<0.1s')
  })

  it('uses whole seconds under a minute', () => {
    expect(formatDuration(55_000)).toBe('55s')
    expect(formatDuration(970)).toBe('1s')
    expect(formatDuration(9_500)).toBe('10s')
    expect(formatDuration(1_600)).toBe('2s')
  })

  it('uses minutes and seconds under an hour, never a decimal minute', () => {
    expect(formatDuration(78_000)).toBe('1m 18s')
    expect(formatDuration(76_600)).toBe('1m 17s')
    expect(formatDuration(120_000)).toBe('2m')
    expect(formatDuration(59_600)).toBe('1m')
    expect(formatDuration(3_599_000)).toBe('59m 59s')
  })

  it('uses hours and minutes from an hour up, never a decimal hour', () => {
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m')
    expect(formatDuration(3_600_000)).toBe('1h')
    expect(formatDuration(3_599_700)).toBe('1h')
    expect(formatDuration(30 * 3_600_000)).toBe('30h')
  })

  it('says "--" for zero or no data, or what the caller asks for', () => {
    expect(formatDuration(0)).toBe('--')
    expect(formatDuration(null)).toBe('--')
    expect(formatDuration(undefined)).toBe('--')
    expect(formatDuration(-5)).toBe('--')
    expect(formatDuration(0, { empty: '0s' })).toBe('0s')
  })
})
