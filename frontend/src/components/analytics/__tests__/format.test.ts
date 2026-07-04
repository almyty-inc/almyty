import { describe, it, expect } from 'vitest'

import { computeYAxisMax } from '../format'

describe('computeYAxisMax', () => {
  it('returns the floor ceiling for an all-zero week', () => {
    expect(computeYAxisMax([0, 0, 0, 0, 0, 0, 0])).toBe(10)
  })

  it('does not pin low-volume data to a tall fixed axis', () => {
    // Regression: a week with single-digit request counts used to
    // render against a y-max of 200. The ceiling must track the data.
    const max = computeYAxisMax([1, 3, 2, 0, 4, 2, 1])
    expect(max).not.toBe(200)
    expect(max).toBeLessThanOrEqual(10)
    expect(max).toBeGreaterThanOrEqual(4)
  })

  it('picks the next nice 1/2/5 step above the max value', () => {
    expect(computeYAxisMax([12])).toBe(20)
    expect(computeYAxisMax([37])).toBe(50)
    expect(computeYAxisMax([73])).toBe(100)
    expect(computeYAxisMax([170])).toBe(200)
    expect(computeYAxisMax([230])).toBe(500)
    expect(computeYAxisMax([4200])).toBe(5000)
  })

  it('keeps an exact nice value as its own ceiling', () => {
    expect(computeYAxisMax([200])).toBe(200)
    expect(computeYAxisMax([1000])).toBe(1000)
  })

  it('respects a custom minimum ceiling', () => {
    expect(computeYAxisMax([2], 5)).toBe(5)
    expect(computeYAxisMax([7], 5)).toBe(10)
  })

  it('ignores non-finite values', () => {
    expect(computeYAxisMax([NaN, Infinity, 12])).toBe(20)
    expect(computeYAxisMax([])).toBe(10)
  })
})
