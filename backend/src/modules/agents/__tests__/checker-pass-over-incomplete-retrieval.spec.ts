import { AgentVerifierHelper } from '../agent-verifier.helper';
import { runEvidence } from '../checker-evidence';

/**
 * Founder's associate demo, staging run 3f328283 (2026-11-24): the agent
 * asked Google Tasks for `dueMax=2026-11-24T23:59:59+01:00`. Google's
 * dueMax compares on the due date and leaves out tasks due on the bound's
 * own day (read-only direct calls the same day: the Acme task due 24 Nov,
 * id YjJsZXVnMjJTNFI1U0RIaA, is missing for any dueMax on 24 Nov, even
 * 23:59:59Z, and present for 2026-11-25T00:00:00Z). The brief said
 * "Nothing is due today", and the report-only check passed it.
 *
 * The check is refute-only: a verdict finding must cite tool data that
 * contradicts a claim. No tool result held the missing task, so nothing
 * contradicted the sentence; the pass was a pass over incomplete
 * retrieval, not evidence the brief was complete. These pin down what the
 * checker sees and what its pass means, so neither drifts unnoticed.
 */
const tasksCall = (tasklist: string, items: Array<{ id: string; title: string; due: string }>) => ({
  type: 'tool_call',
  input: { tool: 'google_tasks_tasks_tasks_list', parameters: { tasklist, showCompleted: false, dueMax: '2026-11-24T23:59:59+01:00' } },
  output: { kind: 'tasks#tasks', items: items.map((t) => ({ kind: 'tasks#task', status: 'needsAction', ...t })) },
});

const run = {
  input: { message: 'Morning brief' },
  steps: [
    tasksCall('ZDFqV3VCclN0clJSdXJwRw', [
      { id: 'dGwzekd6RHUzVG1pajJYTQ', title: 'Approve November payroll', due: '2026-11-20T00:00:00.000Z' },
      { id: 'WEQwN3ZDRi1taVhlNzJCcg', title: 'Send Q3 cohort retention numbers to Priya (Halcyon)', due: '2026-11-23T00:00:00.000Z' },
    ]),
    tasksCall('V1BZdDVJbnRtNVc3T2pwWQ', [{ id: 'ODE2SFQ2czMyaFp5cEVERw', title: 'Renew passport', due: '2026-11-22T00:00:00.000Z' }]),
  ],
};
const brief = 'Overdue: Approve November payroll (4 days late), Renew passport (2 days late), Q3 retention numbers to Priya (1 day late). Nothing is due today.';

describe('a pass over incomplete retrieval', () => {
  it("the checker is shown each call's filter, so a bounded retrieval is visible to it", () => {
    const evidence = runEvidence(run as any);
    expect(evidence).toContain('"dueMax":"2026-11-24T23:59:59+01:00"');
    // The task the filter left out is in no tool result: nothing the checker
    // read could contradict "Nothing is due today".
    expect(evidence).not.toContain('YjJsZXVnMjJTNFI1U0RIaA');
    expect(evidence).not.toContain('Acme');
  });

  it('a checker that finds no contradiction passes, and the pass carries no finding about completeness', async () => {
    const chat = jest.fn().mockResolvedValue({
      message: { content: JSON.stringify({ verdict: 'pass', failures: [], notes: ['"Nothing is due today" rests on a dueMax-filtered query.'], confirmed: ['3 overdue tasks'] }) },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      cost: 0,
    });
    const panel = await new AgentVerifierHelper({ chat } as any).runPanel(
      { target: brief, checkers: [{ name: 'checker_1', providerId: 'p' }], evidence: runEvidence(run as any) },
      'org',
    );
    expect(panel.verdict).toBe('pass');
    expect(panel.failures).toEqual([]);
    // What the checker would question but could not show stays a note: it
    // never turns a pass into a fail, and is shown on the run.
    expect(panel.notes.map((n) => n.text).join(' ')).toContain('dueMax');
  });

  it('an omission the tool data shows stays a checker note, not a verdict finding', async () => {
    const withTask = {
      ...run,
      steps: [
        tasksCall('ZDFqV3VCclN0clJSdXJwRw', [
          { id: 'YjJsZXVnMjJTNFI1U0RIaA', title: 'Decide on Acme renewal discount before the Marcus call', due: '2026-11-24T00:00:00.000Z' },
        ]),
      ],
    };
    const chat = jest.fn().mockResolvedValue({
      message: {
        content: JSON.stringify({
          verdict: 'fail',
          failures: [{ claim: 'Nothing is due today.', evidence: '"title":"Decide on Acme renewal discount before the Marcus call","due":"2026-11-24T00:00:00.000Z"', rule: 'a task is due today' }],
          notes: [],
          confirmed: [],
        }),
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      cost: 0,
    });
    const panel = await new AgentVerifierHelper({ chat } as any).runPanel(
      { target: brief, checkers: [{ name: 'checker_1', providerId: 'p' }], evidence: runEvidence(withTask as any) },
      'org',
    );
    // Even with the task in the tool data, "Nothing is due today" is an
    // omission, not a value that differs from the tool data, so the code
    // does not verify it as a finding: the report-only check passes and the
    // checker's objection is kept as a note on the run. Catching it is the
    // retrieval's job (list the open tasks, compare due dates by calendar
    // date), not this check's.
    expect(panel.verdict).toBe('pass');
    expect(panel.failures).toEqual([]);
    expect(panel.notes.map((n) => n.text).join(' ')).toContain('a task is due today');
  });
});
