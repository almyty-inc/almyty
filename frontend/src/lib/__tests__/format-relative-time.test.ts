import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

import { formatRelativeTime } from '../utils'

/**
 * A time still to come (a credential's expiry, a workspace's end) used to
 * read "just now": the negative difference fell under every threshold.
 */
describe('formatRelativeTime', () => {
  const NOW = new Date('2026-09-29T12:00:00.000Z')
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  it('says how long ago a past time was', () => {
    expect(formatRelativeTime(at(-10_000))).toBe('just now')
    expect(formatRelativeTime(at(-5 * MIN))).toBe('5m ago')
    expect(formatRelativeTime(at(-3 * HOUR))).toBe('3h ago')
    expect(formatRelativeTime(at(-2 * DAY))).toBe('2d ago')
  })

  it('says how long until a time still to come', () => {
    expect(formatRelativeTime(at(5 * MIN))).toBe('in 5m')
    expect(formatRelativeTime(at(3 * HOUR))).toBe('in 3h')
    expect(formatRelativeTime(at(2 * DAY))).toBe('in 2d')
  })

  it('treats a few seconds ahead as now, not the future', () => {
    expect(formatRelativeTime(at(20_000))).toBe('just now')
  })

  it('falls back to the date a month or more away, either way', () => {
    expect(formatRelativeTime(at(-40 * DAY))).not.toMatch(/ago|^in /)
    expect(formatRelativeTime(at(40 * DAY))).not.toMatch(/ago|^in /)
  })
})
