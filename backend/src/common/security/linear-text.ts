/**
 * One-pass versions of the `{...}` / `{{...}}` regexes, which are
 * quadratic on input anyone can send.
 *
 * `/\{([^}]+)\}/g` looks harmless, but the engine retries it from every
 * `{`: on 100 KB of `{` with no `}` each start scans to the end, which
 * held the event loop for five seconds. These helpers give the same
 * result as the regex they are named after, in a single pass.
 *
 * A trailing-run trim such as `/(?<!\/)\/+$/` has the same problem on a long
 * run that does not end the string; there the fix is the lookbehind
 * form `/(?<!\/)\/+$/`, which can only start at the first character of
 * a run. eslint-plugin-regexp (no-super-linear-move and
 * no-super-linear-backtracking) rejects the slow forms in CI.
 */

interface DelimitedSpan {
  start: number;
  end: number;
  body: string;
}

/**
 * The spans `/<open>([^<close[0]>]+)<close>/g` matches, left to right.
 *
 * The body is the text up to the first `close[0]`, so a start whose
 * first `close[0]` is not followed by the rest of `close` fails, and so
 * does every later start before that character: the scan resumes past
 * it instead of rescanning. With no `close[0]` left, nothing later can
 * match either, which is where the regex spent its time.
 */
function delimitedSpans(value: string, open: string, close: string, limit = Infinity): DelimitedSpan[] {
  const spans: DelimitedSpan[] = [];
  const stop = close[0];
  let at = 0;
  while (spans.length < limit) {
    const start = value.indexOf(open, at);
    if (start === -1) break;
    const bodyStart = start + open.length;
    const first = value.indexOf(stop, bodyStart);
    if (first === -1) break;
    if (first === bodyStart) {
      at = start + 1;
      continue;
    }
    if (!value.startsWith(close, first)) {
      at = first;
      continue;
    }
    spans.push({ start, end: first + close.length, body: value.slice(bodyStart, first) });
    at = first + close.length;
  }
  return spans;
}

/**
 * `value.replace(/<open>([^<close[0]>]+)<close>/g, replacer)`, e.g.
 * `replaceDelimited(t, '{{', '}}', (whole, path) => ...)` for
 * `t.replace(/\{\{([^}]+)\}\}/g, ...)`.
 */
export function replaceDelimited(
  value: string,
  open: string,
  close: string,
  replacer: (whole: string, body: string) => string,
): string {
  let out = '';
  let kept = 0;
  for (const span of delimitedSpans(value, open, close)) {
    out += value.slice(kept, span.start) + replacer(value.slice(span.start, span.end), span.body);
    kept = span.end;
  }
  return kept === 0 ? value : out + value.slice(kept);
}

/** `value.match(/<open>[^<close[0]>]+<close>/g) ?? []`: every whole span. */
export function matchDelimited(value: string, open: string, close: string): string[] {
  return delimitedSpans(value, open, close).map((span) => value.slice(span.start, span.end));
}

/** `/<open>[^<close[0]>]+<close>/.test(value)`. */
export function hasDelimited(value: string, open: string, close: string): boolean {
  return delimitedSpans(value, open, close, 1).length > 0;
}
