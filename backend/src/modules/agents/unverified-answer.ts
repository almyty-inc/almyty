/**
 * The marker on an answer whose check did not pass.
 *
 * An autonomous run with a verify panel on its final output revises its
 * answer until the checkers pass it or the revisions run out. When they run
 * out, the run still completes with the last draft and that draft is
 * delivered. It is delivered marked: one plain line above the answer says
 * the check did not pass and why, in short.
 *
 * The marker is put on the answer itself, once, where the run completes
 * (agent-step-processor.ts): on `run.output` and on the assistant message
 * saved to the conversation. Every surface reads the finished answer from
 * one of those two -- a verify panel holds the streamed candidates back
 * (final-answer.ts withholdsCandidateAnswers), so hosted chat, the widget,
 * messaging channels, the API, the compat APIs and A2A all wait for the run
 * and read what it left -- so none of them can deliver it unmarked.
 * `unverified-answer-delivery.spec.ts` guards that.
 */

export const UNVERIFIED_ANSWER_LEAD = "Note: this answer's check didn't pass";

/**
 * The marker on an answer no checker could give a verdict on (the check
 * failed to run, or every reply was unreadable). Nothing was found wrong
 * with it; it was not checked, and it says that, not "didn't pass".
 */
export const UNCHECKED_ANSWER_LEAD = 'Note: this answer could not be checked';

const MAX_REASON = 160;

type Failure = { rule?: unknown; evidence?: unknown; code?: unknown } | null | undefined;

/** Whether these failures say no checker gave a verdict (agent-verifier.helper.ts mergeVerdicts). */
export function checkUnavailable(failures: Failure[] | null | undefined): boolean {
  const list = (failures ?? []).filter(Boolean);
  return list.length > 0 && list.every((f) => f?.code === 'verification_unavailable');
}

/**
 * The short reason: the first failed rule, one line. The evidence is left
 * out on purpose: it quotes what the checker read (tool results, documents),
 * which a visitor may not be meant to see.
 */
export function unverifiedReason(failures: Failure[] | null | undefined): string {
  if (checkUnavailable(failures)) return 'the checker could not give a verdict';
  const rule = (failures ?? [])
    .map((f) => (typeof f?.rule === 'string' ? f.rule : ''))
    .map((r) => trimTrailingDots(r.replace(/\s+/g, ' ').trim()))
    .find((r) => r.length > 0);
  if (!rule) return 'the checkers found problems that were not fixed';
  return rule.length > MAX_REASON ? `${rule.slice(0, MAX_REASON - 1).trimEnd()}…` : rule;
}

/** Drop trailing dots and spaces without a backtracking regex. */
function trimTrailingDots(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '.' || text[end - 1] === ' ')) end -= 1;
  return text.slice(0, end);
}

/** The marker line for these failures. */
export function unverifiedLine(failures: Failure[] | null | undefined): string {
  const lead = checkUnavailable(failures) ? UNCHECKED_ANSWER_LEAD : UNVERIFIED_ANSWER_LEAD;
  return `${lead}: ${unverifiedReason(failures)}.`;
}

/** The answer with the marker line above it. Marking twice is a no-op. */
export function markUnverifiedAnswer(content: string, failures: Failure[] | null | undefined): string {
  const text = typeof content === 'string' ? content : '';
  if (text.startsWith(UNVERIFIED_ANSWER_LEAD) || text.startsWith(UNCHECKED_ANSWER_LEAD)) return text;
  const line = unverifiedLine(failures);
  return text.trim() ? `${line}\n\n${text}` : line;
}