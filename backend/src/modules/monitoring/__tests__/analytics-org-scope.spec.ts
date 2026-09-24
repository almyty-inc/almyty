import { AnalyticsService } from '../analytics.service';
import { AnalyticsExportHelper } from '../analytics-export.helper';
import { AnalyticsSummariesHelper } from '../analytics-summaries.helper';

/**
 * Every analytics read is scoped to the caller's organization.
 *
 * Two of these predicates carry a `CRITICAL:` comment in the service
 * because they are fixes for real cross-tenant leaks — `getRequestLogs`
 * was unscoped, and `getGatewayUsage` took `organizationId` and never
 * used it. Neither had a test.
 *
 * They had none because the doubles those specs use are canned query
 * builders: `where`/`andWhere` are `jest.fn().mockReturnThis()` and the
 * terminal returns a fixed array, so the arguments are never looked at.
 * Deleting `.where('session.organizationId = :orgId', ...)` from
 * `getLlmUsage` left the whole monitoring suite green.
 *
 * The recorder below keeps every clause and every `where` object instead,
 * so a dropped org predicate anywhere under AnalyticsService — including
 * the two helpers it delegates to — turns this red. It deliberately
 * asserts a property of the queries rather than of the rows: these
 * methods aggregate in SQL, so a filtering fake would have to
 * reimplement Postgres to say anything at all.
 */

type Clause = { sql: string; params?: Record<string, any> };

class RecordingQueryBuilder {
  readonly clauses: Clause[] = [];

  constructor(readonly alias: string) {}

  where(sql: any, params?: any) {
    this.clauses.push({ sql: String(sql), params });
    return this;
  }
  andWhere(sql: any, params?: any) {
    this.clauses.push({ sql: String(sql), params });
    return this;
  }
  orWhere(sql: any, params?: any) {
    this.clauses.push({ sql: String(sql), params });
    return this;
  }
  having(sql: any, params?: any) {
    this.clauses.push({ sql: String(sql), params });
    return this;
  }

  select() { return this; }
  addSelect() { return this; }
  innerJoin() { return this; }
  innerJoinAndSelect() { return this; }
  leftJoin() { return this; }
  leftJoinAndSelect() { return this; }
  groupBy() { return this; }
  addGroupBy() { return this; }
  orderBy() { return this; }
  addOrderBy() { return this; }
  skip() { return this; }
  take() { return this; }
  limit() { return this; }
  offset() { return this; }
  distinct() { return this; }
  setParameter() { return this; }
  setParameters() { return this; }

  async getCount() { return 0; }
  async getOne() { return null; }
  async getMany() { return []; }
  async getManyAndCount(): Promise<[any[], number]> { return [[], 0]; }
  async getRawOne() { return {}; }
  async getRawMany() { return []; }
}

/** Everything one run of a method asked the database for. */
class QueryRecorder {
  readonly builders: RecordingQueryBuilder[] = [];
  readonly finds: any[] = [];

  repo() {
    return {
      createQueryBuilder: jest.fn((alias = 'x') => {
        const qb = new RecordingQueryBuilder(alias);
        this.builders.push(qb);
        return qb;
      }),
      count: jest.fn(async (options?: any) => {
        this.finds.push(options);
        return 0;
      }),
      find: jest.fn(async (options?: any) => {
        this.finds.push(options);
        return [];
      }),
      findOne: jest.fn(async (options?: any) => {
        this.finds.push(options);
        return null;
      }),
    } as any;
  }

  reset() {
    this.builders.length = 0;
    this.finds.length = 0;
  }
}

const clauseBindsOrg = (c: Clause, orgId: string) =>
  /organizationId/i.test(c.sql) &&
  Object.values(c.params ?? {}).some((v) => v === orgId);

const whereBindsOrg = (where: any, orgId: string): boolean => {
  if (!where) return false;
  return (Array.isArray(where) ? where : [where]).every(
    (clause) => clause?.organizationId === orgId,
  );
};

/**
 * Every query the call issued names organizationId and binds the
 * caller's own id to it. A run that issued no query at all fails too —
 * otherwise a method that silently stopped reading would pass.
 */
function expectScopedTo(recorder: QueryRecorder, orgId: string) {
  const issued = recorder.builders.length + recorder.finds.length;
  expect(issued).toBeGreaterThan(0);

  for (const qb of recorder.builders) {
    const scoped = qb.clauses.some((c) => clauseBindsOrg(c, orgId));
    if (!scoped) {
      throw new Error(
        `query builder '${qb.alias}' is not scoped to ${orgId}; clauses were: ` +
          JSON.stringify(qb.clauses.map((c) => c.sql)),
      );
    }
  }

  for (const options of recorder.finds) {
    if (!whereBindsOrg(options?.where, orgId)) {
      throw new Error(
        `find/count is not scoped to ${orgId}; where was: ${JSON.stringify(options?.where)}`,
      );
    }
  }
}

describe('analytics reads are organization-scoped', () => {
  const ORG = 'org-a';

  let recorder: QueryRecorder;
  let service: AnalyticsService;
  let exportHelper: AnalyticsExportHelper;
  let summaries: AnalyticsSummariesHelper;

  beforeEach(() => {
    recorder = new QueryRecorder();
    const repo = () => recorder.repo();
    exportHelper = new AnalyticsExportHelper(repo(), repo(), repo());
    summaries = new AnalyticsSummariesHelper(repo(), repo());
    service = new AnalyticsService(
      repo(),
      repo(),
      repo(),
      repo(),
      repo(),
      repo(),
      repo(),
      exportHelper,
      summaries,
    );
    recorder.reset();
  });

  const calls: Array<[string, () => Promise<unknown>]> = [
    ['getOverview', () => service.getOverview(ORG)],
    [
      'getRequestLogs',
      () => service.getRequestLogs({ organizationId: ORG, page: 1, limit: 50 }),
    ],
    [
      'getRequestLogs (every optional filter set)',
      () =>
        service.getRequestLogs({
          organizationId: ORG,
          page: 2,
          limit: 25,
          gatewayId: 'gw-1',
          toolId: 'tool-1',
          protocol: 'mcp',
          statusFilter: 'error',
          from: new Date('2026-01-01T00:00:00Z'),
          to: new Date('2026-02-01T00:00:00Z'),
        }),
    ],
    ['getToolUsage', () => service.getToolUsage(ORG, '7d')],
    ['getGatewayUsage', () => service.getGatewayUsage(ORG, '7d')],
    ['getLlmUsage', () => service.getLlmUsage(ORG, '7d')],
    ['getTimeline', () => service.getTimeline(ORG, '7d', 'hour')],
    ['getAuditSummary', () => service.getAuditSummary(ORG)],
    ['getAgentRunsSummary', () => service.getAgentRunsSummary(ORG)],
    [
      'exportData (requests)',
      () => service.exportData({ organizationId: ORG, format: 'json', type: 'requests' }),
    ],
    [
      'exportData (tool-executions)',
      () =>
        service.exportData({
          organizationId: ORG,
          format: 'json',
          type: 'tool-executions',
        }),
    ],
    [
      'exportData (llm-sessions)',
      () =>
        service.exportData({ organizationId: ORG, format: 'json', type: 'llm-sessions' }),
    ],
  ];

  it.each(calls)('%s binds the caller organization on every query', async (_name, call) => {
    await call();
    expectScopedTo(recorder, ORG);
  });

  /**
   * getOverview swallows every sub-query error with `.catch(() => 0)`,
   * so a scope regression there cannot surface as a thrown error. Pin
   * the query count too, so a tile that silently stops asking is visible.
   */
  it('getOverview issues all eight tiles, each scoped', async () => {
    await service.getOverview(ORG);

    expect(recorder.builders).toHaveLength(5);
    expect(recorder.finds).toHaveLength(3);
    expectScopedTo(recorder, ORG);
  });

  it('refuses every read that arrives without an organization', async () => {
    await expect(service.getOverview('')).rejects.toThrow(/requires organizationId/);
    await expect(
      service.getRequestLogs({ organizationId: '', page: 1, limit: 10 }),
    ).rejects.toThrow(/requires organizationId/);
    await expect(service.getToolUsage('', '7d')).rejects.toThrow(/requires organizationId/);
    await expect(service.getGatewayUsage('', '7d')).rejects.toThrow(/requires organizationId/);
    await expect(service.getLlmUsage('', '7d')).rejects.toThrow(/requires organizationId/);
    await expect(service.getTimeline('', '7d', 'hour')).rejects.toThrow(
      /requires organizationId/,
    );
    await expect(service.getAuditSummary('')).rejects.toThrow(/requires organizationId/);
    await expect(service.getAgentRunsSummary('')).rejects.toThrow(/requires organizationId/);
    await expect(
      service.exportData({ organizationId: '', format: 'json', type: 'requests' }),
    ).rejects.toThrow(/requires organizationId/);

    expect(recorder.builders).toHaveLength(0);
    expect(recorder.finds).toHaveLength(0);
  });
});
