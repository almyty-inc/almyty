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
import { countsAddUp, followsSortRule, issueQualifies, issueRuleOf, toolItems, type ToolItem } from './answer-checks';

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

/**
 * "Issue 64807 ... should not have been included": a note on whether an
 * issue meets the agent's rule for a problem, judged by the same rule
 * (issueQualifies); or on whether it has a problem label at all. Only a
 * note that is about one issue, named near its start, is read.
 */
function issueClaim(text: string, items: ToolItem[], instructions: string): NoteJudgement {
  const rule = issueRuleOf(instructions);
  if (!rule) return null;
  const named = itemsNamed(text.slice(0, 40), items).filter((it) => it.numbers.length);
  if (named.length !== 1) return null;
  const facts = issueQualifies(named[0], rule);
  if (SAYS_NOT_PROBLEM.test(text) && !TITLE_QUALIFIES.test(text)) return facts.qualifies === null ? null : facts.qualifies ? 'false' : 'true';
  // A note about its labels alone: true where none is a problem label, false where one is.
  if (SAYS_NO_PROBLEM_LABEL.test(text)) return facts.problemLabel ? 'false' : 'true';
  if (SAYS_PROBLEM.test(text)) return facts.qualifies === null ? null : facts.qualifies ? 'true' : 'false';
  return null;
}

/** "Sorting order is correct": a note on the table's order, against the order the instructions give. */
function sortClaim(text: string, ctx: NoteContext): NoteJudgement {
  if (!/\bsort|\border(?:ed)?\b/i.test(text)) return null;
  const says = /\b(?:correctly sorted|sorted correctly|is correctly ordered|sort(?:ing)? order is correct|order is correct|is sorted|properly sorted)\b/i.test(text) && !DENIES.test(text)
    ? true
    : /\bnot (?:correctly )?sorted|\bsort(?:ing)? order is (?:wrong|incorrect)|\bout of order\b/i.test(text)
      ? false
      : null;
  if (says === null) return null;
  const sorted = followsSortRule(ctx.answer, ctx.instructions);
  if (sorted === null) return null;
  return says === sorted ? 'true' : 'false';
}

/** "The skip count is inconsistent with the total returned": a note on whether the answer's counts add up. */
function countClaim(text: string, ctx: NoteContext): NoteJudgement {
  if (!/\b(?:skip|skipped|returned|count|total)\b/i.test(text)) return null;
  const says = /\b(?:inconsistent|does not add up|doesn't add up|do not add up|count is (?:wrong|incorrect)|counts? (?:are|is) (?:wrong|incorrect))\b/i.test(text)
    ? false
    : null;
  if (says === null) return null;
  const adds = countsAddUp(ctx.answer, ctx.evidence);
  if (adds === null) return null;
  return says === adds ? 'true' : 'false';
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
    ['issue rule', () => issueClaim(text, items, ctx.instructions)],
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

/**
 * The notes to show: those the code shows false are left out, those it
 * shows true are marked `checked`. `dropped` counts what was left out, by
 * checker, for the checker's line on the step.
 */
export function screenNotes<N extends { checker: string; text: string; checked?: boolean }>(notes: N[], ctx: NoteContext): { notes: N[]; dropped: Map<string, number> } {
  const kept: N[] = [];
  const dropped = new Map<string, number>();
  for (const n of notes) {
    const verdict = judgeNote(n.text, ctx);
    if (verdict === 'false') {
      dropped.set(n.checker, (dropped.get(n.checker) ?? 0) + 1);
      continue;
    }
    kept.push(verdict === 'true' ? { ...n, checked: true } : n);
  }
  return { notes: kept, dropped };
}
