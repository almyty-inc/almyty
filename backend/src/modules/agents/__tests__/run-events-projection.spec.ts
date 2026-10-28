jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));
jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

import axios from 'axios';

import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { AgentStepProcessor } from '../agent-step-processor';
import { AgentContextCompactor } from '../agent-context-compactor.helper';
import { projectRunEvents, storedRunState } from '../run-events';
import { mergeMetadata, writeRun } from '../run-event-writer';
import { fakeRepository } from '../../../test/fake-repository';
import { expectRunProjectionsHold, RunEventsTable, withRunEvents } from '../../../test/fake-run-events';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { REFUND_TOOL, gatedExecutor } from '../../tools/__tests__/gated-executor.harness';
import { anthropicText, anthropicTool, mainModelConfig, runAgent } from './autonomous-harness';

/**
 * Durable runs, step 1: every step commit appends its events in the same
 * transaction as the run row, and folding the log gives back exactly what
 * the row stores. These runs are the production step processor end to end
 * (autonomous-harness.ts); after each one the projection of its events is
 * compared with the stored row, field by field.
 */
// Durable runs step 2: every run write in this file folds into its row.
expectRunProjectionsHold();

describe('the run event log folds back into the stored run', () => {
  const MODEL = 'claude-sonnet-5';
  const mockedAxios = axios as unknown as jest.Mock;

  const types = (result: { runEvents: RunEventsTable }) => result.runEvents.rows('run-1').map((e) => e.type);

  /** The safety net itself: the log is contiguous, its head is the row's, and it projects to the row. */
  const expectLogMatchesRow = (result: { runEvents: RunEventsTable; runRepository: any }) => {
    const events = result.runEvents.rows('run-1');
    const row = result.runRepository.row('run-1') as AgentRun;
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(row.headSeq).toBe(events.length);
    const projected = projectRunEvents(events);
    const { headSeq, ...state } = projected;
    expect(headSeq).toBe(row.headSeq);
    expect(state).toEqual(storedRunState(row));
  };

  it('a run that answers at once', async () => {
    const result = await runAgent({ models: null, streams: { [MODEL]: [anthropicText(MODEL, 40, ['Your order ships Monday.'], 8)] } });

    expect(result.run.status).toBe(AgentRunStatus.COMPLETED);
    // One commit: opened by run_started, closed by step_committed, with what
    // the step wrote to working memory and metadata in between.
    const seen = types(result);
    expect(seen.slice(0, 2)).toEqual(['run_started', 'model_call']);
    expect(seen.slice(-3)).toEqual(['status_changed', 'run_completed', 'step_committed']);
    expect(seen.filter((t) => t === 'step_committed')).toHaveLength(1);
    expectLogMatchesRow(result);
  });

  it('a run that calls a tool, then answers', async () => {
    const result = await runAgent({
      models: null,
      streams: {
        [MODEL]: [
          anthropicTool(MODEL, 'crm_lookup', { account: '4411' }, 50, 10),
          anthropicText(MODEL, 90, ['It ships Monday.'], 6),
        ],
      },
    });

    expect(result.run.status).toBe(AgentRunStatus.COMPLETED);
    const events = result.runEvents.rows('run-1');
    const call = events.find((e) => e.type === 'tool_call')!;
    const answer = events.find((e) => e.type === 'tool_result')!;
    expect(call.payload).toMatchObject({ callIndex: 0, step: { type: 'tool_call', input: { tool: 'crm_lookup' } } });
    expect(call.payload.step.output).toBeUndefined();
    expect(answer.payload).toMatchObject({ callIndex: 0, index: call.payload.index, result: { output: { account: '4411', eta: 'Monday' } } });
    // Two commits: each closes with step_committed, at the step it processed.
    expect(events.filter((e) => e.type === 'step_committed').map((e) => e.step)).toEqual([0, 1]);
    expect(events.filter((e) => e.type === 'run_started')).toHaveLength(1);
    expectLogMatchesRow(result);
  });

  it('a run that waits for an approval, and carries on once it is given', async () => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { refunded: true, id: 're_1' }, headers: {} });
    const access = membershipFixture();
    access.member('org-1', 'u-1');
    const harness = gatedExecutor(access.executionAccess);
    const approvals = {
      create: jest.fn(async (input: any) => harness.approvalRequests.save({ ...input, status: 'pending', principal: undefined })),
    };
    const result = await runAgent({
      models: null,
      agent: { toolIds: ['tool-refund'] },
      tools: [REFUND_TOOL],
      approvals,
      executeTool: jest.fn((toolId: string, params: any, options: any) => harness.executor.executeTool(toolId, params, options)),
      streams: {
        [MODEL]: [
          anthropicTool(MODEL, 'issue_refund', { amount: 820, order: 'NW-44120' }, 120, 20),
          anthropicText(MODEL, 180, ['The refund has been issued.'], 12),
        ],
      },
    });

    expect(result.run.status).toBe(AgentRunStatus.WAITING_APPROVAL);
    const [approval] = await harness.approvalRequests.find({ where: { runId: 'run-1' } });
    expect(result.runEvents.rows('run-1').find((e) => e.type === 'approval_requested')!.payload).toMatchObject({
      approvalId: approval.id,
      kind: 'tool_call',
      tool: 'issue_refund',
    });
    expectLogMatchesRow(result);

    // Approved, and resumed the way the runtime's listener does it.
    await harness.approvalRequests.update({ id: approval.id }, { status: 'approved' });
    await result.runRepository.update({ id: 'run-1' }, { status: AgentRunStatus.RUNNING });
    await result.drive();

    expect(result.runRepository.row('run-1')!.status).toBe(AgentRunStatus.COMPLETED);
    expect(result.runEvents.rows('run-1').find((e) => e.type === 'approval_resolved')!.payload).toEqual({ approvalId: approval.id });
    expect(result.runEvents.rows('run-1').find((e) => e.type === 'memory_changed' && e.payload.unset)?.payload.unset).toContain('gatedToolCalls');
    expectLogMatchesRow(result);
  });

  it('a run whose context is compacted: one compaction event per step that folded, none for one that did not', async () => {
    // The real compactor, watched: what each step's compact() returned.
    const real = new AgentContextCompactor({} as any);
    const calls: Array<{ folded: number; foldedTotal: number | undefined }> = [];
    const compactor = {
      compact: async (...args: Parameters<AgentContextCompactor['compact']>) => {
        const out = await real.compact(...args);
        calls.push({ folded: out.folded, foldedTotal: args[1].workingMemory?.contextSummary?.foldedTotal });
        return out;
      },
    };
    const result = await runAgent({
      models: null,
      // Any context is over budget: the first step has nothing old enough
      // to fold, the later ones fold the prefix that has grown since.
      modelConfig: { ...mainModelConfig, compaction: { enabled: true, strategy: 'truncate', maxContextTokens: 1, keepRecentMessages: 1 } },
      compactor,
      streams: {
        [MODEL]: [
          anthropicTool(MODEL, 'crm_lookup', { account: '4411' }, 50, 10),
          anthropicTool(MODEL, 'crm_lookup', { account: '4412' }, 60, 10),
          anthropicText(MODEL, 90, ['It ships Monday.'], 6),
        ],
      },
    });

    expect(result.run.status).toBe(AgentRunStatus.COMPLETED);
    const folding = calls.filter((c) => c.folded > 0);
    // Both kinds of step happened, so "iff" is tested both ways.
    expect(calls.some((c) => c.folded === 0)).toBe(true);
    expect(folding.length).toBeGreaterThanOrEqual(1);

    const events = result.runEvents.rows('run-1');
    const compactions = events.filter((e) => e.type === 'compaction');
    expect(compactions.map((e) => ({ folded: e.payload.folded, foldedTotal: e.payload.foldedTotal }))).toEqual(folding);
    // foldedTotal only grows.
    const totals = compactions.map((e) => e.payload.foldedTotal);
    expect(totals).toEqual([...totals].sort((x, y) => x - y));
    expect(new Set(totals).size).toBe(totals.length);
    // Each one is written by the commit of the step it belongs to: the next
    // step_committed after it closes the same step, in the same write.
    for (const c of compactions) {
      const closing = events.find((e) => e.seq > c.seq && e.type === 'step_committed')!;
      expect(closing.step).toBe(c.step);
      expect(events.filter((e) => e.seq > c.seq && e.seq < closing.seq && e.type === 'run_started')).toEqual([]);
    }
    expect(events.some((e) => e.type === 'memory_changed' && e.payload.set?.contextSummary)).toBe(true);
    expectLogMatchesRow(result);
  });

  it('a run that fails', async () => {
    const result = await runAgent({ models: null, streams: { [MODEL]: [new Error('provider unavailable')] } });

    expect(result.run.status).toBe(AgentRunStatus.FAILED);
    const failed = result.runEvents.rows('run-1').find((e) => e.type === 'run_failed')!;
    expect(failed.payload.error).toBe(result.run.error);
    expect(types(result)).toContain('step_recorded');
    expectLogMatchesRow(result);
  });
});

describe('writes that race a step', () => {
  const harness = () => {
    const runs = fakeRepository<AgentRun>({
      make: () => new AgentRun(),
      seed: [{ id: 'run-9', status: AgentRunStatus.RUNNING, currentStep: 2, headSeq: 0, steps: [], workingMemory: {}, metadata: {}, totalCost: 0, totalTokens: 0, toolCallCount: 0, executionTime: 0 } as any],
    });
    const events = withRunEvents(runs);
    const processor = new AgentStepProcessor({ runRepository: runs, logger: { warn: jest.fn() } } as any, {} as any, {} as any, {} as any);
    return { runs, events, processor };
  };

  /** Seqs run 1..n with no gap or repeat, the row's head is the last, and the log folds into the row. */
  const expectSound = (runs: any, events: RunEventsTable) => {
    const log = events.rows('run-9');
    const seqs = log.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const row = runs.row('run-9') as AgentRun;
    expect(row.headSeq).toBe(seqs[seqs.length - 1]);
    const { headSeq, ...state } = projectRunEvents(log);
    expect(headSeq).toBe(row.headSeq);
    expect(state).toEqual(storedRunState(row));
  };

  it('two workers on the same step: the second appends nothing and reports it lost', async () => {
    const { runs, events, processor } = harness();
    const a = runs.row('run-9')!;
    const b = runs.row('run-9')!;
    a.currentStep = 3;
    a.steps = [{ type: 'llm_call', output: 'a', timestamp: 't1' }] as any;
    b.currentStep = 3;
    b.steps = [{ type: 'llm_call', output: 'b', timestamp: 't2' }] as any;
    b.totalCost = 1;

    expect(await (processor as any).commitStep(a, 2)).toBe(true);
    const afterFirst = events.rows('run-9').length;
    expect(await (processor as any).commitStep(b, 2)).toBe(false);

    expect(events.rows('run-9')).toHaveLength(afterFirst);
    expect(runs.row('run-9')!.totalCost).toBe(0);
    expectSound(runs, events);
  });

  it('writes made during the step land first, and the step commit is diffed against them', async () => {
    const { runs, events, processor } = harness();
    const run = runs.row('run-9')!;
    // During the step: request_approval pauses the run (ApprovalsService),
    // and an always-on wake leaves a reply address on its metadata.
    await writeRun(runs as any, { id: 'run-9' }, { status: AgentRunStatus.WAITING_APPROVAL }, [
      { type: 'approval_requested', step: null, payload: { approvalId: 'ap-1', kind: 'run' } },
    ]);
    await writeRun(runs as any, { id: 'run-9' }, mergeMetadata({ replyTo: [{ channelId: 'c', to: 'u' }] }));
    const outside = events.rows('run-9').length;

    // The step, holding the row as loaded before them, commits what it did.
    run.status = AgentRunStatus.WAITING_APPROVAL;
    run.currentStep = 3;
    run.metadata = { replyTo: [{ channelId: 'c', to: 'u' }] };
    run.steps = [{ type: 'tool_call', input: { tool: 'request_approval' }, output: 'Awaiting', timestamp: 't' }] as any;
    expect(await (processor as any).commitStep(run, 2)).toBe(true);

    const log = events.rows('run-9');
    expect(log.length).toBeGreaterThan(outside);
    // One request, from the writer that made it; the commit does not announce it again.
    expect(log.filter((e) => e.type === 'approval_requested')).toHaveLength(1);
    expect(log.filter((e) => e.type === 'status_changed')).toHaveLength(1);
    expect(run.headSeq).toBe(log.length);
    expectSound(runs, events);
  });

  it('a commit after the first one, from the same worker, continues the numbering', async () => {
    const { runs, events, processor } = harness();
    const run = runs.row('run-9')!;
    run.currentStep = 3;
    expect(await (processor as any).commitStep(run, 2)).toBe(true);
    const first = events.rows('run-9').length;
    run.currentStep = 4;
    expect(await (processor as any).commitStep(run, 3)).toBe(true);
    expect(events.rows('run-9').length).toBeGreaterThan(first);
    expectSound(runs, events);
  });

  it('a seq already taken is refused by the primary key, not stored twice', async () => {
    const { runs, events } = harness();
    // Something wrote an event around the writer, without moving the head.
    await (events.insert as any)({ runId: 'run-9', seq: 1, type: 'run_started', step: 2, payload: {} });
    await expect(writeRun(runs as any, { id: 'run-9' }, { status: AgentRunStatus.CANCELLED })).rejects.toThrow(/PK_agent_run_events/);
    expect(events.rows('run-9')).toHaveLength(1);
  });
});

describe('projectRunEvents refuses a log that cannot stand in for the row', () => {
  const started = { seq: 1, type: 'run_started', payload: { status: 'running', currentStep: 0, workingMemory: {}, metadata: null, steps: [] } };
  const committed = (seq: number) => ({ seq, type: 'step_committed', payload: { status: 'running', currentStep: 1, totalCost: 0, totalTokens: 0, toolCallCount: 0, executionTime: 0 } });

  it('a gap', () => {
    expect(() => projectRunEvents([started, committed(3)])).toThrow(/not contiguous/);
  });

  it('a repeated seq', () => {
    expect(() => projectRunEvents([started, committed(2), committed(2)])).toThrow(/not contiguous/);
  });

  it('a log that does not open with run_started', () => {
    expect(() => projectRunEvents([{ ...committed(1) }])).toThrow(/run_started/);
  });

  it('a step out of order', () => {
    expect(() =>
      projectRunEvents([started, { seq: 2, type: 'model_call', payload: { index: 1, step: { type: 'llm_call', timestamp: 't' } } }]),
    ).toThrow(/out of order/);
  });
});
