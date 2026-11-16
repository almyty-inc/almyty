/**
 * The ten rc6 runs from staging (2026-11-12), replayed end to end through
 * the verdict logic: the stored tool results become the evidence the
 * checker is given (runEvidence), the code checks run on the stored
 * answer, and the checker model's stored reply is played back through
 * runPanel, which verifies each of its failures against the evidence.
 *
 * The expected verdict follows the ground truth in results.tsv, where
 * every answer was checked by hand against the live APIs (curl): an answer
 * that is wrong fails, a right one passes.
 *
 * | run | answer (by hand) | expected |
 * |-----|------------------|----------|
 * | RD1 db52dcca | no: lists 9 of the 10 works returned, says 10 returned and "No other works matched" | fail |
 * | RD2 6432deb3 | no: says it skipped 10 papers, lists all 10 | fail |
 * | RD3 e3acd95d | yes: 10/10 entries right | pass |
 * | RD4 c76c1335 | yes: 10/10 entries right | pass |
 * | RW1 22301018 | partly: #67427 (a design question) listed as a high-priority bug; also lists #67389 with the label "aix", which GitHub does not give it | fail |
 * | RW2 49ed3013 | partly: the same #67427 selection; every value matches GitHub | pass, with checker notes |
 * | RW3 e342b57f | no: v5.3.0 (2026-10-09) listed as new in a 2026-10-13 to 2026-11-12 window | fail |
 * | DC1 20f31553 | yes: 8/8 rows match npm | pass |
 * | DC2 bf05f68a | no: dotenv ^16.4.5 -> 18.0.10 marked outdated-minor | fail |
 * | DC3 3e0e5b2f | yes: 8/8 rows match npm | pass |
 *
 * RW1 and RW2 are "partly" right. Which issues count as high priority is
 * a selection judgement, a checker note by the product decision of
 * 2026-11-13, so it fails neither. RW1 still fails, on a value: its
 * #67389 entry says "Labels: aix" where the run's tool result and GitHub
 * (curl, results.tsv round) give it no label. RW2 has no such value, so
 * it passes with its selection judgement on the run as a note; the old
 * verdict failed it on a title complaint that contradicted itself.
 */
import { AgentVerifierHelper } from '../agent-verifier.helper';
import { RC6, evidenceOf, loadRun, type RunFixture } from './fixtures/checker-runs/load';

const EXPECTED: Record<(typeof RC6)[number], 'pass' | 'fail'> = {
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
};

/** What each failed run's note must name: the item and what is wrong. */
const REASONS: Partial<Record<(typeof RC6)[number], RegExp>> = {
  'rc6-RD1-db52dcca': /W7167504345 .*the tool returned it, but the answer leaves it out/,
  'rc6-RD2-6432deb3': /skipped 10 of the 10 works the tool returned, so it should list 0, but it lists 10/,
  'rc6-RW1-22301018': /^#67389: the answer gives the label aix, but the tool results give none$/,
  'rc6-RW3-e342b57f': /^v5\.3\.0 is listed as new, but the tool results date it 2026-10-09/,
  'rc6-DC2-bf05f68a': /^dotenv: the answer says outdated-minor, but 16 to 18 is a major update$/,
};

/**
 * The checker's reply as the run stored it: every failure it kept, and
 * every one the old guards dropped ("not counted: ..." on the step), all
 * played back as failures. The platform's own findings are left out:
 * runPanel makes them again.
 */
function storedReply(fx: RunFixture): string {
  const failures = fx.stored.failures
    .filter((f) => f.kind !== 'deterministic' && !f.code)
    .map((f) => ({ claim: f.claim ?? '', evidence: f.evidence ?? '', rule: f.rule }));
  for (const c of fx.stored.checkers) {
    for (const m of (c.note ?? '').matchAll(/not counted: "([^"]+)"/g)) failures.push({ claim: '', evidence: '', rule: m[1] });
  }
  return JSON.stringify({ verdict: failures.length ? 'fail' : 'pass', failures, notes: [], confirmed: [] });
}

async function replay(name: (typeof RC6)[number]) {
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
    },
    'org',
  );
}

describe('rc6 runs replayed through the verdict logic', () => {
  it.each(RC6.map((name) => [name, EXPECTED[name]] as const))('%s: %s', async (name, expected) => {
    const panel = await replay(name);
    expect(panel.verdict).toBe(expected);
    // Every verdict finding names its item and its field.
    for (const f of panel.failures) {
      expect(f.item).toBeTruthy();
      expect(f.field).toBeTruthy();
    }
    const reason = REASONS[name];
    if (reason) expect(panel.failures.map((f) => f.rule)).toEqual(expect.arrayContaining([expect.stringMatching(reason)]));
    // What the checker model said decides nothing: every verdict finding is the platform's own.
    expect(panel.failures.every((f) => f.kind === 'deterministic')).toBe(true);
  });

  it('predicts all ten as the ground truth has them', async () => {
    const predicted: Record<string, string> = {};
    for (const name of RC6) predicted[name] = (await replay(name)).verdict;
    expect(predicted).toEqual(EXPECTED);
  });

  it('keeps the selection judgements of RW1 and RW2 as checker notes, never as reasons', async () => {
    for (const name of ['rc6-RW1-22301018', 'rc6-RW2-49ed3013'] as const) {
      const panel = await replay(name);
      expect(panel.failures.some((f) => /#67427/.test(f.rule))).toBe(false);
      expect((panel.notes ?? []).length).toBeGreaterThan(0);
    }
    const rw1 = await replay('rc6-RW1-22301018');
    expect(rw1.notes!.some((n) => /#67427/.test(n.text))).toBe(true);
  });

  it('turns the instruction RD1 was failed on into notes; the note on the answer names what is wrong', async () => {
    const panel = await replay('rc6-RD1-db52dcca');
    expect(panel.notes!.some((n) => /^For each remaining work write a numbered entry/.test(n.text))).toBe(true);
    expect(panel.failures.some((f) => /For each remaining work/.test(f.rule))).toBe(false);
  });
});