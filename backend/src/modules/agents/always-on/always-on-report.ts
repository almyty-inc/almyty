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

/** A line that is the marker, give or take quoting, emphasis and a full stop. */
const MARKER_LINE = new RegExp(`^[\\s\`*_"'(\\[]*${NOTHING_TO_REPORT}[\\s\`*_"'.!)\\]]*$`, 'i');

/** The text of a run's answer: a string, or the usual text field of an object. */
export function answerText(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>;
    for (const key of ['text', 'output', 'answer', 'content', 'message', 'response']) {
      if (typeof o[key] === 'string') return o[key] as string;
    }
  }
  return '';
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Whether a wake's answer has something for the owner: not empty, and not
 * the marker. The marker counts on the first or the last line, so an
 * answer that walks through its checks and ends on the marker is quiet.
 */
export function hasNews(output: unknown): boolean {
  const lines = nonEmptyLines(answerText(output));
  if (!lines.length) return false;
  return !MARKER_LINE.test(lines[0]) && !MARKER_LINE.test(lines[lines.length - 1]);
}

/**
 * The answer as people read it where it is posted anyway (after every
 * wake, a reply to the owner): the marker becomes a plain sentence.
 * Anything else is passed through as it is, object answers included.
 */
export function forPeople(output: unknown): unknown {
  return hasNews(output) ? output : NOTHING_TO_REPORT_WORDS;
}
