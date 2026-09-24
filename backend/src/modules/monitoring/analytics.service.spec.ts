import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AnalyticsService } from './analytics.service';
import { AnalyticsExportHelper } from './analytics-export.helper';
import { AnalyticsSummariesHelper } from './analytics-summaries.helper';
import { RequestLog } from '../../entities/request-log.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { AgentRun } from '../../entities/agent-run.entity';

/**
 * A minimal RequestLog row as it lands in the DB. `protocol` mirrors what the
 * request-logging interceptor writes into `metadata.protocol`: a value for
 * resolved-gateway / fixed protocol routes, and `null` for tool-execution
 * request logs (`.../tools/:id/execute`), which are still genuine traffic.
 */
interface FakeLog {
  orgId: string;
  protocol: string | null;
  timestamp: Date;
  statusCode: number;
  responseTime: number;
}

/**
 * Fake QueryBuilder that evaluates the chained where/andWhere predicates
 * against an in-memory list of RequestLog rows. It understands only the
 * handful of clauses getOverview builds, which is enough to prove that:
 *  - the org scope is honoured, and
 *  - the removed `metadata->>'protocol' IS NOT NULL` guard no longer drops
 *    null-protocol (tool-execution) rows from the counts.
 */
class FakeRequestLogQueryBuilder {
  private orgId: string | null = null;
  private since: Date | null = null;
  private requireProtocol = false;
  private minStatus: number | null = null;

  constructor(private readonly rows: FakeLog[]) {}

  leftJoin() {
    return this;
  }
  select() {
    return this;
  }

  where(clause: string, params: any) {
    return this.applyClause(clause, params);
  }
  andWhere(clause: string, params?: any) {
    return this.applyClause(clause, params);
  }

  private applyClause(clause: string, params: any) {
    if (clause.includes('organizationId')) {
      this.orgId = params.orgId;
    } else if (clause.includes('log.timestamp >= :since')) {
      this.since = params.since;
    } else if (clause.includes("metadata->>'protocol' IS NOT NULL")) {
      this.requireProtocol = true;
    } else if (clause.includes('statusCode >= 500')) {
      this.minStatus = 500;
    }
    return this;
  }

  private matched(): FakeLog[] {
    return this.rows.filter((r) => {
      if (this.orgId && r.orgId !== this.orgId) return false;
      if (this.since && r.timestamp < this.since) return false;
      if (this.requireProtocol && r.protocol == null) return false;
      if (this.minStatus != null && r.statusCode < this.minStatus) return false;
      return true;
    });
  }

  async getCount() {
    return this.matched().length;
  }

  async getRawOne() {
    const m = this.matched();
    const avg = m.length ? m.reduce((s, r) => s + r.responseTime, 0) / m.length : 0;
    return { avg };
  }

  async getRawMany() {
    return [];
  }
}

describe('AnalyticsService.getOverview — protocol undercount', () => {
  let service: AnalyticsService;
  let rows: FakeLog[];

  const now = new Date();
  const recent = new Date(now.getTime() - 60 * 1000);

  const buildFor = async (logRows: FakeLog[]) => {
    rows = logRows;

    const requestLogRepository = {
      createQueryBuilder: jest.fn(() => new FakeRequestLogQueryBuilder(rows)),
    };
    // Tool executions and sessions are counted through a query builder
    // (so the private-row filter can ride along); these tests only look at
    // request logs, so both answer zero.
    const zeroQb = () => {
      const qb: any = {
        select: () => qb,
        where: () => qb,
        andWhere: () => qb,
        getCount: async () => 0,
        getRawOne: async () => ({ total: '0' }),
      };
      return qb;
    };
    const toolExecutionRepository = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(zeroQb),
    };
    const conversationRepository = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(zeroQb),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: getRepositoryToken(RequestLog), useValue: requestLogRepository },
        { provide: getRepositoryToken(UsageMetric), useValue: {} },
        { provide: getRepositoryToken(ToolExecution), useValue: toolExecutionRepository },
        { provide: getRepositoryToken(Conversation), useValue: conversationRepository },
        { provide: getRepositoryToken(Message), useValue: {} },
        { provide: getRepositoryToken(AuditLog), useValue: {} },
        { provide: getRepositoryToken(AgentRun), useValue: {} },
        { provide: AnalyticsExportHelper, useValue: {} },
        { provide: AnalyticsSummariesHelper, useValue: {} },
      ],
    }).compile();

    service = module.get(AnalyticsService);
  };

  it('counts a slug-based gateway request (protocol resolved by the interceptor)', async () => {
    await buildFor([
      { orgId: 'org-1', protocol: 'mcp', timestamp: recent, statusCode: 200, responseTime: 40 },
    ]);

    const overview = await service.getOverview('org-1', 'user-1');

    expect(overview.last24h.requests).toBe(1);
    expect(overview.last7d.requests).toBe(1);
  });

  it('counts a tool-execution request log that carries no protocol', async () => {
    // `.../tools/:id/execute` logs are written by the interceptor (isProtocolRequest)
    // but have protocol=null. The old `protocol IS NOT NULL` guard silently
    // dropped these from Overview while getRequestLogs still showed them.
    await buildFor([
      { orgId: 'org-1', protocol: null, timestamp: recent, statusCode: 200, responseTime: 12 },
    ]);

    const overview = await service.getOverview('org-1', 'user-1');

    expect(overview.last24h.requests).toBe(1);
    expect(overview.last7d.requests).toBe(1);
  });

  it('still counts fixed-route protocol requests', async () => {
    await buildFor([
      { orgId: 'org-1', protocol: 'a2a', timestamp: recent, statusCode: 200, responseTime: 8 },
      { orgId: 'org-1', protocol: 'utcp', timestamp: recent, statusCode: 200, responseTime: 8 },
    ]);

    const overview = await service.getOverview('org-1', 'user-1');

    expect(overview.last24h.requests).toBe(2);
  });

  it('does not count another org\'s traffic (no cross-org over-count)', async () => {
    await buildFor([
      { orgId: 'org-1', protocol: 'mcp', timestamp: recent, statusCode: 200, responseTime: 10 },
      { orgId: 'org-2', protocol: 'mcp', timestamp: recent, statusCode: 200, responseTime: 10 },
      { orgId: 'org-2', protocol: null, timestamp: recent, statusCode: 200, responseTime: 10 },
    ]);

    const overview = await service.getOverview('org-1', 'user-1');

    expect(overview.last24h.requests).toBe(1);
  });

  it('counts 5xx protocol AND tool-execution rows in the error tile', async () => {
    await buildFor([
      { orgId: 'org-1', protocol: 'mcp', timestamp: recent, statusCode: 500, responseTime: 10 },
      { orgId: 'org-1', protocol: null, timestamp: recent, statusCode: 503, responseTime: 10 },
      { orgId: 'org-1', protocol: 'mcp', timestamp: recent, statusCode: 200, responseTime: 10 },
    ]);

    const overview = await service.getOverview('org-1', 'user-1');

    expect(overview.last24h.errors).toBe(2);
    expect(overview.last24h.requests).toBe(3);
  });
});

/**
 * The org scope has to be a predicate on `request_logs.organizationId`, which
 * `IDX_request_logs_organizationId_timestamp` covers together with timestamp.
 *
 * The predicate these queries used to carry --
 *   (gw.organizationId = :orgId OR log.metadata->>'organizationId' = :orgIdText)
 * -- ORs across `gateways` and `request_logs`, which no single index can
 * satisfy, so Postgres dropped to the plain timestamp index and read every
 * tenant's logs in the window before hash-joining the other orgs away.
 */
describe('AnalyticsService — request_logs org scope is index-shaped', () => {
  interface Recorded {
    wheres: string[];
    joins: string[];
    selects: string[][];
  }

  const buildRecording = async () => {
    const recorded: Recorded = { wheres: [], joins: [], selects: [] };

    const makeQb = () => {
      const qb: any = {
        leftJoin: (rel: string) => {
          recorded.joins.push(rel);
          return qb;
        },
        innerJoin: (rel: string) => {
          recorded.joins.push(rel);
          return qb;
        },
        select: (arg: any) => {
          if (Array.isArray(arg)) recorded.selects.push(arg);
          return qb;
        },
        addSelect: () => qb,
        where: (clause: string) => {
          recorded.wheres.push(clause);
          return qb;
        },
        andWhere: (clause: string) => {
          recorded.wheres.push(clause);
          return qb;
        },
        orderBy: () => qb,
        groupBy: () => qb,
        skip: () => qb,
        take: () => qb,
        getCount: async () => 0,
        getRawOne: async () => ({ avg: 0, total: '0' }),
        getRawMany: async () => [],
        getManyAndCount: async () => [[], 0],
      };
      return qb;
    };

    const repoWithQb = () => ({
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => makeQb()),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: getRepositoryToken(RequestLog), useValue: repoWithQb() },
        { provide: getRepositoryToken(UsageMetric), useValue: repoWithQb() },
        { provide: getRepositoryToken(ToolExecution), useValue: repoWithQb() },
        { provide: getRepositoryToken(Conversation), useValue: repoWithQb() },
        { provide: getRepositoryToken(Message), useValue: repoWithQb() },
        { provide: getRepositoryToken(AuditLog), useValue: repoWithQb() },
        { provide: getRepositoryToken(AgentRun), useValue: repoWithQb() },
        { provide: AnalyticsExportHelper, useValue: {} },
        { provide: AnalyticsSummariesHelper, useValue: {} },
      ],
    }).compile();

    return { service: module.get(AnalyticsService), recorded };
  };

  const unindexable = (clause: string) =>
    clause.includes('gw.organizationId') || clause.includes("metadata->>'organizationId'");

  it('getOverview scopes all four request_logs tiles on log.organizationId', async () => {
    const { service, recorded } = await buildRecording();

    await service.getOverview('org-1', 'user-1');

    const orgScopes = recorded.wheres.filter((c) => c.includes('organizationId'));
    expect(orgScopes.length).toBeGreaterThanOrEqual(4);
    expect(orgScopes.every((c) => c === 'log.organizationId = :orgId' || c.startsWith('session.') || c.startsWith('exec.'))).toBe(
      true,
    );
    expect(recorded.wheres.some(unindexable)).toBe(false);
    // No hash join to `gateways` just to find out who owns the row.
    expect(recorded.joins).not.toContain('log.gateway');
  });

  it('getTimeline scopes on log.organizationId with no gateway join', async () => {
    const { service, recorded } = await buildRecording();

    await service.getTimeline('org-1', 'day', 'hour', 'user-1');

    expect(recorded.wheres).toContain('log.organizationId = :orgId');
    expect(recorded.wheres.some(unindexable)).toBe(false);
    expect(recorded.joins).not.toContain('log.gateway');
  });

  it('getRequestLogs scopes on log.organizationId with no gateway join', async () => {
    const { service, recorded } = await buildRecording();

    await service.getRequestLogs({ organizationId: 'org-1', page: 1, limit: 50, callerId: 'user-1' });

    expect(recorded.wheres).toContain('log.organizationId = :orgId');
    expect(recorded.wheres.some(unindexable)).toBe(false);
    expect(recorded.joins).not.toContain('log.gateway');
  });

  it('getRequestLogs projects only the columns its mapper emits', async () => {
    const { service, recorded } = await buildRecording();

    await service.getRequestLogs({ organizationId: 'org-1', page: 1, limit: 50, callerId: 'user-1' });

    expect(recorded.selects).toHaveLength(1);
    const projected = recorded.selects[0];

    // The two 10,000-char text columns the mapper never reads.
    expect(projected).not.toContain('log.requestBody');
    expect(projected).not.toContain('log.responseBody');
    // Everything the mapper does read has to survive the projection.
    for (const col of [
      'log.id',
      'log.method',
      'log.path',
      'log.statusCode',
      'log.responseTime',
      'log.metadata',
      'log.gatewayId',
      'log.toolId',
      'log.userId',
      'log.userAgent',
      'log.ipAddress',
      'log.errorMessage',
      'log.requestSize',
      'log.responseSize',
      'log.timestamp',
    ]) {
      expect(projected).toContain(col);
    }
  });
});
