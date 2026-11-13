/**
 * All fifty staging runs of rounds rc5 to rc9 (2026-11-11 to 2026-11-13),
 * replayed end to end through the verdict logic. The stored tool results
 * become the evidence the checker is given (runEvidence). The code checks
 * run on the stored answer with what the step processor hands them: the
 * run's tool results whole, the agent's instructions, and, where the
 * instructions forbid repeating earlier reports or the answer says it
 * skipped some, the agent's earlier answers. The checker model's stored
 * reply is played back through runPanel, its notes through the note
 * verifiers.
 *
 * The expected verdict is the ground truth: every value was checked by hand
 * against the live APIs (results.tsv of each round). Every research digest
 * runs on instructions that say "leave out any paper you already
 * reported", and each re-lists papers that the bodies of the agent's
 * earlier answers listed (research-digest-answers.json); the platform's
 * note above an earlier answer is not a report.
 *
 * | run | answer | expected |
 * |-----|--------|----------|
 * | rc5 RD1 c62aa29a | no: "DOI: None" for 10.17613/zf92n-68j61; all 10 reported before | fail |
 * | rc5 RD2 d4ad7da4, RD3 7e4e631b, RD4 bd98321b | no: all 10 reported before | fail |
 * | rc5 RW1 8a5070c8 | partly: every value right; #67427 has no labels on that day | pass |
 * | rc5 RW2 887a8bfe | yes | pass |
 * | rc5 RW3 dda8789a | no: v5.3.0 outside the window | fail |
 * | rc5 DC1/DC3 | yes | pass |
 * | rc5 DC2 6e00f1e9 | no: summary says 5 major over 6 rows | fail |
 * | rc6 RD1 db52dcca | no: lists 9 of 10, says no other matched; 9 reported before | fail |
 * | rc6 RD2 6432deb3 | no: "skipped 10", lists 10 | fail |
 * | rc6 RD3 e3acd95d, RD4 c76c1335 | no: listed again, reported before | fail |
 * | rc6 RW1 22301018 | no: #67389 "Labels: aix", GitHub gives none | fail |
 * | rc6 RW2 49ed3013 | no: v22.23.5 summary "dependency updates to brotli": its notes have no brotli | fail |
 * | rc6 RW3 e342b57f | no: v5.3.0 outside the window; #7588 (docs), #7427 (question) listed as bugs | fail |
 * | rc6 DC1/DC3 | yes | pass |
 * | rc6 DC2 bf05f68a | no: dotenv 16 -> 18 outdated-minor | fail |
 * | rc7 RD1 0f136ed8 | no: "DOI: <doi> (N/A - no direct DOI...)"; reported before | fail |
 * | rc7 RD2 af3c05c0 | no: 3 "already reported" works never reported | fail |
 * | rc7 RD3 07a3f5c7 | no: RD1 reported all 10 25 s earlier | fail |
 * | rc7 RD4 fcf9e484 | no: "skipped 1" lists 10; 5 reported before | fail |
 * | rc7 RW1 15fca65f | no: v22.23.5 "crypto"; #67427 (question) as a bug | fail |
 * | rc7 RW2 947d8e43 | no: v22.23.5 "dns", "crypto"; #67354 (feature request) as a bug | fail |
 * | rc7 RW3 ab0c73df | no: v5.3.0 outside the window; #7427 (question) as a bug | fail |
 * | rc7 DC1/DC3 | yes | pass |
 * | rc7 DC2 e9cec629 | no: dotenv 16 -> 18 outdated-minor | fail |
 * | rc8 RD1 d99aa38d | no: "in PhilPapers, no DOI."; all 10 reported before | fail |
 * | rc8 RD2 bc75f6f1 | no: 3 "already reported" works never reported | fail |
 * | rc8 RD3 e31b4553 | no: "retrieved 10, skipped 0", lists 4; reported before | fail |
 * | rc8 RD4 d13c5d50 | no: "the remaining 9 new papers", all 9 reported before | fail |
 * | rc8 RW1 64f3b08a | partly: every value right; lists 3 of the qualifying issues (a selection) | pass |
 * | rc8 RW2 d3757bc9 | no: v26.13.1 "critical", v22.23.5 "crypto"; #67427, #67354 as bugs | fail |
 * | rc8 RW3 6d6a8e80 | no: v5.3.0 outside the window | fail |
 * | rc8 DC1/DC2/DC3 | yes | pass |
 * | rc9 RD1 b79da115 | no: re-lists 5 reported works | fail |
 * | rc9 RD2 b37987d4 | no: "skipping 10", lists 10; 3 reported before | fail |
 * | rc9 RD3 fc270572 | no: "skipped 4", leaves out 3; 7 reported before | fail |
 * | rc9 RD4 37f14fe1 | no: "skipped 1", lists 10; 7 reported before | fail |
 * | rc9 RW1 8ca1dcf2 | no: v22.23.5 "undici" (not in its notes); #63826 (question) as a bug | fail |
 * | rc9 RW2 96f7b54a | no: "crypto", "npm"; #63096 (feature request) as a bug; labels fs, stream, util/dotenv made up | fail |
 * | rc9 RW3 941cb583 | no: v5.3.0 outside the window | fail |
 * | rc9 DC1 9f8a4886 | yes (8/8 values; the sort rule is not a value) | pass |
 * | rc9 DC2 0a487018 | no: dotenv 16 -> 18 outdated-minor | fail |
 * | rc9 DC3 93f80a2e | no: summary says 5 outdated major over 4 rows | fail |
 */
import { AgentVerifierHelper } from '../agent-verifier.helper';
import { speaksOfEarlierReports } from '../answer-checks';
import { RC5, RC6, RC7, RC8, RC9, earlierAnswers, evidenceOf, loadRun, wholeToolResults, type RunFixture } from './fixtures/checker-runs/load';

const RUNS = [...RC5, ...RC6, ...RC7, ...RC8, ...RC9] as const;
type Run = (typeof RUNS)[number];

const PASS: ReadonlySet<Run> = new Set<Run>([
  'rc5-RW1-8a5070c8',
  'rc5-RW2-887a8bfe',
  'rc5-DC1-2ee71e77',
  'rc5-DC3-c04b7a9b',
  'rc6-DC1-20f31553',
  'rc6-DC3-3e0e5b2f',
  'rc7-DC1-81411770',
  'rc7-DC3-6f04ad1d',
  'rc8-RW1-64f3b08a',
  'rc8-DC1-22a3aee0',
  'rc8-DC2-986e43dd',
  'rc8-DC3-988ea008',
  'rc9-DC1-9f8a4886',
]);
const EXPECTED = Object.fromEntries(RUNS.map((r) => [r, PASS.has(r) ? 'pass' : 'fail'])) as Record<Run, 'pass' | 'fail'>;

const NEW = (n: number) => new RegExp(`^The answer lists ${n} items? (?:as new|though its instructions say to leave out what it already reported), but this agent's earlier answers already reported`);
const LEGAL_DOI = /^"From Legal Databases to AI-Assisted Justice.*": the answer says it has no DOI \("(.+)"\), but the tool results give 10\.17613\/zf92n-68j61$/;
const WINDOW = /^v5\.3\.0 is listed as new, but the tool results date it 2026-10-09/;
const DOTENV = /^dotenv: the answer says outdated-minor, but 16 to 18 is a major update$/;
const NEVER_REPORTED = /^The answer says it skipped 10 items as already reported, but 3 of them were never reported: W7225839018 .*; W4414382865 .*; W7129283448 .* \(none of this agent's last \d+ answers report them\)$/;
const CATEGORY = (n: string, kind: string) => new RegExp(`^#${n}: the answer lists it as a bug, regression or security issue, but the tool results mark it as ${kind}, and neither its labels nor its title name a problem$`);
const LEFT_OUT = /^W\d+ ".*": the tool returned it, but the answer leaves it out and says "retrieved 10 works; skipped 0"$/;

/** Every reason each failed run is failed on: the item and what is wrong, and nothing else. */
const REASONS: Partial<Record<Run, RegExp[]>> = {
  'rc5-RD1-c62aa29a': [LEGAL_DOI, NEW(10)],
  'rc5-RD2-d4ad7da4': [NEW(10)],
  'rc5-RD3-7e4e631b': [NEW(10)],
  'rc5-RD4-bd98321b': [NEW(10)],
  'rc5-RW3-dda8789a': [WINDOW],
  'rc5-DC2-6e00f1e9': [/^The summary says 5 major, but the table lists 6$/],
  'rc6-RD1-db52dcca': [/skipped 0 of the 10 works the tool returned, so it should list 10, but it lists 9/, /^W7167504345 .*the tool returned it, but the answer leaves it out/, NEW(9)],
  'rc6-RD2-6432deb3': [/skipped 10 of the 10 works the tool returned, so it should list 0, but it lists 10/, NEW(10)],
  'rc6-RD3-e3acd95d': [NEW(9)],
  'rc6-RD4-c76c1335': [NEW(9)],
  'rc6-RW1-22301018': [/^#67389: the answer gives the label aix, but the tool results give none$/],
  'rc6-RW2-49ed3013': [/^v22\.23\.5: the answer's summary names brotli, but the release notes in the tool results never mention it$/],
  'rc6-RW3-e342b57f': [WINDOW, CATEGORY('7588', 'docs'), CATEGORY('7427', 'question')],
  'rc6-DC2-bf05f68a': [DOTENV],
  'rc7-RD1-0f136ed8': [LEGAL_DOI, NEW(10)],
  'rc7-RD2-af3c05c0': [NEVER_REPORTED],
  'rc7-RD3-07a3f5c7': [NEW(10)],
  'rc7-RD4-fcf9e484': [/^The answer says it skipped 1 of the 10 works the tool returned, so it should list 9, but it lists 10$/, NEW(5)],
  'rc7-RW1-15fca65f': [/^v22\.23\.5: the answer's summary names crypto, but the release notes in the tool results never mention it$/, CATEGORY('67427', 'question')],
  'rc7-RW2-947d8e43': [/^v22\.23\.5: the answer's summary names dns and crypto, but the release notes in the tool results never mention them$/, CATEGORY('67354', 'feature request')],
  'rc7-RW3-ab0c73df': [WINDOW, CATEGORY('7427', 'question')],
  'rc7-DC2-e9cec629': [DOTENV],
  'rc8-RD1-d99aa38d': [LEGAL_DOI, NEW(10)],
  'rc8-RD2-bc75f6f1': [NEVER_REPORTED],
  'rc8-RD3-e31b4553': [/^The answer says it skipped 0 of the 10 works the tool returned, so it should list 10, but it lists 4$/, LEFT_OUT, NEW(4)],
  'rc8-RD4-d13c5d50': [NEW(9)],
  'rc8-RW2-d3757bc9': [
    /^v26\.13\.1: the answer's summary names critical, but the release notes in the tool results never mention it$/,
    /^v22\.23\.5: the answer's summary names crypto, but the release notes in the tool results never mention it$/,
    CATEGORY('67427', 'question'),
    CATEGORY('67354', 'feature request'),
  ],
  'rc8-RW3-6d6a8e80': [WINDOW],
  'rc9-RD1-b79da115': [NEW(5)],
  'rc9-RD2-b37987d4': [/^The answer says it skipped 10 of the 10 works the tool returned, so it should list 0, but it lists 10$/, NEW(3)],
  'rc9-RD3-fc270572': [/^The answer says it skipped 4 of the 10 works the tool returned, so it should list 6, but it lists 7$/, NEW(7)],
  'rc9-RD4-37f14fe1': [/^The answer says it skipped 1 of the 10 items the tool returned, so it should list 9, but it lists 10$/, NEW(7)],
  'rc9-RW1-8ca1dcf2': [/^v22\.23\.5: the answer's summary names undici, but the release notes in the tool results never mention it$/, CATEGORY('63826', 'question')],
  'rc9-RW2-96f7b54a': [
    /^v26\.13\.1: the answer's summary names npm, but the release notes in the tool results never mention it$/,
    /^v22\.23\.5: the answer's summary names crypto, but the release notes in the tool results never mention it$/,
    CATEGORY('63096', 'feature request'),
    /^#67429: the answer gives the label fs, but the tool results give none$/,
    /^#67418: the answer gives the label stream, but the tool results give none$/,
    /^#67400: the answer gives the labels util, dotenv, but the tool results give none$/,
  ],
  'rc9-RW3-941cb583': [WINDOW],
  'rc9-DC2-0a487018': [DOTENV],
  'rc9-DC3-93f80a2e': [/^The summary says 5 outdated major, but the table lists 4$/],
};

/**
 * The checker's reply as the run stored it: every failure it gave, those
 * an older guard dropped ("not counted: ..."), and its notes; a stored note
 * with the claim it was about was a failure the round's verdict made a note.
 */
function storedReply(fx: RunFixture): string {
  const failures = fx.stored.failures
    .filter((f) => f.kind !== 'deterministic' && !f.code)
    .map((f) => ({ claim: f.claim ?? '', evidence: f.evidence ?? '', rule: f.rule }));
  for (const c of fx.stored.checkers) {
    for (const m of (c.note ?? '').matchAll(/not counted: "([^"]+)"/g)) failures.push({ claim: '', evidence: '', rule: m[1] });
  }
  const notes: string[] = [];
  for (const n of (fx.stored as { notes?: Array<{ text: string; claim?: string }> }).notes ?? []) {
    if (n.claim) failures.push({ claim: n.claim, evidence: '', rule: n.text });
    else notes.push(n.text);
  }
  return JSON.stringify({ verdict: failures.length ? 'fail' : 'pass', failures, notes, confirmed: [] });
}

export async function replay(name: Run) {
  const fx = loadRun(name);
  const llm = { chat: jest.fn().mockResolvedValue({ message: { content: storedReply(fx) }, cost: 0, usage: { totalTokens: 0 } }) };
  return new AgentVerifierHelper(llm as any).runPanel(
    {
      target: fx.answer,
      checkers: [{ name: 'Answer check', providerId: 'p', model: 'm' }],
      policy: 'any_fail_blocks',
      evidence: evidenceOf(fx),
      rules: fx.instructions,
      now: new Date(fx.now),
      toolResults: wholeToolResults(fx),
      // What prepareCheck reads: the agent's earlier answers, where the answer or its instructions speak of items reported before.
      ...(speaksOfEarlierReports(fx.answer, fx.instructions) ? { earlier: earlierAnswers(fx) } : {}),
    },
    'org',
  );
}

describe('rc5 to rc9 runs replayed through the verdict logic', () => {
  it.each(RUNS.map((name) => [name, EXPECTED[name]] as const))('%s: %s', async (name, expected) => {
    const panel = await replay(name);
    expect(panel.verdict).toBe(expected);
    for (const f of panel.failures) {
      expect(f.item).toBeTruthy();
      expect(f.field).toBeTruthy();
    }
    // Every reason shown is one of the run's true reasons, and every true reason is shown.
    const reasons = REASONS[name] ?? [];
    const rules = Array.from(new Set(panel.failures.map((f) => f.rule)));
    for (const rule of rules) expect([rule, reasons.some((r) => r.test(rule))]).toEqual([rule, true]);
    for (const r of reasons) expect([String(r), rules.some((rule) => r.test(rule))]).toEqual([String(r), true]);
    // What the checker model said decides nothing: every verdict finding is the platform's own.
    expect(panel.failures.every((f) => f.kind === 'deterministic')).toBe(true);
  });

  it('predicts all fifty as the ground truth has them', async () => {
    const predicted: Record<string, string> = {};
    for (const name of RUNS) predicted[name] = (await replay(name)).verdict;
    expect(predicted).toEqual(EXPECTED);
  });

  it('shows none of the rc8 checker notes the tool results prove false', async () => {
    const shown = async (name: Run) => ((await replay(name)).notes ?? []).map((n) => n.text).join('\n');
    expect(await shown('rc8-RW1-64f3b08a')).not.toMatch(/is marked as a prerelease|Issue 67455|Issue 64807/);
    expect(await shown('rc8-RW3-6d6a8e80')).not.toMatch(/Issue 6941 .*should not be included|Issue 7560 .*should not be included/);
    for (const dc of ['rc8-DC1-22a3aee0', 'rc8-DC3-988ea008'] as const) expect(await shown(dc)).not.toMatch(/4\.18\.1 is actually (?:older|a lower)/);
    expect(await shown('rc8-DC2-986e43dd')).not.toMatch(/Sorting order is correct/);
    expect(await shown('rc8-RD1-d99aa38d')).not.toMatch(/correctly states it skipped 0 papers/);
    expect(await shown('rc8-RD4-d13c5d50')).not.toMatch(/the output lists 9 papers, which matches/);
    // And says so on the checker's line.
    expect((await replay('rc8-DC2-986e43dd')).checkers[0].note).toMatch(/note not shown: the tool results show it false/);
  });

  it('shows none of the rc9 checker notes the tool results prove false, and keeps each, with why, for an audit', async () => {
    const run = async (name: Run) => {
      const panel = await replay(name);
      return { shown: (panel.notes ?? []).map((n) => n.text).join('\n'), hidden: panel.hiddenNotes ?? [] };
    };
    const rd2 = await run('rc9-RD2-b37987d4');
    expect(rd2.shown).not.toMatch(/the tool returned 11 works/);
    expect(rd2.hidden).toEqual([expect.objectContaining({ text: expect.stringMatching(/the tool returned 11 works/), why: expect.any(String) })]);
    expect((await run('rc9-RD4-37f14fe1')).shown).not.toMatch(/matches the descending publication date order/);
    const rw1 = await run('rc9-RW1-8ca1dcf2');
    expect(rw1.shown).not.toMatch(/published_at date is wrong/);
    expect(rw1.hidden.filter((n) => /published_at date is wrong/.test(n.text)).map((n) => n.why)).toEqual(Array(3).fill('the answer gives the date the tool results give'));
    const rw3 = await run('rc9-RW3-941cb583');
    expect(rw3.shown).not.toMatch(/Issue #7538 .*should not be included|should list only 1/);
  });
  it('keeps notes the tool results prove right, marked checked, and leaves the rest as they were', async () => {
    const notes = (await replay('rc8-RW2-d3757bc9')).notes ?? [];
    expect(notes.find((n) => /Issue #67354 is labeled 'feature request'/.test(n.text))?.checked).toBe(true);
    expect(notes.find((n) => /Issue #67429 describes a process termination/.test(n.text))?.checked).toBe(true);
    const rd1 = (await replay('rc8-RD1-d99aa38d')).notes ?? [];
    expect(rd1.some((n) => /The titles, authors, venues, and publication dates match/.test(n.text) && !n.checked)).toBe(true);
  });
});
