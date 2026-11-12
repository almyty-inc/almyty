/**
 * Items an answer lists as new that the tool results date before the
 * window the request names.
 *
 * Asked to look back 30 days on 2026-11-12, an agent listed v5.3.0,
 * published 2026-10-09, under "New releases", and the checker passed over
 * it while it failed correct items (run dda8789a). Whether a date falls in
 * a window is counting, not judgement, so it is done here: the window is
 * read from the request (date-arithmetic.ts requestWindow), the items from
 * the answer's "new" section, and each item's date only from the tool
 * result that holds it. An item the evidence gives no date for is left
 * alone. Nothing here knows any API.
 */

import { dayOfIso, requestWindow } from './date-arithmetic';
import { evidenceJson } from './checker-guards';

/** The name the findings of this check carry on the verify step. */
export const WINDOW_CHECKER = 'window check';

/** The finding's machine code. */
export const OUTSIDE_WINDOW = 'outside_window';

/** The date that makes an item new, in order of preference. `updated_at` never does. */
const DATE_FIELDS = ['published_at', 'publication_date', 'release_date', 'released_at', 'publishedAt', 'date', 'created_at', 'createdAt'];

type Dated = { day: number; field: string; raw: string };

export interface WindowFinding {
  rule: string;
  evidence: string;
  checker: string;
  claim: string;
  code: string;
  kind: 'deterministic';
}

function lower(s: string): string {
  return s.trim().toLowerCase();
}

/** The keys an item of the tool results is found by: its tag, name or version, number, DOI and URL. */
function keysOf(item: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const field of ['tag_name', 'tag', 'name', 'version']) {
    const v = item[field];
    if (typeof v !== 'string' || !v.trim()) continue;
    const k = lower(v);
    keys.push(k, k.replace(/^v(?=\d)/, ''));
  }
  if (typeof item.number === 'number') keys.push(`#${item.number}`);
  if (typeof item.doi === 'string' && item.doi) keys.push(lower(item.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//, ''));
  for (const field of ['html_url', 'url']) {
    const v = item[field];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) keys.push(lower(v));
  }
  return keys;
}

function dateOf(item: Record<string, unknown>): Dated | null {
  for (const field of DATE_FIELDS) {
    const raw = item[field];
    const day = dayOfIso(raw);
    if (day !== null) return { day, field, raw: String(raw) };
  }
  return null;
}

/** Every item in the tool results that carries a date, by each key it is found by. */
function datedItems(evidence: string): Map<string, Dated[]> {
  const index = new Map<string, Dated[]>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 12 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    const item = v as Record<string, unknown>;
    const dated = dateOf(item);
    if (dated) {
      for (const key of new Set(keysOf(item))) {
        const list = index.get(key) ?? [];
        list.push(dated);
        index.set(key, list);
      }
    }
    for (const x of Object.values(item)) visit(x, depth + 1);
  };
  for (const value of evidenceJson(evidence)) visit(value, 0);
  return index;
}

/** A heading's level: `#`..`######` by count, a bold line or a "Label:" line as 7 (ends at any heading). */
function headingLevel(line: string): number | null {
  const hashes = /^\s{0,3}(#{1,6})\s+\S/.exec(line);
  if (hashes) return hashes[1].length;
  if (/^\s*\*\*[^*\n]{1,80}\*\*:?\s*$/.test(line)) return 7;
  if (/^\s*[A-Z][^|:\n]{0,80}:\s*$/.test(line)) return 7;
  return null;
}

/** A line that says what follows is not new, or that its item is outside the window. */
const NOT_NEW = /\b(?:no new|none|not new|nothing new|outside|older than|earlier than|before the window|latest release)\b/i;

/** The identifier a line of the answer leads with: a version or tag, an issue number, a DOI, a URL. */
function leadingIdentifier(line: string): string | null {
  let s = line.replace(/^\s*(?:[>#|]+\s*|[-+*]\s+)*(?:\d{1,3}[.)]\s+)?/, '');
  s = s.replace(/^\*\*[^*\n]{1,30}:\*\*\s*/, '').replace(/^\*\*[^*\n]{1,30}\*\*:\s*/, '').replace(/^[A-Za-z][\w ]{0,20}:\s+/, '');
  s = s.replace(/^[[(`*"'_]+/, '');
  const version = /^v?\d{1,6}\.\d{1,6}(?:\.\d{1,6})?(?:-[0-9A-Za-z.]{1,40})?/.exec(s);
  // A version ends there: not "5.3.0.1", not "5.3.0rc".
  if (version && !/^(?:\w|\.\d)/.test(s.slice(version[0].length))) return version[0];
  const number = /^#(\d{1,9})\b/.exec(s);
  if (number) return `#${number[1]}`;
  const doi = /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s)\]|,;]+)/i.exec(s);
  if (doi) return doi[1];
  const url = /^(https?:\/\/[^\s)\]|]+)/.exec(s);
  return url ? url[1] : null;
}

function lookupKeys(id: string): string[] {
  const k = lower(id);
  if (k.startsWith('#') || /^https?:/.test(k) || /^10\./.test(k)) return [k];
  return [k, k.replace(/^v(?=\d)/, ''), `v${k.replace(/^v(?=\d)/, '')}`];
}

/** The lines of each section of the answer whose heading says "new" ("## New releases", "**New issues**"). */
function newSections(answer: string): Array<{ heading: string; lines: string[] }> {
  const lines = answer.split('\n');
  const out: Array<{ heading: string; lines: string[] }> = [];
  for (let i = 0; i < lines.length; i++) {
    const level = headingLevel(lines[i]);
    if (level === null || !/\bnew\b/i.test(lines[i]) || NOT_NEW.test(lines[i])) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) break;
      const inner = headingLevel(line);
      if (inner !== null && (inner <= level || level === 7)) break;
      body.push(line);
    }
    out.push({ heading: lines[i].trim(), lines: body });
    i = j - 1;
  }
  return out;
}

/**
 * The items an answer lists as new whose date in the tool results is
 * before the window the request names, one finding each. Empty when the
 * request names no window, the answer has no "new" section, or no listed
 * item's date is in the evidence.
 */
export function itemsOutsideWindow(input: { request: string; answer: string; evidence: string; now: Date }): WindowFinding[] {
  const window = requestWindow([input.request], input.now);
  if (!window || !input.answer || !input.evidence) return [];
  const sections = newSections(input.answer);
  if (!sections.length) return [];
  const index = datedItems(input.evidence);
  if (!index.size) return [];
  const findings: WindowFinding[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    for (const line of section.lines) {
      if (!line.trim() || NOT_NEW.test(line)) continue;
      const id = leadingIdentifier(line);
      if (!id || seen.has(lower(id))) continue;
      const dates = lookupKeys(id).flatMap((k) => index.get(k) ?? []);
      if (!dates.length) continue;
      seen.add(lower(id));
      // Every date the evidence gives the item is before the window: one inside it is enough to leave it alone.
      if (dates.some((d) => d.day >= window.start)) continue;
      const d = dates.reduce((a, b) => (b.day > a.day ? b : a));
      const iso = d.raw.slice(0, 10);
      const span = window.days !== undefined ? `the ${window.days}-day window (${window.startIso} to ${window.todayIso})` : `the window that starts on ${window.startIso}`;
      findings.push({
        rule: `${id} is listed as new, but the tool results date it ${iso}, before ${span}`,
        evidence: `${d.field}: ${d.raw}; the request's window starts on ${window.startIso}`,
        checker: WINDOW_CHECKER,
        claim: line.trim(),
        code: OUTSIDE_WINDOW,
        kind: 'deterministic',
      });
    }
  }
  return findings;
}
