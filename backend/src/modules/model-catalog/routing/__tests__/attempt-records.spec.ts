import { computeCoFailure } from '../co-failure';
import { attemptsFrom, failedAttemptsFrom } from '../attempt-records';

/**
 * The metric reads history that runs already wrote.
 *
 * computeCoFailure was correct and fed by nothing: there was no job, no
 * table and no endpoint, so the all-model failure rate could not be shown
 * however good the maths was. These tests cover the derivation, which is
 * where it can silently go wrong -- counting the answering model as a
 * failure, or missing the runs where everything failed, which are exactly
 * the ones the metric is about.
 */
describe('attempts derived from run history', () => {
  const run = (id: string, agentId: string, nodeResults: Record<string, any>) => ({ id, agentId, nodeResults });

  it('counts the model that answered as a success and the ones before it as failures', () => {
    const records = attemptsFrom([
      run('e1', 'agent-a', {
        n1: { routing: { modelId: 'fast', tried: [{ modelId: 'cheap', reason: '429' }] } },
      }),
    ]);

    expect(records).toEqual([
      { taskClass: 'agent-a', requestId: 'e1:n1', modelId: 'cheap', succeeded: false },
      { taskClass: 'agent-a', requestId: 'e1:n1', modelId: 'fast', succeeded: true },
    ]);
  });

  it('ignores a node that was never routed, rather than inventing an attempt', () => {
    expect(attemptsFrom([run('e1', 'agent-a', { n1: { output: 'hi' } })])).toEqual([]);
    expect(attemptsFrom([run('e1', 'agent-a', {})])).toEqual([]);
    expect(attemptsFrom([{ id: 'e1', agentId: 'a', nodeResults: null }])).toEqual([]);
  });

  it('keeps each node of a run a separate request, since the router chose per node', () => {
    const records = attemptsFrom([
      run('e1', 'agent-a', {
        n1: { routing: { modelId: 'm1', tried: [] } },
        n2: { routing: { modelId: 'm2', tried: [] } },
      }),
    ]);
    expect(new Set(records.map((r) => r.requestId))).toEqual(new Set(['e1:n1', 'e1:n2']));
  });

  it('finds the runs where EVERY model failed, which leave no attribution at all', () => {
    const records = failedAttemptsFrom([
      run('e2', 'agent-a', {
        n1: { error: 'all candidates failed', triedModels: [{ modelId: 'cheap' }, { modelId: 'fast' }] },
      }),
    ]);

    expect(records).toEqual([
      { taskClass: 'agent-a', requestId: 'e2:n1', modelId: 'cheap', succeeded: false },
      { taskClass: 'agent-a', requestId: 'e2:n1', modelId: 'fast', succeeded: false },
    ]);
  });

  it('ignores a failed node that never got as far as trying a model', () => {
    expect(failedAttemptsFrom([run('e2', 'a', { n1: { error: 'bad input' } })])).toEqual([]);
  });

  it('produces a rate that means what the label says end to end', () => {
    // Two requests where something answered, one where nothing did.
    const executions = [
      run('e1', 'agent-a', { n1: { routing: { modelId: 'fast', tried: [{ modelId: 'cheap', reason: '429' }] } } }),
      run('e2', 'agent-a', { n1: { routing: { modelId: 'fast', tried: [{ modelId: 'cheap', reason: '429' }] } } }),
      run('e3', 'agent-a', { n1: { error: 'exhausted', triedModels: [{ modelId: 'cheap' }, { modelId: 'fast' }] } }),
    ];

    const stats = computeCoFailure([...attemptsFrom(executions), ...failedAttemptsFrom(executions)])[0];

    expect(stats.comparableRequests).toBe(3);
    // One of three: every model failed.
    expect(stats.coFailureRate).toBeCloseTo(1 / 3, 5);
    // Two of three: one failed, another answered. A better policy wins these.
    expect(stats.routingHeadroomRate).toBeCloseTo(2 / 3, 5);
  });

  it('keeps agents apart, so one agent does not average away another', () => {
    const stats = computeCoFailure(
      attemptsFrom([
        run('e1', 'agent-a', { n1: { routing: { modelId: 'm1', tried: [{ modelId: 'm0', reason: 'x' }] } } }),
        run('e2', 'agent-b', { n1: { routing: { modelId: 'm1', tried: [{ modelId: 'm0', reason: 'x' }] } } }),
      ]),
    );
    expect(stats.map((s) => s.taskClass).sort()).toEqual(['agent-a', 'agent-b']);
  });
});
