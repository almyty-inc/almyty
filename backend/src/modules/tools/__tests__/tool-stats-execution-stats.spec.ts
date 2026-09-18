import { ToolStatsHelper } from '../tool-stats.helper';

/**
 * Six scalars must cost one aggregate query, not the window.
 *
 * `getToolExecutionStats` used to `find()` every matching tool_executions
 * row with no `select` and no `take`, then count/sum/average them in heap.
 * A ToolExecution carries `parameters` and `result` as untruncated json and
 * the HTTP executor allows 10MB responses, so a tool at 1 req/s over a
 * `month` timeframe -- which the caller chooses -- is ~2.6M such rows,
 * reached by opening that tool's detail page.
 *
 * Its sibling `ToolsStatsHelper.getOrganizationToolStats` was already moved
 * to COUNT/AVG for exactly this reason. This asserts the shape: no row-
 * returning read at all, and the aggregates computed in SQL.
 */
describe('ToolStatsHelper.getToolExecutionStats — aggregates, not rows', () => {
  let toolExecutionRepository: any;
  let helper: ToolStatsHelper;
  let recorded: { selects: Array<[string, string]>; wheres: string[]; params: any };
  let rawRow: Record<string, any>;

  beforeEach(() => {
    recorded = { selects: [], wheres: [], params: {} };
    rawRow = {
      total: '7',
      successful: '5',
      avgTime: '120.4',
      cachedCount: '2',
      rateLimited: '1',
    };

    const qb: any = {
      select: (expr: string, alias: string) => {
        recorded.selects.push([expr, alias]);
        return qb;
      },
      addSelect: (expr: string, alias: string) => {
        recorded.selects.push([expr, alias]);
        return qb;
      },
      where: (clause: string, params?: any) => {
        recorded.wheres.push(clause);
        Object.assign(recorded.params, params ?? {});
        return qb;
      },
      andWhere: (clause: string, params?: any) => {
        recorded.wheres.push(clause);
        Object.assign(recorded.params, params ?? {});
        return qb;
      },
      getRawOne: jest.fn(async () => rawRow),
      getMany: jest.fn(async () => {
        throw new Error('getMany must not be used to compute scalar stats');
      }),
    };

    toolExecutionRepository = {
      // A row-returning read is the defect itself: fail loudly rather than
      // let the assertion depend on what the fake happens to return.
      find: jest.fn(() => {
        throw new Error('find() loads every execution row — use an aggregate');
      }),
      createQueryBuilder: jest.fn(() => qb),
    };

    helper = new ToolStatsHelper(
      { createQueryBuilder: jest.fn() } as any,
      toolExecutionRepository as any,
      { logToolExecution: jest.fn() } as any,
    );
  });

  it('issues exactly one aggregate query and never loads rows', async () => {
    await helper.getToolExecutionStats('tool-1', 'org-1', 'month');

    expect(toolExecutionRepository.find).not.toHaveBeenCalled();
    expect(toolExecutionRepository.createQueryBuilder).toHaveBeenCalledTimes(1);

    const exprs = recorded.selects.map(([expr]) => expr);
    expect(exprs).toContain('COUNT(*)');
    expect(exprs.some((e) => e.startsWith('AVG('))).toBe(true);
    // Every selected expression is an aggregate — nothing projects a column.
    expect(exprs.every((e) => /^(COUNT|AVG|SUM)\(/.test(e))).toBe(true);
  });

  it('scopes on the (toolId, organizationId, createdAt) index columns', async () => {
    await helper.getToolExecutionStats('tool-1', 'org-1', 'day');

    expect(recorded.wheres).toEqual([
      'execution.toolId = :toolId',
      'execution.organizationId = :organizationId',
      'execution.createdAt >= :since',
    ]);
    expect(recorded.params.toolId).toBe('tool-1');
    expect(recorded.params.organizationId).toBe('org-1');
    expect(recorded.params.since).toBeInstanceOf(Date);
  });

  it('derives the same six scalars the in-heap version produced', async () => {
    const stats = await helper.getToolExecutionStats('tool-1', 'org-1', 'week');

    expect(stats).toEqual({
      totalExecutions: 7,
      successfulExecutions: 5,
      failedExecutions: 2,
      averageExecutionTime: 120,
      cacheHitRate: 28.57,
      rateLimitedExecutions: 1,
    });
  });

  it('returns zeros rather than NaN when the window is empty', async () => {
    rawRow = { total: '0', successful: '0', avgTime: null, cachedCount: '0', rateLimited: '0' };

    const stats = await helper.getToolExecutionStats('tool-1', 'org-1', 'hour');

    expect(stats).toEqual({
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      averageExecutionTime: 0,
      cacheHitRate: 0,
      rateLimitedExecutions: 0,
    });
  });
});
