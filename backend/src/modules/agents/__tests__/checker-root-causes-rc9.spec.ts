/**
 * The general causes behind the rc9 answer-check gate (staging,
 * 2026-11-13): three runs showed a false reason. Every fixture is a real
 * run; the hand-checked truth is in checker-verdicts-replay.spec.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { checkerNotesOf, codeFindings } from '../agent-verifier.helper';
import { AgentStepProcessor } from '../agent-step-processor';
import { AgentRuntimeBuilders } from '../agent-runtime-builders';
import { alreadyReportedBlock } from '../agent-memory.keeper';
import { claimsSkippedAsReported, earlierReportedItems, forbidsRepeats, parseAnswer, speaksOfEarlierReports, splitPlatformNote, toolItems, valueList } from '../answer-checks';
import { judgeNoteBy, screenNotes } from '../checker-notes';
import { earlierAnswers, evidenceOf, loadRun, wholeToolResults } from './fixtures/checker-runs/load';

function findingsOf(name: string, opts: { answer?: string; earlier?: string[] } = {}) {
  const fx = loadRun(name);
  const earlier = opts.earlier ?? (speaksOfEarlierReports(opts.answer ?? fx.answer, fx.instructions) ? earlierAnswers(fx) : undefined);
  return codeFindings({
    request: fx.request,
    answer: opts.answer ?? fx.answer,
    evidence: evidenceOf(fx),
    now: new Date(fx.now),
    whole: wholeToolResults(fx),
    instructions: fx.instructions,
    ...(earlier ? { earlier } : {}),
  });
}

describe("1. an earlier answer reports what its body lists, never the platform's note above it", () => {
  const note = "Note: this answer's check didn't pass: The answer says it skipped 10 items as already reported, but 3 of them were never reported: W7225839018 \"Learning to Become Persians\"; W4414382865.";

  it('splits the note from the body', () => {
    expect(splitPlatformNote(`${note}\n\n1. A paper\n   - DOI: 10.1/abc`)).toEqual({ note, body: '1. A paper\n   - DOI: 10.1/abc' });
    expect(splitPlatformNote('1. A paper')).toEqual({ note: '', body: '1. A paper' });
  });

  it('RD2 b37987d4: W7225839018, named only in rc8 RD2\'s note, is not "already reported"', () => {
    const found = findingsOf('rc9-RD2-b37987d4').find((f) => f.code === 'previously_reported')!;
    expect(found.item.split(', ').sort()).toEqual(['W7130910808', 'W7164183113', 'W7167443195']);
    const items = earlierReportedItems(earlierAnswers(loadRun('rc9-RD2-b37987d4')));
    expect(items.some((it) => it.ids.includes('w7225839018'))).toBe(false);
  });

  it('an item the note names as failed does not count for that answer; prose outside entries does not count', () => {
    const failed = `Note: this answer's check didn't pass: W7000000001: the answer gives DOI 10.1/x, but the tool results give 10.1/y.\n\n1. W7000000001 A paper\n2. W7000000002 Another paper`;
    expect(earlierReportedItems([failed]).map((it) => it.ids[0])).toEqual(['w7000000002']);
    expect(earlierReportedItems(['We looked at W7000000003 but left it out.'])).toEqual([]);
  });
});

describe('2. only a rule in the instructions against repeats holds an answer to earlier reports', () => {
  it('the research digest has the rule; the release watcher and the dependency check do not', () => {
    expect(forbidsRepeats(loadRun('rc9-RD1-b79da115').instructions)).toBe(true);
    expect(forbidsRepeats(loadRun('rc9-RW1-8ca1dcf2').instructions)).toBe(false);
    expect(forbidsRepeats(loadRun('rc9-DC1-9f8a4886').instructions)).toBe(false);
  });

  it('RW1 8ca1dcf2 and RW2 96f7b54a: the heading "New releases" sets nothing off', () => {
    for (const name of ['rc9-RW1-8ca1dcf2', 'rc9-RW2-96f7b54a'] as const) {
      const fx = loadRun(name);
      expect(fx.answer).toMatch(/New releases/);
      expect(speaksOfEarlierReports(fx.answer, fx.instructions)).toBe(false);
      // Even handed every earlier answer, the check does not run.
      expect(findingsOf(name, { earlier: earlierAnswers(loadRun('rc9-RD4-37f14fe1')) }).some((f) => f.code === 'previously_reported')).toBe(false);
    }
  });

  it('words in an answer alone do not set it off ("the remaining 9 new papers" from an agent with no such rule)', () => {
    const fx = loadRun('rc8-RD4-d13c5d50');
    const found = codeFindings({ request: fx.request, answer: fx.answer, evidence: evidenceOf(fx), now: new Date(fx.now), instructions: 'Summarise the papers.', earlier: earlierAnswers(fx) });
    expect(found.some((f) => f.code === 'previously_reported')).toBe(false);
  });
});

describe('3. a phrase that starts with a none word says none, in the one normaliser', () => {
  it.each([
    ['none indicating bug/security explicitly', []],
    ['None (no qualifying labels)', []],
    ['N/A - not labelled', []],
    ['no labels', []],
    ['no-response, needs-info', ['no-response', 'needs-info']],
    ['not-planned', ['not-planned']],
  ])('%p', (text, list) => {
    expect(valueList(text)).toEqual(list);
  });

  it('RW1 8ca1dcf2: no label reason for #67457 or #67455, whose cells say "none indicating bug/security explicitly"', () => {
    expect(findingsOf('rc9-RW1-8ca1dcf2').filter((f) => f.field === 'labels')).toEqual([]);
  });
});

describe('4. a run is told exactly what it is held to, beside its task', () => {
  const fx = loadRun('rc9-RD3-fc270572');
  const items = earlierReportedItems(earlierAnswers(fx));
  const block = alreadyReportedBlock(items);
  /** How the block names a tool item: by the DOI or title its earlier answer gave (the earlier answers give no OpenAlex ids). */
  const named = (name: string, id: string) => {
    const it = toolItems(evidenceOf(loadRun(name))).items.find((x) => x.ids.includes(id.toLowerCase()))!;
    return it.dois[0] ?? it.title;
  };

  it('the list is the check\'s own: every item rc9 RD3 re-listed is in it, QEpy (never reported) is not', () => {
    const relisted = ['W4404573349', 'W7225798192', 'W7225853397', 'W7225870923', 'W7225918253', 'W4404834751', 'W4416169529'];
    for (const id of relisted) expect(block).toContain(named('rc9-RD3-fc270572', id));
    expect(block).not.toContain(named('rc9-RD3-fc270572', 'W7212145999'));
    // Titles and DOIs: what the model sees in what its tools return.
    expect(block).toMatch(/"Retrieval-Augmented Generation Chatbot for Academic Information Services Using GROQ API" — DOI 10\.37373\/tekno\.v14i1\.2526/);
    expect(block.startsWith('[ALREADY REPORTED — DO NOT LIST AGAIN]')).toBe(true);
    // And the check finds exactly those 7 again in RD3's answer.
    const again = findingsOf('rc9-RD3-fc270572').find((f) => f.code === 'previously_reported')!;
    expect(again.item.split(', ').sort()).toEqual([...relisted].sort());
  });

  it('includes runs made before #1174, which carried no reported ids: rc9 RD4 is told of the 6 works rc8 RD4 listed', () => {
    const rd4 = alreadyReportedBlock(earlierReportedItems(earlierAnswers(loadRun('rc9-RD4-37f14fe1'))));
    for (const id of ['W7225804513', 'W7225814773', 'W7225817243', 'W7225823724', 'W4414455531', 'W7225618523', 'W7167443195']) expect(rd4).toContain(named('rc9-RD4-37f14fe1', id));
  });

  it('is in the model\'s context, right after the instructions, on a staging-shaped run', async () => {
    const find = jest.fn().mockResolvedValue(earlierAnswers(fx).map((output, i) => ({ id: `r${i}`, output, createdAt: new Date() })));
    const self = Object.assign(Object.create(AgentStepProcessor.prototype), { s: { runRepository: { find }, logger: { warn: jest.fn() } } });
    const run: any = { id: 'rd3', agentId: 'agent-1', organizationId: 'org-1', createdAt: new Date(fx.now), workingMemory: { memoryRecall: { context: '\n\n## Relevant Memories\n- [long] The user is interested in RAG.' } } };
    await self.alreadyReportedFor(run);
    expect(run.workingMemory.alreadyReported).toBe(block);
    const builders = new AgentRuntimeBuilders({ find: jest.fn(async () => []) } as any, { listActiveRules: jest.fn(async () => []) } as any);
    const agent: any = { id: 'agent-1', instructions: fx.instructions, agentConfig: {}, memoryConfig: { enabled: true } };
    const messages = await builders.buildMessages(agent, run, [], run.workingMemory.memoryRecall.context);
    const system: string = messages[0].content;
    const at = system.indexOf('[ALREADY REPORTED — DO NOT LIST AGAIN]');
    expect(at).toBeGreaterThan(system.indexOf('[INSTRUCTIONS]'));
    expect(at).toBeLessThan(system.indexOf('[RELEVANT MEMORIES]'));
    expect(system.slice(at)).toContain(named('rc9-RD3-fc270572', 'W4404573349'));
  });

  it('the step processor reads it at the start of a run whose instructions forbid repeats', () => {
    const src = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');
    expect(src).toMatch(/if \(forbidsRepeats\(agent\.instructions \?\? ''\) && run\.workingMemory\?\.alreadyReported === undefined\) \{\s*await this\.alreadyReportedFor\(run\);/);
  });
});

describe('5. a skip claim in any tense or word', () => {
  it.each([
    ['I skipping 10 previously reported works.', 10],
    ['Skipping 10 previously reported works.', 10],
    ['I skip 2 already reported papers.', 2],
    ['I left out 3 papers already reported.', 3],
    ['Omitted 1 previously reported work.', 1],
    ['4 were excluded as already reported.', 4],
  ])('%p', (text, n) => {
    expect(claimsSkippedAsReported(`${text}\n\n1. A paper`)).toBe(true);
    const fx = loadRun('rc9-RD2-b37987d4');
    const answer = fx.answer.replace(/I am skipping 10 previously reported works\.|skipping 10 previously reported/i, text);
    void answer;
    expect(parseAnswer(`The tool returned 10 works. ${text}`).outside).toContain(String(n));
  });

  it('RD2 b37987d4: "skipping 10" over a list of 10 is counted', () => {
    expect(findingsOf('rc9-RD2-b37987d4').map((f) => f.rule)).toContain('The answer says it skipped 10 of the 10 works the tool returned, so it should list 0, but it lists 10');
  });
});

describe('6. notes through the counts, sort order, date and issue verifiers; hidden ones kept for an audit', () => {
  const ctxOf = (name: string) => {
    const fx = loadRun(name);
    const evidence = evidenceOf(fx);
    return { answer: fx.answer, evidence, instructions: fx.instructions, findings: findingsOf(name), now: new Date(fx.now) };
  };

  it.each([
    ['rc9-RD2-b37987d4', 'The output claims 10 works returned but the tool returned 11 works.', 'counts'],
    ['rc9-RD4-37f14fe1', 'The order of papers matches the descending publication date order from the evidence.', 'sort order'],
    ['rc9-RW1-8ca1dcf2', 'v26.13.1 published_at date is wrong; should be 2026-11-11T16:44:25Z, not just 2026-11-11', 'date field'],
    ['rc9-RW3-941cb583', 'Issue #7538 has no labels matching bug/regression/security criteria; it should not be included.', 'issue rule'],
    ['rc9-RW3-941cb583', 'Only issue #7532 with \'bug\' label meets the selection criteria; the output lists 10 issues but should list only 1.', 'issue rule'],
  ])('%s: false, by %s', (name, text, by) => {
    expect(judgeNoteBy(text, ctxOf(name))).toEqual({ verdict: 'false', by });
  });

  it('a right count, a right order and a wrong date stay or are marked right', () => {
    expect(judgeNoteBy('The output claims 10 works returned, and the tool returned 10 works.', ctxOf('rc9-RD2-b37987d4')).verdict).toBe('true');
    const wrongDay = loadRun('rc9-RW1-8ca1dcf2').answer.replace("### v26.13.1 'Lithium' (LTS) - 2026-11-11", "### v26.13.1 'Lithium' (LTS) - 2026-11-10");
    expect(judgeNoteBy('v26.13.1 published_at date is wrong', { ...ctxOf('rc9-RW1-8ca1dcf2'), answer: wrongDay }).verdict).toBe('true');
  });

  it('a hidden note keeps its text and why, and the verify step carries it', () => {
    const ctx = ctxOf('rc9-RD2-b37987d4');
    const { notes, hidden } = screenNotes([{ checker: 'c', text: 'The output claims 10 works returned but the tool returned 11 works.' }, { checker: 'c', text: 'Plausible lines.' }], ctx);
    expect(notes.map((n) => n.text)).toEqual(['Plausible lines.']);
    expect(hidden).toEqual([{ checker: 'c', text: 'The output claims 10 works returned but the tool returned 11 works.', why: "the tool results and the answer's own counts say otherwise" }]);
    expect(checkerNotesOf({ notes, hiddenNotes: hidden })).toEqual({ notes, hiddenNotes: hidden });
  });
});

describe('7. package and dependency names a release summary gives must be in that release\'s notes', () => {
  it('RW1 8ca1dcf2: undici for v22.23.5; RW2 96f7b54a: npm for v26.13.1; rc6 RW2: brotli for v22.23.5', () => {
    expect(findingsOf('rc9-RW1-8ca1dcf2').filter((f) => f.code === 'release_notes').map((f) => f.rule)).toEqual([
      "v22.23.5: the answer's summary names undici, but the release notes in the tool results never mention it",
    ]);
    expect(findingsOf('rc9-RW2-96f7b54a').filter((f) => f.code === 'release_notes').map((f) => f.item)).toEqual(['v26.13.1', 'v22.23.5']);
    expect(findingsOf('rc6-RW2-49ed3013').map((f) => f.rule)).toEqual(["v22.23.5: the answer's summary names brotli, but the release notes in the tool results never mention it"]);
  });

  it('a name with a version, in any wording, and nothing in prose ("paralleling v26.13.1", "and others", "to patch several")', () => {
    const fx = loadRun('rc9-RW1-8ca1dcf2');
    const line = /- Multiple dependencies updated including brotli, llhttp, sqlite, and undici\.[ \t]*/;
    expect(fx.answer).toMatch(line);
    const withVersion = fx.answer.replace(line, '- llhttp updated to version 9.4.4 and acorn 8.15.0.');
    expect(findingsOf('rc9-RW1-8ca1dcf2', { answer: withVersion }).map((f) => f.rule)).toContain(
      "v26.13.1: the answer's summary names acorn, but the release notes in the tool results never mention it",
    );
    const prose = fx.answer.replace(line, '- Fixes paralleling v24.22.3; dependencies updated for llhttp, sqlite, and others; deps bumped to patch several issues.');
    expect(findingsOf('rc9-RW1-8ca1dcf2', { answer: prose }).filter((f) => f.item === 'v26.13.1')).toEqual([]);
  });
});

describe('a top-level bullet that leads with an identifier is an entry', () => {
  it('RW3 941cb583: "- Issue #7532: ..." bullets are the issues the answer lists', () => {
    const entries = parseAnswer(loadRun('rc9-RW3-941cb583').answer).entries.filter((e) => /^Issue #\d+/.test(e.head));
    expect(entries.length).toBe(10);
    expect(entries[0].text).toMatch(/Labels: bug, 4\.x, 5\.x/);
    const index = toolItems(evidenceOf(loadRun('rc9-RW3-941cb583')));
    void index;
  });
});
