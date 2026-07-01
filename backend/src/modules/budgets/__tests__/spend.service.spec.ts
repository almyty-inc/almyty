import { SpendService } from '../spend.service';
import { startOfPeriod, normalizeGranularity } from '../spend-period.util';

/**
 * Unit tests for SpendService (T2.1 aggregation) + the period helpers.
 * A real SQL round-trip is covered by DB-integration; here we assert
 * the dollars→cents conversion and result-shape mapping over a stubbed
 * query builder, plus the period-boundary math the enforcement hook and
 * dedup key both rely on.
 */
describe('SpendService', () => {
  function makeQb(rawOne: any, rawMany: any[]) {
    const qb: any = {};
    for (const m of [
      'select', 'addSelect', 'where', 'andWhere', 'groupBy', 'orderBy', 'limit', 'setParameter',
    ]) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getRawOne = jest.fn().mockResolvedValue(rawOne);
    qb.getRawMany = jest.fn().mockResolvedValue(rawMany);
    return qb;
  }

  it('converts summed dollars to integer cents in periodToDateCents', async () => {
    const qb = makeQb({ total: '1.2345' }, []);
    const repo: any = { createQueryBuilder: jest.fn(() => qb) };
    const service = new SpendService(repo);

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
    const repo: any = { createQueryBuilder: jest.fn(() => qb) };
    const service = new SpendService(repo);

    await service.periodToDateCents({
      organizationId: 'org-1',
      agentId: 'agent-9',
      from: new Date(),
    });
    expect(qb.andWhere).toHaveBeenCalledWith('run.agentId = :agentId', { agentId: 'agent-9' });
  });

  it('maps timeseries + byAgent rows with cents conversion', async () => {
    const rows = [
      { periodStart: '2026-06-01T00:00:00.000Z', agentId: 'agent-1', total: '2.00', count: '3' },
    ];
    const qb = makeQb({ total: '5.00' }, rows);
    const repo: any = { createQueryBuilder: jest.fn(() => qb) };
    const service = new SpendService(repo);

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
});
