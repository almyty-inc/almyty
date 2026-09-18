import { AnalyticsSummariesHelper } from '../analytics-summaries.helper';

/**
 * Four COUNTs over an identical window differing only in `status`, and three
 * audit-log COUNTs differing only in their lower bound. One GROUP BY and one
 * set of conditional sums answer each.
 */
describe('analytics summaries issue one aggregate, not several COUNTs', () => {
  const ORG = 'org-1';

  const makeQb = (raw: any, rawMany: any[] = []) => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setParameters: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(raw),
    getRawMany: jest.fn().mockResolvedValue(rawMany),
  });

  it('answers the audit totals from one scan instead of three COUNTs', async () => {
    const auditLogRepository: any = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
    };
    auditLogRepository.createQueryBuilder
      .mockReturnValueOnce(makeQb({ today: '4', thisWeek: '9', thisMonth: '30' }))
      .mockReturnValue(makeQb(null, []));

    const helper = new AnalyticsSummariesHelper(auditLogRepository, { count: jest.fn() } as any);
    const result = await helper.getAuditSummary(ORG);

    // The three repository.count() calls are gone entirely.
    expect(auditLogRepository.count).not.toHaveBeenCalled();
    expect(result.totals).toEqual({ today: 4, thisWeek: 9, thisMonth: 30 });
    expect(result.partial).toBe(false);
  });

  it('still names each audit figure when the one query fails', async () => {
    const failing = makeQb(null);
    failing.getRawOne = jest.fn().mockRejectedValue(new Error('down'));
    const auditLogRepository: any = {
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    auditLogRepository.createQueryBuilder
      .mockReturnValueOnce(failing)
      .mockReturnValue(makeQb(null, []));

    const helper = new AnalyticsSummariesHelper(auditLogRepository, { count: jest.fn() } as any);
    const result = await helper.getAuditSummary(ORG);

    expect(result.partial).toBe(true);
    expect(result.unavailable).toEqual(expect.arrayContaining(['today', 'thisWeek', 'thisMonth']));
    expect(result.totals).toEqual({ today: 0, thisWeek: 0, thisMonth: 0 });
  });

  it('answers the run totals from one GROUP BY status instead of four COUNTs', async () => {
    const agentRunRepository: any = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
    };
    agentRunRepository.createQueryBuilder
      .mockReturnValueOnce(
        makeQb(null, [
          { status: 'completed', count: '7' },
          { status: 'failed', count: '2' },
          { status: 'cancelled', count: '1' },
          { status: 'running', count: '3' },
        ]),
      )
      .mockReturnValue(makeQb({ avg: '0', total: '0' }, []));

    const helper = new AnalyticsSummariesHelper({ count: jest.fn() } as any, agentRunRepository);
    const result = await helper.getAgentRunsSummary(ORG);

    expect(agentRunRepository.count).not.toHaveBeenCalled();
    // `total` is the sum of every status, which is what the unfiltered
    // COUNT answered — running runs included.
    expect(result.totals).toEqual({ total: 13, completed: 7, failed: 2, cancelled: 1 });
  });

  it('reports zeros rather than throwing when the status rollup fails', async () => {
    const failing = makeQb(null, []);
    failing.getRawMany = jest.fn().mockRejectedValue(new Error('down'));
    const agentRunRepository: any = { count: jest.fn(), createQueryBuilder: jest.fn() };
    agentRunRepository.createQueryBuilder
      .mockReturnValueOnce(failing)
      .mockReturnValue(makeQb({ avg: '0', total: '0' }, []));

    const helper = new AnalyticsSummariesHelper({ count: jest.fn() } as any, agentRunRepository);
    const result = await helper.getAgentRunsSummary(ORG);

    expect(result.totals).toEqual({ total: 0, completed: 0, failed: 0, cancelled: 0 });
  });
});
