/**
 * Readers for the small condition language agents and tools use, each
 * returning exactly what the regex it replaces captured.
 *
 * The regexes were
 *
 *   /^(!?)\s*(.+)\.(includes|startsWith|endsWith)\(\s*(.*?)\s*\)$/s
 *   /^(.+?)\s*(===?|!==?|>=?|<=?)\s*(.+)$/
 *   /^!?\s*.+\.\s*[A-Za-z_$][\w$]*\s*\(.*\)$/s
 *   /^data\.(.+?)\s*(===?|!==?)\s*(.+)$/
 *
 * and they ran on a condition node's expression after its {{...}}
 * references were filled in, which is text an upstream step (an LLM, a
 * tool, the person running the agent) chose. Their quantifiers overlap
 * (`\s*` next to `.+`), so a long run of spaces made the engine try
 * every way of sharing it out: 100 KB took ten seconds for a comparison
 * and did not finish in thirty for a method call.
 */

const SPACE = /\s/;

function isLineTerminator(ch: string): boolean {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
}

/** For each index, the first index at or after it that is not `\s` (or the length). */
function nextNonSpace(s: string): Int32Array {
  const out = new Int32Array(s.length + 1);
  out[s.length] = s.length;
  for (let i = s.length - 1; i >= 0; i--) out[i] = SPACE.test(s[i]) ? out[i + 1] : i;
  return out;
}

/** The comparison operators, in the order the regex alternation tries them. */
export const COMPARISON_OPERATORS = ['===', '==', '!==', '!=', '>=', '>', '<=', '<'] as const;
export const EQUALITY_OPERATORS = ['===', '==', '!==', '!='] as const;

/**
 * `^<prefix>(.+?)\s*(<operators>)\s*(.+)$` with no flags: the shortest
 * left side (which, like `.`, cannot cross a line break) followed by an
 * operator, and a right side that runs to the end without one.
 * Returns `[left, operator, right]` or null.
 */
export function matchComparison(
  s: string,
  operators: readonly string[] = COMPARISON_OPERATORS,
  prefix = '',
): [string, string, string] | null {
  if (!s.startsWith(prefix)) return null;
  const n = s.length;
  const skip = nextNonSpace(s);
  let lastBreak = -1;
  for (let i = 0; i < n; i++) if (isLineTerminator(s[i])) lastBreak = i;

  // `\s*(.+)$` from `from`: the spaces are greedy, but give one back when
  // nothing else is left for `.+`.
  const rightStart = (from: number): number => {
    const w = skip[from];
    if (w < n) return w > lastBreak ? w : -1;
    return n - 1 >= from && n - 1 > lastBreak ? n - 1 : -1;
  };

  for (let end = prefix.length + 1; end <= n; end++) {
    if (isLineTerminator(s[end - 1])) break;
    const at = skip[end];
    for (const op of operators) {
      if (!s.startsWith(op, at)) continue;
      const right = rightStart(at + op.length);
      if (right !== -1) return [s.slice(prefix.length, end), op, s.slice(right)];
    }
  }
  return null;
}

const METHOD_CALLS = ['includes', 'startsWith', 'endsWith'] as const;

/**
 * `^(!?)\s*(.+)\.(includes|startsWith|endsWith)\(\s*(.*?)\s*\)$` with
 * the `s` flag. Returns `[negate, receiver, method, argument]` or null.
 */
export function matchMethodCondition(s: string): [string, string, string, string] | null {
  const n = s.length;
  if (!s.endsWith(')')) return null;

  // `.+` is greedy, so the last call in the text is the one taken. Its `(`
  // cannot be the final character, which is the `)`.
  let call = -1;
  let method = '';
  for (const name of METHOD_CALLS) {
    const at = s.lastIndexOf(`.${name}(`);
    if (at > call) {
      call = at;
      method = name;
    }
  }
  if (call === -1) return null;
  const argument = s.slice(call + method.length + 2, n - 1).trim();

  // `(!?)` takes the `!` when it can; `\s*` takes every space it can while
  // leaving `.+` at least one character before the call.
  for (const start of s[0] === '!' ? [1, 0] : [0]) {
    let spaces = start;
    while (spaces < n && SPACE.test(s[spaces])) spaces++;
    const receiverStart = Math.min(spaces, call - 1);
    if (receiverStart >= start) {
      return [start === 1 ? '!' : '', s.slice(receiverStart, call), method, argument];
    }
  }
  return null;
}

const CALL_AFTER_DOT = /\.\s*[A-Za-z_$][\w$]*\s*\(/;

/**
 * `/^!?\s*.+\.\s*[A-Za-z_$][\w$]*\s*\(.*\)$/s.test(s)`: something, a dot,
 * a name, and a parenthesised argument list that closes the text. `.+`
 * can absorb the optional prefix, so the dot only has to come after the
 * first character.
 */
export function looksLikeMethodCall(s: string): boolean {
  return s.endsWith(')') && CALL_AFTER_DOT.test(s.slice(1));
}

/**
 * `/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/` capture 1: the path of an expression
 * that is a single `{{...}}` reference, or null.
 */
export function singleReference(expression: string): string | null {
  const t = expression.trim();
  if (t.length < 5 || !t.startsWith('{{') || !t.endsWith('}}')) return null;
  const inner = t.slice(2, -2);
  if (inner.includes('}')) return null;
  const path = inner.trim();
  // All spaces: the leading `\s*` gives one back so the path is not empty.
  return path || inner.slice(-1);
}
