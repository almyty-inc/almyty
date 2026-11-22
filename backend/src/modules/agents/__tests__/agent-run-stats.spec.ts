/**
 * An agent's numbers come from the runs it still has (agent-run-stats.ts).
 * The SQL itself runs against Postgres in
 * test/integration/agent-run-stats.integration.spec.ts; here the two
 * per-table aggregates are stood in for by rows, to pin how they combine
 * and that removing runs brings every number down.
 */
import { loadAgentRunStats, withRunStats } from '../agent-run-stats';

type Row = { agentId: string; status: string; executionTime: number; totalCost: number; verdict?: string; unavailable?: boolean };

/** A manager whose query answers the two grouped aggregates over in-memory rows. */
function fakeManager(runs: Row[], executions: Row[]) {
  const aggregate = (rows: Row[], ids: string[], statuses: string[], withChecks: boolean) => {
    const by = new Map<string, any>();
    for (const r of rows) {
      if (!ids.includes(r.agentId) || !statuses.includes(r.status)) continue;
      const g = by.get(r.agentId) ?? { agentId: r.agentId, runs: 0, completed: 0, checked: 0, checksPassed: 0, time: 0, cost: 0 };
      g.runs++;
      if (r.status === 'completed') g.completed++;
      const checked = r.status === 'completed' && (r.verdict === 'pass' || r.verdict === 'fail') && !r.unavailable;
      if (checked) g.checked++;
      if (checked && r.verdict === 'pass') g.checksPassed++;
      g.time += r.executionTime;
      g.cost += r.totalCost;
      by.set(r.agentId, g);
    }
    // Postgres hands back numeric strings for some types; the loader copes.
    return [...by.values()].map((g) => ({ ...g, runs: String(g.runs), ...(withChecks ? {} : { checked: undefined, checksPassed: undefined }) }));
  };
  return {
    query: jest.fn(async (sql: string, [ids, statuses]: [string[], string[]]) =>
      sql.includes('"agent_runs"') ? aggregate(runs, ids, statuses, true) : aggregate(executions, ids, statuses, false),
    ),
  };
}

describe('loadAgentRunStats', () => {
  it('works the numbers out from the existing runs and drops them as runs are removed', async () => {
    const runs: Row[] = [
      { agentId: 'a', status: 'completed', executionTime: 1000, totalCost: 0.01, verdict: 'pass' },
      { agentId: 'a', status: 'completed', executionTime: 3000, totalCost: 0.03, verdict: 'fail' },
      { agentId: 'a', status: 'failed', executionTime: 2000, totalCost: 0.02 },
      { agentId: 'a', status: 'completed', executionTime: 6000, totalCost: 0.04, verdict: 'fail', unavailable: true },
      { agentId: 'a', status: 'running', executionTime: 500, totalCost: 0.5 },
    ];
    const manager = fakeManager(runs, []);

    expect((await loadAgentRunStats(manager, ['a'])).get('a')).toEqual({
      runs: 4,
      completed: 3,
      checked: 2,
      checksPassed: 1,
      averageRunTimeMs: 3000,
      totalCost: expect.closeTo(0.1, 6),
    });

    // Delete run / erasure / retention: the first and the failed run go.
    runs.splice(2, 1);
    runs.splice(0, 1);
    expect((await loadAgentRunStats(manager, ['a'])).get('a')).toEqual({
      runs: 2,
      completed: 2,
      checked: 1,
      checksPassed: 0,
      averageRunTimeMs: 4500,
      totalCost: expect.closeTo(0.07, 6),
    });

    runs.length = 0;
    expect((await loadAgentRunStats(manager, ['a'])).get('a')).toEqual({
      runs: 0, completed: 0, checked: 0, checksPassed: 0, averageRunTimeMs: 0, totalCost: 0,
    });
  });

  it('adds an agent’s workflow executions to its runs and keeps agents apart', async () => {
    const manager = fakeManager(
      [{ agentId: 'a', status: 'completed', executionTime: 1000, totalCost: 0.1 }],
      [
        { agentId: 'a', status: 'failed', executionTime: 3000, totalCost: 0.2 },
        { agentId: 'b', status: 'completed', executionTime: 500, totalCost: 0.05 },
      ],
    );
    const stats = await loadAgentRunStats(manager, ['a', 'b', 'a', 'c']);
    expect(stats.get('a')).toEqual({ runs: 2, completed: 1, checked: 0, checksPassed: 0, averageRunTimeMs: 2000, totalCost: expect.closeTo(0.3, 6) });
    expect(stats.get('b')).toEqual({ runs: 1, completed: 1, checked: 0, checksPassed: 0, averageRunTimeMs: 500, totalCost: 0.05 });
    expect(stats.get('c')?.runs).toBe(0);
    // One grouped query per table for the whole page, ids de-duplicated.
    expect(manager.query).toHaveBeenCalledTimes(2);
    expect(manager.query.mock.calls[0][1][0]).toEqual(['a', 'b', 'c']);
  });

  it('asks nothing for no agents', async () => {
    const manager = fakeManager([], []);
    expect((await loadAgentRunStats(manager, [])).size).toBe(0);
    expect(manager.query).not.toHaveBeenCalled();
  });
});

describe('withRunStats', () => {
  it('serves the numbers in runStats and the old counter fields, leaving the entity alone', () => {
    const agent = { id: 'a', name: 'x', totalExecutions: 142, successfulExecutions: 140, averageExecutionTime: 1600, totalCost: 3 };
    const out = withRunStats(agent, { runs: 2, completed: 1, checked: 1, checksPassed: 0, averageRunTimeMs: 9500, totalCost: 0.02 });
    expect(out).toMatchObject({
      id: 'a',
      runStats: { runs: 2, completed: 1, checked: 1, checksPassed: 0, averageRunTimeMs: 9500, totalCost: 0.02 },
      totalExecutions: 2,
      successfulExecutions: 1,
      checkedExecutions: 1,
      passedCheckExecutions: 0,
      averageExecutionTime: 9500,
      totalCost: 0.02,
    });
    expect(agent.totalExecutions).toBe(142);
    expect(withRunStats(agent, undefined).totalExecutions).toBe(0);
  });
});
