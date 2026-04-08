/**
 * Shared defenses against ReDoS from user-supplied regex patterns.
 *
 * We don't ship re2 and we don't run pattern matching in a sandboxed
 * worker with a timeout, so the defense has to be static. Two codepaths
 * currently accept regexes from user input:
 *
 *   - gateway-auth.service.ts: admin-supplied `keyFormat` validation
 *     rule on API key gateways.
 *   - plugins/built-in/pii-filter.plugin.ts: admin-supplied
 *     `customPatterns` list.
 *
 * Both are reachable by a single tenant admin and both run on every
 * authenticated request to the affected surface, so a pathological
 * `(a+)+$` pattern would block the Node event loop for seconds to
 * minutes on every hit and starve every other request on the instance.
 *
 * The safest cheap defense is to refuse obviously-dangerous patterns
 * up front, cap the source length, and cap the input length we probe
 * against. All three need to live in one place so neither caller
 * drifts from the other.
 */

/** Default hard cap on user-supplied regex source length. */
export const DEFAULT_PATTERN_MAX_LENGTH = 512;

/** Default hard cap on the input we feed the regex engine. */
export const DEFAULT_INPUT_MAX_LENGTH = 2048;

/**
 * Heuristic catastrophic-backtracking detector. Intentionally over-eager:
 * a legitimate pattern that trips this check just needs to be rewritten
 * more carefully, and the failure mode for a false positive ("admin
 * picks a different regex") is strictly better than a false negative
 * ("admin takes the platform down").
 *
 * Catches the textbook ReDoS shapes:
 *
 *   (x+)+, (x*)*, (x+)*, (x*)+, (x?)+, (x+)?+
 *   (x{m,n})+, (x+){m,n}, etc.
 *   (a|a)+, (a|ab)+, (ab|a)+  — alternation with overlap
 *
 * Returns true when the pattern looks unsafe.
 */
export function isLikelyCatastrophicRegex(pattern: string): boolean {
  // 1. Any parenthesised group whose body contains a quantifier and
  // which is itself followed by a quantifier. Works across character
  // classes because JS regex `.` doesn't match newlines by default —
  // we explicitly use non-capturing non-greedy inside to keep the
  // check short-circuited. The non-greedy body avoids matching across
  // unrelated groups.
  if (/\(([^()]*[+*?][^()]*|[^()]*\{\d+,?\d*\}[^()]*)\)[+*?{]/.test(pattern)) {
    return true;
  }

  // 2. Alternation inside a quantified group with obviously-overlapping
  // branches (same literal on both sides, or a prefix relationship).
  // Catches the simplest cases: `(a|a)`, `(a|ab)`, `(ab|a)` when
  // followed by +/*/?.
  const altGroup = /\(([^()|]+)\|([^()|]+)\)[+*?]/;
  const m = pattern.match(altGroup);
  if (m) {
    const a = m[1];
    const b = m[2];
    if (a === b || a.startsWith(b) || b.startsWith(a)) {
      return true;
    }
  }

  return false;
}

export interface SafeRegexOptions {
  /** Hard cap on the pattern source length (default 512). */
  maxPatternLength?: number;
  /** Hard cap on the input string length when probing (default 2048). */
  maxInputLength?: number;
  /** Extra flags to pass to the RegExp constructor. */
  flags?: string;
}

export interface SafeRegexCompileResult {
  /** Null when the pattern was refused — safe to treat as "no match". */
  regex: RegExp | null;
  /** Short human-readable reason, only set on refusal. */
  reason?: string;
}

/**
 * Compile a user-supplied regex pattern for safe use against untrusted
 * input. Returns `{regex: null, reason}` when the pattern is refused
 * for any reason — callers should treat that as "no match" rather than
 * throwing, so a bad pattern degrades gracefully instead of crashing
 * the request.
 */
export function compileSafeRegex(
  pattern: string,
  options: SafeRegexOptions = {},
): SafeRegexCompileResult {
  const maxLen = options.maxPatternLength ?? DEFAULT_PATTERN_MAX_LENGTH;

  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { regex: null, reason: 'empty pattern' };
  }
  if (pattern.length > maxLen) {
    return { regex: null, reason: `pattern exceeds ${maxLen} chars` };
  }
  if (isLikelyCatastrophicRegex(pattern)) {
    return { regex: null, reason: 'pattern matches a known ReDoS shape' };
  }
  try {
    return { regex: new RegExp(pattern, options.flags) };
  } catch (err: any) {
    return { regex: null, reason: `invalid pattern: ${err.message}` };
  }
}

/**
 * Truncate an input string to the engine-input cap before handing it
 * to a regex. Bounded input keeps even a pattern that slipped through
 * `compileSafeRegex` polynomial in a fixed constant instead of
 * unbounded.
 */
export function boundRegexInput(input: string, maxInputLength?: number): string {
  const cap = maxInputLength ?? DEFAULT_INPUT_MAX_LENGTH;
  return input.length > cap ? input.slice(0, cap) : input;
}
