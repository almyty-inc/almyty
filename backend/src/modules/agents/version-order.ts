/**
 * Version order, decided by arithmetic rather than by a model.
 *
 * A checker compared dotted versions as text and wrote "4.18.1 is OLDER
 * than 4.17.21", failed a correct answer on it, and the revision changed
 * the right version to the wrong one. A failure whose reason states a
 * version order that is false is not a refutation; the verifier drops it
 * (agent-verifier.helper.ts). Nothing here knows any registry: it reads
 * dotted numbers in prose.
 */

/** -1, 0 or 1: dotted versions compared part by part as integers ("v" prefix allowed, missing parts are 0). */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((p) => parseInt(p, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Bounded so a long run of digits cannot make the scan quadratic. */
const VERSION = /v?\d{1,9}(?:\.\d{1,9}){1,4}/gi;
/**
 * A stated order between two things: a symbol (`<`, `<=`, `≤`, `>`, ...)
 * or a comparative with "than" ("older than", "less than", "more recent
 * than", "a lower minor version than"). "Lower" means the first is the
 * older one; "higher" the newer. An arrow ("->", "=>", "<-") is not a
 * comparison.
 */
const COMPARISON =
  /(?<![-=<>])(<=|>=|≤|≥|<(?![-=<])|>(?![=>]))|\b(older|earlier|lower|smaller|less(?: recent)?|newer|later|higher|greater|bigger|larger|more recent)\s+(?:(?:minor|major|patch)\s+)?(?:versions?\s+)?than\b/gi;
const LOWER = new Set(['<', '<=', '≤', 'older', 'earlier', 'lower', 'smaller', 'less', 'less recent']);
/** Words that leave no plain order statement: "4.18.1 is wrongly older than 4.17.21". */
const NEGATION = /\bnot\b|n't\b|\bnever\b|\bfalse\b|\bwrong\b|\bincorrect\b/i;
/** A denial of the stated order, which turns it around: "is not older than" says "is at least as new as". */
const DENIAL = /\bnot\b|n't\b|\bnever\b/i;

/**
 * Sentences of `text`. A dot inside a version ("4.17.21") is followed by a
 * digit, so only a dot (or ; ! ?) followed by space or the end, or a line
 * break, ends a sentence.
 */
function sentences(text: string): string[] {
  return text.split(/[.;!?](?=\s|$)|\n+/);
}

/**
 * The first false version-order statement in `text` ("A is older than B",
 * "A < B", "A is less than B", where A > B), described in plain words,
 * or null when every such statement is true or there is none. Both
 * versions and the comparison may be anywhere in one sentence: the
 * comparison is read between the nearest version before it and the
 * nearest after it.
 */
export function falseVersionOrder(text: string): string | null {
  if (!text) return null;
  for (const sentence of sentences(text)) {
    const versions = Array.from(sentence.matchAll(VERSION)).map((m) => ({ v: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
    if (versions.length < 2) continue;
    for (const c of sentence.matchAll(COMPARISON)) {
      const at = c.index ?? 0;
      const word = (c[1] ?? c[2] ?? '').toLowerCase();
      const a = [...versions].reverse().find((v) => v.end <= at);
      const b = versions.find((v) => v.start >= at + c[0].length);
      if (!a || !b) continue;
      // "A < B is false": not a statement that A is older.
      const gap = sentence.slice(a.end, b.start);
      const after = sentence.slice(b.end, b.end + 20);
      if (/^\s*(?:(?:is|was)\s+)?(?:false|wrong|incorrect|not true)\b/i.test(after)) continue;
      // "A is not newer than B" states that A is at most B: the denial
      // turns the order around rather than taking the statement back
      // (run 20f31553 failed a correct answer on "4.18.1 is not newer
      // than 4.17.21"). Other words between ("A is wrongly older than
      // B") leave no plain statement to check.
      const denied = DENIAL.test(gap);
      if (!denied && NEGATION.test(gap)) continue;
      const cmp = compareVersions(a.v, b.v);
      // The same version on both sides is never a false order claim: it is a
      // range read as ">=1.6.0" next to "^1.6.0", or a version set beside
      // itself. Dropping it once took a correct premise out of a check while
      // the failures that followed from it stayed (run 6933d7e2).
      if (cmp === 0) continue;
      const saysLower = LOWER.has(word);
      if (denied) {
        if (saysLower && cmp < 0) return `${a.v} is older than ${b.v}: ${b.v} is the newer one`;
        if (!saysLower && cmp > 0) return `${a.v} is newer than ${b.v}: ${a.v} is the newer one`;
        continue;
      }
      if (saysLower && cmp > 0) return `${a.v} is not older than ${b.v}: ${a.v} is the newer one`;
      if (!saysLower && cmp < 0) return `${a.v} is not newer than ${b.v}: ${b.v} is the newer one`;
    }
  }
  return null;
}