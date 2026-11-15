/**
 * The final-answer check decides its verdict from verifiable findings only
 * (product decision, 2026-11-13): what the platform counts and compares
 * itself, and a checker finding whose cited tool data the code confirms.
 * Everything else a checker says is a checker note. Every fixture is a
 * real run from staging (rounds rc5 and rc6); the hand-checked answer is
 * named on each.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentVerifierHelper, codeFindings } from '../agent-verifier.helper';
import { answerCodeFindings } from '../answer-checks';
import { verifyCheckerFinding } from '../checker-findings';
import { fitResult } from '../checker-evidence';
import { falseVersionOrder } from '../version-order';
import { markUnverifiedAnswer, unverifiedReason } from '../unverified-answer';
import { evidenceOf, liveWorks, loadRun } from './fixtures/checker-runs/load';

function findingsOf(name: string, answer?: string) {
  const fx = loadRun(name);
  const evidence = evidenceOf(fx);
  return codeFindings({ request: fx.request, answer: answer ?? fx.answer, evidence, now: new Date(fx.now) });
}

describe("the answer's own counts against its own list", () => {
  it('"I skipped 10" over a list of all 10 is wrong (RD2 6432deb3)', () => {
    expect(findingsOf('rc6-RD2-6432deb3')).toEqual([
      expect.objectContaining({
        rule: 'The answer says it skipped 10 of the 10 works the tool returned, so it should list 0, but it lists 10',
        item: "the answer's list",
        field: 'count',
        code: 'count',
        kind: 'deterministic',
      }),
    ]);
  });

  it('"10 returned, skipped 0" over a list of 9 is wrong (RD1 db52dcca)', () => {
    expect(findingsOf('rc6-RD1-db52dcca').map((f) => f.rule)).toContain(
      'The answer says it skipped 0 of the 10 works the tool returned, so it should list 10, but it lists 9',
    );
  });

  it('a stated total the tool list does not have is wrong', () => {
    const fx = loadRun('rc6-RD4-c76c1335');
    const answer = fx.answer.replace('number of works retrieved: 10', 'number of works retrieved: 12');
    expect(findingsOf('rc6-RD4-c76c1335', answer).map((f) => f.rule)).toContain('The answer says the tool returned 12 works, but the tool returned 10');
  });
});

describe('items the tool returned that the answer leaves out while it says its list is complete', () => {
  it('names W7167504345, the PhilPapers work RD1 dropped while it said "No other works matched" (db52dcca)', () => {
    const left = findingsOf('rc6-RD1-db52dcca').filter((f) => f.code === 'left_out');
    expect(left).toHaveLength(1);
    expect(left[0].item).toMatch(/^W7167504345 "From Legal Databases to AI-Assisted Justice/);
    expect(left[0].field).toBe('listed');
    expect(left[0].rule).toMatch(/the tool returned it, but the answer leaves it out and says "No other works matched since the cutoff date"/);
  });

  it('says nothing where the answer claims no completeness', () => {
    const fx = loadRun('rc6-RD1-db52dcca');
    const answer = fx.answer
      .replace('No other works matched since the cutoff date.', '')
      .replace('Number of works returned: 10. I skipped 0 works as none were previously reported.', '');
    expect(findingsOf('rc6-RD1-db52dcca', answer)).toEqual([]);
  });
});

describe("an item's field against the tool's value for that same item", () => {
  it('"DOI: None" for a work the tool gives a DOI (rc5 RD1 c62aa29a)', () => {
    expect(findingsOf('rc5-RD1-c62aa29a')).toEqual([
      expect.objectContaining({
        field: 'DOI',
        item: '"From Legal Databases to AI-Assisted Justice: A Risk-Sensiti…"',
        rule: '"From Legal Databases to AI-Assisted Justice: A Risk-Sensiti…": the answer says it has no DOI ("DOI: None"), but the tool results give 10.17613/zf92n-68j61',
      }),
    ]);
  });

  it('a label the tool does not give the issue (RW1 22301018: #67389 "aix", GitHub gives none)', () => {
    expect(findingsOf('rc6-RW1-22301018')).toEqual([
      expect.objectContaining({ item: '#67389', field: 'labels', rule: '#67389: the answer gives the label aix, but the tool results give none' }),
    ]);
  });

  it('a publication date and a DOI the tool gives differently', () => {
    const fx = loadRun('rc6-RD3-e3acd95d');
    const answer = fx.answer
      .replace('Publication Date: 2026-11-11', 'Publication Date: 2026-11-01')
      .replace('https://doi.org/10.3390/biomedinformatics6060106', 'https://doi.org/10.3390/biomedinformatics6060999');
    const found = findingsOf('rc6-RD3-e3acd95d', answer);
    expect(found.map((f) => [f.field, f.rule])).toEqual([
      ['publication date', expect.stringMatching(/BioAgent-RAG.*: the answer gives publication date 2026-11-01, but the tool results say 2026-11-11$/)],
      ['DOI', expect.stringMatching(/BioAgent-RAG.*: the answer gives DOI 10\.3390\/biomedinformatics6060999, but the tool results give 10\.3390\/biomedinformatics6060106$/)],
    ]);
  });

  it('a latest version npm did not return', () => {
    const fx = loadRun('rc6-DC1-20f31553');
    const answer = fx.answer.replace('| 5.3.0         |', '| 5.2.0         |');
    expect(findingsOf('rc6-DC1-20f31553', answer).map((f) => f.rule)).toContain('express: the answer gives the latest version as 5.2.0, but the tool results say 5.3.0');
  });
});

describe("a package's update kind against its versions", () => {
  it('dotenv ^16.4.5 against 18.0.10 is not outdated-minor (DC2 bf05f68a)', () => {
    expect(findingsOf('rc6-DC2-bf05f68a')).toEqual([
      expect.objectContaining({ item: 'dotenv', field: 'status', code: 'update_kind', rule: 'dotenv: the answer says outdated-minor, but 16 to 18 is a major update' }),
    ]);
  });

  it('a summary count the table does not add up to (rc5 DC2 6e00f1e9: "5 packages have newer major versions", 6 rows)', () => {
    expect(findingsOf('rc5-DC2-6e00f1e9')).toEqual([
      expect.objectContaining({ item: 'the summary', field: 'count of major', rule: 'The summary says 5 major, but the table lists 6' }),
    ]);
  });
});

describe('the window check stays, and names its item and field', () => {
  it('v5.3.0 listed as new, dated before the window (RW3 e342b57f)', () => {
    expect(findingsOf('rc6-RW3-e342b57f').filter((f) => f.code === 'outside_window')).toEqual([
      expect.objectContaining({ item: 'v5.3.0', field: 'published at', code: 'outside_window', kind: 'deterministic' }),
    ]);
  });
});

describe('no finding on an answer that is right', () => {
  // Each checked by hand against the live API: every entry right.
  it.each([
    'rc6-RD3-e3acd95d',
    'rc6-RD4-c76c1335',
    'rc6-DC1-20f31553',
    'rc6-DC3-3e0e5b2f',
    'rc6-RW2-49ed3013',
    'rc5-RD2-d4ad7da4',
    'rc5-RD3-7e4e631b',
    'rc5-RD4-bd98321b',
    'rc5-DC1-2ee71e77',
    'rc5-DC3-c04b7a9b',
    'rc5-RW2-887a8bfe',
  ])('%s', (name) => {
    expect(findingsOf(name)).toEqual([]);
  });
});

describe('the version-order guard reads a denied order (DC1 20f31553)', () => {
  it('"4.18.1 is not newer than 4.17.21" is false: 4.18.1 is the newer one', () => {
    expect(falseVersionOrder('Status and note are incorrect; 4.18.1 is not newer than 4.17.21')).toBe('4.18.1 is newer than 4.17.21: 4.18.1 is the newer one');
    expect(falseVersionOrder('4.17.21 is not older than 4.18.1')).toBe('4.17.21 is older than 4.18.1: 4.18.1 is the newer one');
    expect(falseVersionOrder('4.18.1 is not older than 4.17.21')).toBeNull();
    expect(falseVersionOrder('4.17.21 is not newer than 4.18.1')).toBeNull();
  });
});

describe('a checker finding counts only when the code verifies the tool data it cites', () => {
  const fx = loadRun('rc6-RD3-e3acd95d');
  const evidence = evidenceOf(fx);
  const now = new Date(fx.now);
  const wrongDate = fx.answer.replace('Publication Date: 2026-11-11', 'Publication Date: 2026-11-01');

  it('verifies a claim in the answer against a value of the same item that differs', () => {
    const check = verifyCheckerFinding(
      { claim: 'Publication Date: 2026-11-01', evidence: '"publication_date": "2026-11-11"', rule: 'BioAgent-RAG is dated 2026-11-11' },
      wrongDate,
      evidence,
      now,
    );
    expect(check.verified).toBe(true);
    expect(check.finding).toMatchObject({ field: 'publication date', answerValue: '2026-11-01', toolValue: '2026-11-11' });
    expect(check.finding!.item).toMatch(/BioAgent-RAG/);
  });

  it('does not verify a claim that is not in the answer, or evidence that is not in the tool results', () => {
    expect(verifyCheckerFinding({ claim: 'Publication Date: 2026-10-30', evidence: '"publication_date":"2026-11-11"' }, fx.answer, evidence, now).why).toBe('the claim it quotes is not in the answer');
    expect(verifyCheckerFinding({ claim: 'Publication Date: 2026-11-11', evidence: '"publication_date":"2026-11-15"' }, fx.answer, evidence, now).why).toBe(
      'the evidence it quotes is not in the tool results',
    );
  });

  it('does not verify tool data of another item than the claim', () => {
    // The claim is Midbrain's date (2026-11-10); the cited date is BioAgent-RAG's.
    const check = verifyCheckerFinding(
      { claim: 'Publication Date: 2026-11-10', evidence: '"publication_date":"2026-11-11"' },
      fx.answer,
      evidence,
      now,
    );
    expect(check).toEqual({ verified: false, why: 'the evidence it quotes is about another item than the claim' });
  });

  it('does not verify values that do not differ (RW2 49ed3013: "Issue title does not match evidence", the titles are the same)', () => {
    const rw2 = loadRun('rc6-RW2-49ed3013');
    const stored = rw2.stored.failures[0];
    const check = verifyCheckerFinding(
      { claim: stored.claim, evidence: '"title":"`test-perf-hooks-histogram-external-memory` failures on node-test-comit-plinux"', rule: stored.rule },
      rw2.answer,
      evidenceOf(rw2),
      new Date(rw2.now),
    );
    expect(check).toEqual({ verified: false, why: 'the value it quotes from the tool results does not differ from the answer' });
  });

  it('never verifies a finding that states a false version order (DC1 20f31553)', () => {
    const dc1 = loadRun('rc6-DC1-20f31553');
    const check = verifyCheckerFinding(
      { claim: '| lodash       | ^4.17.21        | 4.18.1', evidence: '"version":"4.18.1"', rule: 'Status and note are incorrect; 4.18.1 is not newer than 4.17.21' },
      dc1.answer,
      evidenceOf(dc1),
      new Date(dc1.now),
    );
    expect(check.verified).toBe(false);
  });
});

describe('the verdict comes from verifiable findings only', () => {
  const panelFor = async (name: string, reply: object, answer?: string) => {
    const fx = loadRun(name);
    const chat = jest.fn().mockResolvedValue({ message: { content: JSON.stringify(reply) }, usage: {} });
    return new AgentVerifierHelper({ chat } as any).runPanel(
      { target: answer ?? fx.answer, checkers: [{ name: 'Answer check', providerId: 'p', model: 'm' }], evidence: evidenceOf(fx), rules: fx.instructions, now: new Date(fx.now) },
      'org',
    );
  };

  it('a checker that fails a right answer on rule judgements passes it, with its judgements as notes (RD3 e3acd95d)', async () => {
    const fx = loadRun('rc6-RD3-e3acd95d');
    const failures = fx.stored.failures.map((f) => ({ claim: f.claim, evidence: f.evidence, rule: f.rule }));
    expect(failures).toHaveLength(10);
    const panel = await panelFor('rc6-RD3-e3acd95d', { verdict: 'fail', failures, notes: ['The why-it-matters lines stretch.'], confirmed: [] });
    expect(panel.verdict).toBe('pass');
    expect(panel.passed).toBe(true);
    expect(panel.failures).toEqual([]);
    expect(panel.notes).toHaveLength(11);
    expect(panel.notes!.map((n) => n.text)).toContain("You must base the 'why it matters' line only on the title.");
  });

  it('a checker finding the code verifies fails the answer, in the code\'s words', async () => {
    const fx = loadRun('rc6-RD3-e3acd95d');
    const answer = fx.answer.replace('First Author: Ali Asghari', 'First Author: Ali Asgari');
    const panel = await panelFor(
      'rc6-RD3-e3acd95d',
      { verdict: 'fail', failures: [{ claim: 'First Author: Ali Asgari', evidence: '"display_name":"Ali Asghari"', rule: 'first author misspelt' }], notes: [], confirmed: [] },
      answer,
    );
    expect(panel.verdict).toBe('fail');
    const fromChecker = panel.failures.filter((f) => f.checker === 'Answer check');
    expect(fromChecker).toEqual([expect.objectContaining({ kind: 'evidence', field: 'author', claim: 'First Author: Ali Asgari' })]);
    expect(fromChecker[0].rule).toMatch(/BioAgent-RAG.*: the answer gives author Ali Asgari, but the tool results say Ali Asghari$/);
  });

  it('a code finding fails the answer when the checker passed it (DC2 bf05f68a)', async () => {
    const panel = await panelFor('rc6-DC2-bf05f68a', { verdict: 'pass', failures: [], notes: [], confirmed: ['dotenv'] });
    expect(panel.verdict).toBe('fail');
    expect(panel.failures.map((f) => f.rule)).toEqual(['dotenv: the answer says outdated-minor, but 16 to 18 is a major update']);
  });
});

describe('what the answer says when its check did not pass', () => {
  it('names each verdict finding, strongest first, and never a checker note or an instruction', async () => {
    const fx = loadRun('rc6-RD1-db52dcca');
    const reply = { verdict: 'fail', failures: fx.stored.failures.map((f) => ({ claim: f.claim, evidence: f.evidence, rule: f.rule })), notes: ['Some lines speculate.'], confirmed: [] };
    const chat = jest.fn().mockResolvedValue({ message: { content: JSON.stringify(reply) }, usage: {} });
    const panel = await new AgentVerifierHelper({ chat } as any).runPanel(
      { target: fx.answer, checkers: [{ name: 'Source check', providerId: 'p', model: 'm' }], evidence: evidenceOf(fx), rules: fx.instructions, now: new Date(fx.now) },
      'org',
    );
    const marked = markUnverifiedAnswer(fx.answer, panel.failures);
    const line = marked.split('\n')[0];
    expect(line).toMatch(/^Note: this answer's check didn't pass: The answer says it skipped 0 of the 10 works the tool returned, so it should list 10, but it lists 9; W7167504345 /);
    expect(line).not.toMatch(/For each remaining work|Some lines speculate/);
    expect(marked).not.toMatch(/For each remaining work write a numbered entry/);
  });

  it('gives at most three reasons, then how many more', () => {
    const f = (rule: string) => ({ rule, kind: 'deterministic' as const });
    expect(unverifiedReason([f('a is wrong'), f('b is wrong'), f('c is wrong'), f('d is wrong'), f('e is wrong')])).toBe('a is wrong; b is wrong; c is wrong; and 2 more');
  });

  it('never shows a rule failure or a bare instruction', () => {
    const instruction = 'For each remaining work write a numbered entry: exact title.';
    expect(unverifiedReason([{ rule: instruction, instruction, kind: 'evidence' }, { rule: instruction, kind: 'rule' }])).toBe('the checkers found problems that were not fixed');
  });

  it('the run marks its answer with the verdict findings only; notes go on the verify step', () => {
    const src = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');
    for (const m of src.matchAll(/markUnverifiedAnswer\(([^)]*)\)/g)) expect(m[1]).toBe('finalContent, failedCheck');
    expect(src).toMatch(/failedCheck = verifyPanel\.passed \? null : \(verifyPanel\.failures \?\? \[\]\)/);
    // "Checks passed" counts the verdict, which notes never change.
    expect(src).toContain("if (!unavailable) answerCheck = verifyPanel.passed ? 'pass' : 'fail';");
    expect((src.match(/\.\.\.checkerNotesOf\(/g) ?? []).length).toBe(5);
    expect(readFileSync(join(__dirname, '..', 'unverified-answer.ts'), 'utf8')).not.toMatch(/\.notes\b|notes:/);
  });
});

describe('the shortener keeps the identifying leaves of nested objects for every item', () => {
  // A live OpenAlex page with a PhilPapers repository work among journal
  // articles. The stored copies of runs db52dcca and e3acd95d dropped the
  // whole primary_location of the PhilPapers and Zenodo works: their
  // nulls and empty lists pushed the nested object over its limit.
  const works = liveWorks();
  const raw = JSON.stringify(works);

  // 60,000 and 40,000 keep nested objects' identifying leaves (level 3); the old cut dropped three works' venues at each.
  it.each([60_000, 40_000, 25_000])('keeps every venue name and source type at %i characters', (allowance) => {
    const { body, note } = fitResult(raw, works, allowance);
    expect(note).toMatch(/every item is shown/);
    const shown = JSON.parse(body).results as Array<Record<string, any>>;
    expect(shown).toHaveLength(works.results.length);
    works.results.forEach((w, i) => {
      const source = w.primary_location?.source;
      if (!source) return;
      expect(shown[i].primary_location.source.display_name).toBe(source.display_name);
      expect(shown[i].primary_location.source.type).toBe(source.type);
    });
    const philPapers = shown.find((w) => String(w.id).endsWith('W7167504345'))!;
    expect(philPapers.primary_location.source.display_name).toBe('PhilPapers (PhilPapers Foundation)');
    expect(philPapers.doi).toBe('https://doi.org/10.17613/zf92n-68j61');
    expect(note).not.toMatch(/results\[\]\.(?:\{[^}]*\b)?primary_location \(object\)/);
  });

  it('an item field check then reads the venue of every work', () => {
    const answer = '1. Title: From Legal Databases to AI-Assisted Justice: A Risk-Sensitive Framework for the Application of Information Technologies in Law\n   Venue: Zenodo (Repository)';
    const { body, note } = fitResult(raw, works, 40_000);
    const evidence = `REQUEST:\nrag\n\nopenalex_search_works: ${note}\n${body}`;
    expect(answerCodeFindings({ answer, evidence })).toEqual([
      expect.objectContaining({ field: 'venue', rule: expect.stringMatching(/the answer gives the venue as Zenodo \(Repository\), but the tool results give PhilPapers \(PhilPapers Foundation\)$/) }),
    ]);
  });
});
