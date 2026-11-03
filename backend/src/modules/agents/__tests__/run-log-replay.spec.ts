import { HttpStatus, NotFoundException } from '@nestjs/common';

import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { AgentRuntimeEventsHelper } from '../agent-runtime-events.helper';
import { AgentRunsController, resumeSeqOf } from '../agent-runs.controller';
import { writeRun } from '../run-event-writer';
import { runsWithEvents } from '../../../test/fake-run-events';
import { fakeRedisStreams } from '../../../test/fake-redis-streams';

/**
 * Durable runs step 2: a live run view resumes from the run's event log.
 * A viewer sends the last seq it saw and gets every logged event after it,
 * in order, then the live stream, with no gap and no repeat at the
 * handover, even when a write commits while the log is being read.
 */
const until = async (cond: () => boolean, what = 'condition') => {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('a live run view replays the log, then goes live', () => {
  let helper: AgentRuntimeEventsHelper;
  let runs: ReturnType<typeof runsWithEvents>;
  let redis: ReturnType<typeof fakeRedisStreams>;

  beforeEach(() => {
    runs = runsWithEvents([
      { id: 'run-1', organizationId: 'org-1', status: AgentRunStatus.RUNNING, currentStep: 0, headSeq: 0, workingMemory: {}, metadata: {} } as any,
    ]);
    redis = fakeRedisStreams();
    helper = new AgentRuntimeEventsHelper(runs as any, redis);
    // Only announcements move a view, unless a case says otherwise: the
    // handover has to be right without the idle read papering over it.
    helper.logIdleReadMs = 60_000;
    helper.logEndGraceMs = 300;
    helper.onModuleInit();
  });
  afterEach(() => helper.onModuleDestroy());

  /** One step's worth of writing: a few events each. */
  const step = () =>
    writeRun(runs as any, { id: 'run-1' }, (row) => ({ currentStep: row.currentStep + 1, metadata: { ...(row.metadata ?? {}), at: row.currentStep } }));
  const finish = () => writeRun(runs as any, { id: 'run-1' }, { status: AgentRunStatus.COMPLETED, output: 'done' });
  const head = () => runs.row('run-1')!.headSeq;

  const watch = (afterSeq: number, timeoutMs = 5_000) => {
    const seqs: number[] = [];
    const live: string[] = [];
    const controller = new AbortController();
    const ended = helper.subscribeRunLog(
      'run-1',
      afterSeq,
      (e) => seqs.push(e.seq),
      (e) => live.push(e.type),
      controller.signal,
      timeoutMs,
    );
    return { seqs, live, controller, ended };
  };

  it('from seq N: exactly N+1..head, then each live write, in order, once', async () => {
    for (let i = 0; i < 4; i++) await step();
    const n = 3;
    const view = watch(n);
    await until(() => view.seqs.length === head() - n, 'the replay');
    expect(view.seqs).toEqual(range(n + 1, head()));

    for (let i = 0; i < 3; i++) await step();
    await finish();
    await view.ended;
    expect(view.seqs).toEqual(range(n + 1, head()));
  });

  it('a write that commits while the log is read, before the read sees it: sent once, from the read', async () => {
    for (let i = 0; i < 3; i++) await step();
    const before = head();
    const read = runs.events.find.getMockImplementation()!;
    runs.events.find.mockImplementationOnce(async (options: any) => {
      await step(); // commits (and announces itself) before the read takes its rows
      return read(options);
    });
    const view = watch(1);
    await until(() => view.seqs.length > 0 && view.seqs[view.seqs.length - 1] === head(), 'the racing write');
    expect(head()).toBeGreaterThan(before);
    await step();
    await finish();
    await view.ended;
    expect(view.seqs).toEqual(range(2, head()));
  });

  it('a write that commits while the log is read, after the read took its rows: sent once, from its announcement', async () => {
    for (let i = 0; i < 3; i++) await step();
    const read = runs.events.find.getMockImplementation()!;
    let raced = 0;
    runs.events.find.mockImplementationOnce(async (options: any) => {
      const rows = await read(options);
      await step(); // commits after the rows were read, before they are sent
      raced = head();
      return rows;
    });
    const view = watch(0);
    await until(() => raced > 0 && view.seqs[view.seqs.length - 1] === raced, 'the racing write');
    await finish();
    await view.ended;
    expect(view.seqs).toEqual(range(1, head()));
  });

  it('many writes racing the handover from several writers: no gap, no repeat', async () => {
    await step();
    const view = watch(0);
    await Promise.all(Array.from({ length: 12 }, () => step()));
    await finish();
    await view.ended;
    expect(view.seqs).toEqual(range(1, head()));
  });

  it('an announcement that never arrives: the event still comes, from the next read of the log', async () => {
    helper.logIdleReadMs = 50;
    await step();
    const view = watch(head());
    await new Promise((r) => setTimeout(r, 20));
    redis.failNextAddTo(/:log$/);
    const from = head();
    await step();
    await until(() => view.seqs.length > 0 && view.seqs[view.seqs.length - 1] === head(), 'the idle read');
    expect(view.seqs).toEqual(range(from + 1, head()));
    view.controller.abort();
    await view.ended;
  });

  it('a finished run replays whole, from run_started, and the stream ends', async () => {
    await step();
    await step();
    await finish();
    const types: string[] = [];
    await helper.subscribeRunLog('run-1', 0, (e) => types.push(e.type), () => undefined, undefined, 5_000);
    expect(types[0]).toBe('run_started');
    expect(types.filter((t) => t === 'step_committed')).toHaveLength(3);
    expect(types).toContain('run_completed');
  });

  it('a seq at the head sends nothing old; live runtime events are from now on, and a terminal one ends it with the rest of the log', async () => {
    await step();
    helper.emitEvent('run-1', 'llm.chunk', { content: 'before the viewer came' });
    const view = watch(head());
    await new Promise((r) => setTimeout(r, 20));
    helper.emitEvent('run-1', 'llm.chunk', { content: 'live' });
    const from = head();
    await finish();
    helper.emitEvent('run-1', 'run.completed', { output: 'done' });
    await view.ended;
    expect(view.live).toEqual(['llm.chunk', 'run.completed']);
    expect(view.seqs).toEqual(range(from + 1, head()));
  });

  it('the time limit says so, with the last seq sent, so the viewer can resume from it', async () => {
    await step();
    const live: any[] = [];
    await helper.subscribeRunLog('run-1', 0, () => undefined, (e) => live.push(e), undefined, 60);
    expect(live).toEqual([expect.objectContaining({ type: 'stream.timeout', data: expect.objectContaining({ lastSeq: head() }) })]);
  });

  it('each write announces its new head on run:<id>:log', async () => {
    await step();
    await step();
    const announced = (redis.streams.get('run:run-1:log') ?? []).map(([, fields]: any) => Number(fields[1]));
    expect(announced).toHaveLength(2);
    expect(announced[1]).toBe(head());
  });
});

describe('the run stream endpoint', () => {
  const res = () => {
    const out: any = { chunks: [] as string[], headers: {} as Record<string, string>, statusCode: 200, writableEnded: false };
    out.setHeader = jest.fn((k: string, v: string) => (out.headers[k] = v));
    out.flushHeaders = jest.fn();
    out.write = jest.fn((chunk: string) => out.chunks.push(chunk));
    out.end = jest.fn(() => (out.writableEnded = true));
    out.status = jest.fn((code: number) => {
      out.statusCode = code;
      return out;
    });
    out.json = jest.fn((body: any) => (out.body = body));
    Object.defineProperty(out, 'headersSent', { get: () => out.flushHeaders.mock.calls.length > 0 });
    return out;
  };
  const req = (headers: Record<string, string> = {}) => ({ user: { currentOrganizationId: 'org-1' }, headers, on: jest.fn() });
  const logged = (seq: number) => ({ runId: 'run-1', seq, type: 'step_committed', step: 0, payload: { status: 'running' }, createdAt: new Date('2026-10-27T10:00:00Z') });

  const build = () => {
    const runtime = {
      getRun: jest.fn(async (runId: string, org: string, agentId: string) => {
        if (org !== 'org-1' || agentId !== 'agent-1') throw new NotFoundException('Run not found');
        return { id: runId };
      }),
      subscribeRunLog: jest.fn(async (_runId: string, after: number, onLog: (e: any) => void, onEvent: (e: any) => void) => {
        onLog(logged(after + 1));
        onLog(logged(after + 2));
        onEvent({ type: 'llm.chunk', data: { content: 'x' }, timestamp: 't' });
      }),
      subscribeRunEvents: jest.fn(async (_runId: string, handler: (e: any) => void) => {
        handler({ type: 'llm.chunk', data: { content: 'x' }, timestamp: 't' });
      }),
    };
    return { runtime, controller: new AgentRunsController(runtime as any) };
  };

  it('Last-Event-ID resumes after that seq, over ?after; each logged event carries its seq as the SSE id', async () => {
    const { runtime, controller } = build();
    const r = res();
    await controller.streamRun('agent-1', 'run-1', req({ 'last-event-id': '7' }), r, '2');
    expect(runtime.subscribeRunLog).toHaveBeenCalledWith('run-1', 7, expect.any(Function), expect.any(Function), expect.any(AbortSignal));
    expect(runtime.subscribeRunEvents).not.toHaveBeenCalled();
    expect(r.chunks[0]).toBe(`id: 8\nevent: run.log\ndata: ${JSON.stringify({ seq: 8, type: 'step_committed', step: 0, payload: { status: 'running' }, createdAt: '2026-10-27T10:00:00.000Z' })}\n\n`);
    expect(r.chunks[1]).toMatch(/^id: 9\nevent: run\.log\n/);
    // Live runtime events have no id: they are not replayed.
    expect(r.chunks[2]).toMatch(/^event: llm\.chunk\n/);
    expect(r.chunks[r.chunks.length - 1]).toBe('event: done\ndata: {}\n\n');
  });

  it('?after=0 replays the whole history', async () => {
    const { runtime, controller } = build();
    await controller.streamRun('agent-1', 'run-1', req(), res(), '0');
    expect(runtime.subscribeRunLog).toHaveBeenCalledWith('run-1', 0, expect.any(Function), expect.any(Function), expect.any(AbortSignal));
  });

  it('neither: the live stream as before, no ids', async () => {
    const { runtime, controller } = build();
    const r = res();
    await controller.streamRun('agent-1', 'run-1', req(), r, undefined);
    expect(runtime.subscribeRunLog).not.toHaveBeenCalled();
    expect(runtime.subscribeRunEvents).toHaveBeenCalled();
    expect(r.chunks.join('')).not.toMatch(/^id:/m);
  });

  it('a malformed ?after is refused before anything streams', async () => {
    const { runtime, controller } = build();
    const r = res();
    await controller.streamRun('agent-1', 'run-1', req(), r, '-1');
    expect(r.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(runtime.subscribeRunLog).not.toHaveBeenCalled();
    expect(runtime.getRun).not.toHaveBeenCalled();
  });

  it('a run of another organization or agent: not found, and nothing of its log is sent', async () => {
    const { runtime, controller } = build();
    const other = res();
    await controller.streamRun('agent-2', 'run-1', req({ 'last-event-id': '0' }), other, undefined);
    expect(other.statusCode).toBe(404);
    expect(other.chunks).toEqual([]);
    const otherOrg = res();
    await controller.streamRun('agent-1', 'run-1', { ...req(), user: { currentOrganizationId: 'org-2' } }, otherOrg, '0');
    expect(otherOrg.statusCode).toBe(404);
    expect(runtime.subscribeRunLog).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, undefined, null],
    ['5', undefined, 5],
    ['5', '9', 5],
    [undefined, '9', 9],
    [undefined, '0', 0],
    ['garbage', '9', 9],
    ['garbage', undefined, null],
    [undefined, '', null],
    [undefined, '-3', 'invalid'],
    [undefined, '1.5', 'invalid'],
    [undefined, 'abc', 'invalid'],
  ])('Last-Event-ID %p, after %p -> %p', (header, after, expected) => {
    expect(resumeSeqOf(header, after)).toBe(expected);
  });
});
