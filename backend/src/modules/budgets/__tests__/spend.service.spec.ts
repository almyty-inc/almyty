import { SpendService } from '../spend.service';
import { startOfPeriod, normalizeGranularity } from '../spend-period.util';

/**
 * Unit tests for SpendService (T2.1 aggregation) + the period helpers.
 * A real SQL round-trip is covered by DB-integration; here we assert
 * the dollars→cents conversion and result-shape mapping over a stubbed
 * query builder, plus the period-boundary math the enforcement hook and
 * dedup key both rely on.
 *
 * Both execution shapes are stubbed separately: an autonomous agent
 * writes `agent_runs`, a workflow agent writes `agent_executions` and
 * never an AgentRun. Reading only the first meant every workflow agent's
 * spend was invisible to the Cost tab, to period-to-date, to budget
 * enforcement and to spend alerts.
 */
describe('SpendService', () => {
  function makeQb(rawOne: any, rawMany: any[]) {
    const qb: any = {};
    for (const m of [
      'select', 'addSelect', 'where', 'andWhere', 'groupBy', 'orderBy', 'limit', 'setParameter', 'leftJoin',
    ]) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getRawOne = jest.fn().mockResolvedValue(rawOne);
    qb.getRawMany = jest.fn().mockResolvedValue(rawMany);
    return qb;
  }

  const repoOf = (qb: any) => ({ createQueryBuilder: jest.fn(() => qb) }) as any;
  /** A workflow half that contributes nothing, for the run-only cases. */
  const emptyExecRepo = () => repoOf(makeQb({ total: '0' }, []));

  it('converts summed dollars to integer cents in periodToDateCents', async () => {
    const qb = makeQb({ total: '1.2345' }, []);
    const service = new SpendService(repoOf(qb), emptyExecRepo());

    const cents = await service.periodToDateCents({
      organizationId: 'org-1',
      from: new Date('2026-06-01T00:00:00Z'),
    });
    // 1.2345 dollars → 123.45 cents → rounded 123.
    expect(cents).toBe(123);
    // agentId absent → the agent filter must not be applied.
    expect(qb.andWhere).toHaveBeenCalledWith('run.createdAt >= :from', expect.anything());
  });

  it('applies the agent filter when agentId is provided', async () => {
    const qb = makeQb({ total: '0' }, []);
    const service = new SpendService(repoOf(qb), emptyExecRepo());

    await service.periodToDateCents({
      organizationId: 'org-1',
      agentId: 'agent-9',
      from: new Date(),
    });
    expect(qb.andWhere).toHaveBeenCalledWith('run.agentId = :agentId', { agentId: 'agent-9' });
  });

  it('counts a workflow agent that never wrote an AgentRun', async () => {
    // agent_runs has nothing for this org; agent_executions has $4.
    const runQb = makeQb({ total: '0' }, []);
    const execQb = makeQb({ total: '4.00' }, []);
    const service = new SpendService(repoOf(runQb), repoOf(execQb));

    const cents = await service.periodToDateCents({
      organizationId: 'org-1',
      from: new Date('2026-06-01T00:00:00Z'),
    });

    // 0 before the fix — so a workflow agent's budget could never trip.
    expect(cents).toBe(400);
  });

  it('sums both execution shapes for one organization', async () => {
    const service = new SpendService(
      repoOf(makeQb({ total: '1.50' }, [])),
      repoOf(makeQb({ total: '2.50' }, [])),
    );
    expect(
      await service.periodToDateCents({ organizationId: 'org-1', from: new Date() }),
    ).toBe(400);
  });

  it('maps timeseries + byAgent rows with cents conversion', async () => {
    const rows = [
      { periodStart: '2026-06-01T00:00:00.000Z', agentId: 'agent-1', total: '2.00', count: '3' },
    ];
    const qb = makeQb({ total: '5.00' }, rows);
    const service = new SpendService(repoOf(qb), emptyExecRepo());

    const summary = await service.getSummary('org-1', {
      from: new Date('2026-06-01T00:00:00Z'),
      granularity: 'day',
    });

    expect(summary.totalCents).toBe(500);
    expect(summary.timeseries).toEqual([
      { periodStart: '2026-06-01T00:00:00.000Z', spentCents: 200, runCount: 3 },
    ]);
    expect(summary.byAgent).toEqual([
      { agentId: 'agent-1', spentCents: 200, runCount: 3 },
    ]);
  });

  it('merges the two shapes into one bucket per period and one row per agent', async () => {
    // The same agent, the same day, run in both modes: one bucket, one row.
    const runQb = makeQb({ total: '2.00' }, [
      { periodStart: '2026-06-01T00:00:00.000Z', agentId: 'agent-1', total: '2.00', count: '1' },
    ]);
    const execQb = makeQb({ total: '3.00' }, [
      { periodStart: '2026-06-01T00:00:00.000Z', agentId: 'agent-1', total: '3.00', count: '2' },
    ]);
    const service = new SpendService(repoOf(runQb), repoOf(execQb));

    const summary = await service.getSummary('org-1', {
      from: new Date('2026-06-01T00:00:00Z'),
      granularity: 'day',
    });

    expect(summary.totalCents).toBe(500);
    expect(summary.timeseries).toEqual([
      { periodStart: '2026-06-01T00:00:00.000Z', spentCents: 500, runCount: 3 },
    ]);
    expect(summary.byAgent).toEqual([
      { agentId: 'agent-1', spentCents: 500, runCount: 3 },
    ]);
  });

  it('normalizes granularity against a whitelist', () => {
    expect(normalizeGranularity('week')).toBe('week');
    expect(normalizeGranularity('month')).toBe('month');
    expect(normalizeGranularity('hour')).toBe('day');
    expect(normalizeGranularity(undefined)).toBe('day');
    expect(normalizeGranularity('; drop table')).toBe('day');
  });

  it('computes UTC period boundaries for day and month', () => {
    const t = new Date('2026-06-23T15:45:10.000Z');
    expect(startOfPeriod('day', t).toISOString()).toBe('2026-06-23T00:00:00.000Z');
    expect(startOfPeriod('month', t).toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('attributes spend per team via the agent join (null = no team)', async () => {
    const rows = [
      { teamId: 'team-1', total: '6.00', count: '2' },
      { teamId: null, total: '3.00', count: '1' },
    ];
    const qb = makeQb(null, rows);
    const service = new SpendService(repoOf(qb), repoOf(makeQb(null, [])));

    const byTeam = await service.byTeam('org-1', new Date('2026-06-01T00:00:00Z'));
    expect(qb.leftJoin).toHaveBeenCalledWith('agents', 'agent', 'agent.id = run.agentId');
    expect(byTeam).toEqual([
      { teamId: 'team-1', spentCents: 600, runCount: 2 },
      { teamId: null, spentCents: 300, runCount: 1 },
    ]);
  });

  it('rolls a team up across both execution shapes', async () => {
    const service = new SpendService(
      repoOf(makeQb(null, [{ teamId: 'team-1', total: '1.00', count: '1' }])),
      repoOf(makeQb(null, [{ teamId: 'team-1', total: '2.00', count: '1' }])),
    );

    expect(await service.byTeam('org-1', new Date())).toEqual([
      { teamId: 'team-1', spentCents: 300, runCount: 2 },
    ]);
  });

  /**
   * Every aggregation here is a raw query builder, and the stub above
   * chains any clause and answers a canned row, so `organizationId` could
   * be dropped from any of these queries with the suite green: the Cost
   * tab, period-to-date, budget enforcement and alerts would have summed
   * every organization's spend. This builder records each query's
   * clauses, one builder per query, and the test asserts every one of
   * them binds this organization.
   */
  describe('organization scoping', () => {
    const CHAIN = ['select', 'addSelect', 'where', 'andWhere', 'groupBy', 'orderBy', 'limit', 'setParameter', 'leftJoin'];

    function recordingRepo() {
      const queries: Array<{ clauses: Array<[string, Record<string, any> | undefined]>; ran: boolean }> = [];
      const repo = {
        createQueryBuilder: jest.fn(() => {
          const q = { clauses: [] as Array<[string, Record<string, any> | undefined]>, ran: false };
          queries.push(q);
          const qb: any = {};
          for (const m of CHAIN) {
            qb[m] = (...args: any[]) => {
              if (m === 'where' || m === 'andWhere') q.clauses.push([args[0], args[1]]);
              return qb;
            };
          }
          qb.getRawOne = async () => ((q.ran = true), { total: '0' });
          qb.getRawMany = async () => ((q.ran = true), []);
          return qb;
        }),
      };
      return { repo: repo as any, queries };
    }

    it('binds the organization on every query, over both execution shapes', async () => {
      const runs = recordingRepo();
      const execs = recordingRepo();
      const service = new SpendService(runs.repo, execs.repo);
      const from = new Date('2026-06-01T00:00:00Z');

      await service.periodToDateCents({ organizationId: 'org-1', from });
      await service.getSummary('org-1', { from }); // period-to-date + timeseries + byAgent
      await service.byTeam('org-1', from);

      for (const { queries } of [runs, execs]) {
        expect(queries).toHaveLength(5);
        for (const q of queries) {
          expect(q.ran).toBe(true);
          expect(q.clauses).toContainEqual(['run.organizationId = :orgId', { orgId: 'org-1' }]);
        }
      }
    });
  });

  describe('forecast', () => {
    const service = new SpendService({} as any, {} as any);
    const bucket = (spentCents: number) => ({ periodStart: 'x', spentCents, runCount: 1 });

    it('projects a rising linear series', () => {
      const f = service.forecast([bucket(100), bucket(200), bucket(300)], 1);
      expect(f.basis).toBe('linear');
      expect(f.perPeriodCents).toBe(100);
      // fit y = 100x + 100 → x=3 → 400.
      expect(f.projectedCents).toBe(400);
    });

    it('sums multiple periods ahead', () => {
      const f = service.forecast([bucket(100), bucket(200), bucket(300)], 2);
      // x=3 (400) + x=4 (500) = 900.
      expect(f.projectedCents).toBe(900);
      expect(f.periodsAhead).toBe(2);
    });

    it('clamps a declining projection to zero', () => {
      const f = service.forecast([bucket(300), bucket(200), bucket(100)], 1);
      // fit slope -100, x=3 → 0 (clamped, not negative).
      expect(f.projectedCents).toBe(0);
      expect(f.perPeriodCents).toBe(-100);
    });

    it('flags insufficient data with fewer than two points', () => {
      expect(service.forecast([], 1)).toMatchObject({ basis: 'insufficient-data', projectedCents: 0 });
      expect(service.forecast([bucket(50)], 2)).toMatchObject({
        basis: 'insufficient-data',
        projectedCents: 100,
      });
    });
  });
});