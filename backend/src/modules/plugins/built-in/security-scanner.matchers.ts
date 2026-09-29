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
 * half a second to three seconds, on every request the plugin sees. Each
 * matcher returns what `text.match(regex)` returned (every match, or
 * null) and carries the regex's source, which threats report.
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

/** `/on\w+\s*=/gi` */
export const eventHandlerMatcher: LinearMatcher = {
  pattern: '/on\\w+\\s*=/gi',
  match(text) {
    const lower = asciiLower(text);
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
      if (text[eq] === '=') {
        out.push(text.slice(start, eq + 1));
        at = eq + 1;
      } else {
        // Every `on` inside the same word ends at the same place and fails
        // the same way; `\w+` giving characters back leaves a word
        // character next, which is neither space nor `=`.
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
