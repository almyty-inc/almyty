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

const LOWER_WORDS = ['older', 'earlier', 'lower', 'smaller', 'less recent', 'below'];
const HIGHER_WORDS = ['newer', 'later', 'higher', 'greater', 'bigger', 'more recent', 'above'];
/** Bounded so a long run of digits cannot make the scan quadratic. */
const VERSION = /v?\d{1,9}(?:\.\d{1,9}){1,4}/gi;
const MAX_GAP = 40;

/**
 * The first false version-order statement in `text` ("A is older than B"
 * where A > B), described in plain words, or null when every such
 * statement is true or there is none.
 */
export function falseVersionOrder(text: string): string | null {
  if (!text) return null;
  const found = Array.from(text.matchAll(VERSION)).map((m) => ({ v: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  for (let i = 0; i + 1 < found.length; i++) {
    const a = found[i];
    const b = found[i + 1];
    const gap = text.slice(a.end, b.start).toLowerCase();
    if (gap.length > MAX_GAP || !/\bthan\b/.test(gap) || /\bnot\b|n't/.test(gap)) continue;
    const saysLower = LOWER_WORDS.some((w) => gap.includes(w));
    const saysHigher = HIGHER_WORDS.some((w) => gap.includes(w));
    if (saysLower === saysHigher) continue;
    const cmp = compareVersions(a.v, b.v);
    if (saysLower && cmp >= 0) return `${a.v} is not older than ${b.v}: ${cmp === 0 ? 'they are the same version' : `${a.v} is the newer one`}`;
    if (saysHigher && cmp <= 0) return `${a.v} is not newer than ${b.v}: ${cmp === 0 ? 'they are the same version' : `${b.v} is the newer one`}`;
  }
  return null;
}
