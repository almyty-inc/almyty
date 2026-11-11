/**
 * Today's date for a model. A model takes its training cutoff for today
 * unless it is told otherwise: checkers failed real 2026 papers as "from
 * the future", and "this week" resolved to a year that had passed. Every
 * model call a run makes is told the date and the organization's time
 * zone through this one helper (LlmChatHelper applies it to a request
 * with `currentTime: true`; the time zone comes from
 * OrganizationTimeZoneService).
 */

/** The block a model call is given, and how a prompt that has it is recognised. */
export const CURRENT_TIME_MARKER = '[CURRENT TIME]';

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isKnownTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The first of `candidates` that is a known time zone, else UTC. */
export function resolveTimeZone(...candidates: unknown[]): string {
  for (const zone of candidates) if (isKnownTimeZone(zone)) return zone;
  return 'UTC';
}

/** An instant as it reads on a clock in `timeZone`. */
export interface LocalTime {
  weekday: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24-hour */
  time: string;
  /** ISO 8601 with the zone's offset, to the second: 2026-11-11T19:30:00+01:00 */
  iso: string;
}

export function localTime(now: Date, timeZone = 'UTC'): LocalTime {
  const zone = resolveTimeZone(timeZone);
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)) {
    parts[p.type] = p.value;
  }
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMinutes = Math.round((wall - Math.floor(now.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return { weekday: parts.weekday, date, time, iso: `${date}T${time}:${parts.second}${offset}` };
}

/**
 * The date and time a run's model is told, with the weekday, so "today",
 * "this week" and "three days ago" resolve to real dates. In UTC unless a
 * time zone is given.
 */
export function describeNow(now: Date, timeZone = 'UTC'): string {
  const zone = resolveTimeZone(timeZone);
  const local = localTime(now, zone);
  const where = zone === 'UTC' ? 'UTC' : `in ${zone}`;
  return `It is ${local.weekday}, ${local.date}, ${local.time} ${where} (${now.toISOString()}).`;
}

/** The [CURRENT TIME] block of a system prompt. */
export function currentTimeBlock(now: Date, timeZone = 'UTC'): string {
  const zone = resolveTimeZone(timeZone);
  return (
    `${CURRENT_TIME_MARKER}\n${describeNow(now, zone)} The organization's time zone is ${zone}. ` +
    `A date on or before ${localTime(now, zone).date} is not in the future.`
  );
}

type PromptMessage = { role: any; content: any };

function mentionsCurrentTime(content: unknown): boolean {
  if (typeof content === 'string') return content.includes(CURRENT_TIME_MARKER);
  if (Array.isArray(content)) return content.some((part) => typeof part?.text === 'string' && part.text.includes(CURRENT_TIME_MARKER));
  return false;
}

/**
 * `messages` with the current time in their system prompt: appended to the
 * first system message, or as a system message of its own when there is
 * none. A prompt that already carries the block is returned as it is, so
 * applying it twice (chatStream falling through to chat) adds it once.
 */
export function withCurrentTime<M extends PromptMessage>(messages: M[], now: Date, timeZone = 'UTC'): M[] {
  const list = Array.isArray(messages) ? messages : [];
  if (list.some((m) => m?.role === 'system' && mentionsCurrentTime(m.content))) return list;
  const block = currentTimeBlock(now, timeZone);
  const at = list.findIndex((m) => m?.role === 'system');
  if (at === -1) return [{ role: 'system', content: block } as M, ...list];
  const system = list[at];
  const content = Array.isArray(system.content)
    ? [...system.content, { type: 'text', text: `\n\n${block}` }]
    : `${system.content ?? ''}\n\n${block}`;
  return list.map((m, i) => (i === at ? ({ ...m, content } as M) : m));
}
