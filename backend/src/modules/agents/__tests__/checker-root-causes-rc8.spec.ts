/**
 * The general causes behind the rc8 answer-check gate (staging,
 * 2026-11-13): each fix is for every shape of its error, not the one rc8
 * showed. Every fixture is a real run; the hand-checked truth is in
 * checker-verdicts-replay.spec.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { codeFindings } from '../agent-verifier.helper';
import { AgentStepProcessor } from '../agent-step-processor';
import { AgentMemoryKeeper, REPORTED_RUNS_MAX, recordReportedItems, reportedBlock, reportedItemIds } from '../agent-memory.keeper';
import { answerCodeFindings, followsSortRule, issueRuleOf, normalValue, speaksOfEarlierReports, toolItems, valueList } from '../answer-checks';
import { judgeNote, judgeNoteBy } from '../checker-notes';
import { falseVersionOrder } from '../version-order';
import { RC5, RC6, RC7, RC8, earlierAnswers, evidenceOf, loadRun, wholeToolResults } from './fixtures/checker-runs/load';

function findingsOf(name: string, opts: { answer?: string; earlier?: string[]; instructions?: string } = {}) {
  const fx = loadRun(name);
  return codeFindings({
    request: fx.request,
    answer: opts.answer ?? fx.answer,
    evidence: evidenceOf(fx),
    now: new Date(fx.now),
    whole: wholeToolResults(fx),
    instructions: opts.instructions ?? fx.instructions,
    ...(opts.earlier ? { earlier: opts.earlier } : {}),
  });
}

describe('1. a claim that an item has no value for a field, wherever it is written', () => {
  it('RD1 d99aa38d: "in PhilPapers, no DOI." in a sentence, against the DOI the tool gives', () => {
    expect(findingsOf('rc8-RD1-d99aa38d').filter((f) => f.field === 'DOI')).toEqual([
      expect.objectContaining({
        item: '"From Legal Databases to AI-Assisted Justice: A Risk-Sensiti…"',
        rule: '"From Legal Databases to AI-Assisted Justice: A Risk-Sensiti…": the answer says it has no DOI ("no DOI"), but the tool results give 10.17613/zf92n-68j61',
      }),
    ]);
  });

  const fx = loadRun('rc8-RD1-d99aa38d');
  const evidence = evidenceOf(fx);
  const entry = (text: string) => answerCodeFindings({ answer: `1. "From Legal Databases to AI-Assisted Justice: A Risk-Sensitive Framework for the Application of Information Technologies in Law," 2026-12-31, ${text}`, evidence });

  it.each([
    ['without a DOI.', 'DOI'],
    ['DOI not available.', 'DOI'],
    ['DOI: (none)', 'DOI'],
    ['DOI: N/A', 'DOI'],
    ['DOI: https://doi.org/10.17613/zf92n-68j61 (N/A)', 'DOI'],
    ['by an unknown author, venue unknown.', 'venue'],
    ['author unknown, in PhilPapers.', 'first author'],
  ])('reads %p as saying there is no %s', (text, field) => {
    expect(entry(text).filter((f) => f.field === field).map((f) => f.rule)).toEqual([expect.stringMatching(/: the answer says it has no .*, but the tool results give /)]);
  });

  it('a table cell or a labelled field that starts by saying none ("Unknown (preprint, ...)")', () => {
    const table = '| Title | Venue |\n|---|---|\n| From Legal Databases to AI-Assisted Justice: A Risk-Sensitive Framework for the Application of Information Technologies in Law | Unknown (preprint) |';
    expect(answerCodeFindings({ answer: table, evidence }).map((f) => f.rule)).toEqual([expect.stringMatching(/says it has no venue \("venue: Unknown \(preprint\)"\), but the tool results give PhilPapers/)]);
  });

  it('says nothing where the tool results give none too, nor where the words are not about the item\'s value', () => {
    // rc6 RD2: a venue "Unknown (preprint, Université Bordeaux Montaigne)" for a work OpenAlex gives no venue.
    expect(findingsOf('rc6-RD2-6432deb3').filter((f) => f.field === 'venue')).toEqual([]);
    expect(entry('in PhilPapers, DOI: 10.17613/zf92n-68j61. It has no direct relevance to RAG.')).toEqual([]);
    // "no newer version" in a package note is not "no version".
    const dc = loadRun('rc8-DC1-22a3aee0');
    const noted = dc.answer.replace(/\| (Major version[^|]*)\|/, '| no newer version known |');
    expect(findingsOf('rc8-DC1-22a3aee0', { answer: noted })).toEqual([]);
  });
});

describe('2. items an answer presents as new, against what the agent reported before', () => {
  it('RD4 d13c5d50: "the remaining 9 new papers", every one reported by an earlier answer', () => {
    const fx = loadRun('rc8-RD4-d13c5d50');
    const found = findingsOf('rc8-RD4-d13c5d50', { earlier: earlierAnswers(fx) });
    expect(found.map((f) => f.code)).toEqual(['previously_reported']);
    expect(found[0].item.split(', ').sort()).toEqual(
      ['W4414455531', 'W4416965058', 'W7225618523', 'W7225693897', 'W7225723274', 'W7225804513', 'W7225814773', 'W7225817243', 'W7225823724'].sort(),
    );
    expect(found[0].rule).toMatch(/^The answer lists 9 items as new, but this agent's earlier answers already reported them: /);
  });

  it('runs where only the instructions speak of what was reported before', () => {
    const fx = loadRun('rc8-RD4-d13c5d50');
    const quiet = fx.answer.replace('I skipped 1 paper already reported earlier. Here are the remaining 9 new papers:', 'Here they are:');
    expect(speaksOfEarlierReports(quiet, '')).toBe(false);
    expect(speaksOfEarlierReports(quiet, fx.instructions)).toBe(true);
    const found = findingsOf('rc8-RD4-d13c5d50', { answer: quiet, earlier: earlierAnswers(fx) });
    expect(found.map((f) => f.rule)).toEqual([expect.stringMatching(/^The answer lists 9 items though its instructions say to leave out what it already reported, but/)]);
  });

  it('says nothing about items no earlier answer reported, nor without the agent\'s history', () => {
    const fx = loadRun('rc8-RD4-d13c5d50');
    expect(findingsOf('rc8-RD4-d13c5d50', { earlier: ['an unrelated earlier digest'] }).filter((f) => f.code === 'previously_reported')).toEqual([]);
    expect(findingsOf('rc8-RD4-d13c5d50')).toEqual([]);
    expect(speaksOfEarlierReports(loadRun('rc8-DC1-22a3aee0').answer, loadRun('rc8-DC1-22a3aee0').instructions)).toBe(false);
    void fx;
  });

  it('the step processor reads the earlier answers where the instructions speak of them, though the answer does not', async () => {
    const find = jest.fn().mockResolvedValue([{ id: 'r0', output: 'W4416965058 reported', createdAt: new Date() }]);
    const self = Object.assign(Object.create(AgentStepProcessor.prototype), {
      s: { toolRepository: { manager: { getRepository: () => ({ findOne: jest.fn().mockResolvedValue(null) }) } }, runRepository: { find }, logger: { warn: jest.fn() } },
    });
    const fx = loadRun('rc8-RD4-d13c5d50');
    const run: any = { id: 'run-4', agentId: 'agent-1', organizationId: 'org-1', createdAt: new Date(fx.now), input: { message: fx.request }, steps: [] };
    const check = await self.prepareCheck(run, { instructions: fx.instructions }, [{ providerId: 'p', model: 'm' }], 'Here they are:\n\n1. a paper');
    expect(find).toHaveBeenCalledTimes(1);
    expect(check.earlier).toEqual(['W4416965058 reported']);
  });
});

describe('3. one value normaliser: lists in brackets, quotes or any order are the same set', () => {
  it.each([
    ['[linux, s390x]', ['linux', 's390x']],
    ['["s390x", "linux"]', ['s390x', 'linux']],
    ['`linux`, `s390x`', ['linux', 's390x']],
    ['linux; s390x', ['linux', 's390x']],
    ['**[feature request, security]**', ['feature request', 'security']],
    ['(none)', []],
    ['[]', []],
  ])('%p', (text, list) => {
    expect(valueList(text)).toEqual(list);
  });

  it('normalValue reads a value the same however it is wrapped', () => {
    expect(['Linux', '[linux]', '`linux`', '"linux"', '(linux)', '**linux**'].map(normalValue)).toEqual(Array(6).fill('linux'));
  });

  it('RW1 64f3b08a: "[linux, s390x]" and "[feature request, security]" are the labels GitHub gives, in another order', () => {
    expect(findingsOf('rc8-RW1-64f3b08a').filter((f) => f.field === 'labels')).toEqual([]);
  });

  it('a label the tool does not give is still named, whatever the wrapping', () => {
    const fx = loadRun('rc8-RW1-64f3b08a');
    const wrong = fx.answer.replace('[linux, s390x]', '[linux, s390x, `bug`]');
    expect(findingsOf('rc8-RW1-64f3b08a', { answer: wrong }).map((f) => f.rule)).toEqual(['#64807: the answer gives the label bug, but the tool results give s390x, linux']);
  });
});

describe('4. what an agent reported is state every later run is given, not a memory ranked by similarity', () => {
  const agent = { id: 'agent-1', name: 'Research digest', memoryConfig: { enabled: true, save: 'facts' } } as any;
  const runOf = (name: string, over: Record<string, unknown> = {}): any => {
    const fx = loadRun(name);
    return {
      id: name, agentId: 'agent-1', organizationId: 'org-1', userId: 'u-1', endUserId: null, conversationId: null, metadata: {}, workingMemory: {}, totalCost: 0,
      status: 'completed', createdAt: new Date(fx.now), input: { message: fx.request }, output: fx.answer,
      steps: fx.tools.map((t) => ({ type: 'tool_call', input: { tool: t.tool, toolId: 't-1', parameters: t.parameters }, output: t.output })),
      ...over,
    };
  };
  // What the similarity search found on staging for RD2: five prose facts, no id (rc8 mem snapshots).
  const PROSE = [{ item: { id: 'm1', mode: 'memory', tier: 'long', content: 'The user is interested in large language model agents benchmarks since 2026-11-05.' }, score: 0.5 }];
  function keeperWith(rows: any[]) {
    const find = jest.fn().mockResolvedValue(rows);
    const memoryAccounts = { search: jest.fn(async () => PROSE), put: jest.fn() };
    const k = new AgentMemoryKeeper({ memoryAccounts, runRepository: { find }, logger: { warn: jest.fn() } } as any, { callModel: jest.fn() } as any);
    return { k, find };
  }

  it('a finished run keeps the ids of the items its answer reported (RD1 d99aa38d: its 10 works)', () => {
    const run = runOf('rc8-RD1-d99aa38d');
    recordReportedItems(run);
    expect(run.metadata.reportedItems).toHaveLength(10);
    expect(run.metadata.reportedItems).toEqual(expect.arrayContaining(['W7167504345', 'W4416965058', 'W7128530100', 'W7159584895', 'W7212323002']));
    expect(run.metadata.reportedItems.every((id: string) => /^W\d+$/.test(id))).toBe(true);
    // An answer that lists nothing keeps nothing (RD2 bc75f6f1).
    expect(reportedItemIds(runOf('rc8-RD2-bc75f6f1'))).toEqual([]);
  });

  it('run 2 is given run 1\'s ids though its similarity search finds only prose, and can skip exactly run 1\'s items', async () => {
    const run1 = runOf('rc8-RD1-d99aa38d');
    recordReportedItems(run1);
    const { k, find } = keeperWith([{ id: run1.id, metadata: run1.metadata, createdAt: run1.createdAt }]);
    const run2 = runOf('rc8-RD2-bc75f6f1', { metadata: {}, steps: [] });
    const context = await k.recallAtStart(agent, run2, async () => '');
    expect(context).toContain('The user is interested in large language model agents');
    expect(context).toContain('## Items you already reported');
    expect(run2.steps[0]).toMatchObject({ type: 'memory_recall', output: { found: 1, reportedItems: 10 } });
    // Of RD2's ten works, exactly the four RD1 reported are in the block.
    const rd2 = toolItems(evidenceOf(loadRun('rc8-RD2-bc75f6f1'))).items;
    const given = rd2.filter((it) => it.ids.some((id) => context.includes(id.toUpperCase()))).map((it) => it.ids[0].toUpperCase());
    expect(given.sort()).toEqual(['W4416965058', 'W7128530100', 'W7159584895', 'W7212323002']);
    // Read for this agent only, completed runs, newest first, bounded.
    expect(find.mock.calls[0][0]).toMatchObject({ where: { agentId: 'agent-1', organizationId: 'org-1', status: 'completed' }, order: { createdAt: 'DESC' }, take: REPORTED_RUNS_MAX });
    // A run 2 that leaves out exactly those four, as already reported, passes the skip and new checks.
    const fx = loadRun('rc8-RD2-bc75f6f1');
    const kept = rd2.filter((it) => !given.includes(it.ids[0].toUpperCase()));
    const answer = `The tool returned 10 works. I skipped 4 as already reported.\n\n${kept.map((it, i) => `${i + 1}. ${it.title}\n   - DOI: ${it.dois[0] ?? 'none'}`).join('\n')}`;
    expect(codeFindings({ request: fx.request, answer, evidence: evidenceOf(fx), now: new Date(fx.now), instructions: fx.instructions, earlier: [run1.output] })).toEqual([]);
  });

  it('newest first, without repeats', async () => {
    const { k } = keeperWith([
      { id: 'b', metadata: { reportedItems: ['W2', 'W3'] } },
      { id: 'a', metadata: { reportedItems: ['W1', 'W2'] } },
      { id: 'c', metadata: {} },
    ]);
    expect(await k.reportedBefore(agent, runOf('rc8-RD2-bc75f6f1'))).toEqual(['W2', 'W3', 'W1']);
    expect(reportedBlock(['W2', 'W3'])).toMatch(/Leave out any of them your tools return again[^\n]*\nW2, W3$/);
    expect(reportedBlock([])).toBe('');
  });

  it("a memory that is each person's own gives a run only that person's reported items", async () => {
    const { k, find } = keeperWith([]);
    await k.reportedBefore({ ...agent, memoryConfig: { enabled: true, whose: 'person' } }, runOf('rc8-RD2-bc75f6f1', { userId: 'u-7' }));
    expect(find.mock.calls[0][0].where).toMatchObject({ userId: 'u-7' });
  });

  it('the step processor records them on a completed run with memory on', () => {
    const src = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');
    expect(src).toMatch(/run\.status = AgentRunStatus\.COMPLETED;\s*run\.output = finalContent;[\s\S]{0,300}if \(agent\.memoryConfig\?\.enabled\) recordReportedItems\(run\);/);
  });
});

describe('5. severity words a summary gives a release must be in its notes', () => {
  it('RW2 d3757bc9: "critical" for v26.13.1, whose notes rate fixes High, Medium and Low', () => {
    expect(findingsOf('rc8-RW2-d3757bc9').filter((f) => f.code === 'release_notes').map((f) => f.rule)).toEqual([
      "v26.13.1: the answer's summary names critical, but the release notes in the tool results never mention it",
      "v22.23.5: the answer's summary names crypto, but the release notes in the tool results never mention it",
    ]);
  });

  it('"security" and "breaking" count where the notes say them in their own words (a CVE id, SEMVER-MAJOR)', () => {
    const fx = loadRun('rc8-RW2-d3757bc9');
    const said = fx.answer.replace(/multiple critical and high severity fixes/i, 'multiple security fixes, with breaking changes');
    expect(findingsOf('rc8-RW2-d3757bc9', { answer: said }).filter((f) => /v26\.13\.1/.test(f.rule))).toEqual([expect.objectContaining({ rule: expect.stringMatching(/names breaking,/) })]);
  });

  it.each([...RC5, ...RC6, ...RC7, ...RC8].filter((n) => /-RW/.test(n) && !['rc7-RW1-15fca65f', 'rc7-RW2-947d8e43', 'rc8-RW2-d3757bc9'].includes(n)))(
    'no release-notes finding on %s',
    (name) => {
      expect(findingsOf(name).filter((f) => f.code === 'release_notes')).toEqual([]);
    },
  );
});

describe('6. an issue listed as a bug, by the rule the agent\'s instructions give, without GitHub\'s issue type', () => {
  it('reads the rule and its labels from the instructions', () => {
    const rule = issueRuleOf(loadRun('rc8-RW2-d3757bc9').instructions)!;
    expect(Array.from(rule.labels)).toEqual(expect.arrayContaining(['confirmed-bug', 'bug', 'regression', 'priority/critical', 'p0', 'p1', 'high-priority', 'security']));
    expect(issueRuleOf(loadRun('rc8-DC1-22a3aee0').instructions)).toBeNull();
  });

  it('RW2 d3757bc9: #67427 (question) and #67354 (feature request), whose titles name no problem; type is null on every item', () => {
    expect(findingsOf('rc8-RW2-d3757bc9').filter((f) => f.field === 'category').map((f) => f.item)).toEqual(['#67427', '#67354']);
  });

  it('flags no other issue in any of the twelve release-watcher answers', () => {
    const flagged: string[] = [];
    for (const name of [...RC5, ...RC6, ...RC7, ...RC8].filter((n) => /-RW/.test(n))) {
      for (const f of findingsOf(name).filter((x) => x.field === 'category')) flagged.push(`${name} ${f.item}`);
    }
    expect(flagged.sort()).toEqual(
      ['rc6-RW3-e342b57f #7588', 'rc6-RW3-e342b57f #7427', 'rc7-RW1-15fca65f #67427', 'rc7-RW2-947d8e43 #67354', 'rc7-RW3-ab0c73df #7427', 'rc8-RW2-d3757bc9 #67427', 'rc8-RW2-d3757bc9 #67354'].sort(),
    );
  });
});

describe('7. checker notes through the same verifiers', () => {
  const ctxOf = (name: string) => {
    const fx = loadRun(name);
    const evidence = evidenceOf(fx);
    const earlier = speaksOfEarlierReports(fx.answer, fx.instructions) ? earlierAnswers(fx) : undefined;
    const findings = codeFindings({ request: fx.request, answer: fx.answer, evidence, now: new Date(fx.now), whole: wholeToolResults(fx), instructions: fx.instructions, ...(earlier ? { earlier } : {}) });
    return { answer: fx.answer, evidence, instructions: fx.instructions, findings, now: new Date(fx.now) };
  };

  it.each([
    ['rc8-DC3-988ea008', 'lodash 4.18.1 is actually a lower minor version than the base 4.17.21 specified in package.json', 'version order'],
    ['rc8-DC1-22a3aee0', 'lodash 4.18.1 is actually older than the base 4.17.21 (minor 18 > 17 but patch 1 < 21)', 'version order'],
    ['rc8-RW1-64f3b08a', 'v27.0.0-alpha.0.1.0 is marked as a prerelease in the tool results but the OUTPUT lists it as a regular release', 'tool field'],
    ['rc8-RW1-64f3b08a', "Issue 64807 has labels 's390x' and 'linux' but no bug/regression/security label; it should not have been included", 'issue rule'],
    ['rc8-RW3-6d6a8e80', 'Issue 7560 has no labels matching bug/regression/security criteria; it should not be included.', 'issue rule'],
    ['rc8-DC2-986e43dd', 'Sorting order is correct: deprecated first (querystring), then outdated-major (6 packages), then outdated-minor (axios), then up-to-date (none).', 'sort order'],
    ['rc8-RD1-d99aa38d', 'The OUTPUT correctly states it skipped 0 papers as none were previously reported.', 'code finding'],
    ['rc8-RD4-d13c5d50', 'The output claims 1 paper was skipped and lists 9 papers, so the skip count is inconsistent with the total returned.', 'counts'],
  ])('%s: false, by %s', (name, text, by) => {
    expect(judgeNoteBy(text, ctxOf(name))).toEqual({ verdict: 'false', by });
  });

  it.each([
    ['rc7-RW1-15fca65f', 'Release v27.0.0-alpha.0.1.0 is marked as prerelease:false in tool results but is an alpha release.'],
    ['rc8-RW2-d3757bc9', "Issue #67354 is labeled 'feature request' which does not meet the filtering criteria for bugs, regressions, or security."],
    ['rc8-RW2-d3757bc9', 'Issue #67429 describes a process termination (crash) but has no qualifying labels; title indicates a bug.'],
    ['rc8-RD3-e31b4553', "The output's opening line claims 10 works retrieved and 0 skipped, but only 4 are presented, which is inconsistent."],
  ])('%s: true', (name, text) => {
    expect(judgeNote(text, ctxOf(name))).toBe('true');
  });

  it('leaves what it cannot show as a note', () => {
    expect(judgeNote('The importance lines are plausible interpretations based on titles.', ctxOf('rc8-RD1-d99aa38d'))).toBeNull();
    expect(judgeNote('This paper is correctly listed and matches the tool results.', ctxOf('rc8-RD3-e31b4553'))).toBeNull();
  });

  it('the table order the instructions give, read from the status column', () => {
    expect(followsSortRule(loadRun('rc8-DC2-986e43dd').answer, loadRun('rc8-DC2-986e43dd').instructions)).toBe(false);
    const sorted = '| Package | In package.json | Latest | Status | Note |\n|---|---|---|---|---|\n| a | ^1.0.0 | 1.0.0 | deprecated | x |\n| b | ^1.0.0 | 2.0.0 | outdated-major | x |\n| c | ^1.0.0 | 1.1.0 | outdated-minor | x |';
    expect(followsSortRule(sorted, loadRun('rc8-DC2-986e43dd').instructions)).toBe(true);
  });

  it('reads "a lower minor version than" as an order', () => {
    expect(falseVersionOrder('4.18.1 is a lower minor version than 4.17.21')).toBe('4.18.1 is not older than 4.17.21: 4.18.1 is the newer one');
  });
});
