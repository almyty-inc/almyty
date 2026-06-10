import { AgentRuntimeProcessor } from '../agent-runtime.processor';

describe('AgentRuntimeProcessor.handleNextStep — step enqueue idempotency', () => {
  const makeProcessor = (processResult: 'continue' | 'done' | 'waiting') => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) } as any;
    const runtimeService = { processStep: jest.fn().mockResolvedValue(processResult) } as any;
    const processor = new AgentRuntimeProcessor(runtimeService, queue, {} as any);
    return { processor, queue, runtimeService };
  };

  it('enqueues the next step with a deterministic, incremented jobId', async () => {
    const { processor, queue } = makeProcessor('continue');

    await processor.handleNextStep({ data: { runId: 'r1', seq: 4 } } as any);

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe('next-step');
    expect(data).toEqual({ runId: 'r1', seq: 5 });
    expect(opts.jobId).toBe('step:r1:5');
  });

  it('defaults seq to 0 when absent (legacy job) and enqueues step:...:1', async () => {
    const { processor, queue } = makeProcessor('continue');

    await processor.handleNextStep({ data: { runId: 'r1' } } as any);

    expect(queue.add.mock.calls[0][1]).toEqual({ runId: 'r1', seq: 1 });
    expect(queue.add.mock.calls[0][2].jobId).toBe('step:r1:1');
  });

  it('does not enqueue when the step is done or waiting', async () => {
    for (const r of ['done', 'waiting'] as const) {
      const { processor, queue } = makeProcessor(r);
      await processor.handleNextStep({ data: { runId: 'r1', seq: 2 } } as any);
      expect(queue.add).not.toHaveBeenCalled();
    }
  });
});
