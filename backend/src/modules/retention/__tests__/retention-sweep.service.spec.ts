import { In, LessThan } from 'typeorm';
import { RetentionSweepService } from '../retention-sweep.service';
import { RetentionPolicy } from '../../../entities/retention-policy.entity';
import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';

const DAY_MS = 24 * 60 * 60 * 1000;

function mockRepo() {
  return {
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  };
}

function policy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return {
    id: 'p1',
    organizationId: 'org-1',
    enabled: true,
    agentRunsDays: null,
    conversationsDays: null,
    requestLogsDays: null,
    usageMetricsDays: null,
    auditLogDays: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as RetentionPolicy;
}

describe('RetentionSweepService', () => {
  let policyRepo: any;
  let runRepo: any;
  let conversationRepo: any;
  let messageRepo: any;
  let requestLogRepo: any;
  let usageMetricRepo: any;
  let auditLogRepo: any;
  let gatewayRepo: any;
  let auditLogService: any;
  let service: RetentionSweepService;

  beforeEach(() => {
    policyRepo = mockRepo();
    runRepo = mockRepo();
    conversationRepo = mockRepo();
    messageRepo = mockRepo();
    requestLogRepo = mockRepo();
    usageMetricRepo = mockRepo();
    auditLogRepo = mockRepo();
    gatewayRepo = mockRepo();
    auditLogService = { log: jest.fn().mockResolvedValue(null) };
    service = new RetentionSweepService(
      policyRepo,
      runRepo,
      conversationRepo,
      messageRepo,
      requestLogRepo,
      usageMetricRepo,
      auditLogRepo,
      gatewayRepo,
      auditLogService,
    );
  });

  it('does nothing when no org has a policy', async () => {
    policyRepo.find.mockResolvedValue([]);

    const results = await service.sweep();

    expect(results.size).toBe(0);
    expect(runRepo.find).not.toHaveBeenCalled();
    expect(conversationRepo.find).not.toHaveBeenCalled();
    expect(auditLogService.log).not.toHaveBeenCalled();
  });

  it('skips disabled policies', async () => {
    policyRepo.find.mockResolvedValue([
      policy({ enabled: false, agentRunsDays: 1 }),
    ]);

    const results = await service.sweep();

    expect(results.size).toBe(0);
    expect(runRepo.find).not.toHaveBeenCalled();
  });

  it('skips every data class whose day-count is null (keep forever)', async () => {
    const counts = await service.sweepOrganization(policy());

    expect(counts).toEqual({
      agentRuns: 0,
      conversations: 0,
      messages: 0,
      requestLogs: 0,
      usageMetrics: 0,
      auditLogs: 0,
    });
    expect(runRepo.find).not.toHaveBeenCalled();
    expect(conversationRepo.find).not.toHaveBeenCalled();
    expect(requestLogRepo.find).not.toHaveBeenCalled();
    expect(usageMetricRepo.find).not.toHaveBeenCalled();
    expect(auditLogRepo.find).not.toHaveBeenCalled();
    expect(auditLogService.log).not.toHaveBeenCalled();
  });

  it('deletes only terminal agent runs older than the cutoff', async () => {
    runRepo.find.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
    runRepo.delete.mockResolvedValueOnce({ affected: 2 });

    const before = Date.now();
    const counts = await service.sweepOrganization(policy({ agentRunsDays: 30 }));

    expect(counts.agentRuns).toBe(2);
    const where = runRepo.find.mock.calls[0][0].where;
    expect(where.organizationId).toBe('org-1');
    // Only terminal statuses are eligible — running/waiting rows never die.
    expect(where.status).toEqual(
      In([
        AgentRunStatus.COMPLETED,
        AgentRunStatus.FAILED,
        AgentRunStatus.CANCELLED,
        AgentRunStatus.TIMEOUT,
      ]),
    );
    const statuses = where.status.value as AgentRunStatus[];
    expect(statuses).not.toContain(AgentRunStatus.RUNNING);
    expect(statuses).not.toContain(AgentRunStatus.WAITING_APPROVAL);
    expect(statuses).not.toContain(AgentRunStatus.WAITING_INPUT);
    expect(statuses).not.toContain(AgentRunStatus.PENDING);
    expect(statuses).not.toContain(AgentRunStatus.SLEEPING);
    // Cutoff is ~30 days in the past.
    const cutoff = (where.createdAt as any).value as Date;
    expect(where.createdAt).toEqual(LessThan(cutoff));
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(30 * DAY_MS);
    expect(before - cutoff.getTime()).toBeLessThan(30 * DAY_MS + 5_000);
    // Delete targets exactly the selected ids.
    expect(runRepo.delete).toHaveBeenCalledWith({ id: In(['r1', 'r2']) });
  });

  it('keeps selecting batches until a short page is returned', async () => {
    const fullBatch = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}` }));
    runRepo.find
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce([{ id: 'last' }]);
    runRepo.delete
      .mockResolvedValueOnce({ affected: 1000 })
      .mockResolvedValueOnce({ affected: 1 });

    const counts = await service.sweepOrganization(policy({ agentRunsDays: 7 }));

    expect(counts.agentRuns).toBe(1001);
    expect(runRepo.find).toHaveBeenCalledTimes(2);
    expect(runRepo.find.mock.calls[0][0].take).toBe(1000);
    expect(runRepo.delete).toHaveBeenCalledTimes(2);
  });

  it('deletes messages before their conversations, per batch', async () => {
    conversationRepo.find.mockResolvedValueOnce([{ id: 'c1' }, { id: 'c2' }]);
    messageRepo.delete.mockResolvedValueOnce({ affected: 7 });
    conversationRepo.delete.mockResolvedValueOnce({ affected: 2 });

    const counts = await service.sweepOrganization(
      policy({ conversationsDays: 90 }),
    );

    expect(counts.conversations).toBe(2);
    expect(counts.messages).toBe(7);
    expect(messageRepo.delete).toHaveBeenCalledWith({
      conversationId: In(['c1', 'c2']),
    });
    expect(conversationRepo.delete).toHaveBeenCalledWith({
      id: In(['c1', 'c2']),
    });
    // Children go first.
    expect(messageRepo.delete.mock.invocationCallOrder[0]).toBeLessThan(
      conversationRepo.delete.mock.invocationCallOrder[0],
    );
  });

  it('scopes request logs through the org gateways and skips orgs without gateways', async () => {
    gatewayRepo.find.mockResolvedValueOnce([]);
    let counts = await service.sweepOrganization(policy({ requestLogsDays: 14 }));
    expect(counts.requestLogs).toBe(0);
    expect(requestLogRepo.find).not.toHaveBeenCalled();

    gatewayRepo.find.mockResolvedValueOnce([{ id: 'gw1' }, { id: 'gw2' }]);
    requestLogRepo.find.mockResolvedValueOnce([{ id: 'log1' }]);
    requestLogRepo.delete.mockResolvedValueOnce({ affected: 1 });
    counts = await service.sweepOrganization(policy({ requestLogsDays: 14 }));

    expect(counts.requestLogs).toBe(1);
    const where = requestLogRepo.find.mock.calls[0][0].where;
    expect(where.gatewayId).toEqual(In(['gw1', 'gw2']));
    expect(where.timestamp).toBeDefined();
  });

  it('deletes old usage metrics and audit logs by org + cutoff', async () => {
    usageMetricRepo.find.mockResolvedValueOnce([{ id: 'm1' }]);
    usageMetricRepo.delete.mockResolvedValueOnce({ affected: 1 });
    auditLogRepo.find.mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }]);
    auditLogRepo.delete.mockResolvedValueOnce({ affected: 2 });

    const counts = await service.sweepOrganization(
      policy({ usageMetricsDays: 30, auditLogDays: 365 }),
    );

    expect(counts.usageMetrics).toBe(1);
    expect(counts.auditLogs).toBe(2);
    const metricWhere = usageMetricRepo.find.mock.calls[0][0].where;
    expect(metricWhere.organizationId).toBe('org-1');
    expect(metricWhere.timestamp).toBeDefined();
    const auditWhere = auditLogRepo.find.mock.calls[0][0].where;
    expect(auditWhere.organizationId).toBe('org-1');
    expect(auditWhere.createdAt).toBeDefined();
  });

  it('writes a retention_sweep audit entry with counts when anything was deleted', async () => {
    runRepo.find.mockResolvedValueOnce([{ id: 'r1' }]);
    runRepo.delete.mockResolvedValueOnce({ affected: 1 });

    await service.sweepOrganization(policy({ agentRunsDays: 30 }));

    expect(auditLogService.log).toHaveBeenCalledTimes(1);
    const entry = auditLogService.log.mock.calls[0][0];
    expect(entry.organizationId).toBe('org-1');
    expect(entry.action).toBe(AuditAction.RETENTION_SWEEP);
    expect(entry.resourceType).toBe(AuditResource.ORGANIZATION);
    expect(entry.resourceName).toBe('retention_sweep');
    expect(entry.details).toEqual({
      agentRuns: 1,
      conversations: 0,
      messages: 0,
      requestLogs: 0,
      usageMetrics: 0,
      auditLogs: 0,
    });
  });

  it('writes no audit entry when the sweep deleted nothing', async () => {
    runRepo.find.mockResolvedValueOnce([]);

    await service.sweepOrganization(policy({ agentRunsDays: 30 }));

    expect(auditLogService.log).not.toHaveBeenCalled();
  });

  it('continues sweeping other orgs when one org fails', async () => {
    policyRepo.find.mockResolvedValue([
      policy({ organizationId: 'org-bad', agentRunsDays: 1 }),
      policy({ organizationId: 'org-good', agentRunsDays: 1 }),
    ]);
    runRepo.find
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);

    const results = await service.sweep();

    expect(results.has('org-bad')).toBe(false);
    expect(results.has('org-good')).toBe(true);
  });

  it('does not start the interval under NODE_ENV=test and clears it on destroy', () => {
    service.onModuleInit();
    expect((service as any).timer).toBeUndefined();

    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      service.onModuleInit();
      expect((service as any).timer).toBeDefined();
      service.onModuleDestroy();
      expect((service as any).timer).toBeUndefined();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

/**
 * retention.sweep notification: org admins hear about a sweep only when
 * it deleted something, and at most once per org per day.
 */
describe('RetentionSweepService notifications', () => {
  function makeService(recentNotification = false) {
    const repos = {
      policyRepo: { find: jest.fn().mockResolvedValue([]), delete: jest.fn() },
      runRepo: { find: jest.fn().mockResolvedValue([]), delete: jest.fn().mockResolvedValue({ affected: 0 }) },
      conversationRepo: { find: jest.fn().mockResolvedValue([]), delete: jest.fn().mockResolvedValue({ affected: 0 }) },
      messageRepo: { find: jest.fn().mockResolvedValue([]), delete: jest.fn().mockResolvedValue({ affected: 0 }) },
      requestLogRepo: { find: jest.fn().mockResolvedValue([]), delete: jest.fn().mockResolvedValue({ affected: 0 }) },
      usageMetricRepo: { find: jest.fn().mockResolvedValue([]), delete: jest.fn().mockResolvedValue({ affected: 0 }) },
      auditLogRepo: { find: jest.fn().mockResolvedValue([]), delete: jest.fn().mockResolvedValue({ affected: 0 }) },
      gatewayRepo: { find: jest.fn().mockResolvedValue([]) },
    };
    const notifications = {
      emit: jest.fn().mockResolvedValue(undefined),
      hasRecentOrgNotification: jest.fn().mockResolvedValue(recentNotification),
    };
    const service = new RetentionSweepService(
      repos.policyRepo as any,
      repos.runRepo as any,
      repos.conversationRepo as any,
      repos.messageRepo as any,
      repos.requestLogRepo as any,
      repos.usageMetricRepo as any,
      repos.auditLogRepo as any,
      repos.gatewayRepo as any,
      { log: jest.fn().mockResolvedValue(null) } as any,
      notifications as any,
    );
    return { service, repos, notifications };
  }

  const policyWithRuns = () =>
    ({
      id: 'p1',
      organizationId: 'org-1',
      enabled: true,
      agentRunsDays: 30,
      conversationsDays: null,
      requestLogsDays: null,
      usageMetricsDays: null,
      auditLogDays: null,
    } as any);

  it('notifies org admins when the sweep deleted rows', async () => {
    const { service, repos, notifications } = makeService();
    repos.runRepo.find.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
    repos.runRepo.delete.mockResolvedValueOnce({ affected: 2 });

    await service.sweepOrganization(policyWithRuns());

    expect(notifications.hasRecentOrgNotification).toHaveBeenCalledWith(
      'org-1',
      'retention.sweep',
      24 * 60 * 60 * 1000,
    );
    expect(notifications.emit).toHaveBeenCalledTimes(1);
    const input = notifications.emit.mock.calls[0][0];
    expect(input).toMatchObject({
      type: 'retention.sweep',
      organizationId: 'org-1',
    });
    expect(input.roleTarget.orgRoles).toEqual(['owner', 'admin']);
    expect(input.body).toContain('2 expired records');
    expect(input.email.template).toBe('retention.sweep');
    expect(input.email.params.totalDeleted).toBe(2);
  });

  it('stays silent when nothing was deleted', async () => {
    const { service, notifications } = makeService();

    await service.sweepOrganization(policyWithRuns());

    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('caps at one notification per org per day', async () => {
    const { service, repos, notifications } = makeService(true);
    repos.runRepo.find.mockResolvedValueOnce([{ id: 'r1' }]);
    repos.runRepo.delete.mockResolvedValueOnce({ affected: 1 });

    await service.sweepOrganization(policyWithRuns());

    expect(notifications.hasRecentOrgNotification).toHaveBeenCalled();
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('a notification failure never fails the sweep', async () => {
    const { service, repos, notifications } = makeService();
    repos.runRepo.find.mockResolvedValueOnce([{ id: 'r1' }]);
    repos.runRepo.delete.mockResolvedValueOnce({ affected: 1 });
    notifications.emit.mockRejectedValue(new Error('down'));

    const counts = await service.sweepOrganization(policyWithRuns());
    expect(counts.agentRuns).toBe(1);
  });
});