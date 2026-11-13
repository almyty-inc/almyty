/**
 * The marker on an answer whose check did not pass.
 *
 * An autonomous run with a verify panel on its final output has the
 * answer checked. By default the check only reports: a failed check does
 * not send the answer back, and the run completes with the answer as
 * written. With `verify.revise` on, the answer is revised until the
 * checkers pass it or the revisions run out, and then the last draft is
 * delivered. Either way it is delivered marked: one plain line above the
 * answer says the check did not pass and why, in short.
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

import { strongestFirst } from './checker-guards';

export const UNVERIFIED_ANSWER_LEAD = "Note: this answer's check didn't pass";

/**
 * The marker on an answer no checker could give a verdict on (the check
 * failed to run, or every reply was unreadable). Nothing was found wrong
 * with it; it was not checked, and it says that, not "didn't pass".
 */
export const UNCHECKED_ANSWER_LEAD = 'Note: this answer could not be checked';

/** How long one reason may be on the note, and how many the note names before "and N more". */
const MAX_REASON = 160;
const MAX_REASONS = 3;

type Failure = { rule?: unknown; evidence?: unknown; code?: unknown; kind?: unknown; instruction?: unknown } | null | undefined;

/** Whether these failures say no checker gave a verdict (agent-verifier.helper.ts mergeVerdicts). */
export function checkUnavailable(failures: Failure[] | null | undefined): boolean {
  const list = (failures ?? []).filter(Boolean);
  return list.length > 0 && list.every((f) => f?.code === 'verification_unavailable');
}

function oneReason(f: Failure): string {
  const r = trimTrailingDots(String(typeof f?.rule === 'string' ? f.rule : '').replace(/\s+/g, ' ').trim());
  return r.length > MAX_REASON ? `${r.slice(0, MAX_REASON - 1).trimEnd()}…` : r;
}

/**
 * What the note on the answer says is wrong: the verdict findings,
 * strongest first (a finding the platform made itself, then tool data a
 * checker cited and the code confirmed), each naming the item and what is
 * wrong with it, up to three and then how many more. A failure that is
 * only a rule a checker applied (`kind: 'rule'`), or whose reason is the
 * instruction it quotes, is never shown: a bare instruction says nothing
 * about what is wrong (run db52dcca). The evidence is left out on
 * purpose: it quotes what the checker read (tool results, documents),
 * which a visitor may not be meant to see. Checker notes are never here.
 */
export function unverifiedReason(failures: Failure[] | null | undefined): string {
  if (checkUnavailable(failures)) return 'the checker could not give a verdict';
  const shown = strongestFirst((failures ?? []).filter(Boolean))
    .filter((f) => f?.kind !== 'rule' && !(typeof f?.instruction === 'string' && f.instruction.trim() && f.instruction.trim() === String(f?.rule ?? '').trim()))
    .map(oneReason)
    .filter((r, i, all) => r.length > 0 && all.indexOf(r) === i);
  if (!shown.length) return 'the checkers found problems that were not fixed';
  const named = shown.slice(0, MAX_REASONS).join('; ');
  const more = shown.length - MAX_REASONS;
  return more > 0 ? `${named}; and ${more} more` : named;
}

/** Drop trailing dots and spaces without a backtracking regex. */
function trimTrailingDots(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '.' || text[end - 1] === ' ')) end -= 1;
  return text.slice(0, end);
}

/** The marker line for these failures. A reason cut short ends in "…" and takes no full stop after it. */
export function unverifiedLine(failures: Failure[] | null | undefined): string {
  const lead = checkUnavailable(failures) ? UNCHECKED_ANSWER_LEAD : UNVERIFIED_ANSWER_LEAD;
  const reason = unverifiedReason(failures);
  return `${lead}: ${reason}${/[.!?…]$/.test(reason) ? '' : '.'}`;
}

/** The answer with the marker line above it. Marking twice is a no-op. */
export function markUnverifiedAnswer(content: string, failures: Failure[] | null | undefined): string {
  const text = typeof content === 'string' ? content : '';
  if (text.startsWith(UNVERIFIED_ANSWER_LEAD) || text.startsWith(UNCHECKED_ANSWER_LEAD)) return text;
  const line = unverifiedLine(failures);
  return text.trim() ? `${line}\n\n${text}` : line;
}