import { BadRequestException } from '@nestjs/common';
import { parseExpression } from 'cron-parser';

/**
 * When a scheduled agent runs, in the shapes a person picks on the
 * schedule page:
 *
 *   - every N minutes (the original shape, still the default for a stored
 *     schedule that names no kind),
 *   - at a time of day on chosen days of the week (every day, weekdays,
 *     or any set of days -- one day is "weekly"),
 *   - at a time of day on one day of the month.
 *
 * The two time-of-day shapes become a cron expression with a time zone,
 * which Bull's repeatable jobs evaluate with cron-parser. The next-run
 * times shown in the product are computed with the same library and the
 * same expression, so what the page says is what the queue does,
 * daylight saving included: "8:00, Europe/Berlin" is 07:00 UTC in winter
 * and 06:00 UTC in summer. A time that does not exist on the day the
 * clocks go forward runs at the first moment after the gap; a time that
 * happens twice when they go back runs once.
 */
export type ScheduleKind = 'interval' | 'days' | 'monthly';

export interface ScheduleTiming {
  kind: ScheduleKind;
  /** kind 'interval'. */
  intervalMinutes?: number;
  /** kinds 'days' and 'monthly': "HH:MM", 24-hour, local to `timezone`. */
  time?: string;
  /** kind 'days': days of the week, 0 = Sunday ... 6 = Saturday, sorted, unique. */
  days?: number[];
  /** kind 'monthly': the day of the month, 1-28 (every month has one), or 'last' for its last day. */
  dayOfMonth?: number | 'last';
  /** kinds 'days' and 'monthly': an IANA time zone name. */
  timezone?: string;
}

/** Bounds on intervalMinutes. Below the floor we'd flood Redis; above the
 *  ceiling Bull can mishandle the timestamp arithmetic. */
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 60 * 24 * 365; // 1 year

/** The last day of the month every month has. */
export const MAX_DAY_OF_MONTH = 28;

const WEEKDAYS = [1, 2, 3, 4, 5];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function validateIntervalMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException('intervalMinutes must be a finite number');
  }
  if (value < MIN_INTERVAL_MINUTES || value > MAX_INTERVAL_MINUTES) {
    throw new BadRequestException(
      `intervalMinutes must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`,
    );
  }
  return Math.floor(value);
}

/** Whether the runtime knows this IANA zone name. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function parseTime(value: unknown): { hour: number; minute: number } {
  const match = typeof value === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(value.trim()) : null;
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour > 23 || minute > 59) {
    throw new BadRequestException('time must be a time of day like 08:00');
  }
  return { hour, minute };
}

function normalizeDays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestException('Pick at least one day of the week');
  }
  const days = [...new Set(value)].map((d) => Number(d));
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new BadRequestException('days must be days of the week, 0 (Sunday) to 6 (Saturday)');
  }
  return days.sort((a, b) => a - b);
}

/**
 * The timing a request describes, validated and in its stored shape.
 * `fallbackZone` is used when a time-of-day schedule names no zone: the
 * zone of the person setting it (their profile), else UTC.
 */
export function normalizeTiming(body: Record<string, any>, fallbackZone?: string | null): ScheduleTiming {
  const kind: ScheduleKind = body?.kind ?? 'interval';
  if (kind === 'interval') {
    return { kind, intervalMinutes: validateIntervalMinutes(body.intervalMinutes) };
  }
  if (kind !== 'days' && kind !== 'monthly') {
    throw new BadRequestException('kind must be interval, days or monthly');
  }
  const { hour, minute } = parseTime(body.time);
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const zone = body.timezone ?? (isTimeZone(fallbackZone) ? fallbackZone : 'UTC');
  if (!isTimeZone(zone)) throw new BadRequestException(`Unknown time zone: ${String(zone)}`);
  if (kind === 'days') {
    return { kind, time, days: normalizeDays(body.days), timezone: zone };
  }
  if (body.dayOfMonth === 'last') return { kind, time, dayOfMonth: 'last', timezone: zone };
  const day = Number(body.dayOfMonth);
  if (!Number.isInteger(day) || day < 1 || day > MAX_DAY_OF_MONTH) {
    throw new BadRequestException(`dayOfMonth must be between 1 and ${MAX_DAY_OF_MONTH}, or "last"`);
  }
  return { kind, time, dayOfMonth: day, timezone: zone };
}

/** The stored timing of a schedule; one saved before kinds existed is an interval. */
export function timingOf(schedule: Record<string, any> | null | undefined): ScheduleTiming {
  const kind: ScheduleKind = schedule?.kind ?? 'interval';
  if (kind === 'interval') return { kind, intervalMinutes: schedule?.intervalMinutes };
  return {
    kind,
    time: schedule?.time,
    days: schedule?.days,
    dayOfMonth: schedule?.dayOfMonth,
    timezone: schedule?.timezone,
  };
}

/** The cron expression for a time-of-day timing; null for an interval. */
export function cronFor(timing: ScheduleTiming): string | null {
  if (timing.kind === 'interval') return null;
  const { hour, minute } = parseTime(timing.time);
  if (timing.kind === 'days') {
    const days = normalizeDays(timing.days);
    return `${minute} ${hour} * * ${days.length === 7 ? '*' : days.join(',')}`;
  }
  // 'L' is cron-parser's last day of the month (the 28th to the 31st, as the month has it).
  return `${minute} ${hour} ${timing.dayOfMonth === 'last' ? 'L' : timing.dayOfMonth} * *`;
}

/**
 * The Bull repeat options for a timing: `every` in milliseconds for an
 * interval, `cron` and `tz` for a time of day. Throws on a stored timing
 * that no longer validates, so restore can skip it.
 */
export function repeatFor(timing: ScheduleTiming): { every: number } | { cron: string; tz: string } {
  if (timing.kind === 'interval') {
    return { every: validateIntervalMinutes(timing.intervalMinutes) * 60 * 1000 };
  }
  const tz = timing.timezone;
  if (!isTimeZone(tz)) throw new BadRequestException(`Unknown time zone: ${String(tz)}`);
  return { cron: cronFor(timing)!, tz };
}

/**
 * The next `count` times a time-of-day timing fires after `from`, as UTC
 * instants. Empty for an interval, whose next run depends on when the
 * repeat was registered (the queue reports it).
 */
export function nextRuns(timing: ScheduleTiming, from: Date, count = 1): Date[] {
  const cron = cronFor(timing);
  if (!cron) return [];
  const it = parseExpression(cron, { currentDate: from, tz: timing.timezone });
  const out: Date[] = [];
  for (let i = 0; i < count; i++) out.push(it.next().toDate());
  return out;
}

function ordinal(n: number): string {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

function listOf(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function intervalWords(minutes: number): string {
  if (minutes === 1) return 'Every minute';
  if (minutes % (60 * 24) === 0) {
    const d = minutes / (60 * 24);
    return d === 1 ? 'Every 24 hours' : `Every ${d} days`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? 'Every hour' : `Every ${h} hours`;
  }
  return `Every ${minutes} minutes`;
}

/**
 * The schedule in plain words: "Every weekday at 8:00, Europe/Berlin",
 * "Every Monday and Thursday at 17:30, UTC", "On the 1st of every month
 * at 9:00, America/New_York", "Every 15 minutes". Mirrored in the
 * frontend (lib/schedule.ts) so the page and the API say the same thing.
 */
export function describeTiming(timing: ScheduleTiming): string {
  if (timing.kind === 'interval') {
    const minutes = Number(timing.intervalMinutes);
    return Number.isFinite(minutes) && minutes >= 1 ? intervalWords(Math.floor(minutes)) : 'Every few minutes';
  }
  const { hour, minute } = parseTime(timing.time);
  const at = `at ${hour}:${String(minute).padStart(2, '0')}, ${timing.timezone ?? 'UTC'}`;
  if (timing.kind === 'monthly') {
    return timing.dayOfMonth === 'last'
      ? `On the last day of every month ${at}`
      : `On the ${ordinal(Number(timing.dayOfMonth))} of every month ${at}`;
  }
  const days = normalizeDays(timing.days);
  if (days.length === 7) return `Every day ${at}`;
  if (days.length === 5 && WEEKDAYS.every((d) => days.includes(d))) return `Every weekday ${at}`;
  if (days.length === 2 && days[0] === 0 && days[1] === 6) return `Every Saturday and Sunday ${at}`;
  // Monday first, the way a week reads.
  const ordered = [...days.filter((d) => d !== 0), ...days.filter((d) => d === 0)];
  return `Every ${listOf(ordered.map((d) => DAY_NAMES[d]))} ${at}`;
}
