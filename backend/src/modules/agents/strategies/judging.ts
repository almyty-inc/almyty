/**
 * What a judge is asked, and how its answer is read, for the two judged
 * shapes: best of N (pick one) and consensus (say where they agree).
 *
 * Shared by the workflow `merge` node and the autonomous loop's Best of N
 * and Panel strategies, so the two execution shapes judge the same way
 * and a fix to the parse lands in both.
 */

const asText = (o: unknown): string => (typeof o === 'string' ? o : JSON.stringify(o));

/** The default best-of-N ask: the candidates, numbered from 1, and "answer with the number". */
export function bestOfNJudgePrompt(candidates: unknown[]): string {
  return `You are a judge. Pick the best response from these options:\n\n${candidates
    .map((o, i) => `Option ${i + 1}: ${asText(o)}`)
    .join('\n\n')}\n\nRespond with ONLY the number of the best option.`;
}

/**
 * The 0-based index the judge picked, clamped into range. A reply with no
 * number in front picks the first candidate and says so, so a caller can
 * record that the judge was not read rather than that it chose.
 */
export function parseBestOfNPick(answer: string, count: number): { index: number; read: boolean } {
  const pick = parseInt(answer, 10);
  if (Number.isNaN(pick)) return { index: 0, read: false };
  return { index: Math.max(0, Math.min(pick - 1, count - 1)), read: true };
}

/** The consensus ask: how many agree on the substance, and what that group says. */
export function consensusJudgePrompt(responses: unknown[]): string {
  return [
    'Several responses to the same question follow. Do two things.',
    '',
    '1. Count how many of them agree on the substance of the answer — the',
    '   size of the largest group that says the same thing. Disagreement on',
    '   wording is not disagreement.',
    '2. Write the answer that group gives.',
    '',
    'Reply with a single JSON object and nothing else:',
    '  {"agreeing": <integer>, "answer": "<the answer>"}',
    '',
    ...responses.map((o, i) => `Response ${i + 1}: ${asText(o)}`),
  ].join('\n');
}

/**
 * Read a consensus judge's reply. A reply that is not the asked-for JSON
 * keeps its text as the answer and leaves `agreement` undefined, because
 * "we could not tell" must not read as "they agreed".
 */
export function parseConsensus(
  raw: string,
  responses: number,
  threshold: number,
): { answer: string; agreement: number | undefined; consensusReached: boolean } {
  let agreeing: number | undefined;
  let answer: string = raw;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (typeof parsed.agreeing === 'number') agreeing = parsed.agreeing;
      if (typeof parsed.answer === 'string') answer = parsed.answer;
    } catch {
      // Keep the raw answer; the agreement is then genuinely unknown.
    }
  }
  const agreement =
    agreeing === undefined ? undefined : Math.max(0, Math.min(agreeing, responses)) / responses;
  return { answer, agreement, consensusReached: agreement !== undefined && agreement >= threshold };
}
