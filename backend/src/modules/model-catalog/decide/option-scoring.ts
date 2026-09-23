/**
 * Scoring one typed question's declared options from teacher-forced token
 * logprobs.
 *
 * This file is the arithmetic only. It takes logprobs that some provider
 * already produced for a caller-supplied continuation and turns them into a
 * distribution over the declared options. It talks to nothing, so it is the
 * one part of `decide` that can be tested without a provider at all.
 *
 * WHY FULL-SEQUENCE IS THE DEFAULT
 *
 * The obvious implementation reads the probability of the option's first
 * token in the answer slot: prefill up to `Answer: ` and look at what mass
 * sits on `A`, `B`, `C`. It is one number per option and it is wrong on
 * chat-tuned models.
 *
 * A chat model that has been told to answer with a letter still wants to
 * answer in prose, and the mass it puts on a first token is the mass it
 * would have spent starting a sentence with that token. `A` is the English
 * indefinite article, so "A phishing attempt that..." and "An attacker..."
 * both deposit probability on the same first token option `A` is claiming,
 * and option `A` wins ties it never earned. The bias is a property of the
 * letter, not of the answer, so it does not average out across questions,
 * and permuting the option order does not remove it: it follows whichever
 * option happens to be labelled `A`.
 *
 * Scoring the whole option string instead asks a different and better
 * question. Not "how likely is this token here" but "how likely is this
 * entire answer here". The prose continuation that inflated the first token
 * diverges from the option string immediately afterwards and the summed
 * logprob collapses, so the leak is paid back on the second token instead
 * of being counted as evidence.
 *
 * It also removes a restriction rather than adding one. First-token reading
 * requires every option id to be a single token in the serving tokenizer,
 * which is why option sets used to be letters. Sequence scoring has no such
 * requirement, so options can be the words a human would write.
 *
 * `first_token` stays implemented and selectable because it is the cheap
 * mode where a provider returns only the top-k alternatives at one
 * position, and because a mode nobody can reproduce is a mode nobody can
 * argue with. It is never the default, and the mode that ran is recorded in
 * the audit block as `serving_config.scoring`.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * Summed logprobs are not length-normalised. A short option accumulates
 * fewer negative terms than a long one, so an option set whose strings
 * differ wildly in length carries a length bias in the same way first-token
 * reading carries a letter bias. Dividing by the token count is one answer
 * and it is not obviously the right one, so this file computes the honest
 * sum, reports `tokenCount` per option beside it, and leaves the question
 * open rather than picking silently.
 *
 * See docs/design/layers.md, L3.
 */

/**
 * How an option's logprobs were read.
 *
 * Recorded on every decision in `audit.serving_config.scoring`, because two
 * runs of the same question under the two modes are not comparable and a
 * trace that does not say which one ran cannot be reconciled later.
 */
export type ScoringMode = 'sequence' | 'first_token';

export const DEFAULT_SCORING_MODE: ScoringMode = 'sequence';

/**
 * One option's teacher-forced logprobs, as an adapter produced them.
 *
 * `tokenLogprobs` are the per-token logprobs of the option's own
 * continuation tokens under the shared prefix, in order, natural log. The
 * prefix tokens are not included: only the tokens the option itself
 * contributes are scored, so two options sharing a prompt are comparable.
 */
export interface OptionLogprobs {
  optionId: string;
  tokenLogprobs: number[];
}

/** One option's place in the distribution. */
export interface OptionScore {
  optionId: string;
  /** Sum of the option's own token logprobs. Natural log, always <= 0. */
  sumLogprob: number;
  /** How many tokens that sum covers. Reported so length bias is visible. */
  tokenCount: number;
  /** Share of the mass, normalised over the declared options only. */
  probability: number;
}

export interface OptionScoringResult {
  mode: ScoringMode;
  scores: OptionScore[];
  /** The highest-probability option. */
  argmax: string;
  /** Shannon entropy of the distribution, in nats. */
  entropy: number;
}

export type OptionScoringErrorCode =
  | 'NO_OPTIONS'
  | 'EMPTY_OPTION'
  | 'DUPLICATE_OPTION'
  | 'NON_FINITE_LOGPROB';

export class OptionScoringError extends Error {
  constructor(message: string, readonly code: OptionScoringErrorCode) {
    super(message);
    this.name = 'OptionScoringError';
  }
}

/**
 * Reduce one option's token logprobs to the single number the mode scores
 * on.
 *
 * `sequence` sums every token. `first_token` reads only the first, which is
 * the mode this module exists to warn about.
 */
function reduceLogprobs(option: OptionLogprobs, mode: ScoringMode): number {
  if (mode === 'first_token') {
    return option.tokenLogprobs[0];
  }
  return option.tokenLogprobs.reduce((sum, lp) => sum + lp, 0);
}

/**
 * Turn per-option teacher-forced logprobs into a distribution over the
 * declared options.
 *
 * The normalisation is a softmax over the reduced scores, restricted to the
 * declared options by construction: everything the model might have said
 * that is not one of them contributes no mass at all. That restriction is
 * why the result is a distribution over *this question's* options rather
 * than a calibrated probability, and it is why `calibrated` is a separate
 * field on the answer that this function never sets.
 *
 * Subtracting the maximum before exponentiating is not a micro-optimisation.
 * A long option can sum to a few hundred negative nats, and `Math.exp(-800)`
 * is 0 in a double, so without it every option in a long set underflows to
 * zero and the normalisation divides by zero.
 */
export function scoreOptions(
  options: OptionLogprobs[],
  mode: ScoringMode = DEFAULT_SCORING_MODE,
): OptionScoringResult {
  if (options.length === 0) {
    throw new OptionScoringError('Cannot score an empty option set', 'NO_OPTIONS');
  }

  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.optionId)) {
      throw new OptionScoringError(
        `Option "${option.optionId}" appears twice in one question`,
        'DUPLICATE_OPTION',
      );
    }
    seen.add(option.optionId);

    if (option.tokenLogprobs.length === 0) {
      // An option that scored no tokens is a mapping failure in the adapter,
      // not an option with probability zero. Treating it as the latter would
      // let a tokenizer mismatch read as a confident answer.
      throw new OptionScoringError(
        `Option "${option.optionId}" scored no tokens`,
        'EMPTY_OPTION',
      );
    }

    for (const lp of option.tokenLogprobs) {
      if (!Number.isFinite(lp)) {
        throw new OptionScoringError(
          `Option "${option.optionId}" carries a non-finite logprob`,
          'NON_FINITE_LOGPROB',
        );
      }
    }
  }

  const reduced = options.map(option => ({
    optionId: option.optionId,
    sumLogprob: reduceLogprobs(option, mode),
    tokenCount: option.tokenLogprobs.length,
  }));

  const max = Math.max(...reduced.map(r => r.sumLogprob));
  const weights = reduced.map(r => Math.exp(r.sumLogprob - max));
  const total = weights.reduce((sum, w) => sum + w, 0);

  const scores: OptionScore[] = reduced.map((r, i) => ({
    optionId: r.optionId,
    sumLogprob: r.sumLogprob,
    tokenCount: r.tokenCount,
    probability: weights[i] / total,
  }));

  let argmax = scores[0];
  for (const score of scores) {
    if (score.probability > argmax.probability) {
      argmax = score;
    }
  }

  const entropy = scores.reduce(
    (sum, s) => (s.probability > 0 ? sum - s.probability * Math.log(s.probability) : sum),
    0,
  );

  return { mode, scores, argmax: argmax.optionId, entropy };
}
