import { stoppedAtOutputLimit } from '../llm-providers/output-limit';

/**
 * A reply that ends an autonomous run's loop (no tool calls) but holds no
 * answer: it is empty, or it stopped at its output limit before it was
 * done. Such a reply is never the run's answer. The model is asked again,
 * up to NO_ANSWER_RETRIES times within the run's limits, and a run that
 * still has no answer fails with the reason, instead of completing with an
 * empty answer that no check looked at (model comparison 2026-11-13: 6 of
 * 10 Claude runs "completed" empty at a 1024-token limit).
 */
export type NoAnswerKind = 'output_limit' | 'empty';

/** How many times the model is asked again for an answer. */
export const NO_ANSWER_RETRIES = 2;

/** The reason a person reads, on the step and on the failed run. */
export const NO_ANSWER_REASONS: Record<NoAnswerKind, string> = {
  output_limit: 'the model stopped at its output limit before answering',
  empty: 'the model returned an empty answer',
};

/** The code on the failed run's event and metadata. */
export const NO_ANSWER_CODES: Record<NoAnswerKind, string> = {
  output_limit: 'NO_ANSWER_OUTPUT_LIMIT',
  empty: 'NO_ANSWER_EMPTY',
};

/** Whether a final reply holds no answer, and why. Null for a reply that is an answer. */
export function noAnswerOf(message: { content?: string | null; finishReason?: string | null }): NoAnswerKind | null {
  if (stoppedAtOutputLimit(message.finishReason)) return 'output_limit';
  if (!(message.content ?? '').trim()) return 'empty';
  return null;
}

/** What the model is told when it is asked again. */
export function noAnswerNudge(kind: NoAnswerKind): string {
  return kind === 'output_limit'
    ? 'Your last reply reached the output limit before it was finished, so nobody received it. ' +
        'Write your final answer now, complete but more concise. Do not repeat tool calls you have already made.'
    : 'Your last reply was empty, so nobody received an answer. Write your final answer now. ' +
        'Do not repeat tool calls you have already made.';
}

/** The run's error when it ends without an answer. */
export function noAnswerError(kind: NoAnswerKind): string {
  const reason = NO_ANSWER_REASONS[kind];
  return `No answer: ${reason}.`;
}
