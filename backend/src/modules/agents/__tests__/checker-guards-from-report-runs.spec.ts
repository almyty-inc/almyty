import { AgentVerifierHelper } from '../agent-verifier.helper';
import { falseDateArithmetic } from '../date-arithmetic';
import { falseVersionOrder } from '../version-order';

/**
 * The deterministic guards on a checker's failures, from 30 staging runs
 * (2026-11-12). The verdict is shown on every answer, so a guard that
 * drops a right failure makes a false pass, and one that misses a
 * confirmation makes a false fail.
 */

const now = new Date('2026-11-12T03:14:00.000Z');

describe('day arithmetic is judged only when both dates are written in the sentence', () => {
  // Run 7c905dfe, verify step #6: the checker measured "4 days" from the
  // window start; the guard measured from today, called it wrong, and
  // dropped a right failure.
  const fromWindowStart =
    'Release published_at date is outside the 30-day look-back window (2026-10-13 to 2026-11-12). 2026-10-09 is before 2026-11-12 minus 30 days, so it falls 4 days before the window start.';

  it('keeps a count measured from something that is not a date (run 7c905dfe)', () => {
    expect(falseDateArithmetic(fromWindowStart, now)).toBeNull();
    expect(falseDateArithmetic('2026-10-09 is 4 days earlier than the window start, 2026-11-12 being today.', now)).toBeNull();
  });

  it('keeps a count against "the current date" when the sentence does not write that date', () => {
    expect(falseDateArithmetic('v5.3.0 was published 2026-10-09, which is 25 days before the current date.', now)).toBeNull();
    expect(falseDateArithmetic('published 2026-10-09, 25 days ago', now)).toBeNull();
  });

  it('reads a window range by its end, not its start', () => {
    expect(falseDateArithmetic('2026-10-09 is outside the 30-day look-back window (2026-10-13 to 2026-11-12).', now)).toBeNull();
  });

  it('still judges a statement whose two dates are both written', () => {
    expect(falseDateArithmetic('Updated 2026-10-05, 30 days before 2026-11-12.', now)).toMatch(/38 days before 2026-11-12, not 30/);
    expect(falseDateArithmetic('2026-10-09 is 4 days before today (2026-11-12).', now)).toBe('2026-10-09 is 34 days before 2026-11-12, not 4');
    expect(falseDateArithmetic('A release published 2026-10-29 is within the 7-day look-back window (current time 2026-11-12).', now)).toMatch(/14 days from 2026-11-12/);
  });

  it('readFailures keeps the failure of run 7c905dfe, so the check fails', () => {
    const read = new AgentVerifierHelper({} as any).readFailures(
      { verdict: 'fail', failures: [{ claim: '### v5.3.0 (2026-10-09)', rule: fromWindowStart, evidence: '' }] },
      'release-checker',
      '',
      now,
    );
    expect(read.failures).toHaveLength(1);
    expect(read.discarded).toEqual([]);
  });
});

describe('a version set beside itself is not a false order claim', () => {
  // Run 6933d7e2, the last check: "^1.6.0 means >=1.6.0" read as
  // "1.6.0 is newer than 1.6.0", which dropped the premise (axios is up to
  // date) while the failures that followed from it stayed.
  const premise =
    "Latest version 1.21.1 is within the range ^1.6.0 (^1.6.0 means >=1.6.0 <2.0.0), so status should be 'up to date', not 'outdated-minor'.";

  it('never calls an equal-versions comparison false', () => {
    expect(falseVersionOrder(premise)).toBeNull();
    expect(falseVersionOrder('1.6.0 >= 1.6.0')).toBeNull();
    expect(falseVersionOrder('v2.0.0 is not newer than 2.0.0, it is newer than 2.0.0')).toBeNull();
  });

  it('still drops a false order between different versions', () => {
    expect(falseVersionOrder('4.18.1 is OLDER than 4.17.21')).toMatch(/4\.18\.1 is the newer one/);
    expect(falseVersionOrder('^1.6.0 means >=1.6.0 <1.5.0')).toMatch(/1\.6\.0 is not older than 1\.5\.0/);
  });

  it('readFailures keeps the premise of run 6933d7e2', () => {
    const read = new AgentVerifierHelper({} as any).readFailures(
      { verdict: 'fail', failures: [{ claim: 'axios | ^1.6.0 | 1.21.1 | outdated-minor', rule: premise, evidence: 'npm returned axios@1.21.1' }] },
      'dep-checker',
      '',
      now,
    );
    expect(read.failures.map((f) => f.claim)).toEqual(['axios | ^1.6.0 | 1.21.1 | outdated-minor']);
  });
});

describe('a failure whose own words say every item is in the answer', () => {
  // Run 6933d7e2, revision 2: claim "The table contains all packages ...".
  // No wording guard reads it any more: it cites no tool data that
  // contradicts the answer, so it is a checker note, never a verdict.
  const rule =
    'The package.json lists 8 packages total (6 dependencies + 2 devDependencies), and the table shows 8 packages, but the table is missing verification that all were checked. However, all 8 packages are present in the table.';
  const evidence =
    'All packages from package.json are in the table: axios, chalk, uuid, node-fetch, dotenv, querystring (dependencies) and jest, eslint (devDependencies).';

  it('is a checker note, not a verdict finding (run 6933d7e2)', () => {
    const answer = "The table contains all packages from the user's package.json";
    const read = new AgentVerifierHelper({} as any).readFailures(
      { verdict: 'fail', failures: [{ claim: answer, rule, evidence }] },
      'dep-checker',
      'REQUEST:\n{}\n\nnpm_get_package_latest {"package":"axios"}:\n{"name":"axios","version":"1.21.1"}',
      now,
      answer,
    );
    expect(read.failures).toEqual([]);
    expect(read.notes).toEqual([expect.objectContaining({ checker: 'dep-checker', text: rule })]);
  });
});