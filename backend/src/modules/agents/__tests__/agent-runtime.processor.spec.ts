import { AgentRuntimeProcessor } from '../agent-runtime.processor';
import { AgentRunStatus } from '../../../entities/agent-run.entity';

describe('AgentRuntimeProcessor.handleNextStep — step enqueue idempotency', () => {
  const makeProcessor = (processResult: 'continue' | 'done' | 'waiting') => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) } as any;
    const runtimeService = { processStep: jest.fn().mockResolvedValue(processResult) } as any;
    const runRepo = { findOne: jest.fn(), update: jest.fn() } as any;
    const processor = new AgentRuntimeProcessor(runtimeService, queue, {} as any, runRepo);
    return { processor, queue, runtimeService, runRepo };
  };

  it('enqueues the next step with a deterministic, incremented jobId', async () => {
    const { processor, queue } = makeProcessor('continue');

    await processor.handleNextStep({ data: { runId: 'r1', seq: 4 } } as any);

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe('next-step');
    expect(data).toMatchObject({ runId: 'r1', seq: 5 });
    expect(opts.jobId).toBe('step:r1:5');
  });

  it('defaults seq to 0 when absent (legacy job) and enqueues step:...:1', async () => {
    const { processor, queue } = makeProcessor('continue');

    await processor.handleNextStep({ data: { runId: 'r1' } } as any);

    expect(queue.add.mock.calls[0][1]).toMatchObject({ runId: 'r1', seq: 1 });
    expect(queue.add.mock.calls[0][2].jobId).toBe('step:r1:1');
  });

  it('does not enqueue when the step is done or waiting', async () => {
    for (const r of ['done', 'waiting'] as const) {
      const { processor, queue } = makeProcessor(r);
      await processor.handleNextStep({ data: { runId: 'r1', seq: 2 } } as any);
      expect(queue.add).not.toHaveBeenCalled();
    }
  });

  it('carries the correlation id from the job payload into the next step', async () => {
    const { processor, queue } = makeProcessor('continue');

    await processor.handleNextStep({
      data: { runId: 'r1', seq: 1, requestId: 'req-from-the-http-call' },
    } as any);

    expect(queue.add.mock.calls[0][1].requestId).toBe('req-from-the-http-call');
  });
});

/**
 * There was no @OnQueueFailed on this processor at all. Jobs are
 * enqueued with attempts: 3 and removeOnFail: 50, and the handler only
 * logged and rethrew — so the third failure wrote nothing: the run stayed
 * `running`, its `error` stayed null, and the only record of why the
 * queue gave up was a Redis job the next 50 failures would evict.
 */
describe('AgentRuntimeProcessor.onFailed — an exhausted retry is durable', () => {
  const make = (run: any) => {
    const runRepo = {
      findOne: jest.fn().mockResolvedValue(run),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    } as any;
    const processor = new AgentRuntimeProcessor(
      { processStep: jest.fn() } as any,
      { add: jest.fn() } as any,
      {} as any,
      runRepo,
    );
    jest.spyOn((processor as any).logger, 'error').mockImplementation(() => undefined);
    jest.spyOn((processor as any).logger, 'warn').mockImplementation(() => undefined);
    return { processor, runRepo };
  };

  const job = (over: any = {}) =>
    ({
      id: 'job-9',
      name: 'next-step',
      data: { runId: 'r1', seq: 3 },
      attemptsMade: 3,
      opts: { attempts: 3 },
      ...over,
    }) as any;

  it('writes the real failure reason onto the run on the final attempt', async () => {
    const { processor, runRepo } = make({
      id: 'r1',
      status: AgentRunStatus.RUNNING,
      steps: [{ type: 'llm_call', timestamp: '2026-09-01T00:00:00.000Z' }],
    });

    await processor.onFailed(job(), new Error('provider returned 503 three times'));

    expect(runRepo.update).toHaveBeenCalledTimes(1);
    const [where, patch] = runRepo.update.mock.calls[0];
    expect(where).toEqual({ id: 'r1', status: AgentRunStatus.RUNNING });
    expect(patch.status).toBe(AgentRunStatus.FAILED);
    // The reason names the cause, not a generic sweep message.
    expect(patch.error).toContain('provider returned 503 three times');
    expect(patch.error).toContain('3 attempt(s)');
    // And the run's own timeline shows where it stopped.
    expect(patch.steps).toHaveLength(2);
    expect(patch.steps[1]).toMatchObject({ type: 'error' });
    expect(patch.steps[1].error).toContain('provider returned 503');
  });

  it('leaves the run alone while retries remain', async () => {
    const { processor, runRepo } = make({ id: 'r1', status: AgentRunStatus.RUNNING, steps: [] });

    await processor.onFailed(job({ attemptsMade: 1 }), new Error('transient'));

    expect(runRepo.findOne).not.toHaveBeenCalled();
    expect(runRepo.update).not.toHaveBeenCalled();
  });

  it('never overwrites a run that already reached a terminal state', async () => {
    const { processor, runRepo } = make({
      id: 'r1',
      status: AgentRunStatus.CANCELLED,
      steps: [],
    });

    await processor.onFailed(job(), new Error('late failure'));

    expect(runRepo.update).not.toHaveBeenCalled();
  });

  it('reaps a PENDING run too, not only a RUNNING one', async () => {
    // A run whose very first enqueue failed never leaves PENDING, and the
    // reaper deliberately ignores PENDING.
    const { processor, runRepo } = make({ id: 'r1', status: AgentRunStatus.PENDING, steps: [] });

    await processor.onFailed(job(), new Error('redis unavailable'));

    expect(runRepo.update.mock.calls[0][1].status).toBe(AgentRunStatus.FAILED);
  });

  it('records nothing for a job with no run (a timer tick) and does not throw', async () => {
    const { processor, runRepo } = make(null);

    await expect(
      processor.onFailed(job({ name: 'heartbeat', data: { agentId: 'a1' } }), new Error('boom')),
    ).resolves.toBeUndefined();
    expect(runRepo.findOne).not.toHaveBeenCalled();
  });

  it('swallows a write failure rather than replacing it with an unrecorded one', async () => {
    const { processor, runRepo } = make({ id: 'r1', status: AgentRunStatus.RUNNING, steps: [] });
    runRepo.update.mockRejectedValue(new Error('db gone'));

    await expect(processor.onFailed(job(), new Error('original'))).resolves.toBeUndefined();
  });
});

describe('AgentRuntimeProcessor.handleTimeoutCheck', () => {
  it('rethrows so a failing timeout check does not disappear', async () => {
    const runtimeService = {
      processStep: jest.fn().mockRejectedValue(new Error('timeout check exploded')),
    } as any;
    const processor = new AgentRuntimeProcessor(
      runtimeService,
      { add: jest.fn() } as any,
      {} as any,
      { findOne: jest.fn(), update: jest.fn() } as any,
    );
    jest.spyOn((processor as any).logger, 'error').mockImplementation(() => undefined);

    await expect(
      processor.handleTimeoutCheck({ data: { runId: 'r1' } } as any),
    ).rejects.toThrow('timeout check exploded');
  });
});

/**
 * Always on's jobs run on this processor: the timer tick only writes a
 * wake, the wake job turns wakes into a run, a heartbeat job left in Redis
 * from before fires as a tick, and every finished run is handed to Always
 * on so a standing thread can report and look at its inbox again.
 */
describe('AgentRuntimeProcessor and Always on', () => {
  const build = (processResult: 'continue' | 'done' | 'waiting' = 'done') => {
    const alwaysOn = {
      tick: jest.fn().mockResolvedValue(null),
      process: jest.fn().mockResolvedValue('started'),
      onRunFinished: jest.fn().mockResolvedValue(undefined),
    };
    const scheduler = { deliverScheduledRun: jest.fn().mockResolvedValue(undefined) };
    const processor = new AgentRuntimeProcessor(
      { processStep: jest.fn().mockResolvedValue(processResult) } as any,
      { add: jest.fn() } as any,
      {} as any,
      { findOne: jest.fn().mockResolvedValue(null), update: jest.fn() } as any,
      undefined,
      scheduler as any,
      alwaysOn as any,
    );
    return { processor, alwaysOn, scheduler };
  };
  const job = { data: { agentId: 'a-1', organizationId: 'org-1' } } as any;

  it('a tick writes a wake and nothing else', async () => {
    const { processor, alwaysOn } = build();
    await processor.handleAlwaysOnTick(job);
    expect(alwaysOn.tick).toHaveBeenCalledWith('a-1', 'org-1');
    expect(alwaysOn.process).not.toHaveBeenCalled();
  });

  it('a heartbeat job from before Always on fires as a tick', async () => {
    const { processor, alwaysOn } = build();
    await processor.handleLegacyHeartbeat(job);
    expect(alwaysOn.tick).toHaveBeenCalledWith('a-1', 'org-1');
  });

  it('the wake job turns wakes into a run', async () => {
    const { processor, alwaysOn } = build();
    await processor.handleAlwaysOnWake(job);
    expect(alwaysOn.process).toHaveBeenCalledWith('a-1', 'org-1');
  });

  it('a finished run is handed to Always on and to the scheduler', async () => {
    const { processor, alwaysOn, scheduler } = build('done');
    await processor.handleNextStep({ data: { runId: 'r1', seq: 3 } } as any);
    expect(alwaysOn.onRunFinished).toHaveBeenCalledWith('r1');
    expect(scheduler.deliverScheduledRun).toHaveBeenCalledWith('r1');
  });

  it('a run still going is not', async () => {
    const { processor, alwaysOn } = build('waiting');
    await processor.handleNextStep({ data: { runId: 'r1', seq: 3 } } as any);
    expect(alwaysOn.onRunFinished).not.toHaveBeenCalled();
  });
});
