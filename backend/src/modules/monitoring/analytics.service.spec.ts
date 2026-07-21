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
    const toolExecutionRepository = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
    };
    const conversationRepository = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => ({
        select: () => ({
          where: () => ({
            andWhere: () => ({ getRawOne: async () => ({ total: '0' }) }),
          }),
        }),
      })),
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

    const overview = await service.getOverview('org-1');

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

    const overview = await service.getOverview('org-1');

    expect(overview.last24h.requests).toBe(1);
    expect(overview.last7d.requests).toBe(1);
  });

  it('still counts fixed-route protocol requests', async () => {
    await buildFor([
      { orgId: 'org-1', protocol: 'a2a', timestamp: recent, statusCode: 200, responseTime: 8 },
      { orgId: 'org-1', protocol: 'utcp', timestamp: recent, statusCode: 200, responseTime: 8 },
    ]);

    const overview = await service.getOverview('org-1');

    expect(overview.last24h.requests).toBe(2);
  });

  it('does not count another org\'s traffic (no cross-org over-count)', async () => {
    await buildFor([
      { orgId: 'org-1', protocol: 'mcp', timestamp: recent, statusCode: 200, responseTime: 10 },
      { orgId: 'org-2', protocol: 'mcp', timestamp: recent, statusCode: 200, responseTime: 10 },
      { orgId: 'org-2', protocol: null, timestamp: recent, statusCode: 200, responseTime: 10 },
    ]);

    const overview = await service.getOverview('org-1');

    expect(overview.last24h.requests).toBe(1);
  });

  it('counts 5xx protocol AND tool-execution rows in the error tile', async () => {
    await buildFor([
      { orgId: 'org-1', protocol: 'mcp', timestamp: recent, statusCode: 500, responseTime: 10 },
      { orgId: 'org-1', protocol: null, timestamp: recent, statusCode: 503, responseTime: 10 },
      { orgId: 'org-1', protocol: 'mcp', timestamp: recent, statusCode: 200, responseTime: 10 },
    ]);

    const overview = await service.getOverview('org-1');

    expect(overview.last24h.errors).toBe(2);
    expect(overview.last24h.requests).toBe(3);
  });
});
