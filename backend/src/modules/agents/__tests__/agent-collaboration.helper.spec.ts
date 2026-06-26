import { AgentCollaborationHelper } from '../agent-collaboration.helper';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { Agent } from '../../../entities/agent.entity';

/**
 * Per-strategy unit tests for the four collaboration modes the product exposes:
 * sequential | parallel | race | debate. These pin the documented semantics
 * (so the site/docs can state them as tested, not just shipped):
 *   - sequential pipes each agent's output into the next agent's input
 *   - parallel runs all on the SAME input, merges via the judge or concatenates
 *   - race takes the first finisher AND aggregates every racer's cost (budget
 *     safety — losers can't silently bypass maxCostCents)
 *   - debate runs maxRounds rounds (default 3), every debater per round, then
 *     a judge summarizes (or the last round is returned when there's no judge)
 *
 * The runtime + repository are the seams; we inject fakes so no real agent runs.
 */
function makeRuntime() {
  let seq = 0;
  const idToAgent = new Map<string, { agentId: string; input: string }>();
  const startRun = jest.fn(async (agentId: string, _org: string, _user: string, input: string) => {
    const id = `r${++seq}`;
    idToAgent.set(id, { agentId, input });
    return { id };
  });
  const waitForRun = jest.fn(async (id: string) => {
    const a = idToAgent.get(id)!;
    return { agentId: a.agentId, output: `out:${a.agentId}`, totalCost: 1, totalTokens: 10 };
  });
  return {
    startRun,
    waitForRun,
    emitEvent: jest.fn(),
    _inputFor: (id: string) => idToAgent.get(id)?.input,
    _idToAgent: idToAgent,
  };
}

/** Repo whose findOne returns a not-done racer carrying cost (for race aggregation). */
function makeRepo(racerCost = 5) {
  return {
    save: jest.fn(async (r: any) => r),
    findOne: jest.fn(async ({ where: { id } }: any) => ({
      id,
      status: AgentRunStatus.RUNNING,
      totalCost: racerCost,
      totalTokens: racerCost * 10,
      isDone: () => false,
    })),
  };
}

function makeRun(): AgentRun {
  return {
    id: 'parent-run',
    input: 'solve X',
    organizationId: 'org-1',
    userId: 'user-1',
    totalCost: 0,
    totalTokens: 0,
    steps: [],
    status: AgentRunStatus.RUNNING,
    currentStep: 0,
    executionTime: 0,
  } as unknown as AgentRun;
}

function agentWith(collaboration: any): Agent {
  return { id: 'orchestrator', collaboration } as unknown as Agent;
}

describe('AgentCollaborationHelper', () => {
  it('sequential: pipes each agent output into the next agent input, final = last', async () => {
    const runtime = makeRuntime();
    const repo = makeRepo();
    const helper = new AgentCollaborationHelper(repo as any, runtime as any);
    const run = makeRun();
    const agent = agentWith({
      strategy: 'sequential',
      agents: [{ agentId: 'a1', role: 'drafter' }, { agentId: 'a2', role: 'editor' }],
    });

    const result = await helper.runSequentialCollaboration(run, agent);

    expect(result).toBe('done');
    // orchestrator first, then a1, then a2 — chained.
    const calls = runtime.startRun.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['orchestrator', 'a1', 'a2']);
    // a1 received the orchestrator's output; a2 received a1's output.
    const a1RunId = 'r2', a2RunId = 'r3';
    expect(runtime._inputFor(a1RunId)).toBe('out:orchestrator');
    expect(runtime._inputFor(a2RunId)).toBe('out:a1');
    expect(run.output).toBe('out:a2');
    expect(run.status).toBe(AgentRunStatus.COMPLETED);
    expect(run.totalCost).toBe(3); // orchestrator + a1 + a2
    expect(run.steps[0].type).toBe('collaboration_sequential');
  });

  it('parallel (no judge): runs all on the SAME input and concatenates outputs', async () => {
    const runtime = makeRuntime();
    const helper = new AgentCollaborationHelper(makeRepo() as any, runtime as any);
    const run = makeRun();
    const agent = agentWith({
      strategy: 'parallel',
      agents: [{ agentId: 'a1' }, { agentId: 'a2' }],
    });

    await helper.runParallelCollaboration(run, agent);

    // both started with the SAME original input
    expect(runtime._inputFor('r1')).toBe('solve X');
    expect(runtime._inputFor('r2')).toBe('solve X');
    expect(run.output).toContain('out:a1');
    expect(run.output).toContain('out:a2');
    expect(run.totalCost).toBe(2);
    expect((run.steps[0] as any).input.hasJudge).toBe(false);
  });

  it('parallel (with judge): the judge agent merges the outputs into the final answer', async () => {
    const runtime = makeRuntime();
    const helper = new AgentCollaborationHelper(makeRepo() as any, runtime as any);
    const run = makeRun();
    const agent = agentWith({
      strategy: 'parallel',
      agents: [{ agentId: 'a1' }, { agentId: 'a2' }],
      judgeAgentId: 'judge',
    });

    await helper.runParallelCollaboration(run, agent);

    expect(runtime.startRun.mock.calls.map((c) => c[0])).toContain('judge');
    expect(run.output).toBe('out:judge'); // judge's synthesis wins
    expect(run.totalCost).toBe(3); // a1 + a2 + judge
  });

  it('race: first finisher wins AND every racer cost is aggregated (budget safety)', async () => {
    const runtime = makeRuntime();
    const repo = makeRepo(5); // each racer reports cost 5 via findOne
    const helper = new AgentCollaborationHelper(repo as any, runtime as any);
    const run = makeRun();
    const agent = agentWith({
      strategy: 'race',
      agents: [{ agentId: 'a1' }, { agentId: 'a2' }, { agentId: 'a3' }],
    });

    await helper.runRaceCollaboration(run, agent);

    expect(run.status).toBe(AgentRunStatus.COMPLETED);
    expect(String(run.output)).toMatch(/^out:a[123]$/); // some racer won
    // The budget-safety property: cost of ALL 3 racers, not just the winner.
    expect(run.totalCost).toBe(15);
    // Losers were soft-cancelled.
    expect(repo.save).toHaveBeenCalled();
    expect(run.steps[0].type).toBe('collaboration_race');
  });

  it('debate: maxRounds rounds × every debater, then the judge summarizes', async () => {
    const runtime = makeRuntime();
    const helper = new AgentCollaborationHelper(makeRepo() as any, runtime as any);
    const run = makeRun();
    const agent = agentWith({
      strategy: 'debate',
      agents: [{ agentId: 'd1' }, { agentId: 'd2' }],
      judgeAgentId: 'judge',
      maxRounds: 2,
    });

    await helper.runDebateCollaboration(run, agent);

    const started = runtime.startRun.mock.calls.map((c) => c[0]);
    // 2 rounds × 2 debaters + 1 judge = 5 runs
    expect(started.filter((a) => a === 'd1')).toHaveLength(2);
    expect(started.filter((a) => a === 'd2')).toHaveLength(2);
    expect(started.filter((a) => a === 'judge')).toHaveLength(1);
    expect(run.output).toBe('out:judge');
    expect((run.steps[0] as any).input.rounds).toBe(2);
  });

  it('debate: defaults to 3 rounds and, with no judge, returns the last round', async () => {
    const runtime = makeRuntime();
    const helper = new AgentCollaborationHelper(makeRepo() as any, runtime as any);
    const run = makeRun();
    const agent = agentWith({ strategy: 'debate', agents: [{ agentId: 'd1', role: 'pro' }] });

    await helper.runDebateCollaboration(run, agent);

    expect(runtime.startRun.mock.calls.filter((c) => c[0] === 'd1')).toHaveLength(3); // default maxRounds
    expect(String(run.output)).toContain('out:d1'); // last round, no judge
    expect((run.steps[0] as any).input.rounds).toBe(3);
  });

  it('processCollaborationStep: unknown strategy fails the run cleanly', async () => {
    const runtime = makeRuntime();
    const repo = makeRepo();
    const helper = new AgentCollaborationHelper(repo as any, runtime as any);
    const run = makeRun();
    const agent = agentWith({ strategy: 'telepathy', agents: [] });

    const result = await helper.processCollaborationStep(run, agent);

    expect(result).toBe('done');
    expect(run.status).toBe(AgentRunStatus.FAILED);
    expect(run.error).toMatch(/Unknown collaboration strategy/);
    expect(run.steps.some((s: any) => s.type === 'error')).toBe(true);
  });

  it('processCollaborationStep: dispatches each known strategy', async () => {
    const runtime = makeRuntime();
    const helper = new AgentCollaborationHelper(makeRepo() as any, runtime as any);
    for (const strategy of ['sequential', 'parallel', 'race', 'debate']) {
      const run = makeRun();
      const agent = agentWith({ strategy, agents: [{ agentId: 'x' }], maxRounds: 1 });
      const result = await helper.processCollaborationStep(run, agent);
      expect(result).toBe('done');
      expect(run.status).toBe(AgentRunStatus.COMPLETED);
    }
  });
});
