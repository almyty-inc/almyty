import { BadRequestException } from '@nestjs/common';

import {
  cronFor,
  describeTiming,
  nextRuns,
  normalizeTiming,
  repeatFor,
  timingOf,
} from '../agent-schedule-spec';

/**
 * Time-of-day schedules. The queue fires on a cron expression in a time
 * zone; these pin the expression, the plain words the page shows, and the
 * next-run instants across the two daylight saving changes, because
 * "every weekday at 8:00, Europe/Berlin" is a different UTC hour in March
 * than in February and a schedule that drifts by an hour twice a year is
 * the bug this exists to prevent.
 */
describe('agent schedule timing', () => {
  const iso = (ds: Date[]) => ds.map((d) => d.toISOString());

  describe('normalizeTiming', () => {
    it('keeps the original every-N-minutes shape as the default kind', () => {
      expect(normalizeTiming({ intervalMinutes: 15 })).toEqual({ kind: 'interval', intervalMinutes: 15 });
    });

    it('stores a weekday schedule with its zone and sorted, unique days', () => {
      expect(
        normalizeTiming({ kind: 'days', time: '8:00', days: [5, 1, 3, 3, 2, 4], timezone: 'Europe/Berlin' }),
      ).toEqual({ kind: 'days', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' });
    });

    it("uses the person's profile zone when the request names none, then UTC", () => {
      expect(normalizeTiming({ kind: 'days', time: '09:30', days: [1] }, 'America/New_York').timezone).toBe('America/New_York');
      expect(normalizeTiming({ kind: 'days', time: '09:30', days: [1] }, null).timezone).toBe('UTC');
      expect(normalizeTiming({ kind: 'days', time: '09:30', days: [1] }, 'Not/AZone').timezone).toBe('UTC');
    });

    it.each([
      [{ kind: 'days', time: '25:00', days: [1] }],
      [{ kind: 'days', time: '8am', days: [1] }],
      [{ kind: 'days', time: '08:00', days: [] }],
      [{ kind: 'days', time: '08:00', days: [7] }],
      [{ kind: 'days', time: '08:00', days: [1], timezone: 'Mars/Olympus' }],
      [{ kind: 'monthly', time: '08:00', dayOfMonth: 31 }],
      [{ kind: 'monthly', time: '08:00', dayOfMonth: 0 }],
      [{ kind: 'hourly' }],
      [{ kind: 'interval', intervalMinutes: 0 }],
    ])('refuses %j', (body) => {
      expect(() => normalizeTiming(body as any)).toThrow(BadRequestException);
    });
  });

  describe('cron and repeat options', () => {
    it('writes every day as *, and chosen days as a list', () => {
      expect(cronFor({ kind: 'days', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6], timezone: 'UTC' })).toBe('0 8 * * *');
      expect(cronFor({ kind: 'days', time: '17:30', days: [1, 4], timezone: 'UTC' })).toBe('30 17 * * 1,4');
      expect(cronFor({ kind: 'monthly', time: '09:05', dayOfMonth: 1, timezone: 'UTC' })).toBe('5 9 1 * *');
    });

    it('gives Bull a cron with its zone for a time of day, and milliseconds for an interval', () => {
      expect(repeatFor({ kind: 'days', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' })).toEqual({
        cron: '0 8 * * 1,2,3,4,5',
        tz: 'Europe/Berlin',
      });
      expect(repeatFor({ kind: 'interval', intervalMinutes: 15 })).toEqual({ every: 15 * 60 * 1000 });
    });

    it('reads a schedule stored before kinds existed as an interval', () => {
      expect(repeatFor(timingOf({ enabled: true, intervalMinutes: 30, input: {} }))).toEqual({ every: 30 * 60 * 1000 });
    });
  });

  describe('next runs follow the wall clock across daylight saving', () => {
    it('Europe/Berlin at 8:00 is 07:00 UTC before the spring change and 06:00 UTC after it', () => {
      const runs = nextRuns(
        { kind: 'days', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6], timezone: 'Europe/Berlin' },
        new Date('2026-03-27T12:00:00Z'),
        4,
      );
      expect(iso(runs)).toEqual([
        '2026-03-28T07:00:00.000Z',
        '2026-03-29T06:00:00.000Z',
        '2026-03-30T06:00:00.000Z',
        '2026-03-31T06:00:00.000Z',
      ]);
    });

    it('Europe/Berlin at 8:00 goes back to 07:00 UTC after the autumn change', () => {
      const runs = nextRuns(
        { kind: 'days', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6], timezone: 'Europe/Berlin' },
        new Date('2026-10-24T12:00:00Z'),
        2,
      );
      expect(iso(runs)).toEqual(['2026-10-25T07:00:00.000Z', '2026-10-26T07:00:00.000Z']);
    });

    it('a time the autumn change repeats (02:30 on 25 Oct in Berlin) runs once', () => {
      const runs = nextRuns(
        { kind: 'days', time: '02:30', days: [0, 1, 2, 3, 4, 5, 6], timezone: 'Europe/Berlin' },
        new Date('2026-10-24T12:00:00Z'),
        3,
      );
      expect(iso(runs)).toEqual([
        '2026-10-25T00:30:00.000Z',
        '2026-10-26T01:30:00.000Z',
        '2026-10-27T01:30:00.000Z',
      ]);
    });

    it('a time the spring change skips (02:30 on 29 Mar in Berlin) still runs that day, after the gap', () => {
      const [first, second] = nextRuns(
        { kind: 'days', time: '02:30', days: [0, 1, 2, 3, 4, 5, 6], timezone: 'Europe/Berlin' },
        new Date('2026-03-28T12:00:00Z'),
        2,
      );
      expect(first.toISOString().slice(0, 10)).toBe('2026-03-29');
      expect(first.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-03-29T01:00:00Z'));
      expect(second.toISOString()).toBe('2026-03-30T00:30:00.000Z');
    });

    it('weekdays in New York skip the weekend and move an hour at the November change', () => {
      const runs = nextRuns(
        { kind: 'days', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'America/New_York' },
        new Date('2026-10-30T13:00:00Z'), // Friday 09:00 EDT, after that day's run
        2,
      );
      // Monday 2 Nov: EST, UTC-5.
      expect(iso(runs)).toEqual(['2026-11-02T13:00:00.000Z', '2026-11-03T13:00:00.000Z']);
      const before = nextRuns(
        { kind: 'days', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'America/New_York' },
        new Date('2026-10-29T00:00:00Z'),
        1,
      );
      // Thursday 29 Oct: EDT, UTC-4.
      expect(iso(before)).toEqual(['2026-10-29T12:00:00.000Z']);
    });

    it('the last day of the month is the 31st, the 28th in February, the 30th in April', () => {
      const timing = normalizeTiming({ kind: 'monthly', time: '18:00', dayOfMonth: 'last', timezone: 'Europe/Berlin' });
      expect(timing).toEqual({ kind: 'monthly', time: '18:00', dayOfMonth: 'last', timezone: 'Europe/Berlin' });
      expect(repeatFor(timing)).toEqual({ cron: '0 18 L * *', tz: 'Europe/Berlin' });
      expect(iso(nextRuns(timing, new Date('2026-01-15T00:00:00Z'), 4))).toEqual([
        '2026-01-31T17:00:00.000Z',
        '2026-02-28T17:00:00.000Z',
        '2026-03-31T16:00:00.000Z',
        '2026-04-30T16:00:00.000Z',
      ]);
    });
    it('a monthly schedule fires on its day at the local time, summer and winter', () => {
      const runs = nextRuns(
        { kind: 'monthly', time: '09:00', dayOfMonth: 1, timezone: 'Europe/Berlin' },
        new Date('2026-02-15T00:00:00Z'),
        3,
      );
      expect(iso(runs)).toEqual([
        '2026-03-01T08:00:00.000Z',
        '2026-04-01T07:00:00.000Z',
        '2026-05-01T07:00:00.000Z',
      ]);
    });

    it('an interval has no computed next run (the queue reports it)', () => {
      expect(nextRuns({ kind: 'interval', intervalMinutes: 5 }, new Date(), 3)).toEqual([]);
    });
  });

  describe('plain words', () => {
    it.each([
      [{ kind: 'days', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' }, 'Every weekday at 8:00, Europe/Berlin'],
      [{ kind: 'days', time: '07:05', days: [0, 1, 2, 3, 4, 5, 6], timezone: 'UTC' }, 'Every day at 7:05, UTC'],
      [{ kind: 'days', time: '17:30', days: [1], timezone: 'UTC' }, 'Every Monday at 17:30, UTC'],
      [{ kind: 'days', time: '09:00', days: [0, 1, 3, 5], timezone: 'UTC' }, 'Every Monday, Wednesday, Friday and Sunday at 9:00, UTC'],
      [{ kind: 'days', time: '10:00', days: [0, 6], timezone: 'UTC' }, 'Every Saturday and Sunday at 10:00, UTC'],
      [{ kind: 'monthly', time: '09:00', dayOfMonth: 1, timezone: 'America/New_York' }, 'On the 1st of every month at 9:00, America/New_York'],
      [{ kind: 'monthly', time: '09:00', dayOfMonth: 22, timezone: 'UTC' }, 'On the 22nd of every month at 9:00, UTC'],
      [{ kind: 'monthly', time: '09:00', dayOfMonth: 13, timezone: 'UTC' }, 'On the 13th of every month at 9:00, UTC'],
      [{ kind: 'monthly', time: '18:00', dayOfMonth: 'last', timezone: 'UTC' }, 'On the last day of every month at 18:00, UTC'],
      [{ kind: 'interval', intervalMinutes: 15 }, 'Every 15 minutes'],
      [{ kind: 'interval', intervalMinutes: 60 }, 'Every hour'],
      [{ kind: 'interval', intervalMinutes: 180 }, 'Every 3 hours'],
      [{ kind: 'interval', intervalMinutes: 1 }, 'Every minute'],
    ])('%j reads "%s"', (timing, words) => {
      expect(describeTiming(timing as any)).toBe(words);
    });
  });
});
