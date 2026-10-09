/**
 * The daily summary of an always-on agent (docs/always-on.md, "Reports").
 * With `report: 'daily_digest'` it posts nothing after each wake; once a
 * day, at a time of day in a time zone, it posts one short message about
 * the last 24 hours: how often it woke and why, how its work ended, what it
 * changed, and what waits for the owner's OK. A day with nothing in it
 * posts nothing.
 *
 * When it goes out is set per agent; left alone, it is 09:00 in the
 * owner's own time zone. In order:
 *
 * 1. The agent's own setting (`alwaysOn.digest.time`, `.timezone`), the
 *    only one the product shows.
 * 2. For the time zone, the owner's profile.
 * 3. Fallbacks set by data, with no screen of their own: the
 *    organization's `settings.alwaysOn.digestTime` / `.digestTimezone`,
 *    then the install's ALWAYS_ON_DIGEST_DEFAULT, JSON like
 *    `{"time":"08:00","timezone":"Europe/Berlin"}`, over the seeded row
 *    below (09:00 UTC).
 */
import { isTimeZone } from '../agent-schedule-spec';
import type { WakeSource } from '../../../entities/agent-wake.entity';
import type { AlwaysOnConfig } from './always-on.types';

export const ALWAYS_ON_DIGEST_ENV = 'ALWAYS_ON_DIGEST_DEFAULT';

export interface DigestTiming {
  /** "HH:MM", 24-hour, in `timezone`. */
  time: string;
  /** An IANA time zone name. */
  timezone: string;
}

/** The seeded install default. */
export const ALWAYS_ON_DIGEST_SEED: DigestTiming = { time: '09:00', timezone: 'UTC' };

/** How far back a summary looks. */
export const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

function asTime(value: unknown): string | null {
  const match = typeof value === 'string' ? TIME_RE.exec(value.trim()) : null;
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function asZone(value: unknown): string | null {
  return isTimeZone(value) ? value : null;
}

/** The install's default: the seeded row, overridden by ALWAYS_ON_DIGEST_DEFAULT. */
export function installDigestDefault(env: Env = process.env): DigestTiming {
  const out = { ...ALWAYS_ON_DIGEST_SEED };
  const raw = env[ALWAYS_ON_DIGEST_ENV];
  if (!raw || !raw.trim()) return out;
  try {
    const parsed = JSON.parse(raw);
    out.time = asTime(parsed?.time) ?? out.time;
    out.timezone = asZone(parsed?.timezone) ?? out.timezone;
  } catch {
    /* an unreadable override keeps the seed */
  }
  return out;
}

/** When an agent's summary goes out: its own setting, else 09:00 in the owner's time zone, then the data fallbacks. */
export function digestTiming(
  config: Pick<AlwaysOnConfig, 'digest'> | null | undefined,
  org: { settings?: { alwaysOn?: { digestTime?: unknown; digestTimezone?: unknown } | null } | null } | null | undefined,
  ownerZone?: string | null,
  env: Env = process.env,
): DigestTiming {
  const install = installDigestDefault(env);
  const own = org?.settings?.alwaysOn;
  return {
    time: asTime(config?.digest?.time) ?? asTime(own?.digestTime) ?? install.time,
    timezone: asZone(config?.digest?.timezone) ?? asZone(ownerZone) ?? asZone(own?.digestTimezone) ?? install.timezone,
  };
}

/** The cron expression for "every day at `time`". */
export function digestCron(time: string): string {
  const [hour, minute] = (asTime(time) ?? ALWAYS_ON_DIGEST_SEED.time).split(':').map(Number);
  return `${minute} ${hour} * * *`;
}

/** The calendar day an instant falls on in a zone, as YYYY-MM-DD. */
export function localDay(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: isTimeZone(timezone) ? timezone : 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** What a summary is made of. */
export interface DigestFacts {
  agentName: string;
  /** Wakes written in the window, whatever became of them. */
  wakes: Array<{ source: WakeSource; status: string }>;
  /** The standing thread's runs started in the window. */
  runs: Array<{ status: string }>;
  /** Tools that change something, and how often its runs used each. */
  acted: Array<{ name: string; times: number }>;
  /** What waits for the owner's OK now (tool names, or a reason). */
  waiting: string[];
  approvalsUrl: string;
  agentUrl: string;
}

const SOURCE_WORDS: Record<WakeSource, string> = {
  timer: 'by its timer',
  channel: 'by a message',
  webhook: 'by a webhook',
  connection: 'by a connection',
  manual: 'because you asked',
};

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

function list(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The summary in plain words, or null when nothing happened: no wake it
 * could act on, no run and nothing waiting. Counts first, then what it
 * changed, then what waits, with a link to Approvals.
 */
export function digestText(f: DigestFacts): string | null {
  const woke = f.wakes.filter((w) => w.status !== 'dropped');
  if (!woke.length && !f.runs.length && !f.waiting.length) return null;

  const lines: string[] = [`${f.agentName}, the last 24 hours:`];
  if (woke.length) {
    const bySource = new Map<WakeSource, number>();
    for (const w of woke) bySource.set(w.source, (bySource.get(w.source) ?? 0) + 1);
    const why = [...bySource.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([source, n]) => `${times(n)} ${SOURCE_WORDS[source] ?? source}`);
    lines.push(`- It was woken ${list(why)}.`);
  } else {
    lines.push('- Nothing new woke it.');
  }
  if (f.runs.length) {
    const finished = f.runs.filter((r) => r.status === 'completed').length;
    const stopped = f.runs.filter((r) => ['failed', 'cancelled', 'timeout'].includes(r.status)).length;
    const going = f.runs.length - finished - stopped;
    const parts = [
      finished ? `${finished} finished` : null,
      stopped ? `${stopped} stopped before finishing` : null,
      going ? `${going} still going` : null,
    ].filter((p): p is string => !!p);
    lines.push(`- It worked ${times(f.runs.length)}: ${list(parts)}.`);
  }
  if (f.acted.length) {
    lines.push(`- It did: ${list(f.acted.map((a) => (a.times > 1 ? `${a.name} (${times(a.times)})` : a.name)))}.`);
  } else if (f.runs.some((r) => r.status === 'completed')) {
    lines.push('- It only looked things up; it changed nothing.');
  }
  if (f.waiting.length) {
    lines.push(`- Waiting for your OK: ${list(f.waiting)}. Approve or reject it in Approvals: ${f.approvalsUrl}`);
  }
  lines.push('', `More on its page: ${f.agentUrl}`);
  return lines.join('\n');
}
