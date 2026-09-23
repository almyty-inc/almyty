import {
  DEFAULT_SCORING_MODE,
  OptionLogprobs,
  OptionScoringError,
  scoreOptions,
} from '../option-scoring';

/**
 * The fixture this file is built around.
 *
 * An inbound-email triage question, the shape a security team actually
 * writes: four lettered options, one of which is the abstain the contract
 * makes mandatory. The mail is a routine vendor invoice, so the correct
 * answer is B.
 *
 * The numbers are the point. They encode a model that has read the mail
 * correctly and wants to say so in prose: its preferred continuation is
 * "A routine vendor invoice, nothing suspicious." That sentence begins with
 * the English indefinite article, so almost all the mass at the first
 * position sits on the token `A` — and `A` is also the id of the option
 * that says the mail is phishing, which is the answer the model does not
 * believe.
 *
 * Read down the first column and option A looks like a confident answer.
 * Read the whole row and it falls apart on the second token, because the
 * model never wanted to say ") Phishing attempt" after that `A`. That gap
 * between the two readings is the entire reason the default is
 * full-sequence scoring, and it is what this file exists to hold in place.
 */
const EMAIL_TRIAGE: OptionLogprobs[] = [
  {
    // "A) Phishing attempt". The leading `A` is cheap because the model was
    // about to begin a sentence with it; everything after it is expensive.
    optionId: 'A',
    tokenLogprobs: [-0.21, -3.1, -4.6, -0.05, -2.8],
  },
  {
    // "B) Legitimate vendor invoice". The leading `B` costs real probability
    // because no English sentence starts with it, and the rest is nearly
    // free because it is what the model meant.
    optionId: 'B',
    tokenLogprobs: [-2.35, -0.12, -0.44, -0.18, -0.06],
  },
  {
    // "C) Internal announcement".
    optionId: 'C',
    tokenLogprobs: [-3.8, -0.15, -2.95, -1.1],
  },
  {
    // "D) Insufficient information" — the mandatory abstain.
    optionId: 'D',
    tokenLogprobs: [-4.1, -0.14, -3.3, -0.2],
  },
];

function probabilityOf(result: ReturnType<typeof scoreOptions>, optionId: string): number {
  const score = result.scores.find(s => s.optionId === optionId);
  if (!score) {
    throw new Error(`No score for option ${optionId}`);
  }
  return score.probability;
}

describe('option scoring: an option id that is also a sentence opener', () => {
  it('does not favour option A, whose id is the English indefinite article', () => {
    const result = scoreOptions(EMAIL_TRIAGE);

    expect(result.argmax).toBe('B');

    // Not merely "not the winner": the option the first token flattered has
    // to come last, because scoring the whole string is what reveals that
    // the model was going to say something else entirely.
    const ranked = [...result.scores].sort((a, b) => b.probability - a.probability);
    expect(ranked.map(s => s.optionId)).toEqual(['B', 'D', 'C', 'A']);
    expect(probabilityOf(result, 'A')).toBeLessThan(0.01);
  });

  it('reads the same fixture the other way round under first_token, which is the bias', () => {
    // This is the control. If both modes agreed on this fixture the test
    // above would prove nothing, so the failure mode being guarded against
    // is demonstrated rather than asserted.
    const biased = scoreOptions(EMAIL_TRIAGE, 'first_token');

    expect(biased.argmax).toBe('A');
    expect(probabilityOf(biased, 'A')).toBeGreaterThan(0.8);
  });

  it('defaults to sequence, so nobody gets the biased reading by omission', () => {
    expect(DEFAULT_SCORING_MODE).toBe('sequence');
    expect(scoreOptions(EMAIL_TRIAGE).mode).toBe('sequence');
    expect(scoreOptions(EMAIL_TRIAGE).argmax).toBe(scoreOptions(EMAIL_TRIAGE, 'sequence').argmax);
  });

  it('reports the mode that ran, for the audit block', () => {
    expect(scoreOptions(EMAIL_TRIAGE).mode).toBe('sequence');
    expect(scoreOptions(EMAIL_TRIAGE, 'first_token').mode).toBe('first_token');
  });
});

describe('option scoring: option ids are not restricted to one token', () => {
  // Reading the first token only works when every option id is a single
  // token in the serving tokenizer, which is why option sets used to be
  // letters at all. Scoring the whole string lifts that, so an option can
  // be the word a human would have written.
  const TICKET_ROUTING: OptionLogprobs[] = [
    { optionId: 'billing', tokenLogprobs: [-2.9, -3.4] },
    { optionId: 'technical', tokenLogprobs: [-0.31, -0.12, -0.08] },
    { optionId: 'abstain', tokenLogprobs: [-4.2, -2.6] },
  ];

  it('scores multi-token ids and picks the option the model meant', () => {
    const result = scoreOptions(TICKET_ROUTING);

    expect(result.argmax).toBe('technical');
    expect(result.scores.map(s => s.tokenCount)).toEqual([2, 3, 2]);
  });

  it('reports the token count beside the sum, so length bias stays visible', () => {
    const result = scoreOptions(TICKET_ROUTING);
    const technical = result.scores.find(s => s.optionId === 'technical')!;

    // The sum is the honest sum. It is not divided by tokenCount, and the
    // count is carried so a caller can see that a three-token option paid
    // three penalties where a two-token option paid two.
    expect(technical.sumLogprob).toBeCloseTo(-0.51, 10);
    expect(technical.tokenCount).toBe(3);
  });
});

describe('option scoring: the distribution', () => {
  it('normalises over the declared options and nothing else', () => {
    const result = scoreOptions(EMAIL_TRIAGE);
    const total = result.scores.reduce((sum, s) => sum + s.probability, 0);

    expect(total).toBeCloseTo(1, 10);
    expect(result.scores).toHaveLength(EMAIL_TRIAGE.length);
  });

  it('does not depend on the order the options arrive in', () => {
    // Each option is scored against the shared prefix on its own, so
    // reversing the set cannot move any option's probability. Position bias
    // in `decide` comes from the prompt, which permute2 answers; it must
    // not also come from the arithmetic.
    const forward = scoreOptions(EMAIL_TRIAGE);
    const reversed = scoreOptions([...EMAIL_TRIAGE].reverse());

    expect(reversed.argmax).toBe(forward.argmax);
    for (const option of EMAIL_TRIAGE) {
      expect(probabilityOf(reversed, option.optionId)).toBeCloseTo(
        probabilityOf(forward, option.optionId),
        12,
      );
    }
  });

  it('survives options long enough to underflow a naive exponential', () => {
    // A full-sentence option can sum to several hundred negative nats.
    // Exponentiating that directly gives 0 in a double, and four zeroes
    // normalise to NaN, so a long option set would answer NaN rather than
    // fail. The max is subtracted first to keep that from happening.
    const long: OptionLogprobs[] = [
      { optionId: 'long-a', tokenLogprobs: new Array(400).fill(-2) },
      { optionId: 'long-b', tokenLogprobs: new Array(400).fill(-2.1) },
    ];

    const result = scoreOptions(long);

    expect(result.argmax).toBe('long-a');
    expect(Number.isFinite(result.scores[0].probability)).toBe(true);
    expect(result.scores.reduce((sum, s) => sum + s.probability, 0)).toBeCloseTo(1, 10);
  });

  it('reports entropy, which a low-information answer drives up', () => {
    const decisive = scoreOptions(EMAIL_TRIAGE);
    const flat = scoreOptions([
      { optionId: 'A', tokenLogprobs: [-1] },
      { optionId: 'B', tokenLogprobs: [-1] },
      { optionId: 'C', tokenLogprobs: [-1] },
      { optionId: 'D', tokenLogprobs: [-1] },
    ]);

    expect(flat.entropy).toBeCloseTo(Math.log(4), 10);
    expect(decisive.entropy).toBeLessThan(flat.entropy);
  });
});

describe('option scoring: refusals', () => {
  it('refuses an empty option set', () => {
    expect(() => scoreOptions([])).toThrow(OptionScoringError);
    expect(() => scoreOptions([])).toThrow(/empty option set/);
  });

  it('refuses an option that scored no tokens rather than calling it impossible', () => {
    // A zero-token option means the adapter failed to map the option onto
    // the continuation. Folding that into probability zero would let a
    // tokenizer mismatch read as a confident answer about the rest.
    expect(() =>
      scoreOptions([
        { optionId: 'A', tokenLogprobs: [-1] },
        { optionId: 'B', tokenLogprobs: [] },
      ]),
    ).toThrow(/scored no tokens/);
  });

  it('refuses a duplicated option id', () => {
    expect(() =>
      scoreOptions([
        { optionId: 'A', tokenLogprobs: [-1] },
        { optionId: 'A', tokenLogprobs: [-2] },
      ]),
    ).toThrow(/appears twice/);
  });

  it('refuses a non-finite logprob', () => {
    // -Infinity is what a provider returns for a token it assigned no mass
    // to, and it would poison the sum silently.
    expect(() =>
      scoreOptions([
        { optionId: 'A', tokenLogprobs: [-1, -Infinity] },
        { optionId: 'B', tokenLogprobs: [-2] },
      ]),
    ).toThrow(/non-finite logprob/);
  });

  it('carries a code on every refusal', () => {
    try {
      scoreOptions([]);
      fail('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(OptionScoringError);
      expect((error as OptionScoringError).code).toBe('NO_OPTIONS');
    }
  });
});
