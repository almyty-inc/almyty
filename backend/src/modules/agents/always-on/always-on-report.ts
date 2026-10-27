/**
 * "When it has something to tell you" (report: 'when_news'): an always-on
 * wake is reported only when its answer carries something for the owner.
 *
 * The agent is told, in its system prompt and in every wake message, to
 * answer with NOTHING_TO_REPORT and nothing else when nothing needs the
 * owner. That marker, or an empty answer, is a quiet wake: nothing is
 * posted and nobody is notified. Anything else is news. Deciding on an
 * explicit marker rather than on how the words read keeps a short real
 * finding ("Invoice 1042 is overdue") from being taken for small talk.
 */

/** What the agent answers when nothing needs its owner. */
export const NOTHING_TO_REPORT = 'NOTHING_TO_REPORT';

/** The rule the agent reads, in its system prompt and at the end of every wake message. */
export const REPORT_RULE =
  'When you finish, answer with what your owner should know: what you found, what you did, and any question for them. ' +
  `If nothing needs your owner, answer with exactly ${NOTHING_TO_REPORT} and nothing else.`;

/** What people read in place of the marker, where a post goes out anyway (after every wake, a reply to the owner). */
export const NOTHING_TO_REPORT_WORDS = 'Nothing to report right now.';

/** A word with the quoting, emphasis and punctuation around it taken off: "**NOTHING_TO_REPORT**." reads as the marker. */
function bare(word: string): string {
  let start = 0;
  let end = word.length;
  const edge = (c: string) => !/[A-Za-z0-9]/.test(c);
  while (start < end && edge(word[start])) start++;
  while (end > start && edge(word[end - 1])) end--;
  return word.slice(start, end);
}

function isMarker(word: string): boolean {
  return bare(word).toUpperCase() === NOTHING_TO_REPORT;
}

const TEXT_KEYS = ['text', 'output', 'answer', 'content', 'message', 'response'] as const;

/** The key an object answer carries its text under, if any. */
function textKey(o: Record<string, unknown>): string | null {
  for (const key of TEXT_KEYS) if (typeof o[key] === 'string') return key;
  return null;
}

/** The text of a run's answer: a string, or the usual text field of an object. */
export function answerText(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object') {
    const key = textKey(output as Record<string, unknown>);
    if (key) return (output as Record<string, string>)[key];
  }
  return '';
}

/**
 * The text with every marker taken out: a line that held only the marker
 * goes, and a line that held it beside words keeps the words.
 */
export function withoutMarker(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const words = line.split(' ');
    if (!words.some(isMarker)) {
      out.push(line.trimEnd());
      continue;
    }
    const kept = words.filter((w) => !isMarker(w)).join(' ').trim();
    if (/[\p{L}\p{N}]/u.test(kept)) out.push(kept);
  }
  return out.join('\n').replace(/\n\n\n+/g, '\n\n').trim();
}

/** Nothing but the marker, whitespace, punctuation and markdown. */
function quiet(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(withoutMarker(text));
}

/**
 * Whether a wake's answer has something for the owner. Quiet only when it
 * is empty or is just the marker (give or take whitespace, punctuation and
 * markdown). The marker beside real words does not silence them: those
 * words are the news, and the marker is taken out of what is posted.
 * An object answer with no text field is structured content, so news.
 */
export function hasNews(output: unknown): boolean {
  if (output == null) return false;
  if (typeof output === 'string') return !quiet(output);
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>;
    const key = textKey(o);
    return key ? !quiet(o[key] as string) : Object.keys(o).length > 0;
  }
  return true;
}

/**
 * The answer as people read it: a quiet one becomes a plain sentence
 * (where a post goes out anyway: after every wake, a reply to the owner),
 * and a marker beside real words is taken out.
 */
export function forPeople(output: unknown): unknown {
  if (!hasNews(output)) return NOTHING_TO_REPORT_WORDS;
  if (typeof output === 'string') return withoutMarker(output);
  if (output && typeof output === 'object') {
    const key = textKey(output as Record<string, unknown>);
    if (key) return { ...(output as Record<string, unknown>), [key]: withoutMarker((output as Record<string, string>)[key]) };
  }
  return output;
}
