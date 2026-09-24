import { FindOperator } from 'typeorm';

import { AnalyticsService } from '../analytics.service';
import { AnalyticsExportHelper } from '../analytics-export.helper';
import { AnalyticsSummariesHelper } from '../analytics-summaries.helper';

/**
 * Every analytics read is scoped to the caller's organization, and the
 * per-resource ones leave out other members' private resources.
 *
 * The other monitoring specs drive these methods with canned query
 * builders: `where`/`andWhere` are `mockReturnThis()` and the terminal
 * answers a fixed array, so the arguments are never looked at. Deleting
 * the organization predicate from `getLlmUsage`, `getGatewayUsage` or
 * `getRequestLogs` (the last two carry a `CRITICAL:` comment because each
 * was once a real cross-tenant leak), or a private-row filter, left the
 * whole monitoring suite green.
 *
 * These methods aggregate in SQL, so a row-filtering fake would have to
 * reimplement Postgres to say anything. This recorder keeps every clause,
 * every parameter and every `where` object instead, and asserts a
 * property of the queries: each binds the caller's organization, and each
 * per-resource one binds the private-row filter to the caller.
 */

type Clause = { sql: string; params?: Record<string, any> };

class RecordingQueryBuilder {
  readonly clauses: Clause[] = [];
  readonly parameters: Record<string, any> = {};

  constructor(readonly alias: string) {}

  private record(sql: any, params?: any) {
    if (typeof sql !== 'string') throw new Error(`unmodelled where of type ${typeof sql}`);
    this.clauses.push({ sql, params });
    Object.assign(this.parameters, params ?? {});
    return this;
  }
  where(sql: any, params?: any) { return this.record(sql, params); }
  andWhere(sql: any, params?: any) { return this.record(sql, params); }
  // An OR can widen a scope, so it is refused rather than recorded.
  orWhere(): never { throw new Error('orWhere is not modelled'); }

  select() { return this; }
  addSelect() { return this; }
  innerJoin() { return this; }
  leftJoin() { return this; }
  groupBy() { return this; }
  addGroupBy() { return this; }
  orderBy() { return this; }
  skip() { return this; }
  take() { return this; }
  limit() { return this; }
  setParameters(p: Record<string, any>) { Object.assign(this.parameters, p); return this; }

  async getCount() { return 0; }
  async getMany() { return []; }
  async getManyAndCount(): Promise<[any[], number]> { return [[], 0]; }
  async getRawOne() { return {}; }
  async getRawMany() { return []; }
}

/** Everything one call asked the database for. */
class QueryRecorder {
  readonly builders: RecordingQueryBuilder[] = [];
  readonly finds: any[] = [];

  repo() {
    const find = async (options?: any) => {
      this.finds.push(options);
      return [];
    };
    return {
      createQueryBuilder: jest.fn((alias = 'x') => {
        const qb = new RecordingQueryBuilder(alias);
        this.builders.push(qb);
        return qb;
      }),
      count: jest.fn(async (options?: any) => ((await find(options)), 0)),
      find: jest.fn(find),
    } as any;
  }

  reset() {
    this.builders.length = 0;
    this.finds.length = 0;
  }
}

const bindsOrg = (qb: RecordingQueryBuilder, orgId: string) =>
  qb.clauses.some((c) => /\.organizationId = :(\w+)$/.test(c.sql) && c.params?.[c.sql.split(':').pop()!] === orgId);

const PRIVATE_PARAM = /:(privateViewerId|_privateMe)\b/;
const hidesOthersPrivate = (qb: RecordingQueryBuilder, callerId: string) =>
  qb.clauses.some((c) => {
    const m = PRIVATE_PARAM.exec(c.sql);
    return /visibility = 'private'/.test(c.sql) && !!m && qb.parameters[m[1]] === callerId;
  });

function expectScopedTo(recorder: QueryRecorder, orgId: string) {
  // A call that issued nothing would pass every check below.
  expect(recorder.builders.length + recorder.finds.length).toBeGreaterThan(0);
  for (const qb of recorder.builders) {
    if (!bindsOrg(qb, orgId)) {
      throw new Error(`query '${qb.alias}' is not scoped to ${orgId}: ${JSON.stringify(qb.clauses.map((c) => c.sql))}`);
    }
  }
  for (const options of recorder.finds) {
    const clauses = Array.isArray(options?.where) ? options.where : [options?.where];
    if (!clauses.every((w: any) => w?.organizationId === orgId)) {
      throw new Error(`find/count is not scoped to ${orgId}: ${JSON.stringify(options?.where)}`);
    }
  }
}

function expectPrivateRowsHiddenFrom(recorder: QueryRecorder, callerId: string) {
  expect(recorder.builders.length + recorder.finds.length).toBeGreaterThan(0);
  for (const qb of recorder.builders) {
    if (!hidesOthersPrivate(qb, callerId)) {
      throw new Error(`query '${qb.alias}' shows other members' private rows: ${JSON.stringify(qb.clauses.map((c) => c.sql))}`);
    }
  }
  for (const options of recorder.finds) {
    const raw = Object.values(options?.where ?? {}).find(
      (v): v is FindOperator<any> => v instanceof FindOperator && v.type === 'raw',
    );
    const sql = raw?.getSql ? String(raw.getSql('col')) : '';
    const m = PRIVATE_PARAM.exec(sql);
    if (!raw || !/visibility = 'private'/.test(sql) || !m || raw.objectLiteralParameters?.[m[1]] !== callerId) {
      throw new Error(`find shows other members' private rows: ${sql || 'no private filter'}`);
    }
  }
}

describe('analytics reads are organization-scoped', () => {
  const ORG = 'org-a';
  const CALLER = 'user-a';

  let recorder: QueryRecorder;
  let service: AnalyticsService;

  beforeEach(() => {
    recorder = new QueryRecorder();
    const repo = () => recorder.repo();
    service = new AnalyticsService(
      repo(), repo(), repo(), repo(), repo(), repo(), repo(),
      new AnalyticsExportHelper(repo(), repo(), repo()),
      new AnalyticsSummariesHelper(repo(), repo()),
    );
  });

  const reads: Array<[string, () => Promise<unknown>]> = [
    ['getAuditSummary', () => service.getAuditSummary(ORG)],
  ];
  // Per-resource reads: also never another member's private gateway,
  // provider, tool or agent.
  const perResourceReads: Array<[string, () => Promise<unknown>]> = [
    ['getOverview', () => service.getOverview(ORG, CALLER)],
    ['getTimeline', () => service.getTimeline(ORG, '7d', 'hour', CALLER)],
    ['getRequestLogs', () => service.getRequestLogs({ organizationId: ORG, callerId: CALLER, page: 1, limit: 50 })],
    [
      'getRequestLogs (every optional filter set)',
      () =>
        service.getRequestLogs({
          organizationId: ORG, callerId: CALLER, page: 2, limit: 25, gatewayId: 'gw-1', toolId: 'tool-1',
          protocol: 'mcp', statusFilter: 'error', from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-02-01T00:00:00Z'),
        }),
    ],
    ['getToolUsage', () => service.getToolUsage(ORG, '7d', CALLER)],
    ['getGatewayUsage', () => service.getGatewayUsage(ORG, '7d', CALLER)],
    ['getLlmUsage', () => service.getLlmUsage(ORG, '7d', CALLER)],
    ['getAgentRunsSummary', () => service.getAgentRunsSummary(ORG, CALLER)],
    ['exportData (requests)', () => service.exportData({ organizationId: ORG, callerId: CALLER, format: 'json', type: 'requests' })],
    ['exportData (llm-sessions)', () => service.exportData({ organizationId: ORG, callerId: CALLER, format: 'json', type: 'llm-sessions' })],
  ];

  it.each([
    ...reads,
    ...perResourceReads,
    ['exportData (tool-executions)', () => service.exportData({ organizationId: ORG, callerId: CALLER, format: 'json', type: 'tool-executions' })],
  ] as Array<[string, () => Promise<unknown>]>)('%s binds the caller organization on every query', async (_name, call) => {
    await call();
    expectScopedTo(recorder, ORG);
  });

  it.each(perResourceReads)('%s leaves out other members’ private resources', async (_name, call) => {
    await call();
    expectPrivateRowsHiddenFrom(recorder, CALLER);
  });

  // getOverview swallows every sub-query error with `.catch(() => 0)`, so
  // pin the query count too: a tile that silently stops asking is visible.
  it('getOverview issues all eight tiles, each scoped', async () => {
    await service.getOverview(ORG, CALLER);
    expect(recorder.builders).toHaveLength(8);
    expect(recorder.finds).toHaveLength(0);
    expectScopedTo(recorder, ORG);
  });

  it('refuses every read that arrives without an organization', async () => {
    await expect(service.getOverview('', CALLER)).rejects.toThrow(/requires organizationId/);
    await expect(service.getRequestLogs({ organizationId: '', callerId: CALLER, page: 1, limit: 10 })).rejects.toThrow(/requires organizationId/);
    await expect(service.getToolUsage('', '7d', CALLER)).rejects.toThrow(/requires organizationId/);
    await expect(service.getGatewayUsage('', '7d', CALLER)).rejects.toThrow(/requires organizationId/);
    await expect(service.getLlmUsage('', '7d', CALLER)).rejects.toThrow(/requires organizationId/);
    await expect(service.getTimeline('', '7d', 'hour', CALLER)).rejects.toThrow(/requires organizationId/);
    await expect(service.getAuditSummary('')).rejects.toThrow(/requires organizationId/);
    await expect(service.getAgentRunsSummary('', CALLER)).rejects.toThrow(/requires organizationId/);
    await expect(service.exportData({ organizationId: '', callerId: CALLER, format: 'json', type: 'requests' })).rejects.toThrow(/requires organizationId/);
    expect(recorder.builders).toHaveLength(0);
    expect(recorder.finds).toHaveLength(0);
  });
});
