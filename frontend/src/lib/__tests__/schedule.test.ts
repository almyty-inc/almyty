import { describe, expect, it } from 'vitest'

import {
  dayChoiceOf,
  describeDelivery,
  describeSchedule,
  formatRunTime,
  requestFromStored,
} from '../schedule'

/**
 * The schedule in plain words, as the page and the card say it. The cases
 * are the backend's (agent-schedule-spec.spec.ts), so the two cannot drift
 * into describing one schedule two ways.
 */
describe('describeSchedule', () => {
  it.each([
    [{ kind: 'days', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' }, 'Every weekday at 8:00, Europe/Berlin'],
    [{ kind: 'days', time: '07:05', days: [0, 1, 2, 3, 4, 5, 6], timezone: 'UTC' }, 'Every day at 7:05, UTC'],
    [{ kind: 'days', time: '17:30', days: [1], timezone: 'UTC' }, 'Every Monday at 17:30, UTC'],
    [{ kind: 'days', time: '09:00', days: [0, 1, 3, 5], timezone: 'UTC' }, 'Every Monday, Wednesday, Friday and Sunday at 9:00, UTC'],
    [{ kind: 'days', time: '10:00', days: [0, 6], timezone: 'UTC' }, 'Every Saturday and Sunday at 10:00, UTC'],
    [{ kind: 'monthly', time: '09:00', dayOfMonth: 1, timezone: 'America/New_York' }, 'On the 1st of every month at 9:00, America/New_York'],
    [{ kind: 'monthly', time: '09:00', dayOfMonth: 22, timezone: 'UTC' }, 'On the 22nd of every month at 9:00, UTC'],
    [{ kind: 'monthly', time: '09:00', dayOfMonth: 13, timezone: 'UTC' }, 'On the 13th of every month at 9:00, UTC'],
    [{ kind: 'interval', intervalMinutes: 15 }, 'Every 15 minutes'],
    [{ kind: 'interval', intervalMinutes: 60 }, 'Every hour'],
    [{ kind: 'interval', intervalMinutes: 180 }, 'Every 3 hours'],
    [{ kind: 'interval', intervalMinutes: 1 }, 'Every minute'],
    // Saved before kinds existed.
    [{ intervalMinutes: 30 }, 'Every 30 minutes'],
  ])('%j reads "%s"', (timing, words) => {
    expect(describeSchedule(timing as any)).toBe(words)
  })
})

describe('dayChoiceOf', () => {
  it('names every day, weekdays, and anything else as chosen days', () => {
    expect(dayChoiceOf([0, 1, 2, 3, 4, 5, 6])).toBe('every_day')
    expect(dayChoiceOf([5, 4, 3, 2, 1])).toBe('weekdays')
    expect(dayChoiceOf([1, 3])).toBe('specific')
  })
})

describe('requestFromStored', () => {
  it('turns a stored schedule back on as it was, without what the server records', () => {
    expect(
      requestFromStored({
        enabled: false,
        kind: 'days',
        time: '08:00',
        days: [1],
        timezone: 'Europe/Berlin',
        input: { topic: 'sales' },
        deliverTo: { kind: 'channel', channelId: 'ch-1', to: 'C1', label: '#sales' },
        pausedReason: { code: 'MODEL_NOT_FOUND' },
      }),
    ).toEqual({
      kind: 'days',
      time: '08:00',
      days: [1],
      timezone: 'Europe/Berlin',
      input: { topic: 'sales' },
      deliverTo: { kind: 'channel', channelId: 'ch-1', to: 'C1', label: '#sales' },
    })
  })

  it('reads a schedule saved before kinds existed as an interval', () => {
    expect(requestFromStored({ enabled: true, intervalMinutes: 45, input: {} } as any)).toEqual({
      kind: 'interval',
      intervalMinutes: 45,
      input: {},
    })
  })
})

describe('formatRunTime', () => {
  it("shows a run in the schedule's own zone, with the zone", () => {
    // 06:00 UTC on 5 Oct 2026 is 08:00 in Berlin (summer time).
    expect(formatRunTime('2026-10-05T06:00:00.000Z', 'Europe/Berlin')).toBe('Mon 5 Oct, 08:00 (Europe/Berlin)')
    // After the clocks go back, the same wall time is 07:00 UTC.
    expect(formatRunTime('2026-10-26T07:00:00.000Z', 'Europe/Berlin')).toBe('Mon 26 Oct, 08:00 (Europe/Berlin)')
  })
})

describe('describeDelivery', () => {
  it('says where a result went, and why one did not', () => {
    expect(describeDelivery({ status: 'delivered', channelId: 'c', channelName: 'Sales Slack', destination: '#sales', parts: 1, at: '' })).toEqual({
      text: 'Posted to Sales Slack, #sales',
      failed: false,
    })
    expect(describeDelivery({ status: 'delivered', channelId: 'c', channelName: 'Discord', parts: 3, at: '' })?.text).toBe(
      'Posted to Discord in 3 messages',
    )
    expect(
      describeDelivery({ status: 'failed', channelId: 'c', channelName: 'Sales Slack', destination: '#sales', error: 'not_in_channel', at: '' }),
    ).toEqual({ text: 'Posting failed to Sales Slack, #sales: not_in_channel', failed: true })
    expect(describeDelivery(undefined)).toBeNull()
  })
})
