/**
 * What a checker is shown of a run: the request and every tool result,
 * sized to the checker model's context window.
 *
 * A checker that saw only the start of a long tool result took everything
 * past the cut for absent. It called real items "invented" (10 OpenAlex
 * works, it had seen two), the agent deleted correct data while revising,
 * and an answer that left items out could pass. So a large result is
 * compacted before anything is cut: a JSON result keeps every item and
 * each item's identifying fields (id, name, title, tag, version, date, url,
 * doi) and drops long fields such as bodies and abstracts first. Whatever
 * is still left out is said in the evidence itself, on the line that names
 * the tool ("[result shortened: 4 of 10 items shown in results ...]"), and
 * the checker is told that absence from shortened evidence proves nothing.
 */

/** Evidence budget when the checker's context window is not known, in characters. */
export const EVIDENCE_DEFAULT_CHARS = 120_000;
/** The most evidence any checker is shown, whatever its window. */
export const EVIDENCE_MAX_CHARS = 400_000;
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

/**
 * What an autonomous run was asked and what its tools returned: the ground a
 * checker judges the final answer against. Without it a checker had only the
 * answer, so "is this version what npm returned?" was judged from the
 * checker's own (stale) knowledge.
 */
export function runEvidence(run: RunLike, opts: { budgetChars?: number } = {}): string {
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

  const results = (run.steps ?? [])
    .filter((step) => step?.type === 'tool_call')
    .map((step) => {
      const tool = step.input?.tool ?? step.input?.toolName ?? 'tool';
      const args = step.input?.parameters ? ` ${JSON.stringify(step.input.parameters)}` : '';
      const raw = step.error
        ? `ERROR ${String((step.error as any)?.message ?? step.error)}`
        : typeof step.output === 'string'
          ? step.output
          : JSON.stringify(step.output ?? null) ?? 'null';
      return { head: `${tool}${args}`, raw, value: step.error ? undefined : step.output };
    });

  const allowances = shareOut(results.map((r) => r.raw.length), Math.max(0, budget - used));
  results.forEach((r, i) => {
    if (used >= budget) {
      parts.push(`${r.head}: [result left out: the evidence limit was reached]`);
      return;
    }
    const allowance = Math.min(Math.max(allowances[i], MIN_PER_RESULT), budget - used);
    const { body, note } = fitResult(r.raw, r.value, allowance);
    used += body.length;
    parts.push(note ? `${r.head}: ${note}\n${body}` : `${r.head}:\n${body}`);
  });
  return parts.join('\n\n');
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

interface Notes {
  dropped: Set<string>;
  cutTexts: number;
  arrays: Array<{ path: string; shown: number; total: number }>;
}

/** One tool result within `allowance` characters, and the note that says what was left out. */
export function fitResult(raw: string, value: unknown, allowance: number): { body: string; note?: string } {
  if (raw.length <= allowance) return { body: raw };
  const parsed = asJson(value, raw);
  if (parsed !== undefined) {
    for (const level of [1, 2, 3] as const) {
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
      const body = JSON.stringify(compact(parsed, 3, notes, '', 0, mid));
      if (body.length <= allowance) {
        best = { body, notes };
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) return { body: best.body, note: noteOf(best.notes, raw.length, best.body.length) };
    const notes = newNotes();
    const smallest = JSON.stringify(compact(parsed, 3, notes, '', 0, 1));
    const body = smallest.slice(0, allowance);
    return { body, note: noteOf(notes, raw.length, body.length, body.length < smallest.length) };
  }
  const body = raw.slice(0, allowance);
  return { body, note: `${SHORTENED_MARK}: ${(raw.length - body.length).toLocaleString('en-US')} of ${raw.length.toLocaleString('en-US')} chars omitted; only the start is shown]` };
}

function newNotes(): Notes {
  return { dropped: new Set(), cutTexts: 0, arrays: [] };
}

function noteOf(notes: Notes, rawLength: number, bodyLength: number, cutEnd = false): string {
  const parts: string[] = [];
  if (notes.arrays.length) {
    parts.push(notes.arrays.slice(0, 5).map((a) => `${a.shown} of ${a.total} items shown${a.path ? ` in ${a.path}` : ''}`).join(', '));
  } else {
    parts.push('every item is shown');
  }
  if (notes.dropped.size) parts.push(`long fields left out: ${Array.from(notes.dropped).slice(0, 12).join(', ')}`);
  if (notes.cutTexts) parts.push(`${notes.cutTexts} long texts cut`);
  if (cutEnd) parts.push('the end was cut off');
  parts.push(`${Math.max(0, rawLength - bodyLength).toLocaleString('en-US')} chars omitted`);
  return `${SHORTENED_MARK}: ${parts.join('; ')}]`;
}

/** The result as JSON: the step's own object, or a string that parses as an object or array. */
function asJson(value: unknown, raw: string): unknown {
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
      'id', '_id', 'uuid', 'key', 'slug', 'name', 'full_name', 'display_name', 'title', 'tag', 'tag_name',
      'version', 'latest', 'number', 'doi', 'url', 'html_url', 'link', 'homepage', 'login', 'type', 'status',
      'state', 'year', 'publication_year', 'date',
    ].includes(k)
  ) {
    return true;
  }
  return k.includes('date') || k.includes('version') || k.endsWith('_at') || /[a-z]At$/.test(key) || k.startsWith('published');
}

const STRING_LIMIT = { 1: 500, 2: 200, 3: 120 } as const;
const IDENTITY_STRING_LIMIT = 300;
const NESTED_LIMIT = 300;
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

/**
 * Level 1 cuts long strings. Level 2 also drops a field whose value is
 * large and is not an identifying field or a list of items. Level 3 keeps
 * only identifying fields, numbers, booleans and lists of items. Every
 * level keeps every item of a list unless `maxItems` says otherwise.
 */
function compact(v: unknown, level: 1 | 2 | 3, notes: Notes, path: string, depth: number, maxItems: number): unknown {
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
    return items.map((x) => compact(x, level, notes, path, depth + 1, maxItems));
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
    if (level === 1) {
      out[key] = compact(value, level, notes, childPath, depth + 1, maxItems);
      continue;
    }
    if (level === 3) {
      if (value === null || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
      else notes.dropped.add(key);
      continue;
    }
    const small = compact(value, level, notes, childPath, depth + 1, maxItems);
    if ((JSON.stringify(small) ?? '').length <= NESTED_LIMIT) out[key] = small;
    else notes.dropped.add(key);
  }
  return out;
}
