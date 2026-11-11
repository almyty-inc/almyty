jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));

import { MetricStatus, MetricType } from '../../../entities/usage-metric.entity';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { runsWithEvents } from '../../../test/fake-run-events';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { REFUND_TOOL, gatedExecutor } from '../../tools/__tests__/gated-executor.harness';
import { AgentRuntimeService } from '../agent-runtime.service';
import { writeRun } from '../run-event-writer';
import { projectRunEvents, storedRunState } from '../run-events';
import { ProjectionMismatch, logIsSourceOfTruth, onLogMismatch, resetRunLogSource, runLogProjections } from '../run-log-source';
import { RunProjectionCheckService } from '../run-projection-check';
import { anthropicText, anthropicTool, runAgent } from './autonomous-harness';

/**
 * Durable runs step 5: the log is the source of truth. A run's state is
 * what its event log folds into; the row's steps and working memory are a
 * cache of it. Every reader that decides something from a run's state
 * serves the log's, a difference is reported, and the next write repairs
 * the row.
 */

const STEPS = [
  { type: 'llm_call', output: 'Looking the order up.', timestamp: 't1' },
  { type: 'tool_call', toolName: 'crm_lookup', input: { account: '4411' }, output: { status: 'shipped' }, timestamp: 't2' },
];

const seed = (over: Record<string, any> = {}) =>
  runsWithEvents([
    {
      id: 'run-1',
      organizationId: 'org-1',
      agentId: 'agent-1',
      status: AgentRunStatus.RUNNING,
      currentStep: 0,
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

/** A run whose log holds two steps and a plan in working memory, with its row cache then changed around writeRun. */
const corrupted = async () => {
  const runs = seed();
  await writeRun(runs as any, { id: 'run-1' }, { currentStep: 1, steps: STEPS as any, workingMemory: { plan: 'ship it', notes: ['a'] } });
  const logged = { ...runs.row('run-1')! };
  // Something writes the row without the log: the cache no longer is the projection.
  await runs.update({ id: 'run-1' }, { steps: [STEPS[0], { ...STEPS[1], output: { status: 'SECRET-CONTENT' } }], workingMemory: { plan: 'other' } } as any);
  return { runs, logged };
};

const runtime = (runs: ReturnType<typeof runsWithEvents>) => {
  const svc: any = Object.create(AgentRuntimeService.prototype);
  Object.assign(svc, { logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() }, runRepository: runs });
  return svc as AgentRuntimeService;
};

const expectLogIsRow = (runs: ReturnType<typeof runsWithEvents>) => {
  const { headSeq, ...state } = projectRunEvents(runs.events.rows('run-1'));
  expect(headSeq).toBe(runs.row('run-1')!.headSeq);
  expect(state).toEqual(storedRunState(runs.row('run-1')!));
};

let mismatches: ProjectionMismatch[];
let stop: () => void;
const previous = process.env.RUN_LOG_SOURCE_OF_TRUTH;
beforeEach(() => {
  delete process.env.RUN_LOG_SOURCE_OF_TRUTH;
  resetRunLogSource();
  mismatches = [];
  stop = onLogMismatch((m) => mismatches.push(m));
});
afterEach(() => {
  stop();
  if (previous === undefined) delete process.env.RUN_LOG_SOURCE_OF_TRUTH;
  else process.env.RUN_LOG_SOURCE_OF_TRUTH = previous;
});

describe('RUN_LOG_SOURCE_OF_TRUTH', () => {
  it.each([
    [{}, true],
    [{ NODE_ENV: 'test' }, true],
    [{ NODE_ENV: 'development' }, true],
    [{ NODE_ENV: 'production' }, false],
    [{ NODE_ENV: 'production', RUN_LOG_SOURCE_OF_TRUTH: 'true' }, true],
    [{ NODE_ENV: 'production', RUN_LOG_SOURCE_OF_TRUTH: 'on' }, true],
    [{ RUN_LOG_SOURCE_OF_TRUTH: '1' }, true],
    [{ RUN_LOG_SOURCE_OF_TRUTH: 'false' }, false],
    [{ RUN_LOG_SOURCE_OF_TRUTH: 'off' }, false],
    [{ NODE_ENV: 'test', RUN_LOG_SOURCE_OF_TRUTH: '0' }, false],
  ])('%j: %s', (env, on) => {
    expect(logIsSourceOfTruth(env as any)).toBe(on);
  });
});

describe('the run view and the runs list serve the log, not the row cache', () => {
  it('the run view: steps and working memory as the log has them, the difference reported once with hashes, never the content', async () => {
    const { runs, logged } = await corrupted();
    const svc = runtime(runs);

    const run = await svc.getRun('run-1', 'org-1', 'agent-1');
    expect(run.steps).toEqual(logged.steps);
    expect(run.workingMemory).toEqual({ plan: 'ship it', notes: ['a'] });
    expect(run).toBeInstanceOf(AgentRun);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ runId: 'run-1', organizationId: 'org-1', seq: logged.headSeq, from: 'log', reader: 'run_view' });
    expect(mismatches[0].differences.map((d) => d.field)).toEqual(['workingMemory', 'steps']);
    expect(mismatches[0].differences[1]).toMatchObject({ rowLength: 2, projectionLength: 2, firstDifferentIndex: 1 });
    expect(JSON.stringify(mismatches)).not.toContain('SECRET-CONTENT');

    // Viewed again at the same head: served from the log again, not reported again.
    const again = await svc.getRun('run-1', 'org-1', 'agent-1');
    expect(again.workingMemory).toEqual({ plan: 'ship it', notes: ['a'] });
    expect(mismatches).toHaveLength(1);
    // A reader changing what it was served does not change the next reader's.
    again.workingMemory.plan = 'changed by a reader';
    again.steps.push({ type: 'llm_call' } as any);
    expect((await svc.getRun('run-1', 'org-1')).workingMemory.plan).toBe('ship it');
    expect((await svc.getRun('run-1', 'org-1')).steps).toHaveLength(2);
  });

  it('the runs list: each run from its log', async () => {
    const { runs, logged } = await corrupted();
    const svc = runtime(runs);

    const page = await svc.listRuns('agent-1', 'org-1');
    expect(page.total).toBe(1);
    expect(page.data[0].steps).toEqual(logged.steps);
    expect(page.data[0].headSeq).toBe(logged.headSeq);
    expect(mismatches.map((m) => m.reader)).toEqual(['run_list']);
  });

  it('a run with no events is served from its row', async () => {
    const runs = seed({ steps: STEPS, workingMemory: { plan: 'from the row' } });
    const run = await runtime(runs).getRun('run-1', 'org-1');
    expect(run.steps).toEqual(STEPS);
    expect(run.workingMemory).toEqual({ plan: 'from the row' });
    expect(runs.events.find).not.toHaveBeenCalled();
    expect(mismatches).toEqual([]);
  });

  it('a log that does not fold: the row is served and the fold error reported', async () => {
    const { runs } = await corrupted();
    // The row claims events the log does not have.
    await runs.update({ id: 'run-1' }, { headSeq: (runs.row('run-1')!.headSeq ?? 0) + 3 } as any);
    const run = await runtime(runs).getRun('run-1', 'org-1');
    expect(run.workingMemory).toEqual({ plan: 'other' });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].foldError).toMatch(/ends at seq/);
  });

  it('switched off: the row, as before, and the log is not read', async () => {
    process.env.RUN_LOG_SOURCE_OF_TRUTH = 'false';
    const { runs } = await corrupted();
    runs.events.find.mockClear();
    const run = await runtime(runs).getRun('run-1', 'org-1');
    expect(run.workingMemory).toEqual({ plan: 'other' });
    expect(runs.events.find).not.toHaveBeenCalled();
    expect(mismatches).toEqual([]);
  });

  it('reads only what was appended since the projection it holds', async () => {
    const runs = seed();
    for (let i = 1; i <= 20; i++) {
      await writeRun(runs as any, { id: 'run-1' }, (row) => ({ currentStep: i, workingMemory: { ...row.workingMemory, [`k${i}`]: i } }));
    }
    const svc = runtime(runs);
    runLogProjections.forget();
    runLogProjections.stats.eventsRead = 0;
    await svc.getRun('run-1', 'org-1');
    const whole = runs.events.rows('run-1').length;
    expect(runLogProjections.stats.eventsRead).toBe(whole);

    await writeRun(runs as any, { id: 'run-1' }, { currentStep: 21 });
    await svc.getRun('run-1', 'org-1');
    // The write's own read and the view after it: nothing read twice.
    expect(runLogProjections.stats.eventsRead).toBe(whole);
    expect(mismatches).toEqual([]);
  });
});

describe('the next write repairs the row cache', () => {
  it('starts from the log, writes back what differed, and the log still folds into the row', async () => {
    const { runs, logged } = await corrupted();
    let seen: AgentRun | null = null;

    const written = await writeRun(runs as any, { id: 'run-1' }, (row) => {
      seen = row;
      return { currentStep: 2, workingMemory: { ...row.workingMemory, done: true } };
    });

    expect(written).toBeTruthy();
    // The change was a function of the run as the log has it.
    expect(seen!.workingMemory).toEqual({ plan: 'ship it', notes: ['a'] });
    const row = runs.row('run-1')!;
    expect(row.workingMemory).toEqual({ plan: 'ship it', notes: ['a'], done: true });
    expect(row.steps).toEqual(logged.steps);
    expect(row.currentStep).toBe(2);
    expectLogIsRow(runs);
    // The write's events describe only its own change, from the log's state.
    const appended = runs.events.rows('run-1').filter((e) => e.seq > logged.headSeq!);
    expect(appended.map((e) => e.type)).toEqual(['memory_changed', 'step_committed']);
    expect(appended[0].payload).toEqual({ set: { done: true } });

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ from: 'log', reader: 'write', seq: logged.headSeq });

    // Repaired: the next read finds nothing to report.
    await runtime(runs).getRun('run-1', 'org-1');
    expect(mismatches).toHaveLength(1);
  });

  it('switched off, the write starts from the row as before', async () => {
    process.env.RUN_LOG_SOURCE_OF_TRUTH = 'false';
    const { runs } = await corrupted();
    await writeRun(runs as any, { id: 'run-1' }, (row) => ({ currentStep: 2, workingMemory: { ...row.workingMemory, done: true } }));
    expect(runs.row('run-1')!.workingMemory).toEqual({ plan: 'other', done: true });
    expect(mismatches).toEqual([]);
  });

  it('a difference goes out as the projection check reports one: a warning and a run_projection_mismatch metric', async () => {
    stop();
    const metrics = { record: jest.fn() };
    const svc = new RunProjectionCheckService(metrics as any);
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);
    svc.onModuleInit();
    try {
      const { runs, logged } = await corrupted();
      await runtime(runs).getRun('run-1', 'org-1');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatchObject({
        event: 'run_projection_mismatch',
        runId: 'run-1',
        seq: logged.headSeq,
        from: 'log',
        reader: 'run_view',
        fields: ['workingMemory', 'steps'],
      });
      expect(metrics.record).toHaveBeenCalledWith(MetricType.RUN_PROJECTION_MISMATCH, {
        status: MetricStatus.ERROR,
        organizationId: 'org-1',
        dimensions: { runId: 'run-1', seq: logged.headSeq, fields: ['workingMemory', 'steps'], reader: 'run_view' },
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-CONTENT');
      expect(svc.checker.stats.mismatches).toBe(1);
    } finally {
      svc.onModuleDestroy();
      stop = () => undefined;
    }
  });
});

describe('a step resumes from the log, not the row cache', () => {
  const MODEL = 'claude-sonnet-5';

  it('a held call approved while the row lost it: the step still runs it, and the row is repaired', async () => {
    const access = membershipFixture();
    access.member('org-1', 'u-1');
    const harness = gatedExecutor(access.executionAccess);
    const approvals = { create: jest.fn(async (input: any) => harness.approvalRequests.save({ ...input, status: 'pending', principal: undefined })) };
    const executeTool = jest.fn((toolId: string, params: any, options: any) => harness.executor.executeTool(toolId, params, options));
    const result = await runAgent({
      models: null,
      agent: { toolIds: ['tool-refund'] },
      tools: [REFUND_TOOL],
      approvals,
      executeTool,
      streams: {
        [MODEL]: [
          anthropicTool(MODEL, 'issue_refund', { amount: 820, order: 'NW-44120' }, 120, 20),
          anthropicText(MODEL, 180, ['The refund has been issued.'], 12),
        ],
      },
    });
    expect(result.run.status).toBe(AgentRunStatus.WAITING_APPROVAL);
    const held = runsRow(result).workingMemory.gatedToolCalls;
    expect(held).toHaveLength(1);
    const stepsBefore = runsRow(result).steps.length;

    // The row cache loses the held call and the steps; the log keeps them.
    await result.runRepository.update({ id: 'run-1' }, { workingMemory: {}, steps: [] } as any);

    // Approved, and resumed the way the runtime's listener does it.
    const [approval] = await harness.approvalRequests.find({ where: { runId: 'run-1' } });
    await harness.approvalRequests.update({ id: approval.id }, { status: 'approved' });
    await writeRun(result.runRepository as any, { id: 'run-1', status: AgentRunStatus.WAITING_APPROVAL }, { status: AgentRunStatus.RUNNING });
    executeTool.mockClear();
    await result.drive();

    // The approved call was made (it was in the log's working memory), and the run finished.
    expect(executeTool.mock.calls.filter(([toolId]) => toolId === 'tool-refund')).toHaveLength(1);
    const row = runsRow(result);
    expect(row.status).toBe(AgentRunStatus.COMPLETED);
    // Nothing of the run's history was lost with the row cache.
    expect(row.steps.length).toBeGreaterThan(stepsBefore);
    expect(row.workingMemory.gatedToolCalls ?? []).toEqual([]);
    const { headSeq, ...state } = projectRunEvents(result.runEvents.rows('run-1'));
    expect(headSeq).toBe(row.headSeq);
    expect(state).toEqual(storedRunState(row));
    expect(mismatches.map((m) => m.reader)).toContain('write');
  });
});

function runsRow(result: { runRepository: any }): AgentRun {
  return result.runRepository.row('run-1');
}
