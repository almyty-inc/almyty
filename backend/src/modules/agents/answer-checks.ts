/**
 * Checks the platform makes itself on a final answer: counting and
 * comparing, never judging. Each reads the answer and the tool results,
 * and nothing else, and knows no API.
 *
 *  - An item's field against the tool's value for that same item: a date,
 *    a DOI, a version, labels, a title, a venue, a first author. The item
 *    is found by what identifies it (an OpenAlex id, an issue number, a
 *    package name, a title, a DOI).
 *  - A package's update kind against its versions: "outdated-minor" for
 *    ^16.4.5 against 18.0.10 is wrong, 16 to 18 is a major update (run
 *    bf05f68a).
 *  - The answer's own counts against its own list and the tool's list:
 *    "the tool returned 10 works, I skipped 10" over a list of 10 (run
 *    6432deb3); "returned 10, skipped 0" over a list of 9 (run db52dcca).
 *  - Items the tool returned that the answer leaves out while it says its
 *    list is complete ("No other works matched", run db52dcca).
 *  - A summary's counts against the table above it.
 *
 * Every finding names the item and the field, and says what is wrong in
 * plain words. In six rounds of runs these checks were right every time,
 * and a checker model's judgement was not; so a finding here decides the
 * verdict on its own (agent-verifier.helper.ts).
 */

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
          entries.push({ kind: 'row', head: cells[0] ?? '', text: row.trim(), cells: byHeader });
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
      current = { kind: 'numbered', head: numbered[2], list: numberedLists.length - 1, lines: [numbered[2]], text: '' };
      blankBefore = false;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      if (IDENTIFIER_HEAD.test(heading[1].trim())) current = { kind: 'section', head: heading[1].trim(), lines: [heading[1].trim()], text: '' };
      else outside.push(line);
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
  const cut = [' - ', ' – ', ' — ', ' | ', ' (http', ' DOI'].map((m) => s.indexOf(m)).filter((at) => at > 0);
  if (cut.length) s = s.slice(0, Math.min(...cut));
  return s.trim();
}

interface EntryKeys {
  dois: string[];
  doiNone: boolean;
  ids: string[];
  numbers: string[];
  names: string[];
  title: string;
}

const NONE_VALUE = /^(?:none|null|n\/?a|not available|not given|not provided|unknown|no doi|-|—|–)\.?$/i;

function keysOfEntry(entry: AnswerEntry): EntryKeys {
  const text = entry.text;
  const dois = Array.from(new Set(Array.from(text.matchAll(DOI_IN_TEXT), (m) => doiKey(m[0]))));
  const doiLine = labelled(entry, /^doi$/);
  const doiNone = doiLine !== null && NONE_VALUE.test(doiLine.trim());
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
  return { dois, doiNone, ids, numbers: Array.from(numbers), names, title: entryTitle(entry) };
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

function doiFindings(entry: AnswerEntry, items: ToolItem[], keys: EntryKeys): CodeFinding[] {
  const withDoi = items.filter((it) => 'doi' in it.value);
  if (!withDoi.length) return [];
  const it = withDoi[0];
  const tool = typeof it.value.doi === 'string' && it.value.doi ? doiKey(it.value.doi) : null;
  if (keys.dois.length) {
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
  if (keys.doiNone && tool) {
    return [finding(it.label, 'DOI', `${it.label}: the answer says it has no DOI, but the tool results give ${tool}`, `doi: ${it.value.doi}`, labelled(entry, /^doi$/) ?? 'DOI: none', 'item_field')];
  }
  return [];
}

function labelNames(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as Obj).name === 'string' ? ((x as Obj).name as string) : ''))
    .filter(Boolean);
}

function labelFindings(entry: AnswerEntry, items: ToolItem[]): CodeFinding[] {
  const said = labelled(entry, /^labels?$/);
  if (said === null) return [];
  const it = items.find((x) => labelNames(x.value.labels) !== null);
  if (!it) return [];
  const tool = labelNames(it.value.labels)!;
  const toolSet = new Set(tool.map((l) => l.toLowerCase()));
  const listed = NONE_VALUE.test(said.trim()) || !said.trim() ? [] : said.split(',').map((l) => bare(l).toLowerCase()).filter(Boolean);
  const toolWords = tool.length ? tool.join(', ') : 'none';
  if (!listed.length) {
    return tool.length ? [finding(it.label, 'labels', `${it.label}: the answer says it has no labels, but the tool results give ${toolWords}`, `labels: ${toolWords}`, `Labels: ${said}`, 'item_field')] : [];
  }
  const extra = listed.filter((l) => !toolSet.has(l));
  if (!extra.length) return [];
  return [finding(it.label, 'labels', `${it.label}: the answer gives the label${extra.length === 1 ? '' : 's'} ${extra.join(', ')}, but the tool results give ${toolWords}`, `labels: ${toolWords}`, `Labels: ${said}`, 'item_field')];
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
      if (typeof name === 'string' && name.trim()) {
        if (!sameName(venue, name)) out.push(finding(it.label, 'venue', `${it.label}: the answer gives the venue as ${short(venue, 80)}, but the tool results give ${name}`, `primary_location.source.display_name: ${name}`, `Venue: ${venue}`, 'item_field'));
      } else if ((source.value === null || name === null) && venue.trim() && !/^(?:unknown|none|n\/?a|not given|not available)\b/i.test(venue.trim())) {
        out.push(finding(it.label, 'venue', `${it.label}: the answer gives the venue as ${short(venue, 80)}, but the tool results give it no venue`, 'primary_location.source: null', `Venue: ${venue}`, 'item_field'));
      }
    }
  }
  const author = labelled(entry, /^(?:first author|author|lead author)$/);
  if (author !== null && Array.isArray(it.value.authorships)) {
    const first = pathOf(it.value, ['authorships', '0', 'author', 'display_name']);
    const name = first.value;
    if (typeof name === 'string' && name.trim() && !sameName(author, name) && !/^(?:unknown|none|n\/?a)\b/i.test(author.trim())) {
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

/** What each field check says about the entries the answer lists, item by item. */
export function itemFieldFindings(parsed: ParsedAnswer, index: ToolItems): CodeFinding[] {
  const out: CodeFinding[] = [];
  for (const entry of parsed.entries) {
    const { items, by } = itemsOfEntry(entry, index);
    if (!items.length) continue;
    const keys = keysOfEntry(entry);
    out.push(...dateFindings(entry, items), ...doiFindings(entry, items, keys), ...labelFindings(entry, items), ...nameFindings(entry, items, by), ...packageFindings(entry, items));
  }
  return out;
}

const NOUN = '(?:works|items|results|papers|articles|issues|entries|records|publications|packages|releases|hits)';
const RETURNED_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:returned|retrieved|found|gave|yielded)\\s+(?:only\\s+|exactly\\s+)?(\\d{1,4})\\s+(?:[\\w-]+\\s+){0,2}?(${NOUN})\\b`, 'i'),
  new RegExp(`\\b(?:number|count|total)\\s+of\\s+(?:[\\w-]+\\s+){0,2}?(${NOUN})(?:\\s+[\\w-]+){0,4}?(?:[ \\t]*[:=][ \\t]*|[ \\t]+)(\\d{1,4})\\b`, 'i'),
  new RegExp(`\\b(${NOUN})\\s+(?:found|returned|retrieved)\\s*[:=]\\s*(\\d{1,4})\\b`, 'i'),
];
const SKIPPED_PATTERNS: RegExp[] = [/\bskipped\s+(?:only\s+)?(\d{1,4})\b/i, /\b(\d{1,4})\s+(?:[\w-]+\s+){0,3}?(?:were\s+|was\s+)?skipped\b/i];
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
 * Every finding of these checks on an answer. The window check
 * (window-check.ts) is run beside them by the verifier.
 */
export function answerCodeFindings(input: { answer: string; evidence: string }): CodeFinding[] {
  if (!input.answer?.trim() || !input.evidence?.trim()) return [];
  const parsed = parseAnswer(input.answer);
  const index = toolItems(input.evidence);
  const out = [...itemFieldFindings(parsed, index), ...countFindings(parsed, index, input.evidence), ...summaryFindings(parsed)];
  const seen = new Set<string>();
  return out.filter((f) => (seen.has(f.rule) ? false : (seen.add(f.rule), true)));
}
