import { RouteAttribution } from '../routing/model-router.service';
import { ScoringMode } from './option-scoring';

/**
 * The `decide` contract.
 *
 * `decide` is the second way to invoke a model. `generate` asks for a
 * continuation and gets prose back; `decide` asks a typed question over a
 * declared option set and gets a distribution back. The difference that
 * matters is not the shape of the answer, it is that a distribution can be
 * thresholded, audited and later scored against what actually happened,
 * and a paragraph cannot.
 *
 * Three rules from the contract are enforced here in the TYPES rather than
 * in documentation, because every one of them is a claim about confidence
 * that a caller could otherwise make by accident:
 *
 *  1. An `abstain` option is mandatory on every choice question. A forced
 *     choice over options that do not contain the truth is not an answer,
 *     it is the highest-scoring wrong option, and nothing downstream can
 *     tell the two apart. `validateQuestion` refuses a choice question
 *     without one.
 *  2. `conditional_scores` and `calibrated` are different claims and are
 *     different fields. Scores that order the options correctly are not
 *     probabilities that mean anything on their own.
 *  3. `confidence` exists only when `calibrated` is true. This is why the
 *     answer is a discriminated union rather than an interface with two
 *     optional fields: reading `answer.confidence` off an uncalibrated
 *     answer is a compile error, not a runtime surprise, and the UI says
 *     "score" instead.
 *
 * See docs/design/layers.md, L3.
 */

/** Which kind of question is being asked. */
export type DecideQuestionType = 'choice' | 'score' | 'boolean';

/**
 * How the option order is varied across the calls that make one answer.
 *
 * Position in the prompt moves a model's answer on its own, so the order
 * the options happen to be written in is a confound. `permute2` asks twice
 * with the order reversed and merges by option id.
 */
export type DecideOrderPolicy = 'asis' | 'permute2' | 'prior_debias';

/**
 * How the distribution was obtained. Ordered by how much the number can be
 * trusted, which is also the order of the fallback ladder.
 *
 * - `native`: the model returns option probabilities directly.
 * - `logits`: a teacher-forced continuation is scored per token and the
 *   softmax is restricted to the declared options.
 * - `constrained`: the model is made to emit schema-shaped JSON and says a
 *   number in words. Nothing about it is a probability, so this path is
 *   always `calibrated: false`.
 */
export type DecideExecutionPath = 'native' | 'logits' | 'constrained';

export interface DecideOption {
  id: string;
  description?: string;
  /**
   * Marks the option that means "the state does not answer this". Exactly
   * one option per choice question carries it.
   */
  abstain?: boolean;
}

export interface DecideQuestion {
  id: string;
  type: DecideQuestionType;
  prompt: string;
  /** Options for `choice`, ordered levels for `score`, absent for `boolean`. */
  options?: DecideOption[];
  /** Optional per-question model or role selection, e.g. `roleKey:router`. */
  model?: string;
  optionsOrderPolicy?: DecideOrderPolicy;
}

export interface DecideServing {
  temperature?: number;
  seed?: number;
  /**
   * Which scoring mode the logits path should use. Omitted means
   * `sequence`, and a caller has to ask for `first_token` by name.
   */
  scoring?: ScoringMode;
}

export interface DecideReturn {
  distribution?: boolean;
  /** Above zero, the question is asked repeatedly and the spread reported. */
  agreementSamples?: number;
}

export interface DecideRequest {
  state: string | Record<string, unknown> | unknown[];
  questions: DecideQuestion[];
  serving?: DecideServing;
  return?: DecideReturn;
  /**
   * Which execution path the caller insists on. Absent means the ladder
   * picks. Pinning `logits` against a route that cannot score is refused
   * naming the provider rather than quietly served by `constrained`: a
   * caller who asked for a scored answer and got a verbalized one has no
   * way to tell from the number.
   */
  requirePath?: DecideExecutionPath;
}

/**
 * The half of an answer that carries the confidence claim.
 *
 * Split into a union so the impossible combination cannot be constructed.
 * An uncalibrated answer has no `confidence` field at all, so a caller who
 * wants to show one has to narrow on `calibrated` first and handle the
 * other branch.
 */
export type DecideCalibration =
  | {
      calibrated: true;
      /** Only meaningful because a fitted calibrator was applied. */
      confidence: number;
      conditionalScores: false;
    }
  | {
      calibrated: false;
      /** True when the numbers order the options but mean nothing absolutely. */
      conditionalScores: boolean;
    };

export type DecideAnswer = DecideCalibration & {
  type: DecideQuestionType;
  argmax: string;
  distribution?: Record<string, number>;
  /** Shannon entropy of the distribution, in nats. */
  entropy: number;
  /** Set when `agreementSamples` was above zero, otherwise null. */
  agreement: number | null;
};

export interface DecideServingConfig {
  temperature: number;
  seed?: number;
  dtype?: string;
  batchShape?: string;
  /**
   * Which reading produced the numbers, absent when none did.
   *
   * Two runs of one question under the two modes are not comparable, so a
   * trace that does not say which one ran cannot be reconciled against an
   * outcome later. Absent is a real answer rather than a gap: the
   * constrained path reads no logits at all, and recording a mode there
   * would assert a measurement that never happened, which is the exact
   * confusion this field exists to prevent.
   */
  scoring?: ScoringMode;
}

export interface DecideAudit {
  provider: string;
  modelRevision: string;
  promptHash: string;
  /** The order the options were actually presented in. */
  optionOrder: string[];
  servingConfig: DecideServingConfig;
  latencyMs: number;
  tokens: { input: number; output: number };
}

export interface DecideResponse {
  model: string;
  executionPath: DecideExecutionPath;
  answers: Record<string, DecideAnswer>;
  audit: DecideAudit;
  /**
   * Present when the catalog router chose the model, exactly as on a
   * `generate` call. `decide` is an invocation mode, not a second routing
   * system, so it stamps the same attribution on the response, the node
   * result and the audit log.
   */
  routing?: RouteAttribution;
}

export type DecideValidationCode =
  | 'NO_QUESTIONS'
  | 'DUPLICATE_QUESTION_ID'
  | 'NO_OPTIONS'
  | 'DUPLICATE_OPTION_ID'
  | 'ABSTAIN_MISSING'
  | 'ABSTAIN_AMBIGUOUS'
  | 'BOOLEAN_HAS_OPTIONS';

export class DecideValidationError extends Error {
  constructor(message: string, readonly code: DecideValidationCode) {
    super(message);
    this.name = 'DecideValidationError';
  }
}

/**
 * The option a below-threshold or unanswerable question resolves to.
 *
 * Every choice question has one by construction, which is what lets a
 * threshold be applied at all: without it there is no edge to send a
 * low-confidence answer down and the caller is forced to act on a guess.
 */
export function abstainOptionOf(question: DecideQuestion): DecideOption | null {
  return question.options?.find(option => option.abstain === true) ?? null;
}

/**
 * Refuse a question that cannot produce an honest answer, before any model
 * is called.
 *
 * These are contract rules rather than input hygiene, so they are refused
 * here rather than being left to whichever adapter runs.
 */
export function validateQuestion(question: DecideQuestion): void {
  if (question.type === 'boolean') {
    if (question.options && question.options.length > 0) {
      throw new DecideValidationError(
        `Question "${question.id}" is boolean and cannot declare options`,
        'BOOLEAN_HAS_OPTIONS',
      );
    }
    return;
  }

  const options = question.options ?? [];
  if (options.length === 0) {
    throw new DecideValidationError(
      `Question "${question.id}" declares no options`,
      'NO_OPTIONS',
    );
  }

  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.id)) {
      throw new DecideValidationError(
        `Question "${question.id}" declares option "${option.id}" twice`,
        'DUPLICATE_OPTION_ID',
      );
    }
    seen.add(option.id);
  }

  const abstains = options.filter(option => option.abstain === true);
  if (abstains.length === 0) {
    // The rule the whole contract rests on. A choice question without an
    // escape hatch cannot answer "the state does not say", so it answers
    // with the best-scoring wrong option instead and nothing downstream
    // can tell that apart from a real answer.
    throw new DecideValidationError(
      `Question "${question.id}" has no abstain option; every choice question needs one`,
      'ABSTAIN_MISSING',
    );
  }
  if (abstains.length > 1) {
    throw new DecideValidationError(
      `Question "${question.id}" marks ${abstains.length} options as abstain; exactly one is allowed`,
      'ABSTAIN_AMBIGUOUS',
    );
  }
}

export function validateDecideRequest(request: DecideRequest): void {
  if (!request.questions || request.questions.length === 0) {
    throw new DecideValidationError('A decide request asks at least one question', 'NO_QUESTIONS');
  }

  const seen = new Set<string>();
  for (const question of request.questions) {
    if (seen.has(question.id)) {
      throw new DecideValidationError(
        `Question id "${question.id}" appears twice; answers are keyed by id`,
        'DUPLICATE_QUESTION_ID',
      );
    }
    seen.add(question.id);
    validateQuestion(question);
  }
}
