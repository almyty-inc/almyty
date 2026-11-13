/**
 * The root causes of the rc7 answer-check gate (staging, 2026-11-13): one
 * false shown reason, three false passes, one false checker note, and the
 * memory that kept prose where the agent was told to keep ids. Every
 * fixture is a real run of that round; the hand-checked truth is named on
 * each.
 */
import { AgentVerifierHelper, codeFindings } from '../agent-verifier.helper';
import { AgentStepProcessor, EARLIER_ANSWERS_DAYS, EARLIER_ANSWERS_MAX } from '../agent-step-processor';
import { AgentMemoryKeeper, reportedItemsMemory } from '../agent-memory.keeper';
import { answerCodeFindings, claimsSkippedAsReported, parseAnswer, releaseNotesOf, toolItems } from '../answer-checks';
import { earlierAnswers, evidenceOf, loadRun, wholeToolResults } from './fixtures/checker-runs/load';

function findingsOf(name: string, opts: { answer?: string; earlier?: string[]; whole?: boolean } = {}) {
  const fx = loadRun(name);
  return codeFindings({
    request: fx.request,
    answer: opts.answer ?? fx.answer,
    evidence: evidenceOf(fx),
    now: new Date(fx.now),
    ...(opts.earlier ? { earlier: opts.earlier } : {}),
    ...(opts.whole === false ? {} : { whole: wholeToolResults(fx) }),
  });
}

describe('RW1 15fca65f: a label cell "(none)" says the issue has no labels', () => {
  it('raises no label finding on the four issues whose cell is "(none)" and GitHub gives none', () => {
    const found = findingsOf('rc7-RW1-15fca65f');
    expect(found.filter((f) => f.field === 'labels')).toEqual([]);
    expect(found.map((f) => f.rule).join('\n')).not.toMatch(/\(none\)/);
  });

  // The issue search result of the run: #67400 has no labels, #64807 has two.
  const evidence = evidenceOf(loadRun('rc7-RW1-15fca65f'));
  const row = (labels: string, issue = '67400') =>
    `| Number | Title | Labels |\n|---|---|---|\n| ${issue} | an issue | ${labels} |`;

  it.each(['(none)', '[none]', '(N/A)', '*(none)*', '(no labels)', '—', ''])('reads %p as no labels', (cell) => {
    expect(answerCodeFindings({ answer: row(cell), evidence }).filter((f) => f.field === 'labels')).toEqual([]);
  });

  it('still says when "(none)" is given for an issue GitHub gives labels', () => {
    expect(answerCodeFindings({ answer: row('(none)', '64807'), evidence }).map((f) => f.rule)).toEqual([
      '#64807: the answer says it has no labels, but the tool results give s390x, linux',
    ]);
  });

  it('a value in brackets that is not none-like is still a label', () => {
    expect(answerCodeFindings({ answer: row('(bug)'), evidence }).map((f) => f.rule)).toEqual(['#67400: the answer gives the label (bug), but the tool results give none']);
  });
});

describe('RD1 0f136ed8: a DOI field that gives the DOI and says there is none', () => {
  it('fails, naming the item and the DOI field', () => {
    expect(findingsOf('rc7-RD1-0f136ed8')).toEqual([
      expect.objectContaining({
        item: '"From Legal Databases to AI-Assisted Justice: A Risk-Sensiti…"',
        field: 'DOI',
        code: 'item_field',
        rule: '"From Legal Databases to AI-Assisted Justice: A Risk-Sensiti…": the answer gives DOI 10.17613/zf92n-68j61 and in the same field says "(N/A - no direct DOI, but link available)", as if it had none',
      }),
    ]);
  });

  it('a DOI field with the DOI alone, or with words that do not deny it, is right', () => {
    const fx = loadRun('rc7-RD1-0f136ed8');
    const plain = fx.answer.replace(' (N/A - no direct DOI, but link available)', '');
    expect(findingsOf('rc7-RD1-0f136ed8', { answer: plain })).toEqual([]);
    const aside = fx.answer.replace(' (N/A - no direct DOI, but link available)', ' (resolves to the PhilPapers record)');
    expect(findingsOf('rc7-RD1-0f136ed8', { answer: aside })).toEqual([]);
  });
});

describe('RD2 af3c05c0: "skipped 10 as already reported", against what the agent reported before', () => {
  const fx = loadRun('rc7-RD2-af3c05c0');
  const earlier = earlierAnswers(fx);

  it('the answer claims a skip as already reported; a digest that skipped none does not', () => {
    expect(claimsSkippedAsReported(fx.answer)).toBe(true);
    expect(claimsSkippedAsReported(loadRun('rc7-RD1-0f136ed8').answer)).toBe(false);
    expect(claimsSkippedAsReported(loadRun('rc7-RD3-07a3f5c7').answer)).toBe(false);
  });

  it('names the three works no earlier answer of the agent reported', () => {
    const found = findingsOf('rc7-RD2-af3c05c0', { earlier });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ item: 'W7225839018, W4414382865, W7129283448', field: 'already reported', code: 'skipped_not_reported', kind: 'deterministic' });
    expect(found[0].evidence).toBe('3 skipped items are in no earlier answer: W7225839018, W4414382865, W7129283448');
  });

  it('says nothing when every skipped work was in an earlier answer', () => {
    const all = [...earlier, 'W7225839018 W4414382865 https://doi.org/10.1371/journal.pone.0361887'];
    expect(findingsOf('rc7-RD2-af3c05c0', { earlier: all })).toEqual([]);
  });

  it('reads an earlier answer by DOI or by whole title as well as by OpenAlex id', () => {
    const byDoi = [...earlier, 'DOI: https://doi.org/10.1016/j.ecolecon.2026.109287', 'Learning to Become Persians. Achaemenid Afġānistān in the Making', '10.1371/journal.pone.0361887'];
    const found = findingsOf('rc7-RD2-af3c05c0', { earlier: byDoi });
    // The Achaemenid title in the tool result is longer than the one written here: it is not the whole title.
    expect(found.map((f) => f.item)).toEqual(['W7225839018']);
  });

  it('is not checked without the agent\'s history, nor on an answer that lists what it says it skipped', () => {
    expect(findingsOf('rc7-RD2-af3c05c0')).toEqual([]);
    // RD4 says it skipped 1 and lists all 10: the count check names that, not this one.
    const rd4 = loadRun('rc7-RD4-fcf9e484');
    expect(findingsOf('rc7-RD4-fcf9e484', { earlier: earlierAnswers(rd4) }).map((f) => f.code)).toEqual(['count']);
  });

  it('reads the earlier answers only for such a claim, from this agent, bounded in count and days', async () => {
    const find = jest.fn().mockResolvedValue([{ id: 'r0', output: 'W7225839018 reported', createdAt: new Date() }]);
    const self = Object.assign(Object.create(AgentStepProcessor.prototype), {
      s: {
        toolRepository: { manager: { getRepository: () => ({ findOne: jest.fn().mockResolvedValue(null) }) } },
        runRepository: { find },
        logger: { warn: jest.fn() },
      },
    });
    const run: any = { id: 'run-2', agentId: 'agent-1', organizationId: 'org-1', createdAt: new Date('2026-11-13T12:52:09Z'), input: { message: fx.request }, steps: [] };
    const plain = await self.prepareCheck(run, null, [{ providerId: 'p', model: 'm' }], loadRun('rc7-RD3-07a3f5c7').answer);
    expect(find).not.toHaveBeenCalled();
    expect(plain.earlier).toBeUndefined();

    const claimed = await self.prepareCheck(run, null, [{ providerId: 'p', model: 'm' }], fx.answer);
    expect(claimed.earlier).toEqual(['W7225839018 reported']);
    const query = find.mock.calls[0][0];
    expect(query.take).toBe(EARLIER_ANSWERS_MAX);
    expect(query.where).toMatchObject({ agentId: 'agent-1', organizationId: 'org-1', status: 'completed' });
    const [since, before] = query.where.createdAt.value;
    expect(before).toEqual(run.createdAt);
    expect((before.getTime() - since.getTime()) / 86_400_000).toBe(EARLIER_ANSWERS_DAYS);
    expect(query.select).toEqual({ id: true, output: true, createdAt: true });
  });

  it('hands the earlier answers to the code checks through the panel', async () => {
    const chat = jest.fn().mockResolvedValue({ message: { content: JSON.stringify({ verdict: 'pass', failures: [], notes: [], confirmed: [] }) }, usage: {} });
    const panel = await new AgentVerifierHelper({ chat } as any).runPanel(
      { target: fx.answer, checkers: [{ name: 'c', providerId: 'p', model: 'm' }], evidence: evidenceOf(fx), now: new Date(fx.now), earlier },
      'org',
    );
    expect(panel.verdict).toBe('fail');
    expect(panel.failures[0].code).toBe('skipped_not_reported');
  });
});

describe('RD2, its root: the digest memory keeps the ids it reported', () => {
  const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model' } as any;
  const agent = { id: 'agent-1', name: 'Research digest', memoryConfig: { enabled: true, save: 'facts' } } as any;
  /** A finished run of the fixture, as afterRun reads it: its request, answer and tool steps. */
  const runOf = (name: string): any => {
    const fx = loadRun(name);
    return {
      id: name, organizationId: 'org-1', userId: 'u-1', endUserId: null, conversationId: null, metadata: {}, workingMemory: {}, totalCost: 0,
      createdAt: new Date(fx.now),
      input: { message: fx.request },
      output: fx.answer,
      steps: fx.tools.map((t) => ({ type: 'tool_call', input: { tool: t.tool, toolId: 't-1', parameters: t.parameters }, output: t.output })),
    };
  };
  // Facts the agent saved on staging during rc7 (mem-after snapshot): prose, and not one id.
  const PROSE = [
    'The user has recorded DOIs and OpenAlex IDs of these works to avoid duplicates.',
    "A significant paper on RAG evaluation is 'Retrieval-Augmented Generation Chatbot for Academic Information Services Using GROQ API' by Inda Fadila Ainul Hawa, published 2026-11-12.",
  ];

  async function saveAfter(name: string) {
    const memoryAccounts = { put: jest.fn(async () => ({ id: 'mem-1' })), search: jest.fn() };
    const callModel = jest.fn(async () => ({ content: JSON.stringify({ facts: PROSE }) }));
    const k = new AgentMemoryKeeper({ memoryAccounts, logger: { warn: jest.fn() } } as any, { callModel } as any);
    const run = runOf(name);
    await k.afterRun(agent, run, { main: MAIN } as any);
    const saved = (memoryAccounts.put.mock.calls as any[]).map((c) => c[2].content as string);
    return { saved, run, puts: memoryAccounts.put.mock.calls as any[] };
  }

  it('saves the OpenAlex id and DOI of each of the ten works RD1 reported, beside the facts', async () => {
    const { saved, run, puts } = await saveAfter('rc7-RD1-0f136ed8');
    expect(saved.slice(0, 2)).toEqual(PROSE);
    const items = saved[2];
    expect(items).toMatch(/^Reported in the answer to "retrieval augmented generation evaluation, since 2026-11-01" on 2026-11-13 \(10 items\): W\d+ \(DOI /);
    expect(items).toContain('W7167504345 (DOI 10.17613/zf92n-68j61)');
    expect(items.match(/\bW\d{6,12}\b/g)).toHaveLength(10);
    expect(puts[2][2].tags).toContain('reported-items');
    expect(run.steps.at(-1)).toMatchObject({ type: 'memory_save', output: { saved: 3, reportedItems: true } });
  });

  it('run 2 can then skip exactly run 1\'s items: of RD2\'s ten works, the four RD1 reported', async () => {
    const { saved } = await saveAfter('rc7-RD1-0f136ed8');
    const memory = saved.join('\n');
    const rd2 = toolItems(evidenceOf(loadRun('rc7-RD2-af3c05c0'))).items;
    const remembered = rd2.filter((it) => it.ids.some((id) => memory.includes(id.toUpperCase()))).map((it) => it.ids[0].toUpperCase());
    expect(remembered.sort()).toEqual(['W4416965058', 'W7128530100', 'W7159584895', 'W7212323002']);
    // The prose alone, all the agent kept before, lets it recognise none of them.
    expect(rd2.filter((it) => it.ids.some((id) => PROSE.join('\n').includes(id.toUpperCase())))).toEqual([]);
    // And a run 2 that skips exactly those four, as already reported, passes the skip check.
    const kept = rd2.filter((it) => !remembered.includes(it.ids[0].toUpperCase()));
    const answer = `The tool returned 10 works. I skipped 4 as already reported.\n\n${kept.map((it, i) => `${i + 1}. ${it.title}\n   - DOI: ${it.dois[0] ?? 'none'}`).join('\n')}`;
    const fx = loadRun('rc7-RD2-af3c05c0');
    expect(codeFindings({ request: fx.request, answer, evidence: evidenceOf(fx), now: new Date(fx.now), earlier: [loadRun('rc7-RD1-0f136ed8').answer] })).toEqual([]);
  });

  it('keeps no ids for an answer that lists nothing the tool results identify', () => {
    const run = runOf('rc7-RD2-af3c05c0');
    expect(reportedItemsMemory(run)).toBeNull();
  });

  it('screens the ids through the never-save rules like any save', async () => {
    const memoryAccounts = { put: jest.fn(async () => ({ id: 'mem-1' })), search: jest.fn() };
    const callModel = jest.fn(async (_run: any, _role: any, req: any) =>
      /You check text before/.test(req.messages[0].content) ? { content: 'NOTHING' } : { content: JSON.stringify({ facts: [] }) },
    );
    const k = new AgentMemoryKeeper({ memoryAccounts, logger: { warn: jest.fn() } } as any, { callModel } as any);
    await k.afterRun({ ...agent, memoryConfig: { enabled: true, save: 'facts', neverSave: 'paper ids' } }, runOf('rc7-RD1-0f136ed8'), { main: MAIN } as any);
    expect(memoryAccounts.put).not.toHaveBeenCalled();
  });
});

describe('RW2 947d8e43: technical terms a release summary gives that its notes do not', () => {
  it('fails v22.23.5 for "dns" and "crypto", read from the notes whole', () => {
    expect(findingsOf('rc7-RW2-947d8e43')).toEqual([
      expect.objectContaining({
        item: 'v22.23.5',
        field: 'release notes',
        code: 'release_notes',
        rule: "v22.23.5: the answer's summary names dns and crypto, but the release notes in the tool results never mention them",
        claim: '- Security release aligned with higher branches fixing http, dns, tls and crypto issues.',
      }),
    ]);
  });

  it('reads no notes the tool results hold only in part: without them whole there is no finding', () => {
    expect(findingsOf('rc7-RW2-947d8e43', { whole: false })).toEqual([]);
  });

  it('reads the notes\' own module names, and none that is an everyday word', () => {
    const fx = loadRun('rc7-RW2-947d8e43');
    const { vocabulary, byTag } = releaseNotesOf(toolItems(evidenceOf(fx)), wholeToolResults(fx));
    expect(Array.from(vocabulary)).toEqual(expect.arrayContaining(['crypto', 'dns', 'http', 'http2', 'tls', 'child_process', 'sqlite', 'permission']));
    for (const word of ['doc', 'test', 'deps', 'build', 'tools', 'fix', 'stream', 'process', 'module']) expect(vocabulary.has(word)).toBe(false);
    // The notes of v22.23.5 whole (5,581 characters), not the 500 the stored step kept.
    expect(byTag.get('v22.23.5')!.length).toBeGreaterThan(5000);
    expect(byTag.get('v22.23.5')).toMatch(/http2: release headers when a stream is removed/);
  });

  it.each([
    'rc5-RW1-8a5070c8',
    'rc5-RW2-887a8bfe',
    'rc5-RW3-dda8789a',
    'rc6-RW1-22301018',
    'rc6-RW2-49ed3013',
    'rc6-RW3-e342b57f',
    'rc7-RW3-ab0c73df',
  ])('no release-notes finding on %s, whose summaries are true to the notes', (name) => {
    expect(findingsOf(name).filter((f) => f.code === 'release_notes')).toEqual([]);
  });

  it('the summaries of the other three rc7 RW2 releases name terms, and all are in their notes', () => {
    const fx = loadRun('rc7-RW2-947d8e43');
    const parsed = parseAnswer(fx.answer);
    const sections = parsed.entries.filter((e) => e.kind === 'section').map((e) => e.head.split(' ')[0]);
    expect(sections).toEqual(['v27.0.0-alpha.0.1.0', 'v26.13.1', 'v24.22.3', 'v22.23.5']);
    expect(findingsOf('rc7-RW2-947d8e43').map((f) => f.item)).toEqual(['v22.23.5']);
  });

  it('a summary that adds a module to a release, any case, is caught; one that only paraphrases is not', () => {
    const fx = loadRun('rc7-RW2-947d8e43');
    const added = fx.answer.replace('- Dependency updates to brotli, llhttp, sqlite, and undici.', '- Dependency updates to brotli, llhttp, sqlite, and undici; fixes in Inspector and child_process.');
    expect(findingsOf('rc7-RW2-947d8e43', { answer: added }).map((f) => f.rule)).toContain(
      "v24.22.3: the answer's summary names inspector and child_process, but the release notes in the tool results never mention them",
    );
    const prose = fx.answer.replace('fixing http, dns, tls and crypto issues', 'fixing several high severity issues in the networking stack');
    expect(findingsOf('rc7-RW2-947d8e43', { answer: prose })).toEqual([]);
  });
});

describe('an issue listed as a bug whose issue type says otherwise', () => {
  const fx = loadRun('rc7-RW3-ab0c73df');
  const evidence = evidenceOf(fx);
  const list = (issue: string) => `## High-priority open issues (bugs, regressions, security)\n\n1. [#${issue}](https://github.com/expressjs/express/issues/${issue}) an issue`;

  it('keeps an issue of type Task whose title names a security fix (#7564)', () => {
    expect(answerCodeFindings({ answer: list('7564'), evidence }).filter((f) => f.field === 'issue type')).toEqual([]);
  });

  it('fails one of type Feature whose labels and title name no problem', () => {
    const edited = evidence.replace('"title":"Express 4: update body-parser minimum to 1.20.9 for security fix"', '"title":"Express 4: update body-parser minimum to 1.20.9"').replace('"module:body-parser"', '"module:parser"').replace('"name":"Task"', '"name":"Feature"');
    expect(answerCodeFindings({ answer: list('7564'), evidence: edited }).filter((f) => f.field === 'issue type').map((f) => f.rule)).toEqual([
      '#7564: the answer lists it under "High-priority open issues (bugs, regressions, security)", but the tool results give it the issue type Feature, and neither its labels nor its title name a problem',
    ]);
  });

  it('labels alone decide nothing: #67354 "feature request", with no issue type, stays a note (rc7 RW2)', () => {
    expect(findingsOf('rc7-RW2-947d8e43').some((f) => /#67354/.test(f.rule))).toBe(false);
  });
});

describe('DC1 81411770: "cut off at its output limit" only when it was', () => {
  // A reply that is not whole JSON: its last brace is missing. DC1's checker wrote 703 of 8,192 tokens.
  const malformed = '{"verdict":"pass","failures":[],"notes":["lodash 4.18.1 is current"],"confirmed":["lodash"]';
  const check = async (response: Record<string, unknown>) => {
    const chat = jest.fn().mockResolvedValue({ message: { content: malformed, ...(response.finishReason ? { finishReason: response.finishReason } : {}) }, usage: response.usage ?? {} });
    const panel = await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'x', checkers: [{ name: 'dep-checker', providerId: 'p', model: 'm', maxTokens: 8192 }] }, 'org');
    return panel.checkers[0].note;
  };

  it('a malformed reply well under its limit is said to be malformed', async () => {
    expect(await check({ usage: { outputTokens: 703 } })).toBe("the checker's reply was not well-formed JSON; it was read up to its last complete item");
  });

  it('a reply the provider says hit its limit, or that used every token, is said to be cut off', async () => {
    const cut = "the checker's reply was cut off at its output limit (8192 tokens); it was read up to its last complete item";
    expect(await check({ finishReason: 'length', usage: { outputTokens: 8192 } })).toBe(cut);
    expect(await check({ usage: { outputTokens: 8192 } })).toBe(cut);
  });
});

describe('the step processor hands the code checks what they read', () => {
  it('the final-answer check gets the tool results whole and, for a skip claim, the agent\'s earlier answers', async () => {
    const panel = { verdict: 'pass', passed: true, policy: 'any_fail_blocks', failures: [], passedRules: [], checkers: [], cost: 0, tokens: 0 };
    const verifier = { runPanel: jest.fn().mockResolvedValue(panel) };
    const messages = [
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'openalex_search_works', parameters: { search: 'x' } }], content: '' },
      { role: 'tool', toolCallId: 'c1', content: '{"results":[]}' },
    ];
    const s = {
      toolRepository: { manager: { getRepository: () => ({ findOne: async () => null }) } },
      messageRepository: { find: jest.fn().mockResolvedValue(messages) },
      runRepository: { find: jest.fn().mockResolvedValue([{ id: 'r0', output: 'an earlier digest' }]) },
      logger: { warn: jest.fn() },
    };
    const processor = new AgentStepProcessor(s as any, verifier as any, {} as any, {} as any);
    const run: any = { id: 'r', agentId: 'a', organizationId: 'o', conversationId: 'conv', createdAt: new Date(), input: 'q', steps: [], totalCost: 0, totalTokens: 0, metadata: {} };
    const agent: any = { agentConfig: { verify: { enabled: true, checkers: [{ providerId: 'p', model: 'm' }] } } };
    await (processor as any).runAutonomousVerify(run, agent, 'The tool returned 10 works. I skipped 10 as already reported.');
    const opts = verifier.runPanel.mock.calls[0][0];
    expect(opts.toolResults).toEqual([{ tool: 'openalex_search_works', parameters: { search: 'x' }, content: '{"results":[]}' }]);
    expect(opts.earlier).toEqual(['an earlier digest']);
  });

  it('a strategy\'s checker gets the same', async () => {
    const { AutonomousStrategyRunner } = await import('../autonomous-strategy.runner');
    const runPanel = jest.fn().mockResolvedValue({ cost: 0, tokens: 0 });
    const runner = Object.assign(Object.create(AutonomousStrategyRunner.prototype), { verifier: { runPanel } });
    const run: any = { organizationId: 'o', totalCost: 0, totalTokens: 0, metadata: {} };
    const whole = [{ tool: 't', content: '{}' }];
    await runner.check(run, { key: 'checker', name: 'Checker', purpose: 'checker', kind: 'model', providerId: 'p', model: 'm' }, 'answer', undefined, { evidence: 'e', earlier: ['x'], toolResults: whole });
    expect(runPanel.mock.calls[0][0]).toMatchObject({ earlier: ['x'], toolResults: whole });
  });
});
