/**
 * What a checker is shown of a run: the request and every tool result,
 * sized to the checker model's context window.
 *
 * The checker reads the tool results the model that wrote the answer read:
 * whole, from the run's conversation (toolResultsFromMessages), not the
 * copies stored on the steps, which are shortened for storage. A checker
 * that read the stored copy called real authors and venues "not in the
 * evidence" and the revision replaced them with "unknown" (run 5f990f9e).
 *
 * Only when the results do not fit the checker's budget is a result
 * shortened, and then item by item: a JSON result keeps every item, each
 * item's identifying fields (id, name, title, tag, version, date, url, doi)
 * and the identifying leaves of its nested objects (an author's
 * display_name, a venue's name), and drops long text and large or deep
 * structures first. Whatever is still left out is said in the evidence
 * itself, on the line that names the tool ("[result shortened: 4 of 10
 * items shown in results; fields left out: results[].abstract (text) ...]"),
 * and the checker is told that absence from shortened evidence proves
 * nothing (checker-guards.ts drops a failure about a field left out).
 */

/** Evidence budget when the checker's context window is not known, in characters. */
export const EVIDENCE_DEFAULT_CHARS = 120_000;
/**
 * The most evidence any checker is shown, whatever its window: about 50k
 * tokens. Every check and every revision pays for it again, and the staged
 * shortening keeps every item of a large list well inside this.
 */
export const EVIDENCE_MAX_CHARS = 160_000;
const EVIDENCE_MIN_CHARS = 4_000;
/** Conservative: JSON runs nearer three characters a token than four. */
const CHARS_PER_TOKEN = 3;
/** The share of the window the evidence may take; the rest is the prompt, the answer and the reply. */
const WINDOW_SHARE = 0.5;
const MIN_PER_RESULT = 1_500;
const REQUEST_MAX = 20_000;

/** The text every shortening note starts with. */
export const SHORTENED_MARK = '[result shortened';

/**
 * A stored JSON result that was too large to store whole is kept as
 * `{"_shortened": "<note>", "result": <the result, shortened>}`
 * (persist-cap.ts): still valid JSON, every item with its identifying
 * fields, and a note that says what was left out. The run is reloaded
 * from storage between steps, so this is what a checker reads.
 */
export const SHORTENED_KEY = '_shortened';

export interface ShortenedResult {
  [SHORTENED_KEY]: string;
  result: unknown;
}

/** The stored envelope of a shortened result (an object, or its JSON text), or null. */
export function shortenedResultOf(value: unknown): ShortenedResult | null {
  let v = value;
  if (typeof v === 'string') {
    if (!v.startsWith(`{"${SHORTENED_KEY}":`)) return null;
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const note = (v as Record<string, unknown>)[SHORTENED_KEY];
  const keys = Object.keys(v);
  if (typeof note !== 'string' || !note.startsWith(SHORTENED_MARK) || keys.length !== 2 || !keys.includes('result')) return null;
  return v as ShortenedResult;
}

/**
 * A JSON result shortened to fit `cap` characters as stored, item by item
 * (fitResult), in its envelope; null when it is not JSON or cannot be
 * shortened to valid JSON that fits.
 */
export function shortenForStore(parsed: unknown, raw: string, cap: number): ShortenedResult | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  let allowance = cap - 600;
  for (let attempt = 0; attempt < 4 && allowance > 0; attempt++) {
    const { body, note } = fitResult(raw, parsed, allowance);
    let result: unknown;
    try {
      result = JSON.parse(body);
    } catch {
      return null;
    }
    const envelope: ShortenedResult = {
      [SHORTENED_KEY]: note ?? `${SHORTENED_MARK}: ${raw.length.toLocaleString('en-US')} chars stored in part]`,
      result,
    };
    const size = JSON.stringify(envelope).length;
    if (size <= cap) return envelope;
    allowance -= size - cap + 200;
  }
  return null;
}

/**
 * Text a store cut at its limit ends `… (truncated from N characters...)`
 * (persist-cap.ts withTruncationMarker). Read back, it is the kept start
 * and the full length, so it is shown as shortened, not as the whole result.
 */
const CUT_TEXT_END = /… \(truncated from (\d+) characters[^()]*\)$/;

export function cutTextOf(text: string): { kept: string; total: number } | null {
  const tail = text.slice(-120);
  const m = CUT_TEXT_END.exec(tail);
  if (!m) return null;
  return { kept: text.slice(0, text.length - (tail.length - m.index)), total: Number(m[1]) };
}

/**
 * How many characters of evidence a checker gets: half its context window
 * when the window is known (less what else the prompt carries), else a
 * default, never more than EVIDENCE_MAX_CHARS.
 */
export function evidenceBudget(contextLength?: number | null, reservedChars = 0): number {
  if (typeof contextLength !== 'number' || !(contextLength > 0)) return EVIDENCE_DEFAULT_CHARS;
  const chars = Math.floor(contextLength * WINDOW_SHARE * CHARS_PER_TOKEN) - Math.max(0, reservedChars);
  return Math.max(EVIDENCE_MIN_CHARS, Math.min(EVIDENCE_MAX_CHARS, chars));
}

type RunLike = {
  input?: unknown;
  steps?: Array<{ type?: string; input?: any; output?: unknown; error?: unknown }>;
};

/** One tool result as the model that wrote the answer read it. */
export interface RunToolResult {
  tool: string;
  parameters?: unknown;
  /** The result as the conversation holds it: whole, before any storage cap. */
  content: string;
  error?: boolean;
}

type MessageLike = {
  role?: string;
  toolCalls?: Array<{ id?: string; name?: string; parameters?: unknown; arguments?: unknown }> | null;
  toolCallId?: string | null;
  content?: string | null;
  error?: string | null;
};

/**
 * The tool results of a run as its conversation holds them, in the order
 * the calls were made: what the model that wrote the answer was given.
 *
 * The stored steps are capped for storage (persist-cap.ts) and the run's
 * log the same way, so a checker that read them judged a shortened copy:
 * authors and venues the writer had read were "not in the evidence" and
 * the revision replaced them with "unknown" (run 5f990f9e). Each tool
 * result message is saved whole, before the call's `tool_finished` lands
 * on the log, so a step resumed on another worker reads the same results.
 */
export function toolResultsFromMessages(messages: MessageLike[]): RunToolResult[] {
  const results = new Map<string, MessageLike>();
  for (const m of messages ?? []) {
    // The last one wins: an approval's decision replaces its placeholder.
    if (m?.role === 'tool' && m.toolCallId) results.set(m.toolCallId, m);
  }
  const out: RunToolResult[] = [];
  const seen = new Set<string>();
  const add = (id: string, tool: string, parameters: unknown) => {
    const r = results.get(id);
    if (!r || seen.has(id)) return;
    seen.add(id);
    out.push({ tool, ...(parameters !== undefined && parameters !== null ? { parameters } : {}), content: r.content ?? '', ...(r.error ? { error: true } : {}) });
  };
  for (const m of messages ?? []) {
    if (!Array.isArray(m?.toolCalls)) continue;
    for (const call of m.toolCalls) {
      if (call?.id) add(call.id, call.name || 'tool', call.parameters ?? call.arguments);
    }
  }
  for (const id of results.keys()) add(id, 'tool', undefined);
  return out;
}

/**
 * What an autonomous run was asked and what its tools returned: the ground a
 * checker judges the final answer against. Without it a checker had only the
 * answer, so "is this version what npm returned?" was judged from the
 * checker's own (stale) knowledge.
 *
 * `toolResults`, when given, are the results the writer read
 * (toolResultsFromMessages); the stored steps are read only for a run that
 * has none (no conversation). Either way a result is shortened only when
 * the whole evidence would not fit the checker's budget.
 */
export function runEvidence(run: RunLike, opts: { budgetChars?: number; toolResults?: RunToolResult[] } = {}): string {
  const budget = Math.max(EVIDENCE_MIN_CHARS, Math.min(EVIDENCE_MAX_CHARS, opts.budgetChars ?? EVIDENCE_DEFAULT_CHARS));
  const parts: string[] = [];
  let used = 0;

  const request = run.input && typeof run.input === 'object' && 'message' in (run.input as any) ? (run.input as any).message : run.input;
  if (request !== undefined && request !== null && request !== '') {
    const text = typeof request === 'string' ? request : JSON.stringify(request);
    const shown = text.length > REQUEST_MAX ? `${text.slice(0, REQUEST_MAX)}\n[request shortened: ${text.length - REQUEST_MAX} of ${text.length} chars omitted]` : text;
    parts.push(`REQUEST:\n${shown}`);
    used += shown.length;
  }

  const results = opts.toolResults?.length ? opts.toolResults.map(fromMessage) : fromSteps(run);

  const allowances = shareOut(results.map((r) => r.raw.length), Math.max(0, budget - used));
  results.forEach((r, i) => {
    if (used >= budget) {
      parts.push(`${r.head}: [result left out: the evidence limit was reached]`);
      return;
    }
    const allowance = Math.min(Math.max(allowances[i], MIN_PER_RESULT), budget - used);
    const { body, note } = fitResult(r.raw, r.value, allowance);
    used += body.length;
    const notes = [r.stored, note].filter(Boolean).join(' ');
    parts.push(notes ? `${r.head}: ${notes}\n${body}` : `${r.head}:\n${body}`);
  });
  return parts.join('\n\n');
}

type EvidenceItem = { head: string; raw: string; value: unknown; stored?: string };

function headOf(tool: unknown, parameters: unknown): string {
  const args = parameters !== undefined && parameters !== null ? ` ${JSON.stringify(parameters)}` : '';
  return `${String(tool ?? 'tool')}${args}`;
}

function fromMessage(r: RunToolResult): EvidenceItem {
  const head = headOf(r.tool, r.parameters);
  if (r.error) return { head, raw: `ERROR ${r.content}`, value: undefined };
  return { head, raw: r.content, value: undefined };
}

/** The tool results from the stored steps, which may have been shortened for storage. */
function fromSteps(run: RunLike): EvidenceItem[] {
  return (run.steps ?? [])
    .filter((step) => step?.type === 'tool_call')
    .map((step) => {
      const head = headOf(step.input?.tool ?? step.input?.toolName ?? 'tool', step.input?.parameters);
      if (step.error) return { head, raw: `ERROR ${String((step.error as any)?.message ?? step.error)}`, value: undefined };
      // What the store already left out of a large result says so here,
      // on the line that names the tool, like any other shortening.
      let value: unknown = step.output;
      let stored: string | undefined;
      const envelope = shortenedResultOf(value);
      if (envelope) {
        stored = envelope[SHORTENED_KEY];
        value = envelope.result;
      } else if (typeof value === 'string') {
        const cut = cutTextOf(value);
        if (cut) {
          stored = `${SHORTENED_MARK}: the stored result was cut; only the first ${cut.kept.length.toLocaleString('en-US')} of ${cut.total.toLocaleString('en-US')} chars were kept]`;
          value = cut.kept;
        }
      }
      const raw = typeof value === 'string' ? value : JSON.stringify(value ?? null) ?? 'null';
      return { head, raw, value, stored };
    });
}

/**
 * Share a budget among results of these sizes: small results get all they
 * need, and what is left is split evenly among the large ones.
 */
function shareOut(sizes: number[], budget: number): number[] {
  const order = sizes.map((size, i) => ({ size, i })).sort((a, b) => a.size - b.size);
  const out = new Array<number>(sizes.length).fill(0);
  let left = budget;
  order.forEach(({ size, i }, k) => {
    const share = Math.floor(left / (order.length - k));
    out[i] = Math.min(size, share);
    left -= out[i];
  });
  return out;
}

type FieldKind = 'text' | 'object' | 'list' | 'value';

interface Notes {
  /** Every field left out, by path (`results[].authorships[].author`), and what it held. */
  dropped: Map<string, FieldKind>;
  cutTexts: number;
  arrays: Array<{ path: string; shown: number; total: number }>;
}

type Level = 1 | 2 | 3 | 4;

/** One tool result within `allowance` characters, and the note that says what was left out. */
export function fitResult(raw: string, value: unknown, allowance: number): { body: string; note?: string } {
  if (raw.length <= allowance) return { body: raw };
  const parsed = asJson(value, raw);
  if (parsed !== undefined) {
    for (const level of [1, 2, 3, 4] as const) {
      const notes = newNotes();
      const body = JSON.stringify(compact(parsed, level, notes, '', 0, Infinity));
      if (body.length <= allowance) return { body, note: noteOf(notes, raw.length, body.length) };
    }
    // Identifying fields alone are still too long: show as many items as
    // fit (the most that fit, found by bisection), and say how many.
    let lo = 1;
    let hi = longestItemList(parsed, 0) - 1;
    let best: { body: string; notes: Notes } | null = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const notes = newNotes();
      const body = JSON.stringify(compact(parsed, 4, notes, '', 0, mid));
      if (body.length <= allowance) {
        best = { body, notes };
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) return { body: best.body, note: noteOf(best.notes, raw.length, best.body.length) };
    const notes = newNotes();
    const smallest = JSON.stringify(compact(parsed, 4, notes, '', 0, 1));
    const body = smallest.slice(0, allowance);
    return { body, note: noteOf(notes, raw.length, body.length, body.length < smallest.length) };
  }
  const body = raw.slice(0, allowance);
  return { body, note: `${SHORTENED_MARK}: ${(raw.length - body.length).toLocaleString('en-US')} of ${raw.length.toLocaleString('en-US')} chars omitted; only the start is shown]` };
}

function newNotes(): Notes {
  return { dropped: new Map(), cutTexts: 0, arrays: [] };
}

/** Fold what a part kept into the whole: used once the part is known to stay. */
function mergeNotes(into: Notes, from: Notes): void {
  for (const [path, kind] of from.dropped) into.dropped.set(path, kind);
  into.cutTexts += from.cutTexts;
  for (const a of from.arrays) {
    const seen = into.arrays.find((x) => x.path === a.path);
    if (seen) {
      seen.shown += a.shown;
      seen.total += a.total;
    } else {
      into.arrays.push({ ...a });
    }
  }
}

function kindOf(value: unknown): FieldKind {
  if (typeof value === 'string') return 'text';
  if (Array.isArray(value)) return 'list';
  if (value !== null && typeof value === 'object') return 'object';
  return 'value';
}

const KIND_WORD: Record<FieldKind, string> = { text: 'text', object: 'object', list: 'list', value: 'value' };

/** The words that start the list of fields left out; leftOutFieldsOf reads them back. */
export const FIELDS_LEFT_OUT = 'fields left out: ';

/**
 * Every field left out, by path, grouped under the list item they belong
 * to: `results[].{abstract_inverted_index (object), authorships[].raw_author_name (text)}`.
 * Paths are deduplicated: a field left out of every item is named once.
 */
export function describeLeftOut(dropped: Map<string, FieldKind>): string {
  const groups = new Map<string, string[]>();
  for (const [path, kind] of dropped) {
    const at = path.lastIndexOf('[].');
    const prefix = at === -1 ? '' : path.slice(0, at + 2);
    const member = at === -1 ? path : path.slice(at + 3);
    const list = groups.get(prefix) ?? [];
    list.push(`${member} (${KIND_WORD[kind]})`);
    groups.set(prefix, list);
  }
  const out: string[] = [];
  for (const [prefix, members] of groups) {
    if (!prefix) out.push(...members);
    else out.push(members.length === 1 ? `${prefix}.${members[0]}` : `${prefix}.{${members.join(', ')}}`);
  }
  return out.join(', ');
}

/**
 * The paths a shortening note in `evidence` says were left out, expanded
 * (`results[].{a (text), b.c (object)}` reads as `results[].a`, `results[].b.c`).
 */
export function leftOutFieldsOf(evidence: string): string[] {
  const out = new Set<string>();
  let from = 0;
  for (;;) {
    const at = evidence.indexOf(FIELDS_LEFT_OUT, from);
    if (at === -1) break;
    let i = at + FIELDS_LEFT_OUT.length;
    let depth = 0;
    let end = i;
    for (; end < evidence.length; end++) {
      const c = evidence[end];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (depth === 0 && c === ';') break;
      // "[]" is part of a path; any other "]" closes the note.
      else if (c === ']' && evidence[end - 1] !== '[') break;
      else if (c === '\n') break;
    }
    const text = evidence.slice(i, end);
    from = end;
    // Split on ", " outside braces.
    const entries: string[] = [];
    depth = 0;
    let start = 0;
    for (i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (depth === 0 && c === ',') {
        entries.push(text.slice(start, i));
        start = i + 1;
      }
    }
    entries.push(text.slice(start));
    for (const entry of entries) {
      const e = entry.trim();
      const brace = e.indexOf('.{');
      if (brace !== -1 && e.endsWith('}')) {
        const prefix = e.slice(0, brace);
        for (const member of e.slice(brace + 2, -1).split(',')) {
          const name = stripKind(member);
          if (name) out.add(`${prefix}.${name}`);
        }
      } else {
        const name = stripKind(e);
        if (name) out.add(name);
      }
    }
  }
  return Array.from(out);
}

/** An entry without its "(kind)" suffix. No regex: the suffix is one of four words. */
function stripKind(entry: string): string {
  const e = entry.trim();
  for (const kind of Object.values(KIND_WORD)) {
    const suffix = `(${kind})`;
    if (e.endsWith(suffix)) return e.slice(0, -suffix.length).trim();
  }
  return e;
}

function noteOf(notes: Notes, rawLength: number, bodyLength: number, cutEnd = false): string {
  const parts: string[] = [];
  if (notes.arrays.length) {
    parts.push(notes.arrays.map((a) => `${a.shown} of ${a.total} items shown${a.path ? ` in ${a.path}` : ''}`).join(', '));
  } else {
    parts.push('every item is shown');
  }
  if (notes.dropped.size) parts.push(`${FIELDS_LEFT_OUT}${describeLeftOut(notes.dropped)}`);
  if (notes.cutTexts) parts.push(`${notes.cutTexts} long texts cut`);
  if (cutEnd) parts.push('the end was cut off');
  parts.push(`${Math.max(0, rawLength - bodyLength).toLocaleString('en-US')} chars omitted`);
  return `${SHORTENED_MARK}: ${parts.join('; ')}]`;
}

/** The result as JSON: the step's own object, or a string that parses as an object or array. */
export function asJson(value: unknown, raw: string): unknown {
  if (value !== null && typeof value === 'object') return value;
  const text = raw.trim();
  if (!(text.startsWith('{') || text.startsWith('['))) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Fields that say which item an item is. Kept at every level. */
export function isIdentityKey(key: string): boolean {
  const k = key.toLowerCase();
  if (
    [
      'id', '_id', 'uuid', 'key', 'slug', 'name', 'full_name', 'display_name', 'title', 'tag', 'tag_name', 'label',
      'version', 'latest', 'number', 'doi', 'url', 'html_url', 'link', 'homepage', 'login', 'type', 'status',
      'state', 'year', 'publication_year', 'date', 'orcid', 'issn_l',
    ].includes(k)
  ) {
    return true;
  }
  return k.includes('date') || k.includes('version') || k.endsWith('_at') || /[a-z]At$/.test(key) || k.startsWith('published');
}

const STRING_LIMIT = { 1: 500, 2: 200, 3: 120, 4: 120 } as const;
const IDENTITY_STRING_LIMIT = 300;
const NESTED_LIMIT = 300;
/** A nested object kept for its identifying leaves at level 3, at most this long. */
const NESTED_IDENTITY_LIMIT = 400;
const MAX_DEPTH = 12;

function isItemList(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.some((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
}

/** Whether a value is, or holds, a list of items. Such containers are never dropped. */
function holdsItems(v: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH || v === null || typeof v !== 'object') return false;
  if (isItemList(v)) return true;
  if (Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).some((x) => holdsItems(x, depth + 1));
}

function longestItemList(v: unknown, depth: number): number {
  if (depth > MAX_DEPTH || v === null || typeof v !== 'object') return 0;
  const own = isItemList(v) ? v.length : 0;
  const inner = Object.values(v as Record<string, unknown>).map((x) => longestItemList(x, depth + 1));
  return Math.max(own, ...inner, 0);
}

function cutText(text: string, limit: number, notes: Notes): string {
  if (text.length <= limit) return text;
  notes.cutTexts++;
  return `${text.slice(0, limit)}…`;
}

/** Whether a compacted object still holds anything: a leaf (an identifying field, a number, a flag) at any depth. */
function holdsLeaf(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return v !== undefined;
  if (Array.isArray(v)) return v.some(holdsLeaf);
  return Object.values(v as Record<string, unknown>).some(holdsLeaf);
}

/**
 * Level 1 cuts long strings. Level 2 also drops a field whose value is
 * large and is not an identifying field or a list of items; of a large
 * nested object (`authorships[].author`, `primary_location.source`) it
 * keeps the short identifying leaves (name, display_name, id, ...). Level
 * 3 keeps identifying fields, numbers, booleans, lists of items and the
 * identifying leaves of nested objects: long text and large or deep
 * structures go first. Level 4 drops nested objects whole. Every level
 * keeps every item of a list unless `maxItems` says otherwise. Each field
 * left out is recorded by its path.
 */
function compact(v: unknown, level: Level, notes: Notes, path: string, depth: number, maxItems: number): unknown {
  if (depth > MAX_DEPTH) return '…';
  if (typeof v === 'string') return cutText(v, STRING_LIMIT[level], notes);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    let items = v;
    if (isItemList(v) && v.length > maxItems) {
      items = v.slice(0, maxItems);
      const where = path || 'the list';
      const seen = notes.arrays.find((a) => a.path === where);
      if (seen) {
        seen.shown += items.length;
        seen.total += v.length;
      } else {
        notes.arrays.push({ path: where, shown: items.length, total: v.length });
      }
    }
    return items.map((x) => compact(x, level, notes, `${path}[]`, depth + 1, maxItems));
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isIdentityKey(key)) {
      out[key] = typeof value === 'string' ? cutText(value, IDENTITY_STRING_LIMIT, notes) : compact(value, level, notes, childPath, depth + 1, maxItems);
      continue;
    }
    if (holdsItems(value, depth + 1)) {
      out[key] = compact(value, level, notes, childPath, depth + 1, maxItems);
      continue;
    }
    if (level === 1 || value === null || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = level === 1 ? compact(value, level, notes, childPath, depth + 1, maxItems) : value;
      continue;
    }
    if (level === 2) {
      const inner = newNotes();
      const small = compact(value, level, inner, childPath, depth + 1, maxItems);
      if ((JSON.stringify(small) ?? '').length <= NESTED_LIMIT) {
        out[key] = small;
        mergeNotes(notes, inner);
        continue;
      }
    }
    if (level <= 3 && kindOf(value) === 'object') {
      // Too large whole: the nested object's identifying leaves, when they are short.
      const inner = newNotes();
      const small = compact(value, 3, inner, childPath, depth + 1, maxItems);
      if (holdsLeaf(small) && (JSON.stringify(small) ?? '').length <= NESTED_IDENTITY_LIMIT) {
        out[key] = small;
        mergeNotes(notes, inner);
        continue;
      }
    }
    notes.dropped.set(childPath, kindOf(value));
  }
  return out;
}