import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { MessageType } from '../../../entities/message.entity';
import { expectRunProjectionsHold, runsWithEvents, watchRunProjection } from '../../../test/fake-run-events';
import { writeRun } from '../run-event-writer';
import { projectRunEvents, storedRunState } from '../run-events';
import { claimRun } from '../run-lease';
import { StepJournal, idempotencyKey } from '../run-resume';
import { TOOL_CHARGE, TOOL_EMAIL, answers, callsTools, externalService, never, resumeAgent, resumeRun, resumeWorkers } from './resume-harness';

/**
 * Durable runs step 4: resume and idempotency keys
 * (docs/design/durable-runs.md, run-resume.ts). A step writes its progress
 * on the run's log before its commit; a worker that picks the step up again
 * resumes from it: the model is not asked again, a finished call is not
 * made again, and a call whose outcome the log does not know goes out with
 * the key it was first made with.
 */
const RUN = 'run-1';
const ORG = 'org-1';
const AGENT = 'agent-1';

const seeded = (row: Partial<AgentRun> = {}) =>
  runsWithEvents([{ id: RUN, ...resumeRun(ORG, AGENT), agent: { id: AGENT, ...resumeAgent(ORG) }, ...row } as any]);

const expectSound = (runs: ReturnType<typeof runsWithEvents>) => {
  const log = runs.events.rows(RUN);
  const row = runs.row(RUN)!;
  expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
  expect(row.headSeq).toBe(log.length);
  const { headSeq, ...state } = projectRunEvents(log);
  expect(headSeq).toBe(row.headSeq);
  expect(state).toEqual(storedRunState(row));
  return log;
};

/** Let the dying worker get to the point it dies at. */
const until = async (reached: () => boolean) => {
  for (let i = 0; i < 2000 && !reached(); i++) await new Promise((r) => setImmediate(r));
  if (!reached()) throw new Error('the worker never got there');
};

const drive = async (worker: { processStep(id: string): Promise<string> }) => {
  let out: string;
  do {
    out = await worker.processStep(RUN);
  } while (out === 'continue');
  return out;
};

const ofType = <E extends { type: string }>(log: E[], type: string): E[] => log.filter((e) => e.type === type);

describe('durable runs step 4: the step progress write (writeRun progress)', () => {
  expectRunProjectionsHold();

  it('appends the notes alone: no step_committed, the row state untouched, headSeq moved', async () => {
    const runs = seeded();
    await writeRun(runs as any, { id: RUN }, { currentStep: 0, output: null });
    const before = storedRunState(runs.row(RUN)!);
    const head = runs.row(RUN)!.headSeq;

    const written = await writeRun(runs as any, { id: RUN }, {}, [{ type: 'model_answered', step: null, payload: { messageCount: 2, response: { cost: 1 } } }], { progress: true });

    expect(written?.headSeq).toBe(head + 1);
    const log = expectSound(runs);
    expect(log.slice(head).map((e) => [e.type, e.step])).toEqual([['model_answered', 0]]);
    expect(storedRunState(runs.row(RUN)!)).toEqual(before);
  });

  it('is refused like the step commit: another worker holds the run, it finished, or it moved on', async () => {
    const runs = seeded({ leaseOwner: 'worker-b' });
    const note = [{ type: 'tool_started' as const, step: 0, payload: { callIndex: 0 } }];
    expect(await writeRun(runs as any, { id: RUN, leaseOwner: 'worker-a' }, {}, note, { progress: true })).toBeNull();
    expect(await writeRun(runs as any, { id: RUN, currentStep: 3 }, {}, note, { progress: true })).toBeNull();
    await writeRun(runs as any, { id: RUN }, { status: AgentRunStatus.CANCELLED });
    const journal = await StepJournal.read(runs as any, Object.assign(new AgentRun(), runs.row(RUN), { leaseOwner: 'worker-b' }));
    expect(await journal.recordStarted(0, 'charge_card')).toBe(false);
    expect(ofType(runs.events.rows(RUN), 'tool_started')).toEqual([]);
  });

  it('changes nothing but the log: a change with it is refused', async () => {
    const runs = seeded();
    await expect(writeRun(runs as any, { id: RUN }, { output: 'x' }, [{ type: 'tool_started', step: 0, payload: {} }], { progress: true })).rejects.toThrow(
      /changes nothing but the log/,
    );
  });

  it('the projection check folds progress without comparing it, and the next commit still matches', async () => {
    const runs = seeded();
    const watch = watchRunProjection();
    try {
      await writeRun(runs as any, { id: RUN }, { currentStep: 0, workingMemory: { a: 1 } });
      await writeRun(runs as any, { id: RUN }, {}, [{ type: 'tool_started', step: null, payload: { callIndex: 0 } }], { progress: true });
      await writeRun(runs as any, { id: RUN }, {}, [{ type: 'tool_finished', step: null, payload: { callIndex: 0 } }], { progress: true });
      await writeRun(runs as any, { id: RUN }, { currentStep: 1, workingMemory: { a: 2 } });
      expect(watch.mismatches).toEqual([]);
      // The commits are compared; the progress is not (it changed nothing to compare).
      expect(watch.checker.stats.checks).toBe(2);
      expect(watch.checker.stats.cacheHits).toBe(1);
    } finally {
      watch.stop();
    }
  });
});

describe('durable runs step 4: the step journal', () => {
  it('reads the progress of the step the run is at, and nothing of an earlier step', async () => {
    const runs = seeded();
    const progress = (step: number, type: any, payload: any) => writeRun(runs as any, { id: RUN }, {}, [{ type, step, payload }], { progress: true });
    await progress(0, 'model_answered', { messageCount: 1, response: { cost: 9 } });
    await progress(0, 'tool_started', { callIndex: 0 });
    await progress(0, 'tool_finished', { callIndex: 0, call: { result: 'step 0' } });
    await writeRun(runs as any, { id: RUN }, { currentStep: 1 });
    // The run at step 1: step 0's progress is behind the commit that moved it.
    const fresh = await StepJournal.read(runs as any, runs.row(RUN)!);
    expect(fresh.resuming).toBe(false);
    expect(fresh.answer).toBeNull();
    expect(fresh.outcomeOf(0)).toBeNull();

    await progress(1, 'model_answered', { messageCount: 3, response: { cost: 2 } });
    await writeRun(runs as any, { id: RUN }, (row) => ({ metadata: { ...(row.metadata ?? {}), replyTo: 'x' } }));
    await progress(1, 'tool_started', { callIndex: 0 });
    await progress(1, 'tool_finished', { callIndex: 0, call: { result: 'step 1' } });
    await progress(1, 'tool_started', { callIndex: 1 });

    const journal = await StepJournal.read(runs as any, runs.row(RUN)!);
    expect(journal.step).toBe(1);
    expect(journal.resuming).toBe(true);
    expect(journal.answer).toMatchObject({ messageCount: 3 });
    // A write by someone else in between (a metadata merge) does not cut the step's progress short.
    expect(journal.outcomeOf(0)).toMatchObject({ call: { result: 'step 1' } });
    expect(journal.wasStarted(1)).toBe(true);
    expect(journal.outcomeOf(1)).toBeNull();
    expect(journal.key(1)).toBe(`${RUN}:1:1`);
  });

  it('reads a long tail a page at a time', async () => {
    const runs = seeded();
    for (let i = 0; i < 230; i++) await writeRun(runs as any, { id: RUN }, {}, [{ type: 'tool_started', step: 0, payload: { callIndex: i } }], { progress: true });
    const journal = await StepJournal.read(runs as any, runs.row(RUN)!);
    expect(journal.wasStarted(0)).toBe(true);
    expect(journal.wasStarted(229)).toBe(true);
  });

  it('the key is (runId, step, callIndex)', () => {
    expect(idempotencyKey('r', 4, 2)).toBe('r:4:2');
  });
});

describe('durable runs step 4: a worker that dies mid-step, and the one that takes the run over', () => {
  expectRunProjectionsHold();

  const charge = { id: 'tc-1', name: 'charge_card', parameters: { amount: 40 } };
  const receipt = { id: 'tc-2', name: 'send_receipt', parameters: { to: 'ana@example.com' } };

  const setup = async (replies: any[], dying?: (toolId: string, parameters: any, options: any) => Promise<any> | null) => {
    const runs = seeded();
    const service = externalService();
    let dead = false;
    const w = await resumeWorkers({
      runs: runs as any,
      runId: RUN,
      organizationId: ORG,
      agentId: AGENT,
      replies,
      executeTool: async (toolId, parameters, options) => {
        const death = !dead && dying ? dying(toolId, parameters, options) : null;
        if (death) {
          dead = true;
          return death;
        }
        return { success: true, data: service.call({ toolId, ...parameters }, options.idempotencyKey), executionTime: 3 };
      },
    });
    return { runs, service, w };
  };

  it('killed after its call returned, before its commit: the call is not made again, the model not asked again, the cost counted once', async () => {
    // Without the kill, for comparison.
    const clean = await setup([callsTools([charge]), answers('Charged 40 EUR.')]);
    expect(await drive(clean.w.worker())).toBe('done');
    const uninterrupted = clean.runs.row(RUN)!;

    const { runs, service, w } = await setup([callsTools([charge]), answers('Charged 40 EUR.')]);
    const owner = await w.claimDead();
    const a = w.worker();
    const commit = jest.spyOn(a as any, 'commitStep').mockImplementation(never);
    void (a as any).processLeasedStep(RUN, owner);
    await until(() => commit.mock.calls.length > 0);
    expect(service.effects).toHaveLength(1);

    const b = w.worker();
    expect(await drive(b)).toBe('done');

    const row = runs.row(RUN)!;
    expect(row.status).toBe(AgentRunStatus.COMPLETED);
    expect(row.output).toBe('Charged 40 EUR.');
    expect(service.effects).toHaveLength(1);
    expect(w.toolCalls).toHaveLength(1);
    expect(w.modelCalls).toHaveLength(2);
    expect(row.totalCost).toBeCloseTo(uninterrupted.totalCost, 10);
    expect(row.totalTokens).toBe(uninterrupted.totalTokens);
    expect(row.toolCallCount).toBe(uninterrupted.toolCallCount);
    expect(row.steps.map((s: any) => s.type)).toEqual(uninterrupted.steps.map((s: any) => s.type));
    expect(row.attempt).toBe(1);
    expect(row.takeovers).toBe(0);

    const log = expectSound(runs);
    expect(ofType(log, 'lease_taken_over')).toHaveLength(1);
    expect(ofType(log, 'model_answered').map((e) => e.step)).toEqual([0, 1]);
    expect(ofType(log, 'tool_started')).toHaveLength(1);
    expect(ofType(log, 'tool_finished')).toHaveLength(1);
    expect(ofType(log, 'tool_finished')[0].payload).toMatchObject({ callIndex: 0, key: `${RUN}:0:0`, tool: 'charge_card', toolCalls: 1 });
    // The conversation has the call and its result once.
    const conversation = w.messages.rows();
    expect(conversation.filter((m: any) => m.type === MessageType.TOOL_CALL)).toHaveLength(1);
    expect(conversation.filter((m: any) => m.type === MessageType.TOOL_RESULT)).toHaveLength(1);
    // The resumed answer is marked so on the live event.
    expect(w.events.filter((e) => e.type === 'llm.response').map((e) => !!e.data.resumed)).toEqual([false, true, false]);
  });

  it('killed in the call: the call goes out again with the key it was first made with, and the service makes it once', async () => {
    const { runs, service, w } = await setup([callsTools([charge]), answers('Charged.')], (_toolId, parameters, options) => {
      // The service did it; the answer never came back.
      service.call({ toolId: TOOL_CHARGE, ...parameters }, options.idempotencyKey);
      return never();
    });
    const owner = await w.claimDead();
    void (w.worker() as any).processLeasedStep(RUN, owner);
    await until(() => w.toolCalls.length > 0);

    expect(await drive(w.worker())).toBe('done');

    expect(w.toolCalls.map((c) => c.options.idempotencyKey)).toEqual([`${RUN}:0:0`, `${RUN}:0:0`]);
    expect(service.effects).toHaveLength(1);
    expect(w.modelCalls).toHaveLength(2);
    expect(runs.row(RUN)!.status).toBe(AgentRunStatus.COMPLETED);
    const log = expectSound(runs);
    expect(ofType(log, 'tool_started')).toHaveLength(2);
    expect(ofType(log, 'tool_finished')).toHaveLength(1);
  });

  it('two calls, killed in the second: the first is played back from the log, the second made again with its key', async () => {
    const { runs, service, w } = await setup([callsTools([charge, receipt]), answers('Charged and sent.')], (toolId, parameters, options) => {
      if (toolId !== TOOL_EMAIL) return null;
      service.call({ toolId, ...parameters }, options.idempotencyKey);
      return never();
    });
    const owner = await w.claimDead();
    void (w.worker() as any).processLeasedStep(RUN, owner);
    await until(() => w.toolCalls.length > 1);

    expect(await drive(w.worker())).toBe('done');

    expect(w.toolCalls.map((c) => [c.toolId, c.options.idempotencyKey])).toEqual([
      [TOOL_CHARGE, `${RUN}:0:0`],
      [TOOL_EMAIL, `${RUN}:0:1`],
      [TOOL_EMAIL, `${RUN}:0:1`],
    ]);
    expect(service.effects.map((e) => e.parameters.toolId)).toEqual([TOOL_CHARGE, TOOL_EMAIL]);
    const row = runs.row(RUN)!;
    expect(row.toolCallCount).toBe(2);
    expect(row.steps.filter((s: any) => s.type === 'tool_call').map((s: any) => s.input.tool)).toEqual(['charge_card', 'send_receipt']);
    expectSound(runs);
  });

  it('cancelled while the model answered: the answer is not acted on, no call is made, its cost is kept', async () => {
    const { runs, w } = await setup([callsTools([charge])]);
    const owner = await w.claimDead();
    const a = w.worker();
    const s: any = (a as any).s;
    const chat = s.llmProvidersService.chatStream.getMockImplementation();
    s.llmProvidersService.chatStream.mockImplementationOnce(async (...args: any[]) => {
      await writeRun(runs as any, { id: RUN }, { status: AgentRunStatus.CANCELLED });
      return chat(...args);
    });
    expect(await (a as any).processLeasedStep(RUN, owner)).toBe('done');
    expect(w.toolCalls).toEqual([]);
    const row = runs.row(RUN)!;
    expect(row.status).toBe(AgentRunStatus.CANCELLED);
    expect(row.totalCost).toBeCloseTo(0.002, 10);
    expect(ofType(expectSound(runs), 'model_answered')).toEqual([]);
  });

  it('every step keys its calls by its own number', async () => {
    const { w } = await setup([callsTools([charge]), callsTools([receipt]), answers('Done.')]);
    expect(await drive(w.worker())).toBe('done');
    expect(w.toolCalls.map((c) => c.options.idempotencyKey)).toEqual([`${RUN}:0:0`, `${RUN}:1:0`]);
  });

  describe('takeover and resume against the takeover cap', () => {
    const T = Date.now();
    const at = (s: number) => new Date(T + s * 1000);

    it('a step that keeps taking its worker down still ends at the cap, its finished call made once', async () => {
      const saved = process.env.RUN_MAX_TAKEOVERS;
      process.env.RUN_MAX_TAKEOVERS = '3';
      try {
        const { runs, service, w } = await setup([callsTools([charge, receipt])], (toolId) => (toolId === TOOL_EMAIL ? never() : null));
        // Every worker after the first dies in the second call, too.
        let deaths = 0;
        const s: any = (w.worker() as any).s;
        s.toolExecutorService.executeTool.mockImplementation(async (toolId: string, parameters: any, options: any) => {
          w.toolCalls.push({ toolId, parameters, options });
          if (toolId === TOOL_EMAIL) {
            deaths++;
            return never();
          }
          return { success: true, data: service.call({ toolId, ...parameters }, options.idempotencyKey), executionTime: 3 };
        });

        // The first worker, and two that take the run over: each dies in the second call.
        for (let i = 0; i < 3; i++) {
          const claim = await claimRun(runs as any, RUN, { leaseMs: 1, now: at(-100 + i * 10) });
          expect(claim).toMatchObject({ claimed: true, takenOver: i > 0 });
          void (w.worker() as any).processLeasedStep(RUN, (claim as any).owner);
          await until(() => deaths === i + 1);
        }
        expect(runs.row(RUN)!.takeovers).toBe(2);

        // The third takeover of the step stops the run instead of resuming it again.
        const last = w.worker();
        expect(await last.processStep(RUN)).toBe('done');
        const row = runs.row(RUN)!;
        expect(row.status).toBe(AgentRunStatus.FAILED);
        expect(row.error).toBe('This step stopped its worker 3 times in a row, so the run was stopped.');
        expect(row.takeovers).toBe(3);
        // The first call was made once, by the first worker; every later one played it back.
        expect(w.toolCalls.filter((c) => c.toolId === TOOL_CHARGE)).toHaveLength(1);
        expect(w.toolCalls.filter((c) => c.toolId === TOOL_EMAIL).map((c) => c.options.idempotencyKey)).toEqual(Array(3).fill(`${RUN}:0:1`));
        expect(w.modelCalls).toHaveLength(1);
        const log = expectSound(runs);
        expect(ofType(log, 'tool_finished')).toHaveLength(1);
        expect(ofType(log, 'lease_taken_over')).toHaveLength(3);
      } finally {
        if (saved === undefined) delete process.env.RUN_MAX_TAKEOVERS;
        else process.env.RUN_MAX_TAKEOVERS = saved;
      }
    });

    it('a resumed step that commits counts the takeovers again from 0', async () => {
      const { runs, w } = await setup([callsTools([charge]), callsTools([receipt]), answers('Done.')]);
      // Step 0: the first worker dies before its commit; the takeover resumes and commits.
      const owner = await w.claimDead();
      const a = w.worker();
      const commit = jest.spyOn(a as any, 'commitStep').mockImplementation(never);
      void (a as any).processLeasedStep(RUN, owner);
      await until(() => commit.mock.calls.length > 0);
      const b = w.worker();
      expect(await b.processStep(RUN)).toBe('continue');
      expect(runs.row(RUN)).toMatchObject({ currentStep: 1, takeovers: 0, attempt: 1 });

      // Step 1: another death and takeover is the step's first, not the run's second.
      const owner2 = await w.claimDead();
      const c = w.worker();
      const commit2 = jest.spyOn(c as any, 'commitStep').mockImplementation(never);
      void (c as any).processLeasedStep(RUN, owner2);
      await until(() => commit2.mock.calls.length > 0);
      expect(await drive(w.worker())).toBe('done');
      expect(runs.row(RUN)).toMatchObject({ status: AgentRunStatus.COMPLETED, attempt: 2, takeovers: 0 });
      expect(w.toolCalls.map((t) => t.toolId)).toEqual([TOOL_CHARGE, TOOL_EMAIL]);
      expect(w.modelCalls).toHaveLength(3);
      expectSound(runs);
    });
  });

  it('calls retried after a waking machine resume the same way: the finished one is not made again', async () => {
    const runs = seeded({
      workingMemory: {
        wakingToolCalls: [
          { toolCallId: 'tc-1', toolId: TOOL_CHARGE, toolName: 'charge_card', parameters: { amount: 40 } },
          { toolCallId: 'tc-2', toolId: TOOL_EMAIL, toolName: 'send_receipt', parameters: { to: 'ana@example.com' } },
        ],
      },
    });
    const service = externalService();
    let dying = true;
    const w = await resumeWorkers({
      runs: runs as any,
      runId: RUN,
      organizationId: ORG,
      agentId: AGENT,
      replies: [],
      executeTool: async (toolId, parameters, options) => {
        const data = service.call({ toolId, ...parameters }, options.idempotencyKey);
        if (toolId === TOOL_EMAIL && dying) {
          dying = false;
          return never();
        }
        return { success: true, data, executionTime: 3 };
      },
    });
    const owner = await w.claimDead();
    void (w.worker() as any).processLeasedStep(RUN, owner);
    await until(() => w.toolCalls.length > 1);

    expect(await w.worker().processStep(RUN)).toBe('continue');

    expect(w.toolCalls.map((c) => [c.toolId, c.options.idempotencyKey])).toEqual([
      [TOOL_CHARGE, `${RUN}:0:0`],
      [TOOL_EMAIL, `${RUN}:0:1`],
      [TOOL_EMAIL, `${RUN}:0:1`],
    ]);
    expect(service.effects).toHaveLength(2);
    const row = runs.row(RUN)!;
    expect(row.currentStep).toBe(1);
    expect(row.workingMemory.wakingToolCalls).toBeUndefined();
    expect(row.steps.filter((s: any) => s.type === 'tool_call').map((s: any) => s.input.tool)).toEqual(['charge_card', 'send_receipt']);
    expectSound(runs);
  });
});
