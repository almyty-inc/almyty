/**
 * Integration tests for AnalyticsService — getAuditSummary & getAgentRunsSummary.
 *
 * Strategy: use mock repositories that return controlled data, but let
 * the SERVICE logic (aggregation, bucketing, calculations) run for real.
 * The tests verify that the math is correct, not just that the repo was called.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AnalyticsService } from '../analytics.service';
import { AnalyticsExportHelper } from '../analytics-export.helper';
import { AnalyticsSummariesHelper } from '../analytics-summaries.helper';
import { RequestLog } from '../../../entities/request-log.entity';
import { UsageMetric } from '../../../entities/usage-metric.entity';
import { ToolExecution } from '../../../entities/tool-execution.entity';
import { Conversation } from '../../../entities/conversation.entity';
import { Message } from '../../../entities/message.entity';
import { AuditLog, AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { AgentRun } from '../../../entities/agent-run.entity';
import { MoreThanOrEqual } from 'typeorm';

// ---------------------------------------------------------------------------
// Helpers to build chainable query builder mocks
// ---------------------------------------------------------------------------

function chainQb(overrides: Record<string, any> = {}) {
  const qb: any = {};
  const chain = ['select', 'addSelect', 'where', 'andWhere', 'orWhere', 'orderBy', 'groupBy', 'addGroupBy', 'skip', 'take', 'limit', 'leftJoinAndSelect', 'innerJoinAndSelect', 'update', 'set'];
  for (const m of chain) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getOne = jest.fn().mockResolvedValue(null);
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getRawOne = jest.fn().mockResolvedValue(null);
  qb.getCount = jest.fn().mockResolvedValue(0);
  qb.execute = jest.fn().mockResolvedValue({ affected: 0 });
  Object.assign(qb, overrides);
  return qb;
}

function makeRepo(overrides: Record<string, any> = {}) {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(e => Promise.resolve(e)),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(() => chainQb()),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AnalyticsService — Audit & Agent Runs Integration', () => {
  let service: AnalyticsService;
  let auditRepo: any;
  let agentRunRepo: any;
  let requestLogRepo: any;
  let usageMetricRepo: any;
  let toolExecRepo: any;
  let conversationRepo: any;
  let messageRepo: any;

  const ORG_ID = 'org-test-1';

  beforeEach(async () => {
    auditRepo = makeRepo();
    agentRunRepo = makeRepo();
    requestLogRepo = makeRepo();
    usageMetricRepo = makeRepo();
    toolExecRepo = makeRepo();
    conversationRepo = makeRepo();
    messageRepo = makeRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: getRepositoryToken(RequestLog), useValue: requestLogRepo },
        { provide: getRepositoryToken(UsageMetric), useValue: usageMetricRepo },
        { provide: getRepositoryToken(ToolExecution), useValue: toolExecRepo },
        { provide: getRepositoryToken(Conversation), useValue: conversationRepo },
        { provide: getRepositoryToken(Message), useValue: messageRepo },
        { provide: getRepositoryToken(AuditLog), useValue: auditRepo },
        { provide: getRepositoryToken(AgentRun), useValue: agentRunRepo },
        AnalyticsExportHelper,
        AnalyticsSummariesHelper,
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  // =========================================================================
  // getAuditSummary — empty state
  // =========================================================================

  describe('getAuditSummary — empty state', () => {
    it('should return zeroes and empty arrays when no data exists', async () => {
      // All repo methods already return 0 / []
      const result = await service.getAuditSummary(ORG_ID);

      expect(result.totals.today).toBe(0);
      expect(result.totals.thisWeek).toBe(0);
      expect(result.totals.thisMonth).toBe(0);
      expect(result.byResourceType).toEqual([]);
      expect(result.byAction).toEqual([]);
      expect(result.topUsers).toEqual([]);
      expect(result.timeline).toEqual([]);
    });
  });

  // =========================================================================
  // getAuditSummary — counts by resource type and action
  // =========================================================================

  describe('getAuditSummary — resource type & action counts', () => {
    it('should correctly parse count strings into integers from byResourceType query', async () => {
      // count() calls for totals
      auditRepo.count
        .mockResolvedValueOnce(15)   // totalToday
        .mockResolvedValueOnce(42)   // totalWeek
        .mockResolvedValueOnce(100); // totalMonth

      // byResourceType raw query
      const byResourceTypeQb = chainQb({
        getRawMany: jest.fn().mockResolvedValue([
          { resourceType: AuditResource.AGENT, count: '25' },
          { resourceType: AuditResource.TOOL, count: '15' },
          { resourceType: AuditResource.GATEWAY, count: '10' },
        ]),
      });

      // byAction raw query
      const byActionQb = chainQb({
        getRawMany: jest.fn().mockResolvedValue([
          { action: AuditAction.CREATE, count: '20' },
          { action: AuditAction.UPDATE, count: '18' },
          { action: AuditAction.DELETE, count: '12' },
        ]),
      });

      // topUsers raw query
      const topUsersQb = chainQb({
        getRawMany: jest.fn().mockResolvedValue([
          { userId: 'u1', userEmail: 'admin@test.com', count: '30' },
          { userId: 'u2', userEmail: 'dev@test.com', count: '20' },
        ]),
      });

      // hourlyTimeline raw query
      const timelineQb = chainQb({
        getRawMany: jest.fn().mockResolvedValue([
          { bucket: '2026-03-31T10:00:00.000Z', count: '5' },
          { bucket: '2026-03-31T11:00:00.000Z', count: '8' },
        ]),
      });

      auditRepo.createQueryBuilder
        .mockReturnValueOnce(byResourceTypeQb)
        .mockReturnValueOnce(byActionQb)
        .mockReturnValueOnce(topUsersQb)
        .mockReturnValueOnce(timelineQb);

      const result = await service.getAuditSummary(ORG_ID);

      // Totals
      expect(result.totals.today).toBe(15);
      expect(result.totals.thisWeek).toBe(42);
      expect(result.totals.thisMonth).toBe(100);

      // byResourceType — verify parseInt happened
      expect(result.byResourceType).toEqual([
        { resourceType: AuditResource.AGENT, count: 25 },
        { resourceType: AuditResource.TOOL, count: 15 },
        { resourceType: AuditResource.GATEWAY, count: 10 },
      ]);

      // byAction — verify parseInt happened
      expect(result.byAction).toEqual([
        { action: AuditAction.CREATE, count: 20 },
        { action: AuditAction.UPDATE, count: 18 },
        { action: AuditAction.DELETE, count: 12 },
      ]);

      // topUsers
      expect(result.topUsers).toHaveLength(2);
      expect(result.topUsers[0]).toEqual({ userId: 'u1', userEmail: 'admin@test.com', count: 30 });
      expect(result.topUsers[1]).toEqual({ userId: 'u2', userEmail: 'dev@test.com', count: 20 });

      // timeline
      expect(result.timeline).toHaveLength(2);
      expect(result.timeline[0].count).toBe(5);
      expect(result.timeline[1].count).toBe(8);
    });
  });

  // =========================================================================
  // getAuditSummary — hourly bucketing
  // =========================================================================

  describe('getAuditSummary — hourly timeline bucketing', () => {
    it('should preserve bucket timestamps and parse counts', async () => {
      auditRepo.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const now = new Date();
      const hour1 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - 2).toISOString();
      const hour2 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - 1).toISOString();
      const hour3 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).toISOString();

      const timelineQb = chainQb({
        getRawMany: jest.fn().mockResolvedValue([
          { bucket: hour1, count: '3' },
          { bucket: hour2, count: '7' },
          { bucket: hour3, count: '1' },
        ]),
      });

      auditRepo.createQueryBuilder
        .mockReturnValueOnce(chainQb()) // byResourceType
        .mockReturnValueOnce(chainQb()) // byAction
        .mockReturnValueOnce(chainQb()) // topUsers
        .mockReturnValueOnce(timelineQb);

      const result = await service.getAuditSummary(ORG_ID);

      expect(result.timeline).toHaveLength(3);
      expect(result.timeline[0].timestamp).toBe(hour1);
      expect(result.timeline[0].count).toBe(3);
      expect(result.timeline[1].count).toBe(7);
      expect(result.timeline[2].count).toBe(1);
    });
  });

  // =========================================================================
  // getAgentRunsSummary — empty state
  // =========================================================================

  describe('getAgentRunsSummary — empty state', () => {
    it('should return zero counts and empty arrays', async () => {
      agentRunRepo.count.mockResolvedValue(0);
      const avgQb = chainQb({ getRawOne: jest.fn().mockResolvedValue({ avg: null }) });
      const costQb = chainQb({ getRawOne: jest.fn().mockResolvedValue({ total: null }) });
      const byAgentQb = chainQb({ getRawMany: jest.fn().mockResolvedValue([]) });
      const timelineQb = chainQb({ getRawMany: jest.fn().mockResolvedValue([]) });

      agentRunRepo.createQueryBuilder
        .mockReturnValueOnce(avgQb)
        .mockReturnValueOnce(costQb)
        .mockReturnValueOnce(byAgentQb)
        .mockReturnValueOnce(timelineQb);

      const result = await service.getAgentRunsSummary(ORG_ID);

      expect(result.totals.total).toBe(0);
      expect(result.totals.completed).toBe(0);
      expect(result.totals.failed).toBe(0);
      expect(result.totals.cancelled).toBe(0);
      expect(result.avgDuration).toBe(0);
      expect(result.totalCost).toBe(0);
      expect(result.byAgent).toEqual([]);
      expect(result.timeline).toEqual([]);
    });
  });

  // =========================================================================
  // getAgentRunsSummary — correct counts & calculations
  // =========================================================================

  describe('getAgentRunsSummary — counts & math', () => {
    it('should compute correct totals, average duration, and cost', async () => {
      // count() calls: total, completed, failed, cancelled
      agentRunRepo.count
        .mockResolvedValueOnce(50)   // total
        .mockResolvedValueOnce(35)   // completed
        .mockResolvedValueOnce(10)   // failed
        .mockResolvedValueOnce(5);   // cancelled

      // avgDuration
      const avgQb = chainQb({
        getRawOne: jest.fn().mockResolvedValue({ avg: '2345.678' }),
      });

      // totalCost
      const costQb = chainQb({
        getRawOne: jest.fn().mockResolvedValue({ total: '1.23456' }),
      });

      // byAgent
      const byAgentQb = chainQb({
        getRawMany: jest.fn().mockResolvedValue([
          { agentId: 'agent-a', count: '30', completed: '25', failed: '5', avgDuration: '1500.5', cost: '0.75' },
          { agentId: 'agent-b', count: '20', completed: '10', failed: '5', avgDuration: '3000.2', cost: '0.48' },
        ]),
      });

      // timeline
      const timelineQb = chainQb({
        getRawMany: jest.fn().mockResolvedValue([
          { bucket: '2026-03-25', count: '10', completed: '8', failed: '2' },
          { bucket: '2026-03-26', count: '15', completed: '12', failed: '3' },
          { bucket: '2026-03-27', count: '25', completed: '15', failed: '5' },
        ]),
      });

      agentRunRepo.createQueryBuilder
        .mockReturnValueOnce(avgQb)
        .mockReturnValueOnce(costQb)
        .mockReturnValueOnce(byAgentQb)
        .mockReturnValueOnce(timelineQb);

      const result = await service.getAgentRunsSummary(ORG_ID);

      // Totals
      expect(result.totals.total).toBe(50);
      expect(result.totals.completed).toBe(35);
      expect(result.totals.failed).toBe(10);
      expect(result.totals.cancelled).toBe(5);

      // avgDuration should be rounded: Math.round(2345.678) = 2346
      expect(result.avgDuration).toBe(2346);

      // totalCost: Math.round(1.23456 * 10000) / 10000 = 1.2346
      expect(result.totalCost).toBe(1.2346);

      // byAgent — verify parseInt and parseFloat
      expect(result.byAgent).toHaveLength(2);
      expect(result.byAgent[0]).toEqual({
        agentId: 'agent-a',
        count: 30,
        completed: 25,
        failed: 5,
        avgDuration: 1501, // Math.round(1500.5)
        cost: 0.75,
      });
      expect(result.byAgent[1]).toEqual({
        agentId: 'agent-b',
        count: 20,
        completed: 10,
        failed: 5,
        avgDuration: 3000, // Math.round(3000.2)
        cost: 0.48,
      });

      // timeline — verify parseInt
      expect(result.timeline).toHaveLength(3);
      expect(result.timeline[0]).toEqual({ timestamp: '2026-03-25', count: 10, completed: 8, failed: 2 });
      expect(result.timeline[1]).toEqual({ timestamp: '2026-03-26', count: 15, completed: 12, failed: 3 });
      expect(result.timeline[2]).toEqual({ timestamp: '2026-03-27', count: 25, completed: 15, failed: 5 });
    });
  });

  // =========================================================================
  // getAgentRunsSummary — cost rounding edge cases
  // =========================================================================

  describe('getAgentRunsSummary — cost rounding', () => {
    it('should round totalCost to 4 decimal places correctly', async () => {
      agentRunRepo.count.mockResolvedValue(1);

      const avgQb = chainQb({ getRawOne: jest.fn().mockResolvedValue({ avg: '100' }) });
      const costQb = chainQb({ getRawOne: jest.fn().mockResolvedValue({ total: '0.999999' }) });
      const byAgentQb = chainQb();
      const timelineQb = chainQb();

      agentRunRepo.createQueryBuilder
        .mockReturnValueOnce(avgQb)
        .mockReturnValueOnce(costQb)
        .mockReturnValueOnce(byAgentQb)
        .mockReturnValueOnce(timelineQb);

      const result = await service.getAgentRunsSummary(ORG_ID);

      // Math.round(0.999999 * 10000) / 10000 = Math.round(9999.99) / 10000 = 10000/10000 = 1
      expect(result.totalCost).toBe(1);
    });

    it('should handle zero cost', async () => {
      agentRunRepo.count.mockResolvedValue(0);

      const avgQb = chainQb({ getRawOne: jest.fn().mockResolvedValue({ avg: '0' }) });
      const costQb = chainQb({ getRawOne: jest.fn().mockResolvedValue({ total: '0' }) });
      const byAgentQb = chainQb();
      const timelineQb = chainQb();

      agentRunRepo.createQueryBuilder
        .mockReturnValueOnce(avgQb)
        .mockReturnValueOnce(costQb)
        .mockReturnValueOnce(byAgentQb)
        .mockReturnValueOnce(timelineQb);

      const result = await service.getAgentRunsSummary(ORG_ID);
      expect(result.totalCost).toBe(0);
    });
  });

  // =========================================================================
  // getAuditSummary — handles repo errors gracefully via .catch()
  // =========================================================================

  describe('getAuditSummary — error resilience', () => {
    it('should return 0 / [] when repo calls throw (the .catch() fallbacks)', async () => {
      auditRepo.count.mockRejectedValue(new Error('DB down'));

      const failQb = chainQb({
        getRawMany: jest.fn().mockRejectedValue(new Error('DB down')),
      });

      auditRepo.createQueryBuilder.mockReturnValue(failQb);

      const result = await service.getAuditSummary(ORG_ID);

      expect(result.totals.today).toBe(0);
      expect(result.totals.thisWeek).toBe(0);
      expect(result.totals.thisMonth).toBe(0);
      expect(result.byResourceType).toEqual([]);
      expect(result.byAction).toEqual([]);
      expect(result.topUsers).toEqual([]);
      expect(result.timeline).toEqual([]);
    });
  });

  // =========================================================================
  // getAgentRunsSummary — handles repo errors gracefully
  // =========================================================================

  describe('getAgentRunsSummary — error resilience', () => {
    it('should return 0 / [] when repo calls throw', async () => {
      agentRunRepo.count.mockRejectedValue(new Error('DB down'));

      const failQb = chainQb({
        getRawOne: jest.fn().mockRejectedValue(new Error('DB down')),
        getRawMany: jest.fn().mockRejectedValue(new Error('DB down')),
      });

      agentRunRepo.createQueryBuilder.mockReturnValue(failQb);

      const result = await service.getAgentRunsSummary(ORG_ID);

      expect(result.totals.total).toBe(0);
      expect(result.totals.completed).toBe(0);
      expect(result.totals.failed).toBe(0);
      expect(result.totals.cancelled).toBe(0);
      expect(result.avgDuration).toBe(0);
      expect(result.totalCost).toBe(0);
      expect(result.byAgent).toEqual([]);
      expect(result.timeline).toEqual([]);
    });
  });

  // =========================================================================
  // Organization scoping — verify orgId is passed to queries
  // =========================================================================

  describe('Organization scoping', () => {
    it('getAuditSummary should pass orgId to all count() and query builder calls', async () => {
      await service.getAuditSummary('org-specific-123');

      // All count calls should include organizationId (count is called with { where: { organizationId, ... } })
      for (const call of auditRepo.count.mock.calls) {
        expect(call[0].where.organizationId).toBe('org-specific-123');
      }

      // All createQueryBuilder chains should include where() with orgId
      for (const call of auditRepo.createQueryBuilder.mock.calls) {
        const qb = auditRepo.createQueryBuilder.mock.results[
          auditRepo.createQueryBuilder.mock.calls.indexOf(call)
        ].value;
        // Verify .where() was called with orgId parameter
        const whereCalls = qb.where.mock.calls;
        if (whereCalls.length > 0) {
          const whereArgs = whereCalls[0];
          // The where clause should reference orgId
          expect(whereArgs[1]).toHaveProperty('orgId', 'org-specific-123');
        }
      }
    });

    it('getAgentRunsSummary should pass orgId to all count() calls', async () => {
      const avgQb = chainQb({ getRawOne: jest.fn().mockResolvedValue({ avg: '0' }) });
      const costQb = chainQb({ getRawOne: jest.fn().mockResolvedValue({ total: '0' }) });
      agentRunRepo.createQueryBuilder
        .mockReturnValueOnce(avgQb)
        .mockReturnValueOnce(costQb)
        .mockReturnValueOnce(chainQb())
        .mockReturnValueOnce(chainQb());

      await service.getAgentRunsSummary('org-xyz');

      for (const call of agentRunRepo.count.mock.calls) {
        expect(call[0].where.organizationId).toBe('org-xyz');
      }
    });
  });
});
