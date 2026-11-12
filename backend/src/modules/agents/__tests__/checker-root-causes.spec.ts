import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentStepProcessor } from '../agent-step-processor';
import { AgentVerifierHelper, VERDICT_SCHEMA } from '../agent-verifier.helper';
import { SHORTENED_KEY, runEvidence, shortenedResultOf } from '../checker-evidence';
import { confirmsClaim, presentInEvidence, saysAbsentFromEvidence } from '../checker-guards';
import { STEP_PAYLOAD_CAP, capPersistedPayload } from '../persist-cap';
import { falseVersionOrder } from '../version-order';

/**
 * Real runs on staging (2026-11-12), checked against OpenAlex, GitHub and
 * npm: 9 of 10 got a false "check didn't pass" and revisions deleted
 * correct data. Each describe below is one root cause.
 */

/** Ten OpenAlex works the way the API returns them: long abstracts, authorships, locations. */
function openAlexWorks(): { results: any[]; meta: any } {
  const words = (n: number, seed: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${seed}word${i}`, [i, i + 7]]));
  const results = Array.from({ length: 10 }, (_, i) => ({
    id: `https://openalex.org/W71675043${String(i).padStart(2, '0')}`,
    doi: `https://doi.org/10.1007/s00287-026-0161${i}-5`,
    title: `Work number ${i + 1}: a study of vision language model hallucination`,
    display_name: `Work number ${i + 1}: a study of vision language model hallucination`,
    publication_date: `2026-11-0${(i % 9) + 1}`,
    primary_location: { source: { display_name: `Journal ${i + 1}`, host_organization_lineage: ['https://openalex.org/P4310317082'] } },
    authorships: Array.from({ length: 6 }, (_, a) => ({ author: { id: `https://openalex.org/A${i}${a}`, display_name: `Author ${a}` }, institutions: [{ display_name: 'Some University' }] })),
    abstract_inverted_index: words(160, `w${i}`),
  }));
  return { meta: { count: 10, per_page: 10 }, results };
}

describe('1. a stored tool result keeps every item (persist cap is JSON-aware)', () => {
  const processor = new AgentStepProcessor({} as any, {} as any, {} as any, {} as any);
  const bound = (steps: any[]) => (processor as any).boundStepsForPersist(steps);
  const raw = JSON.stringify(openAlexWorks());

  it('the fixture is over the cap, like run 0db5d8dd', () => {
    expect(raw.length).toBeGreaterThan(STEP_PAYLOAD_CAP);
  });

  it('stores a JSON text result as valid JSON with every item and the note', () => {
    const [step] = bound([{ type: 'tool_call', input: { tool: 'openalex_search_works' }, output: raw }]);
    expect(typeof step.output).toBe('string');
    expect(step.output.length).toBeLessThanOrEqual(STEP_PAYLOAD_CAP);
    const stored = JSON.parse(step.output);
    expect(stored[SHORTENED_KEY]).toMatch(/^\[result shortened: every item is shown/);
    expect(stored.result.results).toHaveLength(10);
    stored.result.results.forEach((w: any, i: number) => {
      expect(w.doi).toBe(`https://doi.org/10.1007/s00287-026-0161${i}-5`);
      expect(w.id).toMatch(/^https:\/\/openalex\.org\/W/);
      expect(w.title).toMatch(/^Work number/);
    });
  });

  it('stores an object result as an object, same shape', () => {
    const [step] = bound([{ type: 'tool_call', output: openAlexWorks() }]);
    expect(shortenedResultOf(step.output)).not.toBeNull();
    expect((step.output as any).result.results).toHaveLength(10);
    expect(JSON.stringify(step.output).length).toBeLessThanOrEqual(STEP_PAYLOAD_CAP);
  });

  it('the checker reads every DOI from the stored step, and the note on the tool line', () => {
    const stored = bound([{ type: 'tool_call', input: { tool: 'openalex_search_works' }, output: raw }]);
    const evidence = runEvidence({ input: 'papers', steps: stored });
    for (let i = 0; i < 10; i++) expect(evidence).toContain(`10.1007/s00287-026-0161${i}-5`);
    expect(evidence).toMatch(/openalex_search_works: \[result shortened: every item is shown/);
  });

  it('cuts text that is not JSON so it fits, and says it was cut', () => {
    const text = 'plain log line\n'.repeat(5_000);
    const capped = capPersistedPayload(text) as string;
    expect(capped.length).toBeLessThanOrEqual(STEP_PAYLOAD_CAP);
    expect(capped).toMatch(/… \(truncated from 75000 characters; only the first \d+ are kept\)$/);
  });

  it('checker evidence treats cut text as shortened, the old marker included', () => {
    const cutNow = capPersistedPayload('x'.repeat(50_000));
    const cutBefore = `${'{"results":[{"id":1}'.padEnd(32_768, ' ')}… (truncated from 32803 characters)`;
    for (const output of [cutNow, cutBefore]) {
      const evidence = runEvidence({ steps: [{ type: 'tool_call', input: { tool: 't' }, output }] });
      expect(evidence).toMatch(/^t: \[result shortened: the stored result was cut; only the first [\d,]+ of [\d,]+ chars were kept\]/);
    }
  });

  it('is idempotent, so a replayed step stores what the log holds', () => {
    for (const output of [raw, openAlexWorks(), 'z'.repeat(80_000)]) {
      const once = bound([{ type: 'tool_call', output }]);
      const twice = bound(JSON.parse(JSON.stringify(once)));
      expect(twice).toEqual(once);
    }
  });

  it('the log and the row cap through the same function', () => {
    const src = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');
    const forRow = src.slice(src.indexOf('private async stepsForPersist'), src.indexOf('private boundStepsForPersist'));
    const forLog = src.slice(src.indexOf('private async hideForLog'), src.indexOf('private async toolCallMessageSaved'));
    expect(forRow).toMatch(/this\.boundStepsForPersist\(run\.steps\)/);
    expect(forLog).toMatch(/this\.boundStepsForPersist\(steps/);
  });
});

describe('2. only real failures count', () => {
  const helper = new AgentVerifierHelper({} as any);

  it('a fail verdict whose items say the claim is correct passes (run 9fc02bae)', () => {
    const read = helper.readFailures(
      {
        verdict: 'fail',
        failures: [
          { claim: '2. DOI: none', rule: "DOI is listed as null in evidence, but output states 'none' which is acceptable; no failure here", evidence: '' },
          { claim: 'Venue for paper 4: ACM Journal', rule: 'Matches evidence source display_name; no failure', evidence: '' },
          { claim: 'DOI: https://doi.org/10.1145/3860323', rule: 'DOI matches evidence, correct', evidence: '' },
          { claim: 'moment 2.31.0', rule: 'Version comparison error: the npm tool returned 2.31.0, which is correct. The classification is correct but the reasoning is incomplete.', evidence: '' },
        ],
      },
      'c',
    );
    expect(read.failures).toHaveLength(0);
    expect(read.discarded.map((d) => d.reason)).toEqual(Array(4).fill(expect.stringMatching(/its own words say the claim is right/)));
  });

  it('keeps a failure that confirms one part and names a real error in another', () => {
    expect(confirmsClaim('The tag is correct but the date is wrong: the release was published 2026-10-09')).toBeNull();
    expect(confirmsClaim('Venue is acceptable but "Respai.de journal article" is not stated in evidence')).toBeNull();
    expect(confirmsClaim('Version is not correctly classified')).toBeNull();
    expect(confirmsClaim('The DOI does not match the evidence')).toBeNull();
  });

  it('a claim the checker also lists as confirmed does not count', () => {
    const read = helper.readFailures(
      { verdict: 'fail', failures: [{ claim: 'axios latest version is 1.21.1', rule: 'Version mismatch' }], confirmed: ['axios latest version is 1.21.1'] },
      'c',
    );
    expect(read.failures).toHaveLength(0);
    expect(read.discarded[0].reason).toMatch(/also listed this claim as confirmed/);
  });

  it('asks for the verdict in a schema with a separate confirmed list', async () => {
    const chat = jest.fn().mockResolvedValue({ message: { content: '{"verdict":"pass","failures":[],"confirmed":["lodash 4.18.1"]}' }, cost: 0.01, usage: { inputTokens: 900, outputTokens: 20, totalTokens: 920 } });
    const panel = await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p', model: 'm' }], evidence: 'e' }, 'org-1');
    const request = chat.mock.calls[0][1];
    expect(request.responseFormat).toEqual({ name: 'checker_verdict', schema: VERDICT_SCHEMA });
    expect(VERDICT_SCHEMA.required).toEqual(['verdict', 'failures', 'confirmed']);
    expect(request.messages[0].content).toMatch(/"confirmed":\[/);
    expect(request.messages[0].content).not.toMatch(/"status":"fail"/);
    expect(panel.passed).toBe(true);
    expect(panel.passedRules).toContain('lodash 4.18.1');
    expect(panel.inputTokens).toBe(900);
  });

  it('asks again without the schema when the provider refuses it', async () => {
    const refused = Object.assign(new Error("Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model."), { response: { status: 400 } });
    const chat = jest.fn().mockRejectedValueOnce(refused).mockResolvedValueOnce({ message: { content: '{"verdict":"pass","failures":[]}' }, usage: {} });
    const panel = await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p', model: 'm' }] }, 'org-1');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][1].responseFormat).toBeUndefined();
    expect(chat.mock.calls[1][1].currentTime).toBe(true);
    expect(panel.passed).toBe(true);
  });

  it('does not ask again for an error that is not about the schema', async () => {
    const chat = jest.fn().mockRejectedValue(Object.assign(new Error('rate limited'), { response: { status: 429 } }));
    const panel = await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p', model: 'm' }] }, 'org-1');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(panel.unavailable).toBe(true);
  });
});

describe('3. version order is read in any phrasing', () => {
  it.each([
    '4.18.1 < 4.17.21, so this is a downgrade',
    'However, 4.18.1 < 4.17.21, so this is a downgrade, not up to date.',
    'Since 4.18.1 is less than 4.17.21, the claim is incorrect.',
    'lodash latest version 4.18.1 is actually older than the requested version 4.17.21 in package.json',
    '4.18.1 is lower than 4.17.21',
    '4.17.21 is newer than 4.18.1',
    '4.17.21 > 4.18.1',
  ])('drops "%s"', (text) => {
    expect(falseVersionOrder(text)).toMatch(/4\.18\.1 is the newer one/);
  });

  it.each([
    '4.18.1 is newer than 4.17.21',
    '4.17.21 < 4.18.1',
    '4.18.1 is not older than 4.17.21',
    'Since 4.18.1 < 4.17.21 is false (4.18.1 > 4.17.21), this is a minor update',
    'upgrade 4.17.21 -> 4.18.1 is available',
    '2.31.0 has minor version 31, which is greater than 29.',
    'Version 4.18.1 is older. 4.17.21 is the pinned one.',
  ])('keeps "%s"', (text) => {
    expect(falseVersionOrder(text)).toBeNull();
  });
});

describe('4. absent or invented, against evidence that holds the item', () => {
  const evidence = runEvidence({
    steps: [
      { type: 'tool_call', input: { tool: 'openalex_search_works' }, output: openAlexWorks() },
      { type: 'tool_call', input: { tool: 'github_search_issues' }, output: { items: [{ number: 67285, title: 'crypto: X509Certificate returns "Bad time value"', html_url: 'https://github.com/nodejs/node/issues/67285' }] } },
    ],
  });

  it('drops "not found" for a DOI the tool returned (run 0db5d8dd)', () => {
    const hit = presentInEvidence(
      { claim: '8. Work number 8 - DOI: https://doi.org/10.1007/s00287-026-01617-5', rule: 'Paper not found in the OpenAlex search results for the query', evidence: 'No paper with this title or DOI in the returned results.' },
      evidence,
    );
    expect(hit).toBe('10.1007/s00287-026-01617-5');
  });

  it('drops "not found in evidence" for an issue number the tool returned (run 31423ff5)', () => {
    expect(
      presentInEvidence({ claim: '[#67285] crypto: X509Certificate returns "Bad time value"', rule: 'Issue listed but not found in evidence.', evidence: '' }, evidence),
    ).toBe('#67285');
  });

  it('drops "invented" for a title the tool returned', () => {
    expect(
      presentInEvidence({ claim: 'Work number 3: a study of vision language model hallucination', rule: 'This paper appears invented', evidence: '' }, evidence),
    ).toMatch(/Work number 3/);
  });

  it('keeps it when the item really is not in the evidence', () => {
    expect(presentInEvidence({ claim: 'DOI: https://doi.org/10.1103/2lpt-bx5v', rule: 'DOI not found in the tool results', evidence: '' }, evidence)).toBeNull();
  });

  it('keeps an omission from the answer: "not in the OUTPUT" is not an absence from the evidence (run f924a19e)', () => {
    expect(saysAbsentFromEvidence("It is listed in the search results but does not appear in the OUTPUT's list of high-priority issues")).toBe(false);
    expect(presentInEvidence({ claim: '#67285 - X509Certificate', rule: "does not appear in the OUTPUT's list", evidence: '' }, evidence)).toBeNull();
  });

  it('notes on the step why a failure was not counted', async () => {
    const reply = {
      verdict: 'fail',
      failures: [{ claim: '9. Work number 9 - DOI: https://doi.org/10.1007/s00287-026-01618-5', rule: 'Paper not found in the OpenAlex search results', evidence: 'No such DOI in the returned results' }],
    };
    const chat = jest.fn().mockResolvedValue({ message: { content: JSON.stringify(reply) }, usage: {} });
    const panel = await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'answer', checkers: [{ name: 'Source check', providerId: 'p', model: 'm' }], evidence }, 'org-1');
    expect(panel.passed).toBe(true);
    expect(panel.checkers[0].note).toMatch(/not counted: "Paper not found.*10\.1007\/s00287-026-01618-5 is in the tool results/);
  });
});

describe('5. the answer check is in the cost by role, and its input tokens on the step', () => {
  it('charges the verify gate to its own role line', async () => {
    const panel = { verdict: 'fail', passed: false, policy: 'any_fail_blocks', failures: [], passedRules: [], checkers: [{ checker: 'c', verdict: 'fail' }], cost: 0.0453, tokens: 30_000, inputTokens: 29_000, outputTokens: 1_000 };
    const verifier = { runPanel: jest.fn().mockResolvedValue(panel) };
    const s = { toolRepository: { manager: { getRepository: () => ({ findOne: async () => null }) } }, logger: { warn: jest.fn() } };
    const processor = new AgentStepProcessor(s as any, verifier as any, {} as any, {} as any);
    const run: any = { id: 'r', organizationId: 'o', userId: 'u', input: 'q', steps: [], totalCost: 0.017, totalTokens: 0, metadata: { roleCosts: { main: { name: 'Main', purpose: 'main', kind: 'model', cost: 0.017, tokens: 1, calls: 4 } } } };
    const agent: any = { agentConfig: { verify: { enabled: true, checkers: [{ providerId: 'p', model: 'm' }] } } };
    await (processor as any).runAutonomousVerify(run, agent, 'the answer');
    expect(run.metadata.roleCosts.answer_check).toEqual({ name: 'Answer check', purpose: 'checker', kind: 'model', cost: 0.0453, tokens: 30_000, calls: 1 });
    const total = Object.values(run.metadata.roleCosts).reduce((sum: number, l: any) => sum + l.cost, 0);
    expect(total).toBeCloseTo(run.totalCost, 6);
  });

  it('every verify step records what the checker read', () => {
    const src = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');
    const pushes = src.split("type: 'verify',").slice(1).map((rest) => rest.slice(0, rest.indexOf('timestamp:')));
    expect(pushes.length).toBeGreaterThanOrEqual(7);
    for (const push of pushes) expect(push).toMatch(/tokens: checkTokens\((check|verifyPanel|panel)\)/);
  });
});
