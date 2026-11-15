/**
 * Checks the platform makes itself on a final answer: counting and
 * comparing, never judging. Each reads the answer, the tool results, the
 * agent's instructions and, where it matters, what the agent answered
 * before; none knows an API. Every value the answer gives is read one way
 * (normalValue, valueList): "[linux, s390x]", "`linux`, `s390x`" and
 * "s390x, linux" are one set, "(none)" and "[N/A]" say none.
 *
 *  - An item's field against the tool's value for that same item: a date,
 *    a DOI, a version, labels, a title, a venue, a first author. The item
 *    is found by what identifies it (an OpenAlex id, an issue number, a
 *    package name, a title, a DOI).
 *  - Every claim that an item has no value for a field, in a field, a cell
 *    or a sentence ("in PhilPapers, no DOI.", run d99aa38d), against the
 *    tool's value for that item.
 *  - A package's update kind against its versions: "outdated-minor" for
 *    ^16.4.5 against 18.0.10 is wrong, 16 to 18 is a major update (run
 *    bf05f68a).
 *  - The technical terms and severity words a release's summary names
 *    against that release's notes: "dns" and "crypto" for v22.23.5 (run
 *    947d8e43), "critical" for v26.13.1 (run d3757bc9).
 *  - An issue listed as a bug that the agent's own rule cannot let in: a
 *    question or feature request whose labels and title name no problem.
 *  - The answer's own counts against its own list and the tool's list:
 *    "the tool returned 10 works, I skipped 10" over a list of 10 (run
 *    6432deb3); "returned 10, skipped 0" over a list of 9 (run db52dcca).
 *  - Items the tool returned that the answer leaves out while it says its
 *    list is complete ("No other works matched", run db52dcca).
 *  - Against the agent's earlier answers: items it says it skipped as
 *    already reported that none reported (run af3c05c0), and items it lists
 *    as new that one did (run d13c5d50).
 *  - A summary's counts against the table above it.
 *
 * Every finding names the item and the field, and says what is wrong in
 * plain words. A finding here decides the verdict on its own
 * (agent-verifier.helper.ts); a checker model's judgement is a note.
 */

import { asJson, cutTextOf } from './checker-evidence';
import { evidenceJson } from './checker-guards';
import { compareVersions } from './version-order';

/** The name findings of these checks carry on the verify step. */
export const CODE_CHECKER = 'code check';

export interface CodeFinding {
  rule: string;
  evidence: string;
  checker: string;
  claim: string;
  code: string;
  kind: 'deterministic';
  /** The item the finding is about, as a person knows it ("dotenv", "#67427", a title). */
  item: string;
  /** The field of that item that is wrong ("publication date", "status", "count"). */
  field: string;
}

type Obj = Record<string, unknown>;

/** One item of a tool result, with what it is found by. */
export interface ToolItem {
  value: Obj;
  /** Which list of the tool results it belongs to. */
  list: number;
  label: string;
  dois: string[];
  ids: string[];
  numbers: string[];
  names: string[];
  title: string;
}

export interface ToolItems {
  items: ToolItem[];
  /** The length of each list, by its index. */
  lists: number[];
}

/** Lower case, accents dropped, anything but letters and digits as one space. */
export function plain(text: unknown): string {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tight(text: unknown): string {
  return plain(text).replace(/ /g, '');
}

/** A DOI as a key: lower case, without its resolver prefix or trailing punctuation. */
export function doiKey(text: unknown): string {
  let s = String(text ?? '').trim().toLowerCase();
  s = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');
  while (s && '.,;:)]}>"\'*`'.includes(s[s.length - 1])) s = s.slice(0, -1);
  return s;
}

const DOI_IN_TEXT = /\b10\.\d{4,9}\/[^\s"'<>|,;)\]`*]+/g;
const OPENALEX_ID = /\bW\d{6,12}\b/g;

function short(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Keys that say a list's members are items, not settings or query parts. */
const ITEM_KEYS = ['id', 'doi', 'number', 'title', 'name', 'tag_name', 'html_url', 'version'];

function isItem(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && ITEM_KEYS.some((k) => k in (v as Obj));
}

function toolItem(value: Obj, list: number): ToolItem {
  const dois: string[] = [];
  if (typeof value.doi === 'string' && value.doi) dois.push(doiKey(value.doi));
  const ids: string[] = [];
  if (typeof value.id === 'string') for (const m of value.id.matchAll(OPENALEX_ID)) ids.push(m[0].toLowerCase());
  const numbers: string[] = [];
  if (typeof value.number === 'number') numbers.push(`#${value.number}`);
  const names: string[] = [];
  for (const field of ['tag_name', 'name']) {
    const v = value[field];
    if (typeof v !== 'string' || !v.trim() || v.length > 80) continue;
    const k = v.trim().toLowerCase();
    names.push(k, k.replace(/^v(?=\d)/, ''));
  }
  const title = typeof value.title === 'string' ? value.title : '';
  const label =
    typeof value.number === 'number'
      ? `#${value.number}`
      : typeof value.tag_name === 'string' && value.tag_name
        ? value.tag_name
        : title
          ? `"${short(title)}"`
          : typeof value.name === 'string' && value.name
            ? value.name
            : dois[0] ?? ids[0]?.toUpperCase() ?? 'an item';
  return { value, list, label, dois, ids, numbers, names: Array.from(new Set(names)), title };
}

/**
 * Every item in the tool results: the members of each list of items that
 * is not inside another item (`results`, `items`, a list of releases), and
 * a result that is a single object (a package, a release, a repository).
 */
export function toolItems(evidence: string): ToolItems {
  const items: ToolItem[] = [];
  const lists: number[] = [];
  const visit = (v: unknown, depth: number): boolean => {
    if (depth > 8 || v === null || typeof v !== 'object') return false;
    if (Array.isArray(v)) {
      const members = v.filter(isItem);
      if (members.length && members.length >= v.length / 2) {
        const index = lists.length;
        lists.push(v.length);
        for (const m of members) items.push(toolItem(m, index));
        return true;
      }
      let found = false;
      for (const x of v) found = visit(x, depth + 1) || found;
      return found;
    }
    let found = false;
    for (const x of Object.values(v as Obj)) found = visit(x, depth + 1) || found;
    return found;
  };
  for (const value of evidenceJson(evidence ?? '')) {
    // A result that is one item (an npm package, a release, a repository)
    // is that item; its own lists (maintainers, assets) are not the tool's items.
    if (isItem(value)) {
      lists.push(1);
      items.push(toolItem(value, lists.length - 1));
      continue;
    }
    visit(value, 0);
  }
  return { items, lists };
}

/** One entry of the answer: a numbered item, a table row, or a section headed by an identifier. */
export interface AnswerEntry {
  kind: 'numbered' | 'row' | 'section';
  /** The entry's first line (a row: its first cell). */
  head: string;
  text: string;
  /** For a numbered entry, which numbered list it is in. */
  list?: number;
  /** For a row, its cells by the lower-cased header. */
  cells?: Record<string, string>;
  /** The heading the entry stands under, when one that names no item comes before it ("High-priority open issues (bugs, regressions, security)"). */
  under?: string;
}

export interface ParsedAnswer {
  entries: AnswerEntry[];
  /** How many entries each numbered list has. */
  numberedLists: number[];
  /** The table rows' headers, when the answer has a table. */
  headers: string[];
  /** The answer's lines outside every entry: where it speaks about its list. */
  outside: string;
}

function cellsOf(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** A table's separator row ("|---|:--:|"), read with its spaces taken out. */
function isSeparatorRow(line: string): boolean {
  return /^\|?:?-{3,}:?(?:\|:?-{3,}:?)*\|?$/.test(line.replace(/\s/g, ''));
}
const HEADING = /^ {0,3}#{1,6}[ \t](.*)$/;
const NUMBERED = /^ {0,3}(\d{1,3})[.)][ \t](.*)$/;
const RULE_LINE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
/** A heading that leads with what identifies an item: a version or tag, an issue number. */
const IDENTIFIER_HEAD = /^[*_`"[(]*(?:v?\d{1,6}\.\d{1,6}(?:\.\d{1,6})?\b|#\d{1,9}\b)/i;
/** A top-level bullet, and the word it may name its item's kind with first ("Issue #7532", "Release v5.3.0"). */
const BULLET = /^ ?[-*+][ \t](.*)$/;
const BULLET_LEAD = /^[*_`]{0,2}(?:issue|pr|pull request|release|tag|version)[ \t]+/i;

/** The answer as entries, its numbered lists, and what it says outside them. */
export function parseAnswer(answer: string): ParsedAnswer {
  const lines = String(answer ?? '').split('\n');
  const entries: AnswerEntry[] = [];
  const numberedLists: number[] = [];
  const outside: string[] = [];
  let headers: string[] = [];
  let current: (AnswerEntry & { lines: string[] }) | null = null;
  let lastNumber = 0;
  let blankBefore = false;
  // The last heading that does not name an item: what the entries after it are listed as.
  let under = '';
  const flush = () => {
    if (!current) return;
    const { lines: body, ...entry } = current;
    entries.push({ ...entry, text: body.join('\n').trimEnd() });
    current = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|/.test(line)) {
      flush();
      const block: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) block.push(lines[i++]);
      i--;
      if (block.length >= 2 && isSeparatorRow(block[1])) {
        const head = cellsOf(block[0]).map((h) => plain(h));
        headers = head;
        for (const row of block.slice(2)) {
          if (isSeparatorRow(row)) continue;
          const cells = cellsOf(row);
          const byHeader: Record<string, string> = {};
          head.forEach((h, k) => (byHeader[h || `column ${k + 1}`] = cells[k] ?? ''));
          entries.push({ kind: 'row', head: cells[0] ?? '', text: row.trim(), cells: byHeader, ...(under ? { under } : {}) });
        }
      } else {
        outside.push(...block);
      }
      blankBefore = false;
      continue;
    }
    const numbered = NUMBERED.exec(line);
    if (numbered) {
      flush();
      const n = Number(numbered[1]);
      if (!numberedLists.length || n !== lastNumber + 1) numberedLists.push(0);
      lastNumber = n;
      numberedLists[numberedLists.length - 1]++;
      current = { kind: 'numbered', head: numbered[2], list: numberedLists.length - 1, lines: [numbered[2]], text: '', ...(under ? { under } : {}) };
      blankBefore = false;
      continue;
    }
    // A top-level bullet that leads with what identifies an item ("- Issue #7532: ...", "- **v5.3.0** ...") is an entry like a heading's (run 941cb583).
    const bullet = BULLET.exec(line);
    if (bullet && IDENTIFIER_HEAD.test(bullet[1].replace(BULLET_LEAD, '').trim())) {
      flush();
      current = { kind: 'section', head: bullet[1].trim(), lines: [bullet[1].trim()], text: '', ...(under ? { under } : {}) };
      blankBefore = false;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      if (IDENTIFIER_HEAD.test(heading[1].trim())) current = { kind: 'section', head: heading[1].trim(), lines: [heading[1].trim()], text: '', ...(under ? { under } : {}) };
      else {
        outside.push(line);
        under = heading[1].trim();
      }
      blankBefore = false;
      continue;
    }
    if (RULE_LINE.test(line)) {
      flush();
      blankBefore = false;
      continue;
    }
    if (current) {
      if (!line.trim()) {
        current.lines.push(line);
        blankBefore = true;
        continue;
      }
      const continues = current.kind === 'section' || /^\s/.test(line) || /^[-*+]\s/.test(line) || !blankBefore;
      if (continues) {
        current.lines.push(line);
        blankBefore = false;
        continue;
      }
      flush();
    }
    outside.push(line);
    blankBefore = !line.trim();
  }
  flush();
  return { entries, numberedLists, headers, outside: outside.join('\n') };
}

const QUOTES = '"“”\'‘’';

/** Markdown and quotes off a value the answer gives. */
function bare(text: string): string {
  let s = text
    .replace(/\[([^\]]{0,300})\]\([^)]{0,500}\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
  let start = 0;
  let end = s.length;
  while (start < end && QUOTES.includes(s[start])) start++;
  while (end > start && QUOTES.includes(s[end - 1])) end--;
  s = s.slice(start, end);
  return s.trim();
}

/** A "Label: value" line, read without a regex: the label is the words before the first colon. */
function labelLine(line: string): { label: string; value: string } | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  let label = line.slice(0, colon).trim();
  while (label && '-*+ '.includes(label[0])) label = label.slice(1);
  while (label && label.endsWith('*')) label = label.slice(0, -1);
  label = label.trim();
  if (!/^[A-Za-z][A-Za-z ._-]{0,40}$/.test(label)) return null;
  let value = line.slice(colon + 1).trim();
  while (value.startsWith('*')) value = value.slice(1);
  return { label, value: value.trim() };
}

/** The value of a "Label: value" line of an entry, for the first label `label` matches. */
function labelled(entry: AnswerEntry, label: RegExp): string | null {
  if (entry.cells) {
    for (const [header, cell] of Object.entries(entry.cells)) if (label.test(header)) return bare(cell);
    return null;
  }
  for (const line of entry.text.split('\n')) {
    const m = labelLine(line);
    if (m && label.test(plain(m.label))) return bare(m.value);
  }
  return null;
}

/** The title an entry gives: its "Title:" line, else its first line without the number, link or identifiers. */
function entryTitle(entry: AnswerEntry): string {
  const t = labelled(entry, /^title$/);
  if (t) return t;
  if (entry.kind !== 'numbered') return '';
  let s = entry.head.replace(/^\s*\[#?\d+\]\([^)]*\)\s*/, '').replace(/^\s*\[#?\d+\]\s*/, '').replace(/^#\d+\s*[:.-]?\s*/, '');
  s = bare(s);
  // A title in quotes, then the rest of a sentence: '"GraphAgents: ...," 2026-11-11, by ...'.
  const cut = [' - ', ' – ', ' — ', ' | ', ' (http', ' DOI', ',” ', '," ', '" (', '” ('].map((m) => s.indexOf(m)).filter((at) => at > 0);
  if (cut.length) s = s.slice(0, Math.min(...cut));
  return s.trim();
}

interface EntryKeys {
  dois: string[];
  ids: string[];
  numbers: string[];
  names: string[];
  title: string;
}

const NONE_VALUE = /^(?:none|null|nil|n\/?a|not available|not given|not provided|not listed|unknown|missing|no doi|no labels?|-|—|–)\.?$/i;

/**
 * The one way a value the answer gives is read, wherever it is compared:
 * markdown and quotes off (bare), and the brackets around it, at any depth:
 * "(none)" is "none", "[n/a]" is "n/a", "**`[linux]`**" is "linux".
 */
function unwrap(text: string): string {
  let s = bare(text);
  while (s.length >= 2 && '([{<'.includes(s[0]) && ')]}>'['([{<'.indexOf(s[0])] === s[s.length - 1]) s = bare(s.slice(1, -1));
  return s;
}

/** A value as it is compared: unwrapped, spaces collapsed, lower case. */
export function normalValue(text: string): string {
  return unwrap(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A list value as its members, each normalised: "[linux, s390x]",
 * "`linux`, `s390x`", "\"linux\"; \"s390x\"" and "linux | s390x" are all
 * {linux, s390x}. A none-like value is the empty list.
 */
export function valueList(text: string): string[] {
  if (noneLike(text)) return [];
  return Array.from(new Set(unwrap(text).split(/[,;|]/).map((part) => normalValue(part)).filter(Boolean)));
}

/**
 * Words a value starts with when it says there is none, as a word of their
 * own (not "no-response", "not-planned"): "none indicating bug/security
 * explicitly" (run 8ca1dcf2), "Unknown (preprint, ...)", "N/A - no direct
 * DOI", "no labels", "not available".
 */
const NONE_START = /^(?:none|null|nil|n\/a|unknown|missing|no|not available|not given|not provided|not listed)(?=$|[\s,.;:()[\]])/i;

/**
 * Whether a value the answer gives says there is none: "none", "(none)",
 * "[N/A]", "", "-", or a phrase that starts with a none word. The one test
 * every check uses (valueList, labels, the none-claim check, names).
 */
function noneLike(text: string): boolean {
  const s = unwrap(text);
  return !s || NONE_VALUE.test(s) || NONE_START.test(s);
}

/** noneLike, by the name its callers read it by: a value that starts by saying there is none. */
function startsNone(text: string): boolean {
  return noneLike(text);
}

function keysOfEntry(entry: AnswerEntry): EntryKeys {
  const text = entry.text;
  const dois = Array.from(new Set(Array.from(text.matchAll(DOI_IN_TEXT), (m) => doiKey(m[0]))));
  const ids = Array.from(new Set(Array.from(text.matchAll(OPENALEX_ID), (m) => m[0].toLowerCase())));
  const numbers = new Set<string>();
  const head = entry.kind === 'row' ? entry.head : entry.head.slice(0, 120);
  for (const m of head.matchAll(/#(\d{1,9})\b/g)) numbers.add(`#${m[1]}`);
  for (const m of text.matchAll(/\/(?:issues|pull)\/(\d{1,9})\b/g)) numbers.add(`#${m[1]}`);
  if (entry.kind === 'row' && /^\d{1,9}$/.test(bare(entry.head))) numbers.add(`#${bare(entry.head)}`);
  const names: string[] = [];
  if (entry.kind === 'row') {
    const n = bare(entry.head).toLowerCase();
    if (n) names.push(n);
  } else {
    const v = /^[*_`"[(]*(v?\d{1,6}\.\d{1,6}(?:\.\d{1,6})?(?:-[0-9A-Za-z.]+)?)\b/i.exec(entry.head.trim());
    if (v) names.push(v[1].toLowerCase(), v[1].toLowerCase().replace(/^v(?=\d)/, ''));
  }
  return { dois, ids, numbers: Array.from(numbers), names, title: entryTitle(entry) };
}

/** Whether two titles name the same work: one holds the other, compared as letters and digits. */
function sameTitle(a: string, b: string): boolean {
  const x = tight(a);
  const y = tight(b);
  if (x.length < 12 || y.length < 12) return x === y && x.length > 0;
  return x === y || (Math.min(x.length, y.length) >= 20 && (x.includes(y) || y.includes(x)));
}

/** The tool items an entry is about, and by what it was found. */
export function itemsOfEntry(entry: AnswerEntry, index: ToolItems): { items: ToolItem[]; by: 'id' | 'number' | 'name' | 'title' | 'doi' | null } {
  const keys = keysOfEntry(entry);
  const pick = (test: (item: ToolItem) => boolean) => index.items.filter(test);
  let found = keys.ids.length ? pick((it) => it.ids.some((k) => keys.ids.includes(k))) : [];
  if (found.length) return { items: found, by: 'id' };
  found = keys.numbers.length ? pick((it) => it.numbers.some((k) => keys.numbers.includes(k))) : [];
  if (found.length) return { items: found, by: 'number' };
  found = keys.names.length ? pick((it) => it.names.some((k) => keys.names.includes(k))) : [];
  if (found.length) return { items: found, by: 'name' };
  found = keys.title ? pick((it) => !!it.title && sameTitle(it.title, keys.title)) : [];
  if (found.length) return { items: found, by: 'title' };
  found = keys.dois.length ? pick((it) => it.dois.some((k) => keys.dois.includes(k))) : [];
  if (found.length) return { items: found, by: 'doi' };
  return { items: [], by: null };
}

function finding(item: string, field: string, rule: string, evidence: string, claim: string, code: string): CodeFinding {
  return { rule, evidence, checker: CODE_CHECKER, claim: short(claim, 300), code, kind: 'deterministic', item, field };
}

const PUBLISHED = ['publication_date', 'published_at', 'release_date', 'released_at', 'publishedAt', 'published'];
const UPDATED = ['updated_at', 'updatedAt'];
const CREATED = ['created_at', 'createdAt'];

/** The tool fields a date in the answer is compared with, by the words that label it. */
function dateFieldsFor(label: string): string[] | null {
  const l = plain(label);
  if (/\bupdat|\bmodif/.test(l)) return UPDATED;
  if (/\bcreat|\bopened/.test(l)) return CREATED;
  if (/\bpubli|\brelease|\bissued|^date$|\bdate$/.test(l)) return PUBLISHED;
  return null;
}

const DATE_IN_TEXT = /\b(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g;

/** Each date an entry gives, with the label it stands under. */
function datesOf(entry: AnswerEntry): Array<{ day: string; label: string; line: string }> {
  const out: Array<{ day: string; label: string; line: string }> = [];
  if (entry.cells) {
    for (const [header, cell] of Object.entries(entry.cells)) {
      for (const m of cell.matchAll(DATE_IN_TEXT)) out.push({ day: m[1], label: header, line: cell });
    }
    return out;
  }
  for (const line of entry.text.split('\n')) {
    for (const m of line.matchAll(DATE_IN_TEXT)) {
      const before = line.slice(0, m.index ?? 0);
      const colon = before.lastIndexOf(':');
      const label = colon === -1 ? before : before.slice(Math.max(0, before.lastIndexOf('\n', colon)), colon);
      out.push({ day: m[1], label: bare(label.replace(/^\s*[-*+]\s+/, '')), line: line.trim() });
    }
  }
  return out;
}

const FIELD_WORDS: Record<string, string> = {
  publication_date: 'publication date',
  published_at: 'published date',
  publishedAt: 'published date',
  release_date: 'release date',
  released_at: 'release date',
  published: 'published date',
  updated_at: 'updated date',
  updatedAt: 'updated date',
  created_at: 'created date',
  createdAt: 'created date',
};

function dateFindings(entry: AnswerEntry, items: ToolItem[]): CodeFinding[] {
  const out: CodeFinding[] = [];
  for (const d of datesOf(entry)) {
    const fields = dateFieldsFor(d.label);
    if (!fields) continue;
    const given = items
      .map((it) => {
        const field = fields.find((f) => typeof it.value[f] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(it.value[f] as string));
        return field ? { it, field, raw: it.value[field] as string } : null;
      })
      .filter((x): x is { it: ToolItem; field: string; raw: string } => !!x);
    if (!given.length || given.some((g) => g.raw.slice(0, 10) === d.day)) continue;
    const g = given[0];
    const words = FIELD_WORDS[g.field] ?? g.field.replace(/_/g, ' ');
    out.push(finding(g.it.label, words, `${g.it.label}: the answer gives ${words} ${d.day}, but the tool results say ${g.raw.slice(0, 10)}`, `${g.field}: ${g.raw}`, d.line, 'item_field'));
  }
  return out;
}

/** A DOI the answer gives that is not the one the tool gives the item. That the item has none is noneClaimFindings'. */
function doiFindings(items: ToolItem[], keys: EntryKeys): CodeFinding[] {
  const withDoi = items.filter((it) => 'doi' in it.value);
  if (!withDoi.length || !keys.dois.length) return [];
  const it = withDoi[0];
  const tool = typeof it.value.doi === 'string' && it.value.doi ? doiKey(it.value.doi) : null;
  if (tool && keys.dois.includes(tool)) return [];
  const said = keys.dois[0];
  return [
    finding(
      it.label,
      'DOI',
      tool ? `${it.label}: the answer gives DOI ${said}, but the tool results give ${tool}` : `${it.label}: the answer gives DOI ${said}, but the tool results give it no DOI`,
      `doi: ${tool ?? 'null'}`,
      said,
      'item_field',
    ),
  ];
}

function labelNames(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as Obj).name === 'string' ? ((x as Obj).name as string) : ''))
    .filter(Boolean);
}

/** Labels the answer gives an item that the tool does not, compared as sets (valueList). That it has none is noneClaimFindings'. */
function labelFindings(entry: AnswerEntry, items: ToolItem[]): CodeFinding[] {
  const said = labelled(entry, /^labels?$/);
  if (said === null || noneLike(said)) return [];
  const it = items.find((x) => labelNames(x.value.labels) !== null);
  if (!it) return [];
  const tool = labelNames(it.value.labels)!;
  const toolSet = new Set(tool.map((l) => normalValue(l)));
  const extra = valueList(said).filter((l) => !toolSet.has(l));
  if (!extra.length) return [];
  const toolWords = tool.length ? tool.join(', ') : 'none';
  return [finding(it.label, 'labels', `${it.label}: the answer gives the label${extra.length === 1 ? '' : 's'} ${extra.join(', ')}, but the tool results give ${toolWords}`, `labels: ${toolWords}`, `Labels: ${said}`, 'item_field')];
}

/**
 * A field of an item that an answer can say the item has none of, and
 * the tool's value of it. `tool` is undefined where the tool results do
 * not carry the field at all (nothing to compare), null where they say
 * there is none.
 */
interface NoneField {
  field: string;
  /** The label or table header the field is given under. */
  label: RegExp;
  /** Words in a sentence that say the item has none: "in PhilPapers, no DOI." */
  inline?: RegExp;
  tool: (it: ToolItem) => string | null | undefined;
}

const NONE_FIELDS: NoneField[] = [
  {
    field: 'DOI',
    label: /^doi$/,
    inline:
      /\b(?:no|without(?: an?)?|lacks?(?: an?)?|missing(?: an?)?)\s+(?:direct\s+|official\s+|valid\s+|known\s+|registered\s+|listed\s+)?doi\b|\bdoi\s+(?:is\s+)?(?:not available|unavailable|missing|not given|not provided|not listed|unknown)\b|\bdoi:?[ \t]{0,3}[([]?(?:none|n\/a)\b/i,
    tool: (it) => ('doi' in it.value ? (typeof it.value.doi === 'string' && it.value.doi ? doiKey(it.value.doi) : null) : undefined),
  },
  {
    field: 'labels',
    label: /^labels?$/,
    inline: /\b(?:no|without)\s+labels?\b|\bunlabell?ed\b|\blabels?:?[ \t]{0,3}[([]?(?:none|n\/a)\b/i,
    tool: (it) => {
      const names = labelNames(it.value.labels);
      return names === null ? undefined : names.length ? names.join(', ') : null;
    },
  },
  {
    field: 'venue',
    label: /^(?:venue|journal|source|published in)$/,
    inline: /\b(?:no|without(?: a)?)\s+(?:known\s+|listed\s+)?venue\b|\bvenue\s+(?:is\s+)?(?:unknown|not available|missing|not given|not listed)\b/i,
    tool: (it) => {
      if (!('primary_location' in it.value)) return undefined;
      const source = pathOf(it.value, ['primary_location', 'source']);
      if (!source.present) return undefined;
      const name = source.value && typeof source.value === 'object' ? (source.value as Obj).display_name : null;
      return typeof name === 'string' && name.trim() ? name : null;
    },
  },
  {
    field: 'first author',
    label: /^(?:first author|author|lead author)$/,
    inline: /\b(?:no|without(?: an?)?)\s+(?:known\s+|listed\s+)?authors?\b|\bauthors?\s+(?:is\s+|are\s+)?(?:unknown|not available|missing|not given|not listed)\b/i,
    tool: (it) => {
      if (!Array.isArray(it.value.authorships)) return undefined;
      const name = pathOf(it.value, ['authorships', '0', 'author', 'display_name']).value;
      return typeof name === 'string' && name.trim() ? name : null;
    },
  },
  {
    field: 'latest version',
    label: /\blatest\b|^version$/,
    tool: (it) => ('version' in it.value ? (typeof it.value.version === 'string' && it.value.version ? it.value.version : null) : undefined),
  },
];

/** What a field says besides its DOIs: the field with every DOI and DOI address taken out. */
function besideDoi(line: string): string {
  return line.replace(/\bhttps?:\/\/(?:dx\.)?doi\.org\/\S{1,300}/gi, ' ').replace(DOI_IN_TEXT, ' ');
}

/** An entry's text without its links and addresses, where a "no DOI" could only be part of a URL. */
function proseOf(text: string): string {
  return text.replace(/\]\([^)\s]{0,500}\)/g, ']').replace(/\bhttps?:\/\/\S{0,500}/g, ' ');
}

/**
 * Every claim in an entry that its item has no value for a field, against
 * the tool's value for that item: a field given as "none", "(N/A)",
 * "unknown" or "-" ("DOI: None", run c62aa29a; a "Labels" cell "(none)"),
 * a field that gives a value and says there is none ("DOI: <doi> (N/A - no
 * direct DOI)", run 0f136ed8), and the same said in a sentence ("in
 * PhilPapers, no DOI.", run d99aa38d). The item is the one the entry
 * names; where the tool results give it a value, the claim is wrong.
 */
function noneClaimFindings(entry: AnswerEntry, items: ToolItem[]): CodeFinding[] {
  const out: CodeFinding[] = [];
  const prose = proseOf(entry.text);
  for (const f of NONE_FIELDS) {
    const withField = items.filter((it) => f.tool(it) !== undefined);
    if (!withField.length) continue;
    const it = withField[0];
    const value = f.tool(it);
    if (!value) continue;
    let said: string | null = null;
    const given = labelled(entry, f.label);
    if (given !== null) {
      if (startsNone(given) && (unwrap(given) || f.field === 'labels')) said = `${f.field === 'labels' ? 'Labels' : f.field === 'DOI' ? 'DOI' : f.field}: ${given || '(empty)'}`;
      else if (f.field === 'DOI' && f.inline && f.inline.test(besideDoi(given))) said = `DOI: ${given}`;
      else if (f.field === 'DOI' && /^\W*(?:n\/a|none)\b/i.test(besideDoi(given).trim())) said = `DOI: ${given}`;
    }
    if (!said && f.inline) {
      const m = f.inline.exec(f.field === 'DOI' ? besideDoi(prose) : prose);
      if (m) said = m[0];
    }
    if (!said) continue;
    out.push(
      finding(
        it.label,
        f.field,
        `${it.label}: the answer says it has no ${f.field} ("${short(said.trim(), 70)}"), but the tool results give ${short(value, 80)}`,
        `${f.field}: ${value}`,
        said.trim(),
        'item_field',
      ),
    );
  }
  return out;
}

/** Whether two names are the same, the one holding the other, compared as letters and digits. */
function sameName(a: string, b: string): boolean {
  const x = tight(a);
  const y = tight(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function pathOf(v: Obj, path: string[]): { present: boolean; value: unknown } {
  let cur: unknown = v;
  for (const key of path) {
    if (cur === null || cur === undefined) return { present: true, value: null };
    if (typeof cur !== 'object' || !(key in (cur as Obj))) return { present: false, value: undefined };
    cur = Array.isArray(cur) && /^\d+$/.test(key) ? (cur as unknown[])[Number(key)] : (cur as Obj)[key];
  }
  return { present: true, value: cur };
}

function nameFindings(entry: AnswerEntry, items: ToolItem[], by: string | null): CodeFinding[] {
  const out: CodeFinding[] = [];
  const it = items[0];
  const venue = labelled(entry, /^(?:venue|journal|source|published in)$/);
  if (venue !== null && 'primary_location' in it.value) {
    const pl = it.value.primary_location as Obj | null;
    const source = pl && typeof pl === 'object' ? pathOf(pl, ['source']) : { present: true, value: null };
    if (source.present) {
      const name = source.value && typeof source.value === 'object' ? (source.value as Obj).display_name : null;
      // A venue the answer says there is none of ("unknown", "(n/a)") is the none-claim check's (noneClaimFindings).
      if (typeof name === 'string' && name.trim()) {
        if (!startsNone(venue) && !sameName(venue, name)) out.push(finding(it.label, 'venue', `${it.label}: the answer gives the venue as ${short(venue, 80)}, but the tool results give ${name}`, `primary_location.source.display_name: ${name}`, `Venue: ${venue}`, 'item_field'));
      } else if ((source.value === null || name === null) && !startsNone(venue)) {
        out.push(finding(it.label, 'venue', `${it.label}: the answer gives the venue as ${short(venue, 80)}, but the tool results give it no venue`, 'primary_location.source: null', `Venue: ${venue}`, 'item_field'));
      }
    }
  }
  const author = labelled(entry, /^(?:first author|author|lead author)$/);
  if (author !== null && Array.isArray(it.value.authorships)) {
    const first = pathOf(it.value, ['authorships', '0', 'author', 'display_name']);
    const name = first.value;
    if (typeof name === 'string' && name.trim() && !sameName(author, name) && !startsNone(author)) {
      out.push(finding(it.label, 'first author', `${it.label}: the answer gives the first author as ${short(author, 60)}, but the tool results give ${name}`, `authorships[0].author.display_name: ${name}`, `First author: ${author}`, 'item_field'));
    }
  }
  if (by !== 'title' && it.title) {
    const title = entryTitle(entry);
    if (title && tight(title).length >= 12 && !sameTitle(title, it.title)) {
      const words = new Set(plain(title).split(' '));
      const toolWords = plain(it.title).split(' ');
      const shared = toolWords.filter((w) => words.has(w)).length;
      if (shared < Math.min(words.size, toolWords.length) / 2) {
        out.push(finding(it.label, 'title', `${it.label}: the answer gives the title as "${short(title, 80)}", but the tool results give "${short(it.title, 80)}"`, `title: ${it.title}`, title, 'item_field'));
      }
    }
  }
  return out;
}

/** A dotted version; one followed by more of itself ("5.3.0.1", "5.3.0rc") is not read. A pre-release tag after "-" is left off. */
const VERSION = /(?<![\w.])v?(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?(?!\w|\.\d)/;

function parseVersion(text: string): { text: string; major: number } | null {
  const m = VERSION.exec(text);
  if (!m) return null;
  return { text: m[0].replace(/^v/i, ''), major: Number(m[1]) };
}

function headerAt(cells: Record<string, string>, test: RegExp): string | null {
  return Object.keys(cells).find((h) => test.test(h)) ?? null;
}

/**
 * A package row's latest version and update kind against the tool's
 * version: the major numbers decide a major update, and an outdated
 * status needs a newer version than the one the project is on.
 */
function packageFindings(entry: AnswerEntry, items: ToolItem[]): CodeFinding[] {
  const cells = entry.cells;
  if (!cells) return [];
  const out: CodeFinding[] = [];
  const name = bare(entry.head);
  const tool = items.find((it) => typeof it.value.version === 'string');
  const latestHeader = headerAt(cells, /\blatest\b/);
  const latestCell = latestHeader ? parseVersion(cells[latestHeader]) : null;
  if (tool && latestCell && compareVersions(latestCell.text, String(tool.value.version)) !== 0) {
    out.push(finding(name, 'latest version', `${name}: the answer gives the latest version as ${latestCell.text}, but the tool results say ${tool.value.version}`, `version: ${tool.value.version}`, entry.text, 'item_field'));
  }
  const statusHeader = headerAt(cells, /\bstatus\b|\bupdate\b|\bkind\b/);
  const rangeHeader = Object.keys(cells).find((h) => h !== latestHeader && /^[~^]|^>=?|^=/.test(cells[h].trim().replace(/[`*]/g, '')));
  if (!statusHeader || !rangeHeader) return out;
  const status = plain(cells[statusHeader]);
  if (!status || /deprecat|fail|error|not found|unknown/.test(status)) return out;
  const base = parseVersion(cells[rangeHeader].replace(/^[\s`*]*(?:[~^]|>=?|=)\s*/, ''));
  const latest = tool ? parseVersion(String(tool.value.version)) : latestCell;
  if (!base || !latest) return out;
  const said = cells[statusHeader].replace(/[`*]/g, '').trim();
  const evidence = `version: ${latest.text}; package.json: ${cells[rangeHeader].replace(/[`*]/g, '').trim()}`;
  const order = compareVersions(latest.text, base.text);
  if (order < 0) return out;
  const saysMajor = /\bmajor\b/.test(status);
  const saysMinor = /\bminor\b|\bpatch\b/.test(status);
  const saysCurrent = /up to date|current|latest/.test(status) && !saysMajor && !saysMinor;
  if (latest.major > base.major && (saysMinor || saysCurrent)) {
    out.push(finding(name, 'status', `${name}: the answer says ${said}, but ${base.major} to ${latest.major} is a major update`, evidence, entry.text, 'update_kind'));
  } else if (saysMajor && latest.major === base.major && base.major > 0) {
    out.push(finding(name, 'status', `${name}: the answer says ${said}, but ${base.text} to ${latest.text} stays on major version ${base.major}`, evidence, entry.text, 'update_kind'));
  } else if ((saysMajor || saysMinor) && order === 0) {
    out.push(finding(name, 'status', `${name}: the answer says ${said}, but the latest version, ${latest.text}, is the one package.json names`, evidence, entry.text, 'update_kind'));
  }
  return out;
}

/**
 * Subsystem names that are also everyday words or commit kinds ("doc",
 * "test", "fix"): a summary says them in plain prose, so they are not read
 * as a claim about the release.
 */
const PLAIN_SUBSYSTEMS = new Set([
  'benchmark', 'build', 'chore', 'ci', 'console', 'deps', 'doc', 'docs', 'errors', 'events', 'feat', 'fix', 'lib', 'meta', 'misc', 'module', 'node', 'path', 'perf', 'policy', 'process', 'refactor',
  'release', 'report', 'revert', 'src', 'stream', 'string', 'style', 'test', 'tests', 'tool', 'tools',
]);

function addSubsystems(text: string, into: Set<string>): void {
  for (const part of text.split(/[,/]/)) {
    const name = part.trim().toLowerCase();
    if (/^[a-z][a-z0-9_]{1,24}$/.test(name) && !PLAIN_SUBSYSTEMS.has(name)) into.add(name);
  }
}

/** Text without markdown's backslash escapes: release notes write "**child\_process**". */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([_*`[\]()#.-])/g, '$1');
}

function subsystemsOf(body: string, into: Set<string>): void {
  for (const line of unescapeMarkdown(body).split('\n')) {
    let at = line.indexOf('**');
    while (at !== -1) {
      const end = line.indexOf('**', at + 2);
      if (end === -1) break;
      if (line[end + 2] === ':' && end - at < 60) addSubsystems(line.slice(at + 2, end), into);
      at = line.indexOf('**', end + 2);
    }
    const cve = line.indexOf('(CVE-');
    if (cve !== -1) {
      const close = line.indexOf(') ', cve);
      const colon = close === -1 ? -1 : line.indexOf(':', close);
      if (colon !== -1 && colon - close < 40) addSubsystems(line.slice(close + 2, colon), into);
    }
  }
}

/** Whether a release's notes are whole: not cut by the store ("… (truncated from") or by the evidence ("…"). */
function isWholeText(text: string): boolean {
  return !!text.trim() && !text.trimEnd().endsWith('…') && !cutTextOf(text);
}

/** A tool result read whole, as the run's conversation holds it (checker-evidence.ts RunToolResult). */
export interface WholeToolResult {
  content: string;
  error?: boolean;
}

/**
 * The release notes the tool results hold, by tag, and the subsystem
 * names they use: the "**crypto**:" of a changelog line, the "http2:"
 * after a CVE id. Those names are the tool's own vocabulary of modules,
 * so a summary naming one says something the notes can confirm or not.
 *
 * Notes come from the tool results read whole (`whole`, the run's
 * conversation) where the caller has them: the evidence a checker gets is
 * cut to fit its budget, and a release list's notes are cut first. Notes
 * cut anywhere are never compared, only read for their vocabulary.
 */
export interface ReleaseNotes {
  byTag: Map<string, string>;
  vocabulary: Set<string>;
}

export function releaseNotesOf(index: ToolItems, whole?: WholeToolResult[]): ReleaseNotes {
  const byTag = new Map<string, string>();
  const vocabulary = new Set<string>();
  const add = (tag: unknown, body: unknown) => {
    if (typeof tag !== 'string' || typeof body !== 'string' || !body.trim()) return;
    subsystemsOf(body, vocabulary);
    if (!isWholeText(body)) return;
    const key = tag.trim().toLowerCase();
    if (!byTag.has(key)) byTag.set(key, body);
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Obj;
    if ('tag_name' in o && 'body' in o) {
      add(o.tag_name, o.body);
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  for (const r of whole ?? []) {
    if (r?.error || typeof r?.content !== 'string' || !r.content.includes('tag_name')) continue;
    walk(asJson(undefined, r.content), 0);
  }
  for (const it of index.items) add(it.value.tag_name, it.value.body);
  return { byTag, vocabulary };
}

/** Whether a word is a code identifier: "child_process", "subprocess.timedOut", "fs.cpSync". */
function isIdentifier(word: string): boolean {
  if (word.length < 4 || word.length > 60 || !/^[a-z]/i.test(word) || !/[a-z0-9]$/i.test(word)) return false;
  if (!/^[A-Za-z0-9._]+$/.test(word) || word.includes('..') || word.includes('._') || word.includes('_.')) return false;
  const joined = word.includes('_') || word.includes('.');
  // A lower-case word joined by a dot ("e.g", "package.json") is prose or a file; one with an inner capital or an underscore is code.
  return joined && (word.includes('_') || /[a-z][A-Z]/.test(word));
}

/**
 * The technical terms a release's entry in the answer names (code
 * identifiers, CVE ids, the subsystem names of the tool's release notes)
 * against that release's notes in the tool results. A term its notes never
 * mention, matched case-insensitively as a whole word, was not in the
 * release: "fixing http, dns, tls and crypto issues" for v22.23.5, whose
 * notes name neither dns nor crypto (run 947d8e43). Ordinary words are not
 * terms, and notes the tool results hold only in part are not read.
 */
function releaseNoteFindings(entry: AnswerEntry, items: ToolItem[], by: string | null, notes: ReleaseNotes): CodeFinding[] {
  if (by !== 'name' || entry.kind === 'row') return [];
  const release = items.find((it) => typeof it.value.tag_name === 'string');
  if (!release) return [];
  const tag = String(release.value.tag_name);
  const body = notes.byTag.get(tag.trim().toLowerCase());
  if (!body) return [];
  const text = unescapeMarkdown(body).toLowerCase();
  // What the entry says about the release, without its heading line, links and addresses.
  const said = entry.text
    .split('\n')
    .slice(1)
    .join('\n')
    .replace(/\]\([^)\s]{0,500}\)/g, ']')
    .replace(/\bhttps?:\/\/\S{0,500}/g, ' ');
  const terms: string[] = [];
  for (const raw of said.split(/[\s,;:()[\]{}"'`*!?<>|]+/)) {
    let word = raw;
    while (word.endsWith('.')) word = word.slice(0, -1);
    if (!word) continue;
    const key = word.toLowerCase();
    const term = /^cve-\d{4}-\d{4,7}$/.test(key) || isIdentifier(word) || notes.vocabulary.has(key) || severityOf(key) !== null;
    if (term && !terms.includes(key)) terms.push(key);
  }
  for (const name of dependencyNamesOf(said)) if (!terms.includes(name)) terms.push(name);
  // A term counts as mentioned where a word of the notes starts with it: "buffer" is in "retain buffers".
  // A severity word counts where the notes say it in any of its words ("security": a CVE id).
  const missing = terms.filter((t) => !(severityOf(t) ?? [t]).some((w) => hasWordStart(text, w)));
  if (!missing.length) return [];
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  const line = said.split('\n').find((l) => missing.some((t) => hasWord(l.toLowerCase(), t))) ?? said;
  return [
    finding(
      tag,
      'release notes',
      `${tag}: the answer's summary names ${list}, but the release notes in the tool results never mention ${missing.length === 1 ? 'it' : 'them'}`,
      `body of ${tag} (${body.length} characters) has no ${missing.join(', ')}`,
      line.trim(),
      'release_notes',
    ),
  ];
}
/** Words that stand before a version in prose without naming a package: "aligned with v24.22.3", "from 4.17 to 4.18". */
const NOT_A_PACKAGE = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'since', 'than', 'the', 'to', 'v', 'version', 'versions', 'with', 'was',
  'node', 'nodejs', 'node.js', 'release', 'releases', 'lts', 'current', 'latest', 'tag', 'branch', 'line', 'updated', 'upgraded', 'bumped', 'update', 'updates',
  'others', 'other', 'more', 'etc', 'several', 'various', 'misc', 'patch', 'minor', 'major', 'security',
]);

function packageName(word: string): string | null {
  let name = word.trim().toLowerCase();
  while (name && '.,;:'.includes(name[name.length - 1])) name = name.slice(0, -1);
  return /^[a-z@][a-z0-9_./@-]{1,40}$/.test(name) && !NOT_A_PACKAGE.has(name) && !/^v?\d/.test(name) ? name : null;
}

/** Words that say a line speaks of updated packages. */
const UPDATE_CONTEXT = /\b(?:updat|upgrad|bump|dependenc|deps\b)/i;

/**
 * The packages and dependencies a release's summary says the release
 * updated, in a line that speaks of updates: a name with a version
 * ("undici updated to version 7.30.2", run 8ca1dcf2; never a release tag,
 * "fixes paralleling v26.13.1") and each one-word item of a "dependency
 * updates for ..." list ("brotli, llhttp, sqlite, undici, and npm", run
 * 96f7b54a; not "and others", not "to patch several ..."). Each must be in
 * that release's notes.
 */
function dependencyNamesOf(said: string): string[] {
  const out: string[] = [];
  const add = (word: string) => {
    const name = packageName(word);
    if (name && !out.includes(name)) out.push(name);
  };
  for (const line of said.split('\n')) {
    if (!UPDATE_CONTEXT.test(line)) continue;
    for (const m of line.matchAll(/([A-Za-z@][\w./@-]{1,40})\s+(?:(?:is\s+|was\s+)?(?:updated|upgraded|bumped)\s+)?(?:to\s+)?(?:version\s+)?\d{1,4}\.\d{1,4}(?:\.\d{1,6})?(?!\w|\.\d)/g)) add(m[1]);
    const dep = /\b(?:dependenc(?:y|ies)|deps)\b[^.:\n]{0,40}?(?:\bfor\b|\bto\b|\bof\b|\bincluding\b|:)([^.\n]{1,300})/i.exec(line);
    if (dep) {
      for (const part of dep[1].split(/,|\band\b|\bor\b/)) {
        // One name, perhaps with its version: "llhttp 9.4.4". Anything longer is prose, and ends the list.
        const open = part.indexOf('(');
        const words = (open === -1 ? part : part.slice(0, open)).trim().split(/\s+/).filter(Boolean);
        if (!words.length) continue;
        if (words.length > 2 || (words.length === 2 && !/^v?\d/.test(words[1]))) break;
        add(words[0]);
      }
    }
  }
  return out;
}


/**
 * Severity words a summary can attribute to a release, with the words of
 * release notes that say the same: "critical" for v26.13.1, whose notes
 * rate its fixes High, Medium and Low only (run d3757bc9).
 */
const SEVERITY: Record<string, string[]> = {
  critical: ['critical'],
  security: ['security', 'cve-', 'vulnerab'],
  vulnerability: ['vulnerab', 'cve-', 'security'],
  vulnerabilities: ['vulnerab', 'cve-', 'security'],
  breaking: ['breaking', 'semver-major'],
  exploit: ['exploit'],
  exploited: ['exploit'],
};

function severityOf(word: string): string[] | null {
  return SEVERITY[word] ?? null;
}

/** Labels that say an issue is not a problem but something else: a question, a feature request. */
const NOT_A_PROBLEM_KIND = new Set(['question', 'feature', 'feature request', 'feature-request', 'enhancement', 'discussion', 'documentation', 'doc', 'docs', 'proposal', 'idea', 'task', 'epic', 'chore']);
/** Labels the agent's rules commonly name as a problem, beside those its instructions list ("labels like confirmed-bug, ..."). */
const PROBLEM_LABELS = ['bug', 'confirmed-bug', 'regression', 'security', 'crash', 'priority/critical', 'critical', 'p0', 'p1', 'high-priority', 'vulnerability'];
/**
 * Words that say an issue is a bug, a regression or a security problem, in
 * a heading, a label or a title. Broad on purpose: a title with any of them
 * meets "titles indicate bugs", so the check never fails an issue a title
 * could let in.
 */
const PROBLEM_WORDS =
  /\b(?:bugs?|regress|security|crash|vulnerab|cve|rce|exploit|segfault|segmentation|fail|error|broken|break|leak|hang|freez|panic|terminat|abort|incorrect|wrong|truncat|corrupt|overflow|deadlock|race|unexpected|invalid|unhandled|unable|cannot|can't|doesn't|does not|not work|mismatch|missing|undefined|throws?|exception|warning|flak|timeout|slow|stuck|los(?:e|es|t|ing)\b)/i;

/**
 * The rule an agent's instructions give for which issues to list as
 * problems ("pick the ones whose labels or titles indicate bugs,
 * regressions or security (labels like confirmed-bug, bug, ...)"): its
 * problem labels, or null when the instructions give no such rule.
 */
export function issueRuleOf(instructions: string): { labels: Set<string> } | null {
  const text = String(instructions ?? '');
  if (!/\b(?:labels?|titles?)\b[^.\n]{0,60}\bindicat[^.\n]{0,60}\b(?:bugs?|regressions?|security)\b/i.test(text)) return null;
  const labels = new Set(PROBLEM_LABELS);
  const like = /\blabels? like\s+([^)\n]{1,300})/i.exec(text);
  if (like) for (const l of valueList(like[1].replace(/\bor\b|\band\b/gi, ','))) labels.add(l);
  return { labels };
}

/**
 * An issue the answer lists as a bug, a regression or a security problem
 * that the agent's own rule cannot let in: its labels mark it as something
 * else (a question, a feature request; or GitHub's issue type does), none
 * of its labels is a problem label, and its title has no word that says
 * there is a problem. #67354 "Fall back to a user-configured directory
 * when resolving imports" (feature request), #67427 (question) in run
 * d3757bc9. An issue without such a label is never failed: whether its
 * title indicates a bug is a judgement, a checker note.
 */
/**
 * Whether an issue meets the agent's rule for a problem: true where a
 * label is a problem label or its title has a problem word, false where it
 * meets neither and a label (or its issue type) marks it as something else,
 * null where the tool results cannot say (no labels to read, or nothing
 * but its title to judge by).
 */
export function issueQualifies(
  it: ToolItem,
  rule: { labels: Set<string> } | null,
): { qualifies: boolean | null; problemLabel: boolean; kinds: string[]; labels: string[]; type: string } {
  const labels = labelNames(it.value.labels) ?? [];
  const t = it.value.type;
  const type = typeof t === 'string' ? t : t && typeof t === 'object' && typeof (t as Obj).name === 'string' ? ((t as Obj).name as string) : '';
  const problemLabels = rule?.labels ?? new Set(PROBLEM_LABELS);
  const isProblemLabel = (l: string) => problemLabels.has(normalValue(l)) || /\b(?:bug|regression|security|crash|vulnerab|cve|critical)/i.test(l);
  const problemLabel = labels.some(isProblemLabel);
  if (labelNames(it.value.labels) === null) return { qualifies: null, problemLabel, kinds: [], labels, type };
  if (problemLabel || PROBLEM_WORDS.test(it.title) || /^bug$/i.test(type.trim())) return { qualifies: true, problemLabel, kinds: [], labels, type };
  const kinds = [...labels.filter((l) => NOT_A_PROBLEM_KIND.has(normalValue(l))), ...(type && NOT_A_PROBLEM_KIND.has(normalValue(type)) ? [`issue type ${type}`] : [])];
  return { qualifies: kinds.length ? false : null, problemLabel, kinds, labels, type };
}

function issueCategoryFindings(entry: AnswerEntry, items: ToolItem[], rule: { labels: Set<string> } | null): CodeFinding[] {
  const listedAsProblem = rule !== null || (!!entry.under && PROBLEM_WORDS.test(entry.under));
  if (!listedAsProblem) return [];
  const it = items.find((x) => x.numbers.length && labelNames(x.value.labels) !== null);
  if (!it) return [];
  const { qualifies, kinds, labels, type } = issueQualifies(it, rule);
  if (qualifies !== false) return [];
  return [
    finding(
      it.label,
      'category',
      `${it.label}: the answer lists it as a bug, regression or security issue, but the tool results mark it as ${kinds.join(', ')}, and neither its labels nor its title name a problem`,
      `labels: ${labels.join(', ') || 'none'}${type ? `; type: ${type}` : ''}; title: ${it.title}`,
      entry.head,
      'item_field',
    ),
  ];
}

/**
 * Whether the answer's table is in the order the agent's instructions
 * sort it by ("sorted with deprecated first, then outdated-major, then
 * outdated-minor, then up to date"), read from its status column. Null
 * where the instructions give no such order or a row's status is not in it.
 */
export function followsSortRule(answer: string, instructions: string): boolean | null {
  const text = String(instructions ?? '').toLowerCase().replace(/-/g, ' ');
  const at = text.indexOf('sort');
  if (at === -1) return null;
  let rule = text.slice(at, at + 300);
  const end = rule.indexOf('. ');
  if (end !== -1) rule = rule.slice(0, end);
  const parsed = parseAnswer(answer);
  const statusHeader = parsed.headers.find((h) => /\bstatus\b/.test(h));
  if (!statusHeader) return null;
  const ranks: number[] = [];
  for (const row of parsed.entries) {
    if (row.kind !== 'row' || !row.cells) continue;
    const status = normalValue(row.cells[statusHeader] ?? '').replace(/-/g, ' ');
    const rank = status ? rule.indexOf(status) : -1;
    if (rank === -1) return null;
    ranks.push(rank);
  }
  if (ranks.length < 2) return null;
  return ranks.every((r, i) => i === 0 || r >= ranks[i - 1]);
}

/** What each field check says about the entries the answer lists, item by item. */
export function itemFieldFindings(parsed: ParsedAnswer, index: ToolItems, notes: ReleaseNotes = releaseNotesOf(index), instructions = ''): CodeFinding[] {
  const out: CodeFinding[] = [];
  const rule = issueRuleOf(instructions);
  for (const entry of parsed.entries) {
    const { items, by } = itemsOfEntry(entry, index);
    if (!items.length) continue;
    const keys = keysOfEntry(entry);
    out.push(
      ...dateFindings(entry, items),
      ...doiFindings(items, keys),
      ...labelFindings(entry, items),
      ...noneClaimFindings(entry, items),
      ...nameFindings(entry, items, by),
      ...packageFindings(entry, items),
      ...releaseNoteFindings(entry, items, by, notes),
      ...issueCategoryFindings(entry, items, rule),
    );
  }
  return out;
}

const NOUN = '(?:works|items|results|papers|articles|issues|entries|records|publications|packages|releases|hits)';
const RETURNED_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:returned|retrieved|found|gave|yielded)\\s+(?:only\\s+|exactly\\s+)?(\\d{1,4})\\s+(?:[\\w-]+\\s+){0,2}?(${NOUN})\\b`, 'i'),
  new RegExp(`\\b(?:number|count|total)\\s+of\\s+(?:[\\w-]+\\s+){0,2}?(${NOUN})(?:\\s+[\\w-]+){0,4}?(?:[ \\t]*[:=][ \\t]*|[ \\t]+)(\\d{1,4})\\b`, 'i'),
  new RegExp(`\\b(${NOUN})\\s+(?:found|returned|retrieved)\\s*[:=]\\s*(\\d{1,4})\\b`, 'i'),
];
/**
 * A count the answer says it skipped, in any tense or word for it: "I
 * skipped 10", "skipping 10 previously reported" (run b37987d4), "I skip
 * 2", "left out 3", "omitting 1", "4 were excluded".
 */
const SKIP_VERB = '(?:skipp(?:ed|ing)|skips?|left out|leaving out|leaves? out|omit(?:ted|ting|s)?|exclud(?:ed|ing|es?)|dropp(?:ed|ing))';
const SKIPPED_PATTERNS: RegExp[] = [
  new RegExp(`\\b${SKIP_VERB}\\s+(?:only\\s+|the\\s+)?(\\d{1,4})\\b`, 'i'),
  new RegExp(`\\b(\\d{1,4})\\s+(?:[\\w-]+\\s+){0,3}?(?:were\\s+|was\\s+|are\\s+|is\\s+)?(?:skipped|left out|omitted|excluded|dropped)\\b`, 'i'),
];
const COMPLETE_PATTERNS: RegExp[] = [
  new RegExp(`\\bno other\\s+(?:[\\w-]+\\s+){0,2}?${NOUN}\\b[^.\\n]{0,60}`, 'i'),
  new RegExp(`\\b(?:all|every)\\s+(?:of\\s+the\\s+)?(?:\\d{1,4}\\s+)?(?:[\\w-]+\\s+){0,2}?${NOUN}\\b[^.\\n]{0,40}?\\b(?:are|is)\\s+(?:listed|shown|included|below|above)\\b`, 'i'),
];

/** The first statement of how many items the tool returned, wherever in the text it is. */
function statedReturned(text: string): { n: number; noun: string; words: string } | null {
  let first: RegExpExecArray | null = null;
  for (const p of RETURNED_PATTERNS) {
    const m = p.exec(text);
    if (m && (!first || m.index < first.index)) first = m;
  }
  if (!first) return null;
  const num = /^\d+$/.test(first[1]) ? first[1] : first[2];
  const noun = /^\d+$/.test(first[1]) ? first[2] : first[1];
  return { n: Number(num), noun: noun.toLowerCase(), words: first[0] };
}

function statedSkipped(text: string): { n: number; words: string } | null {
  for (const p of SKIPPED_PATTERNS) {
    const m = p.exec(text);
    if (m) return { n: Number(m[1]), words: m[0] };
  }
  return null;
}

/** Results the evidence shows only some items of: their counts cannot be read from it. */
const PARTIAL = / of \d+ items shown|\[result left out|the end was cut off|only the start is shown|the stored result was cut|chars stored in part/;

/**
 * The answer's own counts against its own list and the tool's list, and
 * the tool's items it leaves out while saying its list is complete.
 */
export function countFindings(parsed: ParsedAnswer, index: ToolItems, evidence: string): CodeFinding[] {
  const out: CodeFinding[] = [];
  const numbered = parsed.entries.filter((e) => e.kind === 'numbered');
  if (!numbered.length) return out;
  // The numbered list the answer gives the tool's items in, and the tool list they come from.
  const byList = new Map<number, Map<number, Set<ToolItem>>>();
  for (const e of numbered) {
    const { items } = itemsOfEntry(e, index);
    for (const it of items) {
      const lists = byList.get(e.list!) ?? new Map<number, Set<ToolItem>>();
      const set = lists.get(it.list) ?? new Set<ToolItem>();
      set.add(it);
      lists.set(it.list, set);
      byList.set(e.list!, lists);
    }
  }
  let answerList = parsed.numberedLists.length === 1 ? 0 : -1;
  let toolList = -1;
  let best = 0;
  for (const [a, lists] of byList) {
    for (const [t, set] of lists) {
      if (set.size > best) {
        best = set.size;
        answerList = a;
        toolList = t;
      }
    }
  }
  if (answerList === -1) return out;
  const listed = parsed.numberedLists[answerList];
  const entries = numbered.filter((e) => e.list === answerList);
  // Most of the answer's list must be the tool's items for the tool's list to be the one it speaks of.
  if (toolList !== -1 && best < Math.ceil(listed / 2)) toolList = -1;
  const partial = PARTIAL.test(evidence);
  const toolCount = toolList !== -1 && !partial ? index.lists[toolList] : null;

  const returned = statedReturned(parsed.outside);
  const skipped = statedSkipped(parsed.outside);
  const noun = returned?.noun ?? 'items';
  const listName = `the ${noun} the tool returned`;
  if (returned && toolCount !== null && returned.n !== toolCount) {
    out.push(finding(listName, 'count', `The answer says the tool returned ${returned.n} ${noun}, but the tool returned ${toolCount}`, `${toolCount} items in the tool's list`, returned.words, 'count'));
  }
  const total = returned?.n ?? toolCount;
  if (skipped && total !== null && total !== undefined) {
    const expected = total - skipped.n;
    if (listed !== expected) {
      out.push(
        finding(
          'the answer\'s list',
          'count',
          `The answer says it skipped ${skipped.n} of the ${total} ${noun} the tool returned, so it should list ${Math.max(0, expected)}, but it lists ${listed}`,
          `${total} returned, ${skipped.n} skipped, ${listed} listed`,
          skipped.words,
          'count',
        ),
      );
    }
  } else if (returned && listed > returned.n) {
    out.push(finding('the answer\'s list', 'count', `The answer says the tool returned ${returned.n} ${noun}, but it lists ${listed}`, `${returned.n} returned, ${listed} listed`, returned.words, 'count'));
  }

  // Items the tool returned that the answer leaves out, where it says nothing else matched.
  const complete = COMPLETE_PATTERNS.map((p) => p.exec(parsed.outside)?.[0]).find(Boolean) ?? (returned && skipped ? `${returned.words}; ${skipped.words}` : null);
  if (complete && toolList !== -1 && !partial) {
    const shown = new Set<ToolItem>();
    for (const e of entries) for (const it of itemsOfEntry(e, index).items) shown.add(it);
    const missing = index.items.filter((it) => it.list === toolList && !shown.has(it));
    const allowed = skipped?.n ?? 0;
    if (missing.length > allowed) {
      if (allowed === 0) {
        for (const it of missing) {
          const id = it.ids[0]?.toUpperCase() ?? it.dois[0] ?? it.numbers[0];
          const name = id && !it.label.includes(id) ? `${id} ${it.label}` : it.label;
          out.push(finding(name, 'listed', `${name}: the tool returned it, but the answer leaves it out and says "${short(complete, 80)}"`, `${name} is in the tool's list`, complete, 'left_out'));
        }
      } else {
        out.push(
          finding(
            'the answer\'s list',
            'listed',
            `The answer leaves out ${missing.length} of the ${noun} the tool returned but says it skipped ${allowed}`,
            missing.map((it) => it.label).join(', '),
            complete,
            'left_out',
          ),
        );
      }
    }
  }
  return out;
}

/**
 * Each entry of the answer that names a tool item, in the answer's order:
 * the item, the first date the entry gives (or null), and whether its
 * dates agree with the tool's (dateFindings). For the note verifiers.
 */
export function datedEntries(answer: string, evidence: string): Array<{ item: ToolItem; day: string | null; agrees: boolean }> {
  const index = toolItems(evidence);
  const out: Array<{ item: ToolItem; day: string | null; agrees: boolean }> = [];
  const toolDays = (it: ToolItem) =>
    [...PUBLISHED, ...UPDATED, ...CREATED].map((f) => it.value[f]).filter((v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)).map((v) => v.slice(0, 10));
  for (const entry of parseAnswer(answer).entries) {
    const { items } = itemsOfEntry(entry, index);
    if (!items.length) continue;
    const day = datesOf(entry)[0]?.day ?? null;
    // A date the entry gives agrees where the tool gives the item that day in one of its date fields, and no labelled date of it differs.
    const agrees = dateFindings(entry, items).length === 0 && (!day || items.some((it) => toolDays(it).includes(day)));
    out.push({ item: items[0], day, agrees });
  }
  return out;
}

/** How many items the tool returned in the list the answer speaks of, or null where it cannot say. */
export function toolListLength(answer: string, evidence: string): number | null {
  if (PARTIAL.test(evidence)) return null;
  const index = toolItems(evidence);
  const { list } = shownAndList(parseAnswer(answer), index);
  return list === -1 ? null : index.lists[list] ?? null;
}

/**
 * Whether the answer's own counts add up: the tool returned what it says,
 * and returned less skipped is what it lists ("returned 10, skipped 1",
 * 9 listed). Null where it states no returned or no skipped count.
 */
export function countsAddUp(answer: string, evidence: string): boolean | null {
  const parsed = parseAnswer(answer);
  const returned = statedReturned(parsed.outside);
  const skipped = statedSkipped(parsed.outside);
  if (!returned || !skipped) return null;
  const listed = parsed.numberedLists.length === 1 ? parsed.numberedLists[0] : parsed.entries.length === 0 ? 0 : null;
  if (listed === null) return null;
  const wrong = countFindings(parsed, toolItems(evidence), evidence).some((f) => f.code === 'count');
  return !wrong && returned.n - skipped.n === listed;
}

const SUMMARY_COUNT = /\b(\d{1,4})\s+(?:(?:packages?|dependencies|deps)\s+)?(?:(?:have|has|are|is|with|show|need)\s+)?(?:(?:newer|an?|available)\s+)?(deprecated|outdated[- ]major|outdated[- ]minor|up[- ]to[- ]date|major|minor)\b/gi;

/** A summary's counts ("5 packages have newer major versions") against the rows of the table it sums up. */
export function summaryFindings(parsed: ParsedAnswer): CodeFinding[] {
  const rows = parsed.entries.filter((e) => e.kind === 'row' && e.cells);
  const statusHeader = parsed.headers.find((h) => /\bstatus\b/.test(h));
  if (!rows.length || !statusHeader) return [];
  const statusOf = (e: AnswerEntry) => plain(e.cells![statusHeader] ?? '');
  const predicate = (word: string): ((s: string) => boolean) => {
    const w = plain(word);
    if (w.includes('deprecat')) return (s) => s.includes('deprecat');
    if (w.includes('major')) return (s) => /\bmajor\b/.test(s);
    if (w.includes('minor')) return (s) => /\bminor\b/.test(s);
    return (s) => /up to date|current/.test(s);
  };
  const out: CodeFinding[] = [];
  const seen = new Set<string>();
  for (const m of parsed.outside.matchAll(SUMMARY_COUNT)) {
    const stated = Number(m[1]);
    const word = m[2].toLowerCase();
    const key = plain(word).replace('outdated ', '');
    if (seen.has(key)) continue;
    seen.add(key);
    const counted = rows.filter((r) => predicate(word)(statusOf(r))).length;
    if (stated !== counted) {
      out.push(finding('the summary', `count of ${plain(word)}`, `The summary says ${stated} ${plain(word)}, but the table lists ${counted}`, `${counted} rows with that status`, m[0], 'count'));
    }
  }
  return out;
}

/**
 * A claim that items were left out because an earlier answer already
 * reported them: "I skipped 10 as already reported in the earlier digest"
 * (run af3c05c0), "all were already reported in earlier digests".
 */
const REPORTED_BEFORE = /\b(?:already|previously)\s+(?:been\s+)?(?:reported|listed|covered|included|sent|shared|seen)\b|\b(?:earlier|previous|prior)\s+(?:digests?|runs?|reports?|answers?|summar(?:y|ies))\b/i;
const LEFT_OUT = /\b(?:skipp|left out|leaves? out|omitt|exclud|dropp|filtered out)/i;

/** Whether an answer says it left items out because an earlier answer already reported them. */
export function claimsSkippedAsReported(answer: string): boolean {
  const outside = parseAnswer(answer).outside;
  const skipped = statedSkipped(outside);
  if (skipped && skipped.n === 0) return false;
  return REPORTED_BEFORE.test(outside) && (!!skipped || LEFT_OUT.test(outside) || /\ball\b[^.\n]{0,60}\balready\b/i.test(outside));
}

/** `needle` in `hay` (both lower case) with no letter, digit or underscore on either side. */
function hasWord(hay: string, needle: string): boolean {
  return findWord(hay, needle, true);
}

/** `needle` at the start of a word of `hay` (both lower case): "buffer" is in "buffers". */
function hasWordStart(hay: string, needle: string): boolean {
  return findWord(hay, needle, false);
}

function findWord(hay: string, needle: string, wholeWord: boolean): boolean {
  if (!needle) return false;
  const edge = (c: string | undefined) => !c || !/[a-z0-9_]/.test(c);
  let at = hay.indexOf(needle);
  while (at !== -1) {
    if (edge(hay[at - 1]) && (!wholeWord || edge(hay[at + needle.length]))) return true;
    at = hay.indexOf(needle, at + 1);
  }
  return false;
}

/** The most items one finding about earlier answers names. */
const SKIPPED_NAMED_MAX = 10;

/**
 * Words an answer uses when it presents what it lists as new: "the
 * remaining 9 new papers", "none were reported previously". They only
 * choose the finding's wording; whether the check runs is the agent's
 * instructions' to say (forbidsRepeats).
 */
const NEW_CLAIM =
  /\bnew\s+(?:unique\s+)?(?:papers?|works?|items?|articles?|entries|publications?)\b|\b(?:none|not)\b[^.\n]{0,30}\b(?:reported|listed)\b[^.\n]{0,20}\b(?:before|previously|earlier)\b|\b(?:none|not)\s+(?:\w+\s+){0,2}?previously\s+reported\b/i;

/**
 * A rule in the agent's instructions against repeating what it reported
 * before: "leave out any paper (by DOI or OpenAlex id) you already
 * reported", "do not list issues reported in earlier runs". Only such a
 * rule holds an answer to the agent's earlier answers; a heading "New
 * releases" in the answer does not (run 8ca1dcf2).
 */
const NO_REPEAT_RULE =
  /\b(?:leave out|skip|omit|exclude|drop|filter out|(?:do not|don't|never) (?:repeat|list|include|report|mention)|avoid (?:repeating|listing|reporting))\b[^.\n]{0,120}\b(?:already|previously|earlier|before)\b/i;

/** Whether the agent's instructions forbid repeating what it reported before. */
export function forbidsRepeats(instructions: string): boolean {
  return NO_REPEAT_RULE.test(String(instructions ?? ''));
}

/** Whether the check reads the agent's earlier answers: its instructions forbid repeats, or the answer says it skipped items as already reported. */
export function speaksOfEarlierReports(answer: string, instructions = ''): boolean {
  return forbidsRepeats(instructions) || claimsSkippedAsReported(answer);
}

/** The platform's line above an answer whose check did not pass, or could not be made (unverified-answer.ts). */
const PLATFORM_LEADS = ["Note: this answer's check didn't pass", 'Note: this answer could not be checked'];

/**
 * An earlier answer as its agent wrote it, and the platform's note above
 * it: "Note: this answer's check didn't pass: ... 3 of them were never
 * reported: W7225839018 ..." is the platform's, and reports nothing (run
 * b37987d4 counted it as a report).
 */
export function splitPlatformNote(output: string): { body: string; note: string } {
  const text = String(output ?? '');
  if (!PLATFORM_LEADS.some((lead) => text.startsWith(lead))) return { body: text, note: '' };
  const end = text.indexOf('\n\n');
  return end === -1 ? { body: '', note: text } : { body: text.slice(end + 2), note: text.slice(0, end) };
}

/** An item an earlier answer listed in its body, by what identifies it. */
export interface EarlierItem {
  ids: string[];
  dois: string[];
  numbers: string[];
  title: string;
}

/** The most earlier items read, and given to a run. */
export const EARLIER_ITEMS_MAX = 200;

/**
 * What this agent's earlier answers reported, newest first, without
 * repeats: each entry an answer's body listed (a numbered item, a row, a
 * section), by its ids, DOIs, issue numbers and title. The platform's note
 * is not read, and an item the note names (the check failed on it) does
 * not count for that answer. The check holds an answer to these, and a run
 * is given these (AgentMemoryKeeper.alreadyReported): one list, one rule.
 */
export function earlierReportedItems(earlier: string[]): EarlierItem[] {
  const out: EarlierItem[] = [];
  const seen = new Set<string>();
  for (const output of earlier ?? []) {
    const { body, note } = splitPlatformNote(output);
    const failed = new Set<string>([
      ...Array.from(note.matchAll(OPENALEX_ID), (m) => m[0].toLowerCase()),
      ...Array.from(note.matchAll(DOI_IN_TEXT), (m) => doiKey(m[0])),
      ...Array.from(note.matchAll(/#(\d{1,9})\b/g), (m) => `#${m[1]}`),
    ]);
    for (const entry of parseAnswer(body).entries) {
      const keys = keysOfEntry(entry);
      if ([...keys.ids, ...keys.dois, ...keys.numbers].some((k) => failed.has(k))) continue;
      if (!keys.ids.length && !keys.dois.length && !keys.numbers.length && tight(keys.title).length < 20) continue;
      // One item, however each answer wrote it: by any of its ids, DOIs, numbers, or its title.
      const keysOf = [...keys.ids, ...keys.dois, ...keys.numbers, ...(tight(keys.title).length >= 20 ? [tight(keys.title)] : [])];
      if (keysOf.some((k) => seen.has(k))) continue;
      for (const k of keysOf) seen.add(k);
      out.push({ ids: keys.ids, dois: keys.dois, numbers: keys.numbers, title: keys.title });
      if (out.length >= EARLIER_ITEMS_MAX) return out;
    }
  }
  return out;
}

/** Whether an earlier item is this tool item: a shared id, DOI or issue number, or the same title. */
function sameItem(e: EarlierItem, it: ToolItem): boolean {
  return (
    e.ids.some((k) => it.ids.includes(k)) ||
    e.dois.some((k) => it.dois.includes(k)) ||
    e.numbers.some((k) => it.numbers.includes(k)) ||
    (!!e.title && !!it.title && tight(it.title).length >= 20 && sameTitle(e.title, it.title))
  );
}

/**
 * What this agent's earlier answers reported, as a lookup: whether a tool
 * item is one of the items their bodies listed (earlierReportedItems).
 * Null for an item with nothing to find it by.
 */
function earlierReports(earlier: string[]): (it: ToolItem) => boolean | null {
  const items = earlierReportedItems(earlier);
  return (it) => {
    if (!it.ids.length && !it.dois.length && !it.numbers.length && tight(it.title).length < 20) return null;
    return items.some((e) => sameItem(e, it));
  };
}

function namedItem(it: ToolItem): string {
  const id = it.ids[0]?.toUpperCase() ?? it.numbers[0] ?? it.dois[0];
  return id && !it.label.includes(id) ? `${id} ${it.label}` : it.label;
}

function itemId(it: ToolItem): string {
  return it.ids[0]?.toUpperCase() ?? it.numbers[0] ?? it.dois[0] ?? it.label;
}

/** The items the answer's entries show, and the tool list it speaks of: the one most entries come from, else the longest list of identifiable items. */
function shownAndList(parsed: ParsedAnswer, index: ToolItems): { shown: Set<ToolItem>; list: number } {
  const shown = new Set<ToolItem>();
  const byList = new Map<number, number>();
  for (const e of parsed.entries) {
    for (const it of itemsOfEntry(e, index).items) {
      shown.add(it);
      byList.set(it.list, (byList.get(it.list) ?? 0) + 1);
    }
  }
  let list = -1;
  let best = 0;
  for (const [l, n] of byList) if (n > best) (best = n), (list = l);
  if (list === -1) {
    for (let l = 0; l < index.lists.length; l++) {
      const n = index.items.filter((it) => it.list === l && (it.ids.length || it.dois.length || it.numbers.length)).length;
      if (n > best) (best = n), (list = l);
    }
  }
  return { shown, list };
}

/**
 * Items the answer says it skipped as already reported, against what this
 * agent's earlier answers actually reported. `earlier` is the output of
 * the agent's earlier completed runs, newest first and bounded by the
 * caller (EARLIER_ANSWERS_MAX). A skipped item none of them holds was
 * never reported: the answer dropped a new item and said it was old (run
 * af3c05c0, 3 of its 10 "already reported" works). Only items the answer
 * leaves out are checked, and only when the count it says it skipped (if
 * it says one) is the count it leaves out.
 */
export function skippedAsReportedFindings(answer: string, parsed: ParsedAnswer, index: ToolItems, evidence: string, earlier?: string[]): CodeFinding[] {
  if (!earlier || !index.items.length || PARTIAL.test(evidence) || !claimsSkippedAsReported(answer)) return [];
  const { shown, list } = shownAndList(parsed, index);
  if (list === -1) return [];
  const skippedItems = index.items.filter((it) => it.list === list && !shown.has(it));
  const stated = statedSkipped(parsed.outside);
  if (!skippedItems.length || (stated && stated.n !== skippedItems.length)) return [];
  const reported = earlierReports(earlier);
  const never = skippedItems.filter((it) => reported(it) === false);
  if (!never.length) return [];
  const named = never.slice(0, SKIPPED_NAMED_MAX).map(namedItem);
  const more = never.length > named.length ? ` and ${never.length - named.length} more` : '';
  const where = earlier.length ? `none of this agent's last ${earlier.length} answers report ${never.length === 1 ? 'it' : 'them'}` : 'this agent has no earlier answer';
  const ids = never.map(itemId);
  return [
    finding(
      ids.slice(0, SKIPPED_NAMED_MAX).join(', '),
      'already reported',
      `The answer says it skipped ${skippedItems.length} ${skippedItems.length === 1 ? 'item' : 'items'} as already reported, but ${never.length} of them ${never.length === 1 ? 'was' : 'were'} never reported: ${named.join('; ')}${more} (${where})`,
      `${never.length} skipped ${never.length === 1 ? 'item is' : 'items are'} in no earlier answer: ${ids.join(', ')}`,
      statedSkipped(parsed.outside)?.words ?? short(parsed.outside, 120),
      'skipped_not_reported',
    ),
  ];
}

/**
 * Items the answer lists that this agent's earlier answers already listed,
 * for an agent whose instructions forbid repeats ("leave out any paper you
 * already reported"). Each listed item is then a claim that it is new:
 * "the remaining 9 new papers" (run d13c5d50, all 9 reported before). An
 * item counts as reported only where an earlier answer's body listed it
 * (earlierReportedItems).
 */
export function listedAsNewFindings(answer: string, parsed: ParsedAnswer, index: ToolItems, evidence: string, earlier?: string[], instructions = ''): CodeFinding[] {
  if (!earlier?.length || !index.items.length || PARTIAL.test(evidence) || !forbidsRepeats(instructions)) return [];
  const { shown, list } = shownAndList(parsed, index);
  const reported = earlierReports(earlier);
  const again = [...shown].filter((it) => it.list === list && reported(it) === true);
  if (!again.length) return [];
  const named = again.slice(0, SKIPPED_NAMED_MAX).map(namedItem);
  const more = again.length > named.length ? ` and ${again.length - named.length} more` : '';
  const ids = again.map(itemId);
  const saysNew = NEW_CLAIM.test(parsed.outside) || claimsSkippedAsReported(answer);
  const claim = saysNew ? 'as new' : 'though its instructions say to leave out what it already reported';
  return [
    finding(
      ids.slice(0, SKIPPED_NAMED_MAX).join(', '),
      'previously reported',
      `The answer lists ${again.length} ${again.length === 1 ? 'item' : 'items'} ${claim}, but this agent's earlier answers already reported ${again.length === 1 ? 'it' : 'them'}: ${named.join('; ')}${more}`,
      `${again.length} listed ${again.length === 1 ? 'item is' : 'items are'} in an earlier answer of the last ${earlier.length}: ${ids.join(', ')}`,
      short(parsed.outside, 160),
      'previously_reported',
    ),
  ];
}

/**
 * The items an answer lists that its tool results identify, by their
 * stable ids: what a later run needs to recognise them (agent-memory.keeper.ts).
 */
export function reportedItemsOf(answer: string, evidence: string): Array<{ id: string; doi?: string; title?: string }> {
  if (!answer?.trim() || !evidence?.trim()) return [];
  const parsed = parseAnswer(answer);
  const index = toolItems(evidence);
  const out: Array<{ id: string; doi?: string; title?: string }> = [];
  const seen = new Set<ToolItem>();
  for (const e of parsed.entries) {
    for (const it of itemsOfEntry(e, index).items) {
      if (seen.has(it)) continue;
      seen.add(it);
      const id = it.ids[0]?.toUpperCase() ?? it.numbers[0] ?? it.dois[0];
      if (!id) continue;
      out.push({ id, ...(it.dois[0] && it.dois[0] !== id ? { doi: it.dois[0] } : {}), ...(it.title ? { title: short(it.title, 80) } : {}) });
    }
  }
  return out;
}

/**
 * Every finding of these checks on an answer. The window check
 * (window-check.ts) is run beside them by the verifier. `earlier` is what
 * this agent's earlier runs answered, when the caller has it: what the
 * answer says it skipped, and what it lists as new, are checked against
 * it. `whole` is the run's tool results read whole, when the caller has
 * them: release notes are compared from them, since the evidence cuts long
 * texts. `instructions` are the agent's own: the rule for which issues are
 * bugs, and whether it is told to leave out what it reported before.
 */
export function answerCodeFindings(input: { answer: string; evidence: string; earlier?: string[]; whole?: WholeToolResult[]; instructions?: string }): CodeFinding[] {
  if (!input.answer?.trim() || !input.evidence?.trim()) return [];
  const parsed = parseAnswer(input.answer);
  const index = toolItems(input.evidence);
  const instructions = input.instructions ?? '';
  const out = [
    ...itemFieldFindings(parsed, index, releaseNotesOf(index, input.whole), instructions),
    ...countFindings(parsed, index, input.evidence),
    ...summaryFindings(parsed),
    ...skippedAsReportedFindings(input.answer, parsed, index, input.evidence, input.earlier),
    ...listedAsNewFindings(input.answer, parsed, index, input.evidence, input.earlier, instructions),
  ];
  const seen = new Set<string>();
  return out.filter((f) => (seen.has(f.rule) ? false : (seen.add(f.rule), true)));
}