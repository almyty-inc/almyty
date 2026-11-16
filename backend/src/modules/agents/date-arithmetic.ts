/**
 * Day arithmetic, done by counting rather than by a model.
 *
 * A checker wrote "2026-10-09 ... is within 30 days of 2026-11-12 (33 days
 * ago)", failed a correct answer that had left the release out, and the
 * revision put it back in (run 942d21f9). Another failed a release that
 * was rightly left out of a 7-day window as "within the 7-day look-back
 * window" when it was 14 days old (run 85f89397). A failure whose stated
 * day arithmetic is false is not a refutation; the verifier drops it
 * (agent-verifier.helper.ts), as it drops a false version order
 * (version-order.ts). Nothing here knows any API: it reads ISO dates and
 * day counts in prose.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** An ISO date, with an optional time that is read but not counted. */
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z?)?/g;

type Found = { day: number; text: string; start: number; end: number };

/** Days since the epoch of a UTC calendar date. */
function dayOf(y: number, m: number, d: number): number | null {
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function dayOfDate(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS);
}

function isoOfDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function datesIn(sentence: string): Found[] {
  const out: Found[] = [];
  for (const m of sentence.matchAll(ISO_DATE)) {
    const day = dayOf(Number(m[1]), Number(m[2]), Number(m[3]));
    if (day === null) continue;
    out.push({ day, text: m[0].slice(0, 10), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** Sentences: a dot inside a timestamp ("01:53:21.740Z") is followed by a digit and does not end one. */
function sentences(text: string): string[] {
  return text.split(/[.;!?](?=\s|$)|\n+/);
}

/**
 * A stated window: "within 30 days of D", "outside the 7-day look-back
 * window", "is not within the last 30 days", "more than 30 days before D".
 */
const WINDOW =
  /\b(not\s+|isn't\s+|is\s+not\s+)?(within|inside|outside(?:\s+of)?|beyond|older\s+than|more\s+than|over|exceed(?:s|ing)?)\s+(?:the\s+|a\s+)?(?:last\s+|past\s+|previous\s+)?(\d{1,4})[- ]?(?:calendar\s+)?days?\b(?:[- ](?:look[- ]?back\s+)?(?:window|range|period))?(?:\s+(?:of|from|before|since|prior\s+to)\s+(?:the\s+)?(?:current\s+(?:date|time)|today|now|run\s+date)?)?/gi;

/** A stated count: "33 days ago", "34 days before the current date", "38 days before 2026-11-12". */
const COUNT = /\b(\d{1,4})\s+(?:full\s+|calendar\s+)?days?\s+(ago|before|earlier|back|prior|old)\b(?:\s+(?:the\s+)?(?:current\s+(?:date|time)|today|now|run\s+date))?/gi;

/** The words that name today as the reference ("of the current date", "before today"). */
const TODAY_WORDS = /\b(?:current\s+(?:date|time)|today|now|run\s+date)\b/i;
/** A reference other than today named right after a count ("4 days earlier than the window start"). */
const OTHER_REFERENCE = /^\s*(?:than|from|after|before|since|prior\s+to|of)\b/i;

/**
 * The date right after a statement ("... of 2026-11-12"), when there is one
 * within a few characters. A range there ("(2026-10-13 to 2026-11-12)") is
 * a window: its end is the reference, not its start.
 */
function dateRightAfter(sentence: string, at: number, dates: Found[]): Found | undefined {
  const first = dates.find((d) => d.start >= at && sentence.slice(at, d.start).trim().length <= 3);
  if (!first) return undefined;
  const second = dates.find((d) => d.start >= first.end);
  if (second && /^\s*(?:to|through|until|till|-|–|—)\s*$/i.test(sentence.slice(first.end, second.start))) return second;
  return first;
}

/** The date a statement is about: the nearest before it that is not the reference day. */
function subjectBefore(dates: Found[], at: number, refDay: number): Found | undefined {
  return [...dates].reverse().find((d) => d.end <= at && d.day !== refDay);
}

/** Words that make a statement the answer's, quoted by the checker ("the OUTPUT says ... is within"), not the checker's own. */
const ATTRIBUTED = /\b(?:output|answer|report|claims?|claimed|says|said|states|stated|lists|listed|treats?|presents?|calls?)\b|["“]/i;

/**
 * The reference day of a statement, only when the sentence states it as a
 * date: the date right after the statement, or today when the statement
 * means today (it names it, or names no reference at all) and today's date
 * is written in the same sentence. Null otherwise: a checker that measured
 * from something else ("4 days before the window start") is not judged by
 * counting from today (run 7c905dfe, a false pass).
 */
function referenceDay(sentence: string, statement: string, end: number, dates: Found[], today: number | null, namesOther: boolean): number | null {
  const right = dateRightAfter(sentence, end, dates);
  if (right) return right.day;
  if (today === null || namesOther) return null;
  if (!dates.some((d) => d.day === today)) return null;
  return TODAY_WORDS.test(statement) || !OTHER_REFERENCE.test(sentence.slice(end)) ? today : null;
}

/**
 * The first false day-arithmetic statement in `text`, in plain words, or
 * null when every statement it can read is true or there is none. A
 * window ("D is within N days of R") is false when D and R are more than
 * N calendar days apart, or for "outside", fewer than N; a count ("D, K
 * days ago") is false when it is off by more than a day (a time of day
 * can move it by one). Both dates of the comparison must be written in
 * the same sentence: the reference is the date right after the statement,
 * or today when the sentence writes today's date and means it. A
 * statement measured from anything else is not judged, and the failure
 * stays. A statement the failure attributes to the answer ("the OUTPUT
 * says D is within ...") is what it refutes, not its own arithmetic, and
 * is not judged.
 */
export function falseDateArithmetic(text: string, now?: Date): string | null {
  if (!text) return null;
  const today = now ? dayOfDate(now) : null;
  for (const sentence of sentences(text)) {
    const dates = datesIn(sentence);
    if (dates.length < 2) continue;
    for (const m of sentence.matchAll(WINDOW)) {
      const at = m.index ?? 0;
      if (ATTRIBUTED.test(sentence.slice(0, at))) continue;
      const end = at + m[0].length;
      // "within 30 days of the release date": a reference named, not today and not a date.
      const namesOther = /\b(?:of|from|before|since|prior\s+to)\s+(?:the\s+)?$/i.test(m[0]);
      const ref = referenceDay(sentence, m[0], end, dates, today, namesOther);
      if (ref === null) continue;
      const subject = subjectBefore(dates, at, ref);
      if (!subject) continue;
      const n = Number(m[3]);
      const apart = Math.abs(ref - subject.day);
      const word = m[2].toLowerCase();
      let inside = word === 'within' || word === 'inside';
      if (m[1]) inside = !inside;
      if (inside && apart > n) return `${subject.text} is ${apart} days from ${isoOfDay(ref)}, so it is not within ${n} days`;
      if (!inside && apart < n) return `${subject.text} is ${apart} days from ${isoOfDay(ref)}, so it is within ${n} days`;
    }
    for (const m of sentence.matchAll(COUNT)) {
      const at = m.index ?? 0;
      if (ATTRIBUTED.test(sentence.slice(0, at))) continue;
      const end = at + m[0].length;
      // "4 days before the window start": before/prior name their reference; only a date or today counts.
      const namesOther = /^(before|prior)$/i.test(m[2]) && !TODAY_WORDS.test(m[0]) && !dateRightAfter(sentence, end, dates);
      const ref = referenceDay(sentence, m[0], end, dates, today, namesOther);
      if (ref === null) continue;
      const subject = subjectBefore(dates, at, ref);
      if (!subject) continue;
      const k = Number(m[1]);
      const apart = Math.abs(ref - subject.day);
      if (Math.abs(apart - k) > 1) return `${subject.text} is ${apart} days before ${isoOfDay(ref)}, not ${k}`;
    }
  }
  return null;
}

const SINCE = /\b(?:since|from|after|published\s+after|on\s+or\s+after)\s+(\d{4}-\d{2}-\d{2})\b/i;
const LAST_N = [
  /\b(?:last|past|previous)\s+(\d{1,4})\s+days?\b/i,
  /\blook(?:ing)?[- ]?back\s+(?:of\s+|window\s+of\s+|period\s+of\s+)?(\d{1,4})\s*days?\b/i,
  /\b(\d{1,4})[- ]days?\s+(?:look[- ]?back|window)\b/i,
];

/** A window a request names: its first day and today, as days since the epoch and as ISO dates. */
export interface RequestWindow {
  start: number;
  today: number;
  startIso: string;
  todayIso: string;
  /** The day count, for "look back N days"; absent for "since D". */
  days?: number;
}

/**
 * The date window a request names ("look back 7 days", "last 30 days",
 * "since 2026-11-01"). The first of `texts` that names one wins (the
 * request before the agent's own rules). Null when none does.
 */
export function requestWindow(texts: Array<string | undefined | null>, now: Date): RequestWindow | null {
  const today = dayOfDate(now);
  for (const text of texts) {
    if (!text) continue;
    for (const re of LAST_N) {
      const m = re.exec(text);
      if (!m) continue;
      const n = Number(m[1]);
      if (!(n > 0)) continue;
      return { start: today - n, today, startIso: isoOfDay(today - n), todayIso: isoOfDay(today), days: n };
    }
    const since = SINCE.exec(text);
    const found = since ? datesIn(since[1]) : [];
    if (found.length) return { start: found[0].day, today, startIso: found[0].text, todayIso: isoOfDay(today) };
  }
  return null;
}

/** The calendar day (days since the epoch) an ISO date or timestamp starts with, or null. */
export function dayOfIso(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim());
  return m ? dayOf(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/**
 * The window a request names, as explicit dates for the checker: it
 * estimated day counts and got them wrong. Null when none is named.
 */
export function windowNote(texts: Array<string | undefined | null>, now: Date): string | null {
  const w = requestWindow(texts, now);
  if (!w) return null;
  if (w.days !== undefined) {
    return (
      `Today is ${w.todayIso} (UTC). The ${w.days}-day window runs from ${w.startIso} to ${w.todayIso}: ` +
      `a date on or after ${w.startIso} is inside it, an earlier date is outside it.`
    );
  }
  return `Today is ${w.todayIso} (UTC). The window starts on ${w.startIso}: a date on or after ${w.startIso} is inside it, an earlier date is outside it.`;
}