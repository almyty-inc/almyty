jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));

import { IsNull } from 'typeorm';

import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { MetricStatus, MetricType } from '../../../entities/usage-metric.entity';
import * as runEvents from '../run-events';
import { claimDelivery, mergeMetadata, notDone, onRunWritten, runStateOf, writeRun } from '../run-event-writer';
import {
  RunProjectionCheckService,
  RunProjectionChecker,
  projectionCheckEnabled,
} from '../run-projection-check';
import { runsWithEvents, watchRunProjection } from '../../../test/fake-run-events';
import { anthropicText, anthropicTool, runAgent } from './autonomous-harness';

/**
 * Durable runs step 2: the projection check. After every committed run
 * write, the events it appended are folded onto the run's projection and
 * compared with the row as written; a difference is logged and counted,
 * never the reason a write fails.
 */
const seedRun = (over: Record<string, any> = {}) =>
  runsWithEvents([
    {
      id: 'run-1',
      organizationId: 'org-1',
      status: AgentRunStatus.RUNNING,
      currentStep: 0,
      headSeq: 0,
      steps: [],
      workingMemory: {},
      metadata: {},
      totalCost: 0,
      totalTokens: 0,
      toolCallCount: 0,
      executionTime: 0,
      ...over,
    } as any,
  ]);

describe('the projection check holds for every way a run is written', () => {
  const MODEL = 'claude-sonnet-5';
  let watch: ReturnType<typeof watchRunProjection>;
  beforeEach(() => {
    watch = watchRunProjection();
  });
  afterEach(() => watch.stop());

  it('step commits of a run that calls a tool and answers: each checked, each equal, folded from the last check', async () => {
    const result = await runAgent({
      models: null,
      streams: {
        [MODEL]: [anthropicTool(MODEL, 'crm_lookup', { account: '4411' }, 50, 10), anthropicText(MODEL, 90, ['It ships Monday.'], 6)],
      },
    });

    expect(result.run.status).toBe(AgentRunStatus.COMPLETED);
    const commits = result.runEvents.rows('run-1').filter((e) => e.type === 'step_committed').length;
    expect(commits).toBeGreaterThanOrEqual(2);
    expect(watch.mismatches).toEqual([]);
    expect(watch.checker.stats.checks).toBe(commits);
    // The first write opens the log; every later one folds onto the projection the previous check kept.
    expect(watch.checker.stats.cacheHits).toBe(commits - 1);
  });

  it('a run that fails', async () => {
    const result = await runAgent({ models: null, streams: { [MODEL]: [new Error('provider unavailable')] } });
    expect(result.run.status).toBe(AgentRunStatus.FAILED);
    expect(watch.checker.stats.checks).toBeGreaterThan(0);
    expect(watch.mismatches).toEqual([]);
  });

  it('every writer outside the step commit: cancel, input, approval request and decision, reaper, delivery claim, metadata, a whole run state, steps rewritten', async () => {
    const runs = seedRun();
    const writes = [
      // A step, with a tool call and working memory.
      () =>
        writeRun(runs as any, { id: 'run-1' }, (row) => ({
          currentStep: 1,
          steps: [{ type: 'tool_call', input: { tool: 'crm' }, output: { ok: true }, duration: 4, timestamp: 't1' }] as any,
          workingMemory: { ...row.workingMemory, plan: ['a'] },
          totalCost: 0.25,
          totalTokens: 40,
          toolCallCount: 1,
        })),
      // request_approval pausing the run, and the decision resuming it.
      () =>
        writeRun(runs as any, { id: 'run-1' }, { status: AgentRunStatus.WAITING_APPROVAL }, [
          { type: 'approval_requested', step: null, payload: { approvalId: 'ap-1', kind: 'run' } },
        ]),
      () =>
        writeRun(runs as any, { id: 'run-1', status: AgentRunStatus.WAITING_APPROVAL }, { status: AgentRunStatus.RUNNING }, [
          { type: 'approval_decided', step: null, payload: { approvalId: 'ap-1', decision: 'approved', decidedBy: 'u-1' } },
        ]),
      // Waiting on input, then the input resuming it.
      () => writeRun(runs as any, { id: 'run-1' }, { status: AgentRunStatus.WAITING_INPUT }),
      () =>
        writeRun(runs as any, { id: 'run-1', status: AgentRunStatus.WAITING_INPUT }, { status: AgentRunStatus.RUNNING }, [
          { type: 'input_received', step: null, payload: { messageId: 'm-1', attachments: 0 } },
        ]),
      // A channel and a wake adding metadata.
      () => writeRun(runs as any, { id: 'run-1' }, mergeMetadata({ aiDisclosureSent: true })),
      () => writeRun(runs as any, { id: 'run-1' }, mergeMetadata({ replyTo: [{ channelId: 'c', to: 'u' }] })),
      // A recorded step rewritten, then the list shortened.
      () =>
        writeRun(runs as any, { id: 'run-1' }, (row) => ({
          steps: [{ ...(row.steps[0] as any), output: { ok: false } }] as any,
        })),
      () => writeRun(runs as any, { id: 'run-1' }, { steps: [] }),
      // Collaboration: a loaded run written whole.
      () => writeRun(runs as any, { id: 'run-1' }, runStateOf({ ...(runs.row('run-1') as any), output: 'done so far' } as AgentRun)),
      // The reaper timing it out, guarded on its status.
      () =>
        writeRun(runs as any, { id: 'run-1', status: AgentRunStatus.RUNNING }, { status: AgentRunStatus.TIMEOUT, error: 'Run timed out' }),
      // Delivery claimed once.
      () => claimDelivery(runs as any, 'run-1', 'schedule'),
    ];
    for (const write of writes) expect(await write()).toBeTruthy();
    // A cancel of a finished run writes nothing, and nothing is checked for it.
    expect(await writeRun(runs as any, { id: 'run-1', status: notDone() }, { status: AgentRunStatus.CANCELLED })).toBeNull();
    expect(await writeRun(runs as any, { id: 'run-1', deliveredAt: IsNull() }, { deliveredAt: new Date() })).toBeNull();

    expect(watch.checker.stats.checks).toBe(writes.length);
    expect(watch.mismatches).toEqual([]);
  });

  it('a cancel while running', async () => {
    const runs = seedRun();
    expect(await writeRun(runs as any, { id: 'run-1', status: notDone() }, { status: AgentRunStatus.CANCELLED })).toBeTruthy();
    expect(watch.checker.stats.checks).toBe(1);
    expect(watch.mismatches).toEqual([]);
  });
});

describe('a difference is logged and counted, and the write still succeeds', () => {
  const previous = process.env.RUN_PROJECTION_CHECK;
  afterEach(() => {
    if (previous === undefined) delete process.env.RUN_PROJECTION_CHECK;
    else process.env.RUN_PROJECTION_CHECK = previous;
  });

  const service = () => {
    process.env.RUN_PROJECTION_CHECK = 'true';
    const metrics = { record: jest.fn() };
    const svc = new RunProjectionCheckService(metrics as any);
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);
    svc.onModuleInit();
    return { svc, metrics, warn };
  };

  it('a write around writeRun shows up at the next write: warned with run id, seq and field hashes, counted, never the content', async () => {
    const { svc, metrics, warn } = service();
    try {
      const runs = seedRun();
      await writeRun(runs as any, { id: 'run-1' }, { currentStep: 1, metadata: { channel: 'web' } });
      // Something changes the row without the log.
      await runs.update({ id: 'run-1' }, { metadata: { channel: 'web', note: 'SECRET-CONTENT the customer typed' } } as any);

      const written = await writeRun(runs as any, { id: 'run-1' }, { currentStep: 2 });

      // The write itself is untouched.
      expect(written).toBeTruthy();
      expect(runs.row('run-1')!.currentStep).toBe(2);
      expect(runs.row('run-1')!.headSeq).toBe(runs.events.rows('run-1').length);

      expect(warn).toHaveBeenCalledTimes(1);
      const [logged] = warn.mock.calls[0] as any[];
      expect(logged).toMatchObject({
        event: 'run_projection_mismatch',
        runId: 'run-1',
        seq: runs.row('run-1')!.headSeq,
        from: 'cache',
        fields: ['metadata'],
      });
      expect(logged.differences[0]).toEqual({ field: 'metadata', rowHash: expect.stringMatching(/^[0-9a-f]{16}$/), projectionHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
      expect(logged.differences[0].rowHash).not.toBe(logged.differences[0].projectionHash);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-CONTENT');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('channel');

      expect(metrics.record).toHaveBeenCalledTimes(1);
      expect(metrics.record).toHaveBeenCalledWith(MetricType.RUN_PROJECTION_MISMATCH, {
        status: MetricStatus.ERROR,
        organizationId: 'org-1',
        dimensions: { runId: 'run-1', seq: runs.row('run-1')!.headSeq, fields: ['metadata'] },
      });
      expect(JSON.stringify(metrics.record.mock.calls)).not.toContain('SECRET-CONTENT');

      // Reported once: the check starts again from the row, so the next write matches.
      await writeRun(runs as any, { id: 'run-1' }, { currentStep: 3 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(svc.checker.stats).toMatchObject({ checks: 3, mismatches: 1 });
    } finally {
      svc.onModuleDestroy();
    }
  });

  it('a check that throws does not fail the write', async () => {
    const { svc } = service();
    const boom = jest.spyOn(svc.checker, 'check').mockImplementation(() => {
      throw new Error('check broke');
    });
    const rejecting = onRunWritten(async () => {
      throw new Error('listener rejected');
    });
    try {
      const runs = seedRun();
      const written = await writeRun(runs as any, { id: 'run-1' }, { status: AgentRunStatus.CANCELLED });
      expect(written).toBeTruthy();
      expect(boom).toHaveBeenCalledTimes(1);
      expect(runs.row('run-1')!.status).toBe(AgentRunStatus.CANCELLED);
    } finally {
      rejecting();
      svc.onModuleDestroy();
    }
  });

  it('a log the fold refuses (a gap) is reported with the reason, no content', () => {
    const mismatches: any[] = [];
    const checker = new RunProjectionChecker((m) => mismatches.push(m));
    const before = Object.assign(new AgentRun(), { id: 'run-1', organizationId: 'org-1', headSeq: 4, status: 'running', currentStep: 1, steps: [], workingMemory: {}, metadata: {} });
    const after = Object.assign(new AgentRun(), { ...before, headSeq: 6, currentStep: 2 });
    checker.check({
      before,
      after,
      events: [{ runId: 'run-1', seq: 6, type: 'step_committed', step: 1, payload: { status: 'running', currentStep: 2, totalCost: 0, totalTokens: 0, toolCallCount: 0, executionTime: 0 } }],
    });
    expect(mismatches).toEqual([
      expect.objectContaining({ runId: 'run-1', seq: 6, fromSeq: 4, from: 'row', differences: [], foldError: expect.stringMatching(/not contiguous: expected seq 5, found 6/) }),
    ]);
  });

  it('steps that part say where, by index and length', async () => {
    const watch = watchRunProjection();
    try {
      const runs = seedRun();
      await writeRun(runs as any, { id: 'run-1' }, { steps: [{ type: 'llm_call', output: 'a', timestamp: 't1' }, { type: 'llm_call', output: 'b', timestamp: 't2' }] as any });
      await runs.update({ id: 'run-1' }, { steps: [{ type: 'llm_call', output: 'a', timestamp: 't1' }, { type: 'llm_call', output: 'changed', timestamp: 't2' }] } as any);
      await writeRun(runs as any, { id: 'run-1' }, { currentStep: 1 });
      expect(watch.mismatches).toHaveLength(1);
      expect(watch.mismatches[0].differences).toEqual([
        expect.objectContaining({ field: 'steps', rowLength: 2, projectionLength: 2, firstDifferentIndex: 1 }),
      ]);
    } finally {
      watch.stop();
    }
  });
});

describe('the cost of the check is the write, not the history', () => {
  it('a 10,000-event run: every check folds only the events its write appended', async () => {
    const watch = watchRunProjection();
    const fold = jest.spyOn(runEvents, 'foldRunEvents');
    try {
      const runs = seedRun();
      let writes = 0;
      // A long run: a model call every 50 writes, working memory and metadata on every one.
      while ((runs.row('run-1')!.headSeq ?? 0) < 10_000) {
        await writeRun(runs as any, { id: 'run-1' }, (row) => ({
          currentStep: row.currentStep + 1,
          ...(row.currentStep % 50 === 0
            ? { steps: [...row.steps, { type: 'llm_call', output: `step ${row.currentStep}`, timestamp: `t${row.currentStep}` }] as any }
            : {}),
          workingMemory: { ...row.workingMemory, last: row.currentStep },
          metadata: { ...row.metadata, tick: row.currentStep },
          totalTokens: (row.totalTokens ?? 0) + 10,
        }));
        writes++;
      }
      expect(watch.mismatches).toEqual([]);
      expect(watch.checker.stats.checks).toBe(writes);
      expect(watch.checker.stats.cacheHits).toBe(writes - 1);
      // No fold ever saw more than one write's events.
      const largest = Math.max(...fold.mock.calls.map(([, events]) => events.length));
      expect(largest).toBeLessThanOrEqual(5);
    } finally {
      fold.mockRestore();
      watch.stop();
    }
  });

  it('the cache holds at most its byte budget; a run that falls out starts again from its row, without a false difference', async () => {
    const mismatches: any[] = [];
    const checker = new RunProjectionChecker((m) => mismatches.push(m), 2_000);
    const stop = onRunWritten((w) => {
      checker.check(w);
    });
    try {
      const runs = runsWithEvents(
        Array.from({ length: 5 }, (_, i) => ({ id: `run-${i}`, organizationId: 'org-1', status: AgentRunStatus.RUNNING, currentStep: 0, headSeq: 0, steps: [], workingMemory: {}, metadata: {} }) as any),
      );
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 5; i++) {
          await writeRun(runs as any, { id: `run-${i}` }, (row) => ({ workingMemory: { ...row.workingMemory, [`k${round}`]: 'x'.repeat(200) } }));
          expect(checker.snapshot().cachedBytes).toBeLessThanOrEqual(2_000);
        }
      }
      expect(checker.stats.cacheMisses).toBeGreaterThan(5);
      expect(mismatches).toEqual([]);
    } finally {
      stop();
    }
  });

  it('a finished run is not kept', async () => {
    const watch = watchRunProjection();
    try {
      const runs = seedRun();
      await writeRun(runs as any, { id: 'run-1' }, { currentStep: 1 });
      expect(watch.checker.snapshot().cachedRuns).toBe(1);
      await writeRun(runs as any, { id: 'run-1' }, { status: AgentRunStatus.COMPLETED });
      expect(watch.checker.snapshot().cachedRuns).toBe(0);
    } finally {
      watch.stop();
    }
  });
});

describe('RUN_PROJECTION_CHECK turns it on', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['on', true],
    [' TRUE ', true],
    ['false', false],
    ['0', false],
    ['', false],
    [undefined, false],
  ])('%p -> %p', (value, on) => {
    expect(projectionCheckEnabled({ RUN_PROJECTION_CHECK: value } as any)).toBe(on);
  });

  it('off: nothing watches the writes', async () => {
    const previous = process.env.RUN_PROJECTION_CHECK;
    process.env.RUN_PROJECTION_CHECK = 'false';
    const svc = new RunProjectionCheckService({ record: jest.fn() } as any);
    svc.onModuleInit();
    try {
      const check = jest.spyOn(svc.checker, 'check');
      await writeRun(seedRun() as any, { id: 'run-1' }, { currentStep: 1 });
      expect(svc.enabled).toBe(false);
      expect(check).not.toHaveBeenCalled();
    } finally {
      svc.onModuleDestroy();
      if (previous === undefined) delete process.env.RUN_PROJECTION_CHECK;
      else process.env.RUN_PROJECTION_CHECK = previous;
    }
  });
});
