import { AgentCollaborationHelper } from '../agent-collaboration.helper';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { Agent } from '../../../entities/agent.entity';
import { principalOfRun } from '../../../common/authorization/execution-access.service';

/**
 * Per-strategy unit tests for the four collaboration modes the product exposes:
 * sequential | parallel | race | debate. These pin the documented semantics
 * (so the site/docs can state them as tested, not just shipped):
 *   - sequential pipes each participant's output into the next one's input
 *   - parallel runs all on the SAME input, merges via the judge or concatenates
 *   - race takes the first finisher AND aggregates every racer's cost (budget
 *     safety — losers can't silently bypass maxCostCents)
 *   - debate runs maxRounds rounds (default 3), every debater per round, then
 *     a judge summarizes (or the last round is returned when there's no judge)
 * A participant is an agent (child run) or a model (one chat call); every
 * strategy and the judge accept both.
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
  // Model participants: one chat call each. Default answer names the model
  // and echoes the user message so piping is observable.
  const chat = jest.fn(async (providerId: string | null, req: any, _org?: string, _user?: string) => {
    const user = req.messages.find((m: any) => m.role === 'user')?.content;
    return {
      message: { role: 'assistant', content: `model:${req.model ?? providerId ?? 'routed'}<${user}>` },
      cost: 2,
      usage: { inputTokens: 5, outputTokens: 15, totalTokens: 20 },
    };
  });
  return {
    startRun,
    waitForRun,
    emitEvent: jest.fn(),
    llmProvidersService: { chat },
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

const ag = (agentId: string, role?: string) => ({ kind: 'agent', agentId, ...(role ? { role } : {}) });
const md = (providerId: string, model: string, extra: Record<string, any> = {}) => ({ kind: 'model', providerId, model, ...extra });

describe('AgentCollaborationHelper', () => {
  it('sequential: pipes each agent output into the next agent input, final = last', async () => {
    const runtime = makeRuntime();
    const repo = makeRepo();
    const helper = new AgentCollaborationHelper(repo as any, runtime as any);
    const run = makeRun();
    const agent = agentWith({
      strategy: 'sequential',
      participants: [ag('a1', 'drafter'), ag('a2', 'editor')],
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
      participants: [ag('a1'), ag('a2')],
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
      participants: [ag('a1'), ag('a2')],
      judge: ag('judge'),
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
      participants: [ag('a1'), ag('a2'), ag('a3')],
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
      participants: [ag('d1'), ag('d2')],
      judge: ag('judge'),
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
    const agent = agentWith({ strategy: 'debate', participants: [ag('d1', 'pro')] });

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
    const agent = agentWith({ strategy: 'telepathy', participants: [] });

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
      const agent = agentWith({ strategy, participants: [ag('x')], maxRounds: 1 });
      const result = await helper.processCollaborationStep(run, agent);
      expect(result).toBe('done');
      expect(run.status).toBe(AgentRunStatus.COMPLETED);
    }
  });

  // ---------------------------------------------------------------------------
  // Model participants
  // ---------------------------------------------------------------------------

  describe('model participants', () => {
    it('sequential [model, agent]: pipes in configured order and sums every cost', async () => {
      const runtime = makeRuntime();
      const helper = new AgentCollaborationHelper(makeRepo() as any, runtime as any);
      const run = makeRun();
      const agent = agentWith({
        strategy: 'sequential',
        participants: [md('prov-1', 'gpt-x', { role: 'drafter', instructions: 'Be terse.', temperature: 0.2, maxTokens: 300 }), ag('a1', 'editor')],
        sharedBrief: 'Ship the answer',
      });

      await helper.runSequentialCollaboration(run, agent);

      // The model got the orchestrator's output as its user message ...
      expect(runtime.llmProvidersService.chat).toHaveBeenCalledTimes(1);
      const [providerId, req, org, user] = runtime.llmProvidersService.chat.mock.calls[0];
      expect(providerId).toBe('prov-1');
      expect(req.model).toBe('gpt-x');
      expect(req.temperature).toBe(0.2);
      expect(req.maxTokens).toBe(300);
      expect(org).toBe('org-1');
      // As the orchestrating run's principal, inherited (principalOfRun).
      expect(user).toEqual(principalOfRun(run));
      expect(req.messages.find((m: any) => m.role === 'user').content).toBe('out:orchestrator');
      // ... with the shared collaboration context and its own instructions.
      const system = req.messages.find((m: any) => m.role === 'system').content;
      expect(system).toContain('You are the "drafter" in a sequential collaboration.');
      expect(system).toContain('Brief: Ship the answer');
      expect(system).toContain('Team members: drafter, editor');
      expect(system).toContain('Be terse.');
      // ... and the agent after it got the model's output.
      expect(runtime.startRun.mock.calls.map((c) => c[0])).toEqual(['orchestrator', 'a1']);
      expect(runtime._inputFor('r2')).toBe('model:gpt-x<out:orchestrator>');
      expect(run.output).toBe('out:a1');
      // orchestrator 1 + model 2 + agent 1
      expect(run.totalCost).toBe(4);
      expect(run.totalTokens).toBe(10 + 20 + 10);
      const recorded = (run.steps[0] as any).output.participantOutputs.map((o: any) => o.participant);
      expect(recorded[1]).toEqual({ kind: 'model', providerId: 'prov-1', model: 'gpt-x', role: 'drafter' });
      expect(recorded[2]).toEqual({ kind: 'agent', agentId: 'a1', role: 'editor' });
    });

    it('parallel with models only (no agents at all) completes through a model judge', async () => {
      const runtime = makeRuntime();
      const helper = new AgentCollaborationHelper(makeRepo() as any, runtime as any);
      const run = makeRun();
      const agent = agentWith({
        strategy: 'parallel',
        participants: [md('p1', 'm1'), md('p2', 'm2')],
        judge: md('p3', 'judge-model'),
      });

      await helper.runParallelCollaboration(run, agent);

      expect(runtime.startRun).not.toHaveBeenCalled();
      const calls = runtime.llmProvidersService.chat.mock.calls;
      expect(calls.map((c) => c[1].model)).toEqual(['m1', 'm2', 'judge-model']);
      // Both participants saw the same original input.
      expect(calls[0][1].messages.find((m: any) => m.role === 'user').content).toBe('solve X');
      expect(calls[1][1].messages.find((m: any) => m.role === 'user').content).toBe('solve X');
      // The judge read both answers and its answer is the output.
      const judgeUser = calls[2][1].messages.find((m: any) => m.role === 'user').content;
      expect(judgeUser).toContain('model:m1<solve X>');
      expect(judgeUser).toContain('model:m2<solve X>');
      expect(calls[2][1].messages.find((m: any) => m.role === 'system').content).toContain('You are the "judge"');
      expect(String(run.output)).toMatch(/^model:judge-model</);
      expect(run.status).toBe(AgentRunStatus.COMPLETED);
      expect(run.totalCost).toBe(6);
      expect((run.steps[0] as any).input.judge).toEqual({ kind: 'model', providerId: 'p3', model: 'judge-model' });
    });

    it('a routed model participant sends the policy and no model id', async () => {
      const runtime = makeRuntime();
      const helper = new AgentCollaborationHelper(makeRepo() as any, runtime as any);
      const run = makeRun();
      const routing = { objective: 'cheapest' };
      const agent = agentWith({
        strategy: 'parallel',
        participants: [{ kind: 'model', routing, model: 'ignored' }],
      });

      await helper.runParallelCollaboration(run, agent);

      const [providerId, req] = runtime.llmProvidersService.chat.mock.calls[0];
      expect(providerId).toBeNull();
      expect(req.routing).toBe(routing);
      expect(req.model).toBeUndefined();
    });

    it('race with two models: the first answer wins and the other call is aborted', async () => {
      const runtime = makeRuntime();
      const signals: Record<string, AbortSignal> = {};
      runtime.llmProvidersService.chat.mockImplementation(async (_p: any, req: any) => {
        signals[req.model] = req.signal;
        if (req.model === 'fast') {
          return { message: { role: 'assistant', content: 'fast answer' }, cost: 3, usage: { totalTokens: 7 } } as any;
        }
        // The slow model only settles when its signal fires.
        return new Promise((_resolve, reject) => {
          req.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      });
      const repo = makeRepo();
      const helper = new AgentCollaborationHelper(repo as any, runtime as any);
      const run = makeRun();
      const agent = agentWith({ strategy: 'race', participants: [md('p1', 'slow'), md('p2', 'fast')] });

      await helper.runRaceCollaboration(run, agent);

      expect(run.status).toBe(AgentRunStatus.COMPLETED);
      expect(run.output).toBe('fast answer');
      expect(signals.slow.aborted).toBe(true);
      expect(signals.fast.aborted).toBe(false);
      // Only the finished call is billed; the aborted one reported nothing.
      expect(run.totalCost).toBe(3);
      expect(run.totalTokens).toBe(7);
      // No agent racer, so no run row was looked up.
      expect(repo.findOne).not.toHaveBeenCalled();
      expect((run.steps[0] as any).output.winner).toEqual({ kind: 'model', providerId: 'p2', model: 'fast' });
    });

    it('debate with models only runs maxRounds rounds of every model', async () => {
      const runtime = makeRuntime();
      const helper = new AgentCollaborationHelper(makeRepo() as any, runtime as any);
      const run = makeRun();
      const agent = agentWith({
        strategy: 'debate',
        participants: [md('p1', 'pro-model', { role: 'pro' }), md('p2', 'con-model', { role: 'con' })],
        maxRounds: 3,
      });

      await helper.runDebateCollaboration(run, agent);

      expect(runtime.startRun).not.toHaveBeenCalled();
      const models = runtime.llmProvidersService.chat.mock.calls.map((c) => c[1].model);
      expect(models.filter((m) => m === 'pro-model')).toHaveLength(3);
      expect(models.filter((m) => m === 'con-model')).toHaveLength(3);
      // Round 2 sees round 1's answers, labelled by role.
      const round2 = runtime.llmProvidersService.chat.mock.calls[2][1].messages.find((m: any) => m.role === 'user').content;
      expect(round2).toContain('[Round 1 - pro]:');
      expect(round2).toContain('[Round 1 - con]:');
      expect(run.status).toBe(AgentRunStatus.COMPLETED);
      expect(run.totalCost).toBe(12);
      expect(String(run.output)).toContain('[pro]:');
    });

    it('rules.outputFormat json asks a model participant for JSON', async () => {
      const runtime = makeRuntime();
      const helper = new AgentCollaborationHelper(makeRepo() as any, runtime as any);
      const agent = agentWith({ strategy: 'parallel', participants: [md('p1', 'm1')], rules: { outputFormat: 'json' } });

      await helper.runParallelCollaboration(makeRun(), agent);

      const system = runtime.llmProvidersService.chat.mock.calls[0][1].messages.find((m: any) => m.role === 'system').content;
      expect(system).toContain('output format: json');
      expect(system).toMatch(/single valid JSON value only/);
    });

    it('rules.maxTotalCost stops a sequential chain before the next model is called', async () => {
      const runtime = makeRuntime();
      const repo = makeRepo();
      const helper = new AgentCollaborationHelper(repo as any, runtime as any);
      const run = makeRun();
      const agent = agentWith({
        strategy: 'sequential',
        // orchestrator costs 1, m1 costs 2 -> 3 >= 3 before m2
        participants: [md('p1', 'm1'), md('p2', 'm2')],
        rules: { maxTotalCost: 3 },
      });

      const result = await helper.runSequentialCollaboration(run, agent);

      expect(result).toBe('done');
      expect(runtime.llmProvidersService.chat.mock.calls.map((c) => c[1].model)).toEqual(['m1']);
      expect(run.status).toBe(AgentRunStatus.FAILED);
      expect(run.error).toMatch(/^Collaboration total cost limit reached \(\$3\.00 >= \$3\)/);
      expect(run.error).toContain('m2');
      const stop = run.steps.find((s: any) => s.type === 'collaboration_cost_limit') as any;
      expect(stop).toBeDefined();
      expect(stop.output).toEqual({ totalCost: 3, maxTotalCost: 3 });
      expect(runtime.emitEvent).toHaveBeenCalledWith('parent-run', 'run.failed', expect.anything());
      expect(repo.save).toHaveBeenCalledWith(run);
    });

    it('rules.maxTotalCost stops a debate before the next round and before the judge', async () => {
      const runtime = makeRuntime();
      const helper = new AgentCollaborationHelper(makeRepo() as any, runtime as any);
      const run = makeRun();
      const agent = agentWith({
        strategy: 'debate',
        participants: [md('p1', 'm1'), md('p2', 'm2')],
        judge: md('p3', 'judge-model'),
        maxRounds: 3,
        rules: { maxTotalCost: 4 },
      });

      await helper.runDebateCollaboration(run, agent);

      // Round 1 spends 4; round 2 and the judge never run.
      expect(runtime.llmProvidersService.chat).toHaveBeenCalledTimes(2);
      expect(run.status).toBe(AgentRunStatus.FAILED);
      expect(run.error).toContain('debate round 2');
    });
  });
});