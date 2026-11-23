/**
 * Linear versions of the security scanner's built-in checks that were
 * quadratic on the request bodies they scan.
 *
 *   /<script[^>]*>.*?<\/script>/gi   every `<script` looked for its `>`
 *   /<iframe[^>]*>.*?<\/iframe>/gi   and then a closing tag, to the end
 *   /on\w+\s*=/gi                    every `on` rescanned the word after it
 *   /\$\(.*\)/g                      every `$(` rescanned its line
 *
 * 100 KB of `on`, `$(` or `<script` in a body held the event loop for
 * half a second to three seconds, on every request the plugin sees. The
 * tag and `$(` matchers return what `text.match(regex)` returned (every
 * match, or null) and carry the regex's source, which threats report. The
 * event-handler matcher has since narrowed to an HTML context (below).
 */

export interface LinearMatcher {
  /** The regex this matcher stands in for, as `RegExp#toString()` printed it. */
  readonly pattern: string;
  match(text: string): string[] | null;
}

/** Case-folded for an ASCII pattern under `/i`, index for index. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function isLineTerminator(ch: string): boolean {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
}

/**
 * The next line terminator at or after `from`, or the length. Callers ask
 * with a `from` that never decreases, so the answer is cached and each
 * character is looked at once.
 */
function lineEnds(text: string): (from: number) => number {
  let end = -1;
  return (from) => {
    if (end >= from) return end;
    end = from;
    while (end < text.length && !isLineTerminator(text[end])) end++;
    return end;
  };
}

/**
 * `indexOf(needle, from)` for a `from` that never decreases: the last
 * answer stands until `from` passes it.
 */
function nextIndex(haystack: string, needle: string): (from: number) => number {
  let found = -2;
  return (from) => {
    if (found === -1 || found >= from) return found;
    found = haystack.indexOf(needle, from);
    return found;
  };
}

/** `/<tag[^>]*>.*?<\/tag>/gi` */
export function tagBlockMatcher(tag: string): LinearMatcher {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  return {
    pattern: `/<${tag}[^>]*>.*?<\\/${tag}>/gi`,
    match(text) {
      const lower = asciiLower(text);
      const nextGt = nextIndex(lower, '>');
      const nextClose = nextIndex(lower, close);
      const lineEnd = lineEnds(text);
      const out: string[] = [];
      let at = 0;
      for (;;) {
        const start = lower.indexOf(open, at);
        if (start === -1) break;
        // `[^>]*>` stops at the first `>`: a shorter run leaves a
        // character that is not `>` next.
        const gt = nextGt(start + open.length);
        if (gt === -1) break;
        // `.*?` then the closing tag, which has to start on the same line.
        const closeAt = nextClose(gt + 1);
        if (closeAt === -1) break;
        if (closeAt < lineEnd(gt + 1)) {
          out.push(text.slice(start, closeAt + close.length));
          at = closeAt + close.length;
        } else {
          at = start + 1;
        }
      }
      return out.length ? out : null;
    },
  };
}

const WORD = /[A-Za-z0-9_]/;
const SPACE = /\s/;
const TAG_NAME_START = /[A-Za-z]/;
const TAG_NAME = /[A-Za-z0-9-]/;

/** Whether the character at `i` follows an odd run of backslashes. */
function isEscaped(text: string, i: number): boolean {
  let n = 0;
  while (i - 1 - n >= 0 && text[i - 1 - n] === '\\') n++;
  return n % 2 === 1;
}

/**
 * How many characters of whitespace end at `p`: 1 for a space character,
 * 2 for a JSON escape (`\n`, `\r`, `\t`, `\f`) -- tool inputs are scanned
 * as JSON, where a newline is a backslash and an `n` -- otherwise 0. With
 * `horizontal`, only spaces and tabs count.
 */
function spaceWidth(text: string, p: number, horizontal = false): number {
  if (p < 0) return 0;
  const ch = text[p];
  if (horizontal ? ch === ' ' || ch === '\t' : SPACE.test(ch)) return 1;
  const escapes = horizontal ? 't' : 'nrtf';
  if (p >= 1 && escapes.includes(ch) && text[p - 1] === '\\' && !isEscaped(text, p - 1)) return 2;
  return 0;
}

/**
 * For each position, whether it is inside an open HTML tag: after `<`, a
 * tag name and a separator (`<img `, `<svg/`, `<svg\n`), before the next
 * `>`. One pass.
 */
function openTags(text: string): Uint8Array {
  const inTag = new Uint8Array(text.length + 1);
  let open = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '>') {
      open = false;
      i++;
      continue;
    }
    if (ch === '<' && i + 1 < text.length && TAG_NAME_START.test(text[i + 1])) {
      let j = i + 2;
      while (j < text.length && TAG_NAME.test(text[j])) j++;
      if (j < text.length && (SPACE.test(text[j]) || text[j] === '/' || text[j] === '\\')) open = true;
      inTag.fill(open ? 1 : 0, i, j);
      i = j;
      continue;
    }
    inTag[i] = open ? 1 : 0;
    i++;
  }
  return inTag;
}

/**
 * An HTML event-handler attribute, `on\w+\s*=`, where it can be one:
 *
 *   - inside a tag, after a separator: `<img src=x onerror=`, `<svg/onload=`,
 *     `<img src="x"onerror=`;
 *   - after a closing quote and a space, breaking out of an attribute value
 *     the input lands in: `x" onmouseover="`.
 *
 * As a bare `/on\w+\s*=/gi` it matched code: `region_rev = {}`,
 * `json_data =`, `con = ...` -- every word with `on` in it before an `=` --
 * and refused ordinary Python sent to a runner's shell tool as XSS.
 */
export const eventHandlerMatcher: LinearMatcher = {
  pattern: '/(<tag ...[\\s\\/"\']|["\'][ \\t]+)on\\w+\\s*=/gi',
  match(text) {
    const lower = asciiLower(text);
    let inTag: Uint8Array | null = null;
    const out: string[] = [];
    let at = 0;
    for (;;) {
      const start = lower.indexOf('on', at);
      if (start === -1) break;
      let wordEnd = start + 2;
      while (wordEnd < text.length && WORD.test(text[wordEnd])) wordEnd++;
      if (wordEnd === start + 2) {
        at = start + 1;
        continue;
      }
      let eq = wordEnd;
      while (eq < text.length && SPACE.test(text[eq])) eq++;
      if (text[eq] !== '=') {
        // Every `on` inside the same word ends at the same place and fails
        // the same way.
        at = wordEnd;
        continue;
      }
      const p = start - 1;
      const space = spaceWidth(text, p);
      const separated = space > 0 || text[p] === '/' || text[p] === '"' || text[p] === "'";
      let attribute = false;
      if (separated) {
        inTag ??= openTags(text);
        if (inTag[start]) {
          attribute = true;
        } else if (spaceWidth(text, p, true) > 0) {
          let q = p;
          for (let w = spaceWidth(text, q, true); w > 0; w = spaceWidth(text, q, true)) q -= w;
          attribute = text[q] === '"' || text[q] === "'";
        }
      }
      if (attribute) {
        out.push(text.slice(start, eq + 1));
        at = eq + 1;
      } else {
        // A later `on` inside this word has a word character before it.
        at = wordEnd;
      }
    }
    return out.length ? out : null;
  },
};

/** `/\$\(.*\)/g`: from `$(` to the last `)` on its line. */
export const commandSubstitutionMatcher: LinearMatcher = {
  pattern: '/\\$\\(.*\\)/g',
  match(text) {
    const lineEnd = lineEnds(text);
    const out: string[] = [];
    let at = 0;
    for (;;) {
      const start = text.indexOf('$(', at);
      if (start === -1) break;
      const end = lineEnd(start + 2);
      let paren = end - 1;
      while (paren >= start + 2 && text[paren] !== ')') paren--;
      if (paren >= start + 2) {
        out.push(text.slice(start, paren + 1));
        at = paren + 1;
      } else {
        // No `)` after this `$(` on the line, so none after a later one.
        at = end;
      }
    }
    return out.length ? out : null;
  },
};
