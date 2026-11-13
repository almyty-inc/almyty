/**
 * All thirty staging runs of rounds rc5, rc6 and rc7 (2026-11-11 to
 * 2026-11-13), replayed end to end through the verdict logic: the stored
 * tool results become the evidence the checker is given (runEvidence),
 * the code checks run on the stored answer with what the step processor
 * hands them (the run's tool results whole, and for an answer that says it
 * skipped items as already reported, the agent's earlier answers), and the
 * checker model's stored reply is played back through runPanel.
 *
 * The expected verdict is the ground truth, every answer checked by hand
 * against the live APIs (results.tsv of each round). A wrong answer fails
 * with a reason that names what is wrong; a right one passes. Which issues
 * count as high priority is a selection judgement, a checker note by the
 * product decision of 2026-11-13: an answer wrong only in that passes.
 *
 * | run | answer (by hand) | expected |
 * |-----|------------------|----------|
 * | rc5 RD1 c62aa29a | no: "DOI: None" for a work the tool gives 10.17613/zf92n-68j61 | fail |
 * | rc5 RD2 d4ad7da4 | yes | pass |
 * | rc5 RD3 7e4e631b | yes | pass |
 * | rc5 RD4 bd98321b | yes | pass |
 * | rc5 RW1 8a5070c8 | partly: #67427 (a design question) selected; every value matches | pass, notes |
 * | rc5 RW2 887a8bfe | yes | pass |
 * | rc5 RW3 dda8789a | no: v5.3.0 (2026-10-09) listed as new in a 10-13..11-12 window | fail |
 * | rc5 DC1 2ee71e77 | yes | pass |
 * | rc5 DC2 6e00f1e9 | no: "5 packages have newer major versions" over 6 such rows | fail |
 * | rc5 DC3 c04b7a9b | yes | pass |
 * | rc6 RD1 db52dcca | no: lists 9 of 10, says "No other works matched" | fail |
 * | rc6 RD2 6432deb3 | no: "skipped 10", lists all 10 | fail |
 * | rc6 RD3 e3acd95d | yes | pass |
 * | rc6 RD4 c76c1335 | yes | pass |
 * | rc6 RW1 22301018 | partly: #67389 "Labels: aix", GitHub gives none | fail |
 * | rc6 RW2 49ed3013 | partly: #67427 selected; every value matches | pass, notes |
 * | rc6 RW3 e342b57f | no: v5.3.0 outside the window | fail |
 * | rc6 DC1 20f31553 | yes | pass |
 * | rc6 DC2 bf05f68a | no: dotenv 16 -> 18 called outdated-minor | fail |
 * | rc6 DC3 3e0e5b2f | yes | pass |
 * | rc7 RD1 0f136ed8 | no (minor): "DOI: <the DOI> (N/A - no direct DOI, but link available)" | fail |
 * | rc7 RD2 af3c05c0 | no: "skipped 10 as already reported", 3 never reported by any earlier run | fail |
 * | rc7 RD3 07a3f5c7 | yes | pass |
 * | rc7 RD4 fcf9e484 | no: "skipped 1", lists 10 | fail |
 * | rc7 RW1 15fca65f | partly: v22.23.5 summary adds "crypto"; #67427 selected | fail |
 * | rc7 RW2 947d8e43 | no: v22.23.5 summary invents "dns" and "crypto"; #67354 selected | fail |
 * | rc7 RW3 ab0c73df | no: v5.3.0 outside the window | fail |
 * | rc7 DC1 81411770 | yes | pass |
 * | rc7 DC2 e9cec629 | no: dotenv 16 -> 18 called outdated-minor | fail |
 * | rc7 DC3 6f04ad1d | yes | pass |
 */
import { AgentVerifierHelper } from '../agent-verifier.helper';
import { claimsSkippedAsReported } from '../answer-checks';
import { RC5, RC6, RC7, earlierAnswers, evidenceOf, loadRun, wholeToolResults, type RunFixture } from './fixtures/checker-runs/load';

const RUNS = [...RC5, ...RC6, ...RC7] as const;
type Run = (typeof RUNS)[number];

const EXPECTED: Record<Run, 'pass' | 'fail'> = {
  'rc5-RD1-c62aa29a': 'fail',
  'rc5-RD2-d4ad7da4': 'pass',
  'rc5-RD3-7e4e631b': 'pass',
  'rc5-RD4-bd98321b': 'pass',
  'rc5-RW1-8a5070c8': 'pass',
  'rc5-RW2-887a8bfe': 'pass',
  'rc5-RW3-dda8789a': 'fail',
  'rc5-DC1-2ee71e77': 'pass',
  'rc5-DC2-6e00f1e9': 'fail',
  'rc5-DC3-c04b7a9b': 'pass',
  'rc6-RD1-db52dcca': 'fail',
  'rc6-RD2-6432deb3': 'fail',
  'rc6-RD3-e3acd95d': 'pass',
  'rc6-RD4-c76c1335': 'pass',
  'rc6-RW1-22301018': 'fail',
  'rc6-RW2-49ed3013': 'pass',
  'rc6-RW3-e342b57f': 'fail',
  'rc6-DC1-20f31553': 'pass',
  'rc6-DC2-bf05f68a': 'fail',
  'rc6-DC3-3e0e5b2f': 'pass',
  'rc7-RD1-0f136ed8': 'fail',
  'rc7-RD2-af3c05c0': 'fail',
  'rc7-RD3-07a3f5c7': 'pass',
  'rc7-RD4-fcf9e484': 'fail',
  'rc7-RW1-15fca65f': 'fail',
  'rc7-RW2-947d8e43': 'fail',
  'rc7-RW3-ab0c73df': 'fail',
  'rc7-DC1-81411770': 'pass',
  'rc7-DC2-e9cec629': 'fail',
  'rc7-DC3-6f04ad1d': 'pass',
};

/** Every reason each failed run is failed on: the item and what is wrong, and nothing else. */
const REASONS: Partial<Record<Run, RegExp[]>> = {
  'rc5-RD1-c62aa29a': [/^"From Legal Databases to AI-Assisted Justice.*": the answer says it has no DOI, but the tool results give 10\.17613\/zf92n-68j61$/],
  'rc5-RW3-dda8789a': [/^v5\.3\.0 is listed as new, but the tool results date it 2026-10-09/],
  'rc5-DC2-6e00f1e9': [/^The summary says 5 major, but the table lists 6$/],
  'rc6-RD1-db52dcca': [/skipped 0 of the 10 works the tool returned, so it should list 10, but it lists 9/, /^W7167504345 .*the tool returned it, but the answer leaves it out/],
  'rc6-RD2-6432deb3': [/skipped 10 of the 10 works the tool returned, so it should list 0, but it lists 10/],
  'rc6-RW1-22301018': [/^#67389: the answer gives the label aix, but the tool results give none$/],
  'rc6-RW3-e342b57f': [/^v5\.3\.0 is listed as new, but the tool results date it 2026-10-09/],
  'rc6-DC2-bf05f68a': [/^dotenv: the answer says outdated-minor, but 16 to 18 is a major update$/],
  'rc7-RD1-0f136ed8': [/^"From Legal Databases to AI-Assisted Justice.*": the answer gives DOI 10\.17613\/zf92n-68j61 and in the same field says "\(N\/A - no direct DOI, but link available\)", as if it had none$/],
  'rc7-RD2-af3c05c0': [
    /^The answer says it skipped 10 items as already reported, but 3 of them were never reported: W7225839018 "Learning to Become Persians.*"; W4414382865 "Climate regulation and civil society activism"; W7129283448 "Evaluating AI performance on end-to-end data science projec…" \(none of this agent's last \d+ answers report them\)$/,
  ],
  'rc7-RD4-fcf9e484': [/^The answer says it skipped 1 of the 10 works the tool returned, so it should list 9, but it lists 10$/],
  'rc7-RW1-15fca65f': [/^v22\.23\.5: the answer's summary names crypto, but the release notes in the tool results never mention it$/],
  'rc7-RW2-947d8e43': [/^v22\.23\.5: the answer's summary names dns and crypto, but the release notes in the tool results never mention them$/],
  'rc7-RW3-ab0c73df': [/^v5\.3\.0 is listed as new, but the tool results date it 2026-10-09, before the 30-day window \(2026-10-14 to 2026-11-13\)$/],
  'rc7-DC2-e9cec629': [/^dotenv: the answer says outdated-minor, but 16 to 18 is a major update$/],
};

/**
 * The checker's reply as the run stored it, every failure it gave played
 * back as a failure: those the round's verdict kept, those an older guard
 * dropped ("not counted: ..."), and those the rc7 verdict made notes (a
 * note with the claim it was about). The platform's own findings are left
 * out: runPanel makes them again.
 */
function storedReply(fx: RunFixture): string {
  const failures = fx.stored.failures
    .filter((f) => f.kind !== 'deterministic' && !f.code)
    .map((f) => ({ claim: f.claim ?? '', evidence: f.evidence ?? '', rule: f.rule }));
  for (const c of fx.stored.checkers) {
    for (const m of (c.note ?? '').matchAll(/not counted: "([^"]+)"/g)) failures.push({ claim: '', evidence: '', rule: m[1] });
  }
  for (const n of (fx.stored as { notes?: Array<{ text: string; claim?: string }> }).notes ?? []) {
    if (n.claim) failures.push({ claim: n.claim, evidence: '', rule: n.text });
  }
  return JSON.stringify({ verdict: failures.length ? 'fail' : 'pass', failures, notes: [], confirmed: [] });
}

async function replay(name: Run) {
  const fx = loadRun(name);
  const llm = { chat: jest.fn().mockResolvedValue({ message: { content: storedReply(fx) }, cost: 0, usage: { totalTokens: 0 } }) };
  const helper = new AgentVerifierHelper(llm as any);
  return helper.runPanel(
    {
      target: fx.answer,
      checkers: [{ name: 'Answer check', providerId: 'p', model: 'm' }],
      policy: 'any_fail_blocks',
      evidence: evidenceOf(fx),
      rules: fx.instructions,
      now: new Date(fx.now),
      toolResults: wholeToolResults(fx),
      // What prepareCheck reads: the agent's earlier answers, for an answer that says it skipped items as already reported.
      ...(claimsSkippedAsReported(fx.answer) ? { earlier: earlierAnswers(fx) } : {}),
    },
    'org',
  );
}

describe('rc5, rc6 and rc7 runs replayed through the verdict logic', () => {
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
    for (const rule of rules) expect(reasons.some((r) => r.test(rule))).toBe(true);
    for (const r of reasons) expect(rules.some((rule) => r.test(rule))).toBe(true);
    // What the checker model said decides nothing: every verdict finding is the platform's own.
    expect(panel.failures.every((f) => f.kind === 'deterministic')).toBe(true);
  });

  it('predicts all thirty as the ground truth has them', async () => {
    const predicted: Record<string, string> = {};
    for (const name of RUNS) predicted[name] = (await replay(name)).verdict;
    expect(predicted).toEqual(EXPECTED);
  });

  it('keeps the selection judgements (#67427, #67354) as checker notes, never as reasons', async () => {
    for (const name of ['rc5-RW1-8a5070c8', 'rc6-RW2-49ed3013', 'rc7-RW1-15fca65f', 'rc7-RW2-947d8e43'] as const) {
      const panel = await replay(name);
      expect(panel.failures.some((f) => /#67427|#67354|#66951/.test(f.rule))).toBe(false);
      expect((panel.notes ?? []).length).toBeGreaterThan(0);
    }
    const rw2 = await replay('rc7-RW2-947d8e43');
    expect(rw2.notes!.some((n) => /#67354/.test(n.text))).toBe(true);
  });
});
