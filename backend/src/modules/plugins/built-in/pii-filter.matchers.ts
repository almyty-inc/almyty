/**
 * What `text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g)`
 * returns, in one pass.
 *
 * The regex tried every word boundary as the start of an address and ran
 * the local part to the end of its run looking for an `@`, and for each
 * `@` backtracked the domain looking for a top-level label: 100 KB of
 * `a.a.a.` in a request or response body took seconds, on every call the
 * filter sees. Here every address hangs off its `@`: the local part is
 * the run of address characters just before it, the domain the run just
 * after, each read once.
 */

const WORD = /[A-Za-z0-9_]/;
const LOCAL = /[A-Za-z0-9._%+-]/;
const DOMAIN = /[A-Za-z0-9.-]/;
// `[A-Z|a-z]`: the `|` is a literal member of the class, kept as it was.
const TOP_LEVEL = /[A-Za-z|]/;

function isWord(ch: string | undefined): boolean {
  return ch !== undefined && WORD.test(ch);
}

function boundaryAt(text: string, i: number): boolean {
  return isWord(text[i - 1]) !== isWord(text[i]);
}

/**
 * Where the address whose `@` is at `at` ends, or -1. The regex takes
 * the longest domain that leaves `.` plus two or more top-level
 * characters, then the longest top-level part that ends on a word
 * boundary; so does this, right to left.
 */
function addressEnd(text: string, at: number): number {
  let domainEnd = at + 1;
  while (domainEnd < text.length && DOMAIN.test(text[domainEnd])) domainEnd++;
  for (let dot = domainEnd - 1; dot >= at + 2; dot--) {
    if (text[dot] !== '.') continue;
    let end = dot + 1;
    while (end < text.length && TOP_LEVEL.test(text[end])) end++;
    for (let p = end; p >= dot + 3; p--) {
      if (boundaryAt(text, p)) return p;
    }
  }
  return -1;
}

export function matchEmailAddresses(text: string): string[] | null {
  const out: string[] = [];
  let from = 0;
  let at = text.indexOf('@');
  while (at !== -1) {
    // `@` is in neither class, so an address holds exactly one, and its
    // local part lies in the run just before it.
    let runStart = at;
    while (runStart > from && LOCAL.test(text[runStart - 1])) runStart--;
    let start = -1;
    for (let s = runStart; s < at; s++) {
      if (boundaryAt(text, s)) {
        start = s;
        break;
      }
    }
    const end = start === -1 ? -1 : addressEnd(text, at);
    if (end !== -1) {
      out.push(text.slice(start, end));
      from = end;
      at = text.indexOf('@', end);
    } else {
      at = text.indexOf('@', at + 1);
    }
  }
  return out.length ? out : null;
}
