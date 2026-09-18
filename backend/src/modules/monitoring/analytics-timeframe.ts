/**
 * Bounds on the analytics window a caller may ask for.
 *
 * `timeframe` used to travel from the query string into a regex-parsed
 * window with no upper bound: `?timeframe=9999m` is roughly 833 years and
 * degenerates every aggregate into a full-table scan, and
 * `?timeframe=999d&granularity=minute` asks for up to 1.44M buckets in one
 * JSON array. `routing-analytics.controller.ts` already clamps its own
 * window to 90 days; these are the same bounds, shared so the several
 * analytics endpoints cannot drift apart.
 */

/** Longest window any analytics endpoint will honour. */
export const MAX_ANALYTICS_WINDOW_DAYS = 90;

/** Window used when the caller sends nothing parseable. */
export const DEFAULT_ANALYTICS_TIMEFRAME = '7d';

/** Most buckets one timeline response will return. */
export const MAX_TIMELINE_BUCKETS = 2000;

const HOURS_PER_UNIT: Record<string, number> = {
  h: 1,
  d: 24,
  w: 24 * 7,
  m: 24 * 30,
};

/** The window a timeframe string asks for, in hours; null when unparseable. */
export function timeframeHours(timeframe: string | undefined): number | null {
  if (typeof timeframe !== 'string') return null;
  const match = timeframe.trim().match(/^(\d+)(h|d|w|m)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value * HOURS_PER_UNIT[match[2]];
}

/**
 * A timeframe string the analytics queries may safely act on: the caller's
 * own when it parses and fits inside MAX_ANALYTICS_WINDOW_DAYS, otherwise
 * the ceiling (or the default when it does not parse at all).
 */
export function clampTimeframe(timeframe: string | undefined): string {
  const hours = timeframeHours(timeframe);
  if (hours === null) return DEFAULT_ANALYTICS_TIMEFRAME;
  const maxHours = MAX_ANALYTICS_WINDOW_DAYS * 24;
  if (hours > maxHours) return `${MAX_ANALYTICS_WINDOW_DAYS}d`;
  return (timeframe as string).trim();
}

/**
 * A granularity whose bucket count over `timeframe` stays under
 * MAX_TIMELINE_BUCKETS, coarsening minute -> hour -> day as needed. The
 * timeframe is expected to have been clamped already.
 */
export function clampGranularity(
  timeframe: string | undefined,
  granularity: string | undefined,
): 'minute' | 'hour' | 'day' {
  const hours = timeframeHours(timeframe) ?? 24 * 7;
  const asked: 'minute' | 'hour' | 'day' =
    granularity === 'minute' ? 'minute' : granularity === 'day' ? 'day' : 'hour';

  const bucketsFor = (g: 'minute' | 'hour' | 'day') =>
    g === 'minute' ? hours * 60 : g === 'hour' ? hours : hours / 24;

  const coarser: Array<'minute' | 'hour' | 'day'> = ['minute', 'hour', 'day'];
  for (let i = coarser.indexOf(asked); i < coarser.length; i++) {
    if (bucketsFor(coarser[i]) <= MAX_TIMELINE_BUCKETS) return coarser[i];
  }
  return 'day';
}
