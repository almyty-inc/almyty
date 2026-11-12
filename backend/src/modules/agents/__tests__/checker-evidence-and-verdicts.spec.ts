import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentStepProcessor } from '../agent-step-processor';
import { AgentVerifierHelper, CHECKER_MAX_TOKENS, salvageTruncatedJson } from '../agent-verifier.helper';
import { EVIDENCE_DEFAULT_CHARS, EVIDENCE_MAX_CHARS, evidenceBudget, runEvidence } from '../checker-evidence';
import { markUnverifiedAnswer } from '../unverified-answer';
import { compareVersions, falseVersionOrder } from '../version-order';

/**
 * Real staging runs against OpenAlex, GitHub and npm, checked against curl,
 * showed the final-answer checker failing correct answers:
 *  - 1622442b / 47563c22 / 363be56b: a tool result longer than the 8,000
 *    characters the checker was shown was cut, and the checker called the
 *    items past the cut "invented" (10 OpenAlex works, it saw ~2; two GitHub
 *    releases from 2026-11-11 were dropped in revision).
 *  - b9803830: the checker call sent no output budget, Anthropic's default
 *    of 1,024 tokens cut the JSON verdict off, nothing was read, and the run
 *    paid for revisions marked "verification_unavailable".
 *  - 16d152c2: items the checker itself called correct counted as failures,
 *    and "4.18.1 is OLDER than 4.17.21" pushed a right answer to a wrong one.
 */

const LONG = 'lorem ipsum dolor sit amet '.repeat(60); // ~1,600 chars

function openAlexWorks(n: number) {
  return {
    meta: { count: n, per_page: n },
    results: Array.from({ length: n }, (_, i) => ({
      id: `https://openalex.org/W${1000 + i}`,
      doi: `https://doi.org/10.1234/work.${i}`,
      title: `Work number ${i}`,
      publication_date: `2026-11-0${(i % 9) + 1}`,
      cited_by_count: i,
      abstract_inverted_index: Object.fromEntries(Array.from({ length: 150 }, (_, w) => [`word${w}`, [w, w + 1]])),
      authorships: [{ author: { display_name: `Author ${i}` }, raw_affiliation_strings: [LONG] }],
    })),
  };
}

function githubReleases(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    tag_name: `v1.${n - i}.0`,
    name: `Release 1.${n - i}.0`,
    published_at: i < 2 ? '2026-11-11T09:00:00Z' : `2026-10-${String(28 - i).padStart(2, '0')}T09:00:00Z`,
    html_url: `https://github.com/acme/widget/releases/tag/v1.${n - i}.0`,
    body: LONG,
  }));
}

const toolStep = (tool: string, output: unknown) => ({ type: 'tool_call', input: { tool }, output });

describe('the checker sees every item of a long tool result', () => {
  it('keeps all ten OpenAlex works, each with its id, doi, title and date, when the result is larger than its share', () => {
    const works = openAlexWorks(10);
    const raw = JSON.stringify(works);
    expect(raw.length).toBeGreaterThan(30_000);
    const evidence = runEvidence({ steps: [toolStep('openalex_search_works', works)] }, { budgetChars: 12_000 });
    for (let i = 0; i < 10; i++) {
      expect(evidence).toContain(`"id":"https://openalex.org/W${1000 + i}"`);
      expect(evidence).toContain(`"doi":"https://doi.org/10.1234/work.${i}"`);
      expect(evidence).toContain(`"title":"Work number ${i}"`);
    }
    expect(evidence.length).toBeLessThanOrEqual(12_000 + 500);
    // It says it was shortened, that no item was dropped, and what was.
    expect(evidence).toMatch(/openalex_search_works: \[result shortened: every item is shown; fields left out: [^\n]*results\[\]\.abstract_inverted_index \(object\)/);
  });

  it('keeps every GitHub release tag and date, the newest included, dropping the bodies first', () => {
    const releases = githubReleases(30);
    const evidence = runEvidence({ steps: [toolStep('github_list_releases', JSON.stringify(releases))] }, { budgetChars: 10_000 });
    for (const r of releases) {
      expect(evidence).toContain(`"tag_name":"${r.tag_name}"`);
      expect(evidence).toContain(`"published_at":"${r.published_at}"`);
    }
    expect(evidence.match(/2026-11-11T09:00:00Z/g)).toHaveLength(2);
    expect(evidence).not.toContain(LONG);
    expect(evidence).toContain('[result shortened: every item is shown');
  });

  it('when even the identifying fields do not fit, says how many items it shows', () => {
    const many = Array.from({ length: 2_000 }, (_, i) => ({ id: `item-${i}`, title: `Title ${i}`, body: LONG }));
    const evidence = runEvidence({ steps: [toolStep('big_list', many)] }, { budgetChars: 8_000 });
    const m = evidence.match(/\[result shortened: (\d+) of 2000 items shown in the list/);
    expect(m).not.toBeNull();
    const shown = Number(m![1]);
    expect(shown).toBeGreaterThan(50);
    expect(shown).toBeLessThan(2_000);
    expect(evidence).toContain('"id":"item-0"');
    expect(evidence).toContain(`"id":"item-${shown - 1}"`);
    expect(evidence).not.toContain(`"id":"item-${shown}"`);
  });

  it('shows a result that fits whole, with no note', () => {
    const works = openAlexWorks(10);
    const evidence = runEvidence({ steps: [toolStep('openalex_search_works', works)] });
    expect(evidence).toContain(JSON.stringify(works));
    expect(evidence).not.toContain('[result shortened');
  });

  it('gives small results all they need and shares the rest among large ones', () => {
    const evidence = runEvidence(
      { steps: [toolStep('npm_latest', { name: 'lodash', version: '4.18.1' }), toolStep('openalex_search_works', openAlexWorks(10))] },
      { budgetChars: 12_000 },
    );
    expect(evidence).toContain('npm_latest:\n{"name":"lodash","version":"4.18.1"}');
    expect(evidence).toContain('"title":"Work number 9"');
  });

  it('sizes the budget to the checker model context window, within a cap', () => {
    expect(evidenceBudget(null)).toBe(EVIDENCE_DEFAULT_CHARS);
    expect(evidenceBudget(200_000)).toBeGreaterThan(EVIDENCE_DEFAULT_CHARS);
    expect(evidenceBudget(2_000_000)).toBe(EVIDENCE_MAX_CHARS);
    expect(evidenceBudget(16_000)).toBeLessThan(EVIDENCE_DEFAULT_CHARS);
    // What the prompt else carries comes off the evidence.
    expect(evidenceBudget(80_000, 50_000)).toBe(evidenceBudget(80_000) - 50_000);
  });

  it("reads the checker's context window from its model card (the step processor)", async () => {
    // Too big for a small window, small enough to fit whole under the cap.
    const works = openAlexWorks(12);
    expect(JSON.stringify(works).length).toBeLessThan(EVIDENCE_MAX_CHARS);
    const run = { id: 'run-1', organizationId: 'org-1', steps: [toolStep('openalex_search_works', works)] };
    const withWindow = (contextLength: number | null) => {
      const findOne = jest.fn().mockResolvedValue(contextLength ? { id: 'm', contextLength } : null);
      const self = Object.assign(Object.create(AgentStepProcessor.prototype), {
        s: { toolRepository: { manager: { getRepository: () => ({ findOne }) } }, logger: { warn: jest.fn() } },
      });
      return { self, findOne };
    };
    const small = withWindow(8_000);
    const smallEvidence = (await small.self.prepareCheck(run, null, [{ providerId: 'p', model: 'tiny' }], 'answer')).evidence;
    expect(small.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org-1', providerId: 'p', vendorModelId: 'tiny' } }));
    expect(smallEvidence.length).toBeLessThanOrEqual(evidenceBudget(8_000, 'answer'.length) + 500);
    expect(smallEvidence).toContain('[result shortened');

    const large = withWindow(1_000_000);
    const largeEvidence = (await large.self.prepareCheck(run, null, [{ providerId: 'p', model: 'huge' }], 'answer')).evidence;
    expect(largeEvidence).toContain(JSON.stringify(works));
  });

  it('tells the checker absence from shortened evidence proves nothing, and to refute only', async () => {
    const chat = jest.fn().mockResolvedValue({ message: { content: '{"verdict":"pass","failures":[]}' } });
    await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p' }], evidence: 'REQUEST:\nx' }, 'org-1');
    const system = chat.mock.calls[0][1].messages[0].content as string;
    expect(system).toMatch(/Never fail a claim only because it is absent from shortened evidence; absence counts only where the evidence is complete/);
    expect(system).toMatch(/the EVIDENCE contradicts it/);
    expect(system).toMatch(/the EVIDENCE that would hold it is complete and does not hold it/);
    expect(system).toContain('[result shortened');
  });

  it('wires the evidence into the strategy checks too (cascade and patch)', () => {
    const src = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');
    expect(src.match(/runner\.check\(\s*run,\s*team\.checker!,\s*finalContent,\s*agent\.agentConfig\?\.verify\?\.spec,\s*await this\.prepareCheck\(run, agent,/g)).toHaveLength(2);
  });
});

describe('a checker reply is never cut off by the provider default', () => {
  const reply = (content: string, finishReason?: string) => ({ message: { content, ...(finishReason ? { finishReason } : {}) }, cost: 0.01, usage: { totalTokens: 10 } });

  it('asks for an output budget large enough for a verdict when the checker sets none', async () => {
    const chat = jest.fn().mockResolvedValue(reply('{"verdict":"pass","failures":[]}'));
    await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p', model: 'claude' }] }, 'org-1');
    expect(chat.mock.calls[0][1].maxTokens).toBe(CHECKER_MAX_TOKENS);
    expect(CHECKER_MAX_TOKENS).toBeGreaterThan(1_024);
  });

  it("keeps a checker's own output budget", async () => {
    const chat = jest.fn().mockResolvedValue(reply('{"verdict":"pass","failures":[]}'));
    await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p', maxTokens: 9_000 }] }, 'org-1');
    expect(chat.mock.calls[0][1].maxTokens).toBe(9_000);
  });

  it('reads a cut-off fail up to its last complete item, and notes it', async () => {
    const cut = '{"verdict":"fail","failures":[{"claim":"x is 3","status":"fail","rule":"x is 2 in the evidence","evidence":"x: 2"},{"claim":"y is 4","status":"fa';
    const chat = jest.fn().mockResolvedValue(reply(cut, 'max_tokens'));
    const panel = await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ name: 'c', providerId: 'p' }] }, 'org-1');
    expect(panel.verdict).toBe('fail');
    expect(panel.unavailable).toBeUndefined();
    expect(panel.failures).toEqual([{ claim: 'x is 3', rule: 'x is 2 in the evidence', evidence: 'x: 2', checker: 'c', kind: 'evidence' }]);
    expect(panel.checkers[0].note).toMatch(/cut off at its output limit \(4096 tokens\); it was read up to its last complete item/);
  });

  it('reads a cut-off pass whose failure list closed', () => {
    expect(salvageTruncatedJson('{"verdict":"pass","failures":[],"passed_rules":["dates match","ids ma')).toEqual({ verdict: 'pass', failures: [] });
  });

  it('never reads a cut-off list of failures as a clean pass', () => {
    expect(salvageTruncatedJson('{"verdict":"pass","failures":[{"rule":"a","status":"fail"},{"rule":"b')).toBeNull();
  });

  it('records why no verdict could be read, in plain words, and the panel says no checker gave one', async () => {
    const chat = jest.fn().mockResolvedValue(reply('{"verdict":"fa', 'max_tokens'));
    const panel = await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ name: 'c', providerId: 'p' }] }, 'org-1');
    expect(panel.passed).toBe(false);
    expect(panel.unavailable).toBe(true);
    expect(panel.checkers[0].error).toBe(`the checker's reply was cut off at its output limit (4096 tokens) before it gave a verdict: "{"verdict":"fa"`);
    expect(panel.failures).toEqual([
      expect.objectContaining({ rule: 'the checker could not give a verdict', code: 'verification_unavailable', evidence: expect.stringContaining('c: the checker') }),
    ]);
  });

  it('reads a cut-off reply in one pass over the text', () => {
    const deep = `{"verdict":"fail","failures":[${'{"rule":"r","evidence":"e"},'.repeat(20_000)}{"rule":"x`;
    const started = Date.now();
    const parsed = salvageTruncatedJson(deep);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(parsed?.failures).toHaveLength(20_000);
  });
});

describe('what a person reads when the check could not be done', () => {
  it('says the answer could not be checked, never the internal code', () => {
    const marked = markUnverifiedAnswer('lodash 4.18.1', [
      { rule: 'the checker could not give a verdict', evidence: 'c: cut off', code: 'verification_unavailable' } as any,
    ]);
    expect(marked).toBe('Note: this answer could not be checked: the checker could not give a verdict.\n\nlodash 4.18.1');
    expect(marked).not.toMatch(/verification_unavailable|didn't pass/);
    expect(markUnverifiedAnswer(marked, [])).toBe(marked);
  });

  it('a failed checker with no reason says so in words', async () => {
    const chat = jest.fn().mockResolvedValue({ message: { content: '{"verdict":"fail"}' } });
    const panel = await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ providerId: 'p' }] }, 'org-1');
    expect(panel.failures[0].rule).toBe('the checker failed the answer without saying why');
  });

  it('a checker without a model says so in words', async () => {
    const panel = await new AgentVerifierHelper({ chat: jest.fn() } as any).runPanel({ target: 'x', checkers: [{}] }, 'org-1');
    expect(panel.checkers[0].error).toBe('the checker has no model set');
    expect(panel.failures[0].rule).toBe('the checker could not give a verdict');
  });

  it('is never sent back for revision (the final-answer gate and the patch strategy)', () => {
    const src = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');
    expect(src).toContain('if (revise && !verifyPanel.passed && !verifyPanel.unavailable && revisions < maxLoops)');
    expect(src).toContain('if (!check.passed && !check.unavailable && revisions < maxLoops)');
  });
});

describe('only items the checker marks as failed count', () => {
  const panelFor = async (content: string) => {
    const chat = jest.fn().mockResolvedValue({ message: { content } });
    return new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ name: 'c', providerId: 'p' }] }, 'org-1');
  };

  it('drops items the checker itself confirms', async () => {
    const panel = await panelFor(
      JSON.stringify({
        verdict: 'fail',
        failures: [
          { claim: 'react 19.2.0', status: 'pass', rule: 'version matches', evidence: 'npm says 19.2.0, which is correct' },
          { claim: 'vite 8.0.1', status: 'correct', rule: 'version matches', evidence: 'which is correct' },
          { claim: 'zod 4.1.0', status: 'fail', rule: 'npm says 3.25.0', evidence: 'zod: 3.25.0' },
        ],
      }),
    );
    expect(panel.verdict).toBe('fail');
    expect(panel.failures.map((f) => f.claim)).toEqual(['zod 4.1.0']);
  });

  it('passes when every listed item is a confirmation', async () => {
    const panel = await panelFor(
      JSON.stringify({ verdict: 'fail', failures: [{ claim: 'react 19.2.0', status: 'pass', rule: 'matches', evidence: 'which is correct' }] }),
    );
    expect(panel.verdict).toBe('pass');
    expect(panel.failures).toEqual([]);
    expect(panel.checkers[0].note).toMatch(/not counted: "matches" \(the checker did not mark it as failed\)/);
  });

  it('does not count a failure that rests on a false version order', async () => {
    const panel = await panelFor(
      JSON.stringify({
        verdict: 'fail',
        failures: [{ claim: 'lodash latest is 4.18.1', status: 'fail', rule: 'Not the latest: 4.18.1 is OLDER than 4.17.21', evidence: 'npm 4.18.1' }],
      }),
    );
    expect(panel.verdict).toBe('pass');
    expect(panel.checkers[0].note).toMatch(/4\.18\.1 is not older than 4\.17\.21: 4\.18\.1 is the newer one/);
  });

  it('keeps a failure whose version order is true', async () => {
    const panel = await panelFor(
      JSON.stringify({ verdict: 'fail', failures: [{ status: 'fail', rule: 'the answer says 4.17.21 is the latest, but 4.17.21 is older than 4.18.1', evidence: 'npm 4.18.1' }] }),
    );
    expect(panel.verdict).toBe('fail');
  });

  it('tells the reviser to change only what a failure names', () => {
    const text = new AgentVerifierHelper({} as any).formatFailuresForRevision(
      [{ claim: 'zod 4.1.0', rule: 'npm says 3.25.0', evidence: 'zod: 3.25.0', checker: 'c' }],
      1,
      2,
    );
    expect(text).toContain('1. "zod 4.1.0": npm says 3.25.0');
    expect(text).toContain('Change only what a problem above names');
    expect(text).toMatch(/do not drop or change an item the checker did not name/);
  });
});

describe('version order', () => {
  it('compares part by part as integers', () => {
    expect(compareVersions('4.18.1', '4.17.21')).toBe(1);
    expect(compareVersions('v1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
    expect(compareVersions('0.9.12', '0.10.0')).toBe(-1);
  });

  it('finds a false "older/newer than" and leaves true or negated ones alone', () => {
    expect(falseVersionOrder('4.18.1 is OLDER than 4.17.21')).toMatch(/4\.18\.1 is not older than 4\.17\.21/);
    expect(falseVersionOrder('1.9.0 is newer than 1.10.0')).toMatch(/1\.10\.0 is the newer one/);
    expect(falseVersionOrder('4.17.21 is older than 4.18.1')).toBeNull();
    expect(falseVersionOrder('4.18.1 is not older than 4.17.21')).toBeNull();
    expect(falseVersionOrder('released 4.18.1 on 2026-11-11')).toBeNull();
  });

  it('scans a long run of digits in linear time', () => {
    const started = Date.now();
    falseVersionOrder('9'.repeat(200_000) + ' is older than 1.0');
    expect(Date.now() - started).toBeLessThan(500);
  });
});
