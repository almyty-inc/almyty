/**
 * Checker notes through the same verifiers as everything else. A note is
 * what a checker said that decides nothing, but the run view shows it, and
 * in rc8 a note the code could show false was on 9 of 10 runs: "4.18.1 is
 * older than 4.17.21", "v27.0.0-alpha.0.1.0 is marked as a prerelease"
 * (the tool says false), "Sorting order is correct" over a table out of
 * order, "#64807 should not have been included" for an issue whose title
 * says it fails, "correctly states it skipped 0 papers as none were
 * previously reported" over papers reported before.
 *
 * Each note is judged: false where the code can show it is wrong (it is
 * not shown), true where it can show it is right (kept, marked checked),
 * and otherwise left as the checker's note.
 */
import { falseVersionOrder } from './version-order';
import { falseDateArithmetic } from './date-arithmetic';
import { countsAddUp, datedEntries, followsSortRule, issueQualifies, issueRuleOf, toolItems, toolListLength, type ToolItem } from './answer-checks';

export type NoteJudgement = 'false' | 'true' | null;

export interface NoteContext {
  answer: string;
  evidence: string;
  /** The agent's own instructions. */
  instructions: string;
  /** What the code checks found on the answer. */
  findings: Array<{ item?: string; field?: string; rule: string }>;
  now: Date;
}

const NEGATED = /\b(?:not|no|never|isn't|isnt|wasn't|without)\b/i;
const AFFIRMS = /\b(?:correct|correctly|accurate|accurately|matches|match|consistent|right|properly)\b/i;
const DENIES = /\b(?:incorrect|incorrectly|wrong|wrongly|inconsistent|mismatch|does not match|doesn't match|should not|shouldn't|not correct|missing|misleading|invalid)\b/i;

/** Fields a tool item carries as true or false, with the words a note says them in. */
const BOOLEAN_FIELDS: Array<{ field: string; words: string[] }> = [
  { field: 'prerelease', words: ['prerelease', 'pre-release'] },
  { field: 'draft', words: ['draft'] },
  { field: 'locked', words: ['locked'] },
  { field: 'archived', words: ['archived'] },
];

/** The tool items a note names: by tag or name, issue number, OpenAlex id. */
function itemsNamed(text: string, items: ToolItem[]): ToolItem[] {
  const lower = text.toLowerCase();
  const numbers = new Set(Array.from(lower.matchAll(/(?:#|\bissues?\s+#?)(\d{2,9})\b/g), (m) => `#${m[1]}`));
  return items.filter(
    (it) =>
      it.numbers.some((n) => numbers.has(n)) ||
      it.ids.some((id) => lower.includes(id)) ||
      it.names.some((n) => n.length >= 4 && /\d/.test(n) && lower.includes(n)),
  );
}

/** "X is marked as a prerelease": the value a note gives a true-or-false field of an item it names. */
function booleanClaim(text: string, items: ToolItem[]): NoteJudgement {
  const lower = text.toLowerCase();
  for (const it of itemsNamed(text, items)) {
    for (const { field, words } of BOOLEAN_FIELDS) {
      const value = it.value[field];
      if (typeof value !== 'boolean') continue;
      const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i !== -1));
      if (!Number.isFinite(at)) continue;
      // "prerelease:false", "prerelease = true": the value written out.
      const written = /^[a-z-]{0,12}\s*[:=]\s*(true|false)\b/.exec(lower.slice(at));
      // Else the clause the word stands in, up to it: "is not marked as a prerelease" says false.
      const start = Math.max(lower.lastIndexOf(',', at), lower.lastIndexOf(';', at), lower.lastIndexOf('. ', at), 0);
      const said = written ? written[1] === 'true' : !NEGATED.test(lower.slice(start, at));
      return said === value ? 'true' : 'false';
    }
  }
  return null;
}

/** Words of a note that say an issue does not meet the rule: "should not have been included", "does not meet the criteria". */
const SAYS_NOT_PROBLEM = /\bshould not (?:have been |be )?(?:included|listed|in\b)|\b(?:does not|doesn't|do not|don't) (?:meet|qualify)|\bnot (?:a )?(?:bug|high[- ]priority)\b|\bnot meet\b/i;
const SAYS_PROBLEM = /\b(?:qualifies|correctly (?:included|listed|identified)|should be included|meets the (?:criteria|rule|filter))\b/i;
/** Words that say its title lets an issue in: the note then claims nothing against it. */
const TITLE_QUALIFIES = /\btitle (?:indicates|suggests|describes|names|says)\b/i;
/** Words of a note about an issue's labels alone: "has no bug/regression/security labels", "does not have labels indicating bugs". */
const SAYS_NO_PROBLEM_LABEL =
  /\b(?:no|without|lacks?|does not have|doesn't have)\b[^.;]{0,30}\b(?:bug|qualifying|problem|regression|security)\b[^.;]{0,30}\blabels?\b|\b(?:does not|doesn't) have (?:any )?labels? (?:indicating|that indicate|matching)/i;

/** "Only issue #7532 ... meets the selection criteria": a note that no other listed issue does. */
const ONLY_ONE_QUALIFIES = /\bonly (?:issue |the issue )?#?(\d{2,9})\b[^.\n]{0,80}\b(?:meets|qualif|matches)/i;

/**
 * "Issue 64807 ... should not have been included": a note on whether the
 * issues it names meet the agent's rule for a problem, judged by the same
 * rule (issueQualifies), for each issue it names near its start ("#7506 /
 * #7538 / #7510 ... should not be included"); or on whether they have a
 * problem label at all; or that only one listed issue qualifies.
 */
function issueClaim(text: string, items: ToolItem[], ctx: NoteContext): NoteJudgement {
  const rule = issueRuleOf(ctx.instructions);
  if (!rule) return null;
  const only = ONLY_ONE_QUALIFIES.exec(text);
  if (only) {
    // Every other issue the answer lists that the rule lets in shows the note false.
    const others = datedEntries(ctx.answer, ctx.evidence)
      .map((e) => e.item)
      .filter((it) => it.numbers.length && !it.numbers.includes(`#${only[1]}`));
    if (others.some((it) => issueQualifies(it, rule).qualifies === true)) return 'false';
    return null;
  }
  // Every issue the note names: a claim about some of them ("#67391 has 'security' but #67455 and #67457 have no bug labels") is read only where all agree.
  const named = itemsNamed(text, items).filter((it) => it.numbers.length);
  if (!named.length) return null;
  const facts = named.map((it) => issueQualifies(it, rule));
  const all = (pick: (f: (typeof facts)[number]) => boolean | null): boolean | null =>
    facts.every((f) => pick(f) === true) ? true : facts.every((f) => pick(f) === false) ? false : null;
  const qualifies = all((f) => f.qualifies);
  if (SAYS_NOT_PROBLEM.test(text) && !TITLE_QUALIFIES.test(text)) return qualifies === null ? null : qualifies ? 'false' : 'true';
  // A note about their labels alone: true where none is a problem label, false where one is.
  if (SAYS_NO_PROBLEM_LABEL.test(text)) {
    const labelled = all((f) => f.problemLabel);
    return labelled === null ? null : labelled ? 'false' : 'true';
  }
  if (SAYS_PROBLEM.test(text)) return qualifies === null ? null : qualifies ? 'true' : 'false';
  return null;
}

/** Words of a note that speak of the order of the answer's items by date. */
const DATE_ORDER = /\b(?:descending|ascending|newest first|oldest first|most recent first|reverse chronological|chronological)\b/i;

/**
 * "Sorting order is correct": a note on the table's order, against the
 * order the instructions give; "the order of papers matches the
 * descending publication date order" (run 37f14fe1), against the dates the
 * answer gives its items.
 */
function sortClaim(text: string, ctx: NoteContext): NoteJudgement {
  if (!/\bsort|\border(?:ed)?\b/i.test(text)) return null;
  const affirms = /\b(?:correctly sorted|sorted correctly|is correctly ordered|sort(?:ing)? order is correct|order is correct|is sorted|properly sorted|order (?:of [\w ]{1,30})?matches|are (?:listed |sorted |ordered )?in [\w ]{0,30}order|follows? the [\w ]{0,30}order)\b/i;
  const says = affirms.test(text) && !DENIES.test(text)
    ? true
    : /\bnot (?:correctly )?(?:sorted|ordered|in [\w ]{0,30}order)|\bsort(?:ing)? order is (?:wrong|incorrect)|\bout of order\b/i.test(text)
      ? false
      : null;
  if (says === null) return null;
  if (DATE_ORDER.test(text)) {
    const days = datedEntries(ctx.answer, ctx.evidence)
      .map((e) => e.day)
      .filter((d): d is string => !!d);
    if (days.length < 2) return null;
    const ascending = /\b(?:ascending|oldest first|chronological)\b/i.test(text) && !/\breverse chronological\b/i.test(text);
    const ordered = days.every((d, i) => i === 0 || (ascending ? d >= days[i - 1] : d <= days[i - 1]));
    return says === ordered ? 'true' : 'false';
  }
  const sorted = followsSortRule(ctx.answer, ctx.instructions);
  if (sorted === null) return null;
  return says === sorted ? 'true' : 'false';
}

/**
 * "The skip count is inconsistent with the total returned": a note on
 * whether the answer's counts add up; "the tool returned 11 works" (run
 * b37987d4, the tool returned 10): a count it gives the tool's list.
 */
function countClaim(text: string, ctx: NoteContext): NoteJudgement {
  // A count the note gives the tool's list: a wrong one shows the note false; a right one shows nothing yet.
  const toolSaid = /\btool (?:returned|returns|gave|provides|provided|has|lists)\s+(?:only\s+)?(\d{1,4})\b/i.exec(text);
  const length = toolSaid ? toolListLength(ctx.answer, ctx.evidence) : null;
  if (toolSaid && length !== null && Number(toolSaid[1]) !== length) return 'false';
  const says = /\b(?:skip|skipped|returned|count|total)\b/i.test(text) &&
    /\b(?:inconsistent|does not add up|doesn't add up|do not add up|count is (?:wrong|incorrect)|counts? (?:are|is) (?:wrong|incorrect))\b/i.test(text)
    ? false
    : null;
  if (says === null) return toolSaid && length !== null ? 'true' : null;
  const adds = countsAddUp(ctx.answer, ctx.evidence);
  if (adds === null) return null;
  return says === adds ? 'true' : 'false';
}

/** Words of a note that call an item's date wrong. */
const DATE_WORDS = /\b(?:published(?:_at)?|publication date|release date|date|updated(?:_at)?|released)\b/i;

/**
 * "v26.13.1 published_at date is wrong; should be 2026-11-11T16:44:25Z,
 * not just 2026-11-11" (run 8ca1dcf2): a note on the dates the answer
 * gives the items it names, against the tool's (dateFindings). False where
 * every date it names agrees, true where one does not.
 */
function dateClaim(text: string, items: ToolItem[], ctx: NoteContext): NoteJudgement {
  if (!DATE_WORDS.test(text) || !/\b(?:wrong|incorrect|should be|does not match|doesn't match|mismatch)\b/i.test(text)) return null;
  // By label: each lookup reads the tool results afresh, so the same item is not the same object.
  const named = new Set(itemsNamed(text, items).map((it) => it.label));
  if (!named.size) return null;
  const dated = datedEntries(ctx.answer, ctx.evidence).filter((e) => named.has(e.item.label) && e.day);
  if (!dated.length) return null;
  return dated.every((e) => e.agrees) ? 'false' : 'true';
}

/** Findings about the answer as a whole: a note about them names their field, not an item. */
const WHOLE_ANSWER_FIELDS = new Set(['previously reported', 'already reported']);

/**
 * A note that calls right what a code check found wrong, or wrong what it
 * found wrong: "correctly states it skipped 0 papers as none were
 * previously reported" beside the finding that they were. The note must
 * name the finding's field, and its item where the finding is about one.
 */
function findingClaim(text: string, ctx: NoteContext): NoteJudgement {
  const lower = text.toLowerCase();
  for (const f of ctx.findings) {
    const field = String(f.field ?? '').toLowerCase();
    if (field.length < 3 || !lower.includes(field)) continue;
    const items = String(f.item ?? '')
      .toLowerCase()
      .replace(/…/g, '')
      .split(/,\s*/)
      .map((x) => x.replace(/^"|"$/g, '').trim())
      .filter((x) => x.length >= 3);
    const aboutItem = WHOLE_ANSWER_FIELDS.has(field) || items.some((x) => lower.includes(x));
    if (!aboutItem) continue;
    if (AFFIRMS.test(text) && !DENIES.test(text) && !/\bnot\b/i.test(text)) return 'false';
    if (DENIES.test(text)) return 'true';
  }
  return null;
}

/** What the code can show about a note, and which verifier showed it. */
export function judgeNoteBy(text: string, ctx: NoteContext): { verdict: NoteJudgement; by: string | null } {
  if (!text?.trim()) return { verdict: null, by: null };
  if (falseVersionOrder(text)) return { verdict: 'false', by: 'version order' };
  if (falseDateArithmetic(text, ctx.now)) return { verdict: 'false', by: 'day arithmetic' };
  const items = toolItems(ctx.evidence).items;
  const checks: Array<[string, () => NoteJudgement]> = [
    ['tool field', () => booleanClaim(text, items)],
    ['issue rule', () => issueClaim(text, items, ctx)],
    ['date field', () => dateClaim(text, items, ctx)],
    ['sort order', () => sortClaim(text, ctx)],
    ['counts', () => countClaim(text, ctx)],
    ['code finding', () => findingClaim(text, ctx)],
  ];
  for (const [by, check] of checks) {
    const verdict = check();
    if (verdict) return { verdict, by };
  }
  return { verdict: null, by: null };
}

/** What the code can show about a note: false, true, or nothing. */
export function judgeNote(text: string, ctx: NoteContext): NoteJudgement {
  return judgeNoteBy(text, ctx).verdict;
}

/** In plain words, what showed a hidden note false. */
const SHOWN_FALSE_BY: Record<string, string> = {
  'version order': 'the versions compare the other way',
  'day arithmetic': 'the day count is wrong',
  'tool field': "the tool results give that field the other value",
  'issue rule': "the agent's rule lets the issue in by its labels or title",
  'date field': 'the answer gives the date the tool results give',
  'sort order': 'the answer is not in that order',
  counts: "the tool results and the answer's own counts say otherwise",
  'code finding': 'a code check found that claim wrong',
};

/**
 * The notes to show, and the ones hidden: a note the code shows false is
 * hidden, kept with what showed it false (`why`) so a reviewer can audit
 * it on the run ("Hidden: proven false by the tool results"); one it shows
 * true is marked `checked`. `dropped` counts the hidden ones by checker.
 */
export function screenNotes<N extends { checker: string; text: string; checked?: boolean; why?: string }>(
  notes: N[],
  ctx: NoteContext,
): { notes: N[]; hidden: N[]; dropped: Map<string, number> } {
  const kept: N[] = [];
  const hidden: N[] = [];
  const dropped = new Map<string, number>();
  for (const n of notes) {
    const { verdict, by } = judgeNoteBy(n.text, ctx);
    if (verdict === 'false') {
      dropped.set(n.checker, (dropped.get(n.checker) ?? 0) + 1);
      hidden.push({ ...n, why: SHOWN_FALSE_BY[by ?? ''] ?? 'the tool results show it false' });
      continue;
    }
    kept.push(verdict === 'true' ? { ...n, checked: true } : n);
  }
  return { notes: kept, hidden, dropped };
}