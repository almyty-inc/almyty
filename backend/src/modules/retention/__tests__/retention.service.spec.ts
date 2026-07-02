import { RetentionService } from '../retention.service';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';

describe('RetentionService', () => {
  let repo: any;
  let auditLogService: any;
  let service: RetentionService;

  beforeEach(() => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((data: any) => ({ ...data })),
      save: jest.fn(async (entity: any) => ({ id: 'p1', ...entity })),
    };
    auditLogService = { log: jest.fn().mockResolvedValue(null) };
    service = new RetentionService(repo, auditLogService);
  });

  describe('getPolicy', () => {
    it('returns the stored policy when one exists', async () => {
      const stored = { id: 'p1', organizationId: 'org-1', agentRunsDays: 30 };
      repo.findOne.mockResolvedValue(stored);

      const result = await service.getPolicy('org-1');

      expect(result).toBe(stored);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
      });
    });

    it('returns keep-forever defaults without persisting when no row exists', async () => {
      const result = await service.getPolicy('org-1');

      expect(result.organizationId).toBe('org-1');
      expect(result.enabled).toBe(true);
      expect(result.agentRunsDays).toBeNull();
      expect(result.conversationsDays).toBeNull();
      expect(result.requestLogsDays).toBeNull();
      expect(result.usageMetricsDays).toBeNull();
      expect(result.auditLogDays).toBeNull();
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('upsertPolicy', () => {
    it('creates a policy on first PUT and audits the change', async () => {
      const result = await service.upsertPolicy(
        'org-1',
        { agentRunsDays: 30, auditLogDays: 365 },
        'user-1',
      );

      expect(repo.save).toHaveBeenCalled();
      expect(result.agentRunsDays).toBe(30);
      expect(result.auditLogDays).toBe(365);
      expect(auditLogService.log).toHaveBeenCalledTimes(1);
      const entry = auditLogService.log.mock.calls[0][0];
      expect(entry.action).toBe(AuditAction.UPDATE);
      expect(entry.resourceType).toBe(AuditResource.ORGANIZATION);
      expect(entry.resourceName).toBe('retention_policy');
      expect(entry.userId).toBe('user-1');
      expect(entry.changes).toEqual(
        expect.arrayContaining([
          { field: 'agentRunsDays', from: null, to: 30 },
          { field: 'auditLogDays', from: null, to: 365 },
        ]),
      );
    });

    it('updates only the provided fields on an existing policy', async () => {
      repo.findOne.mockResolvedValue({
        id: 'p1',
        organizationId: 'org-1',
        enabled: true,
        agentRunsDays: 30,
        conversationsDays: 90,
        requestLogsDays: null,
        usageMetricsDays: null,
        auditLogDays: null,
      });

      const result = await service.upsertPolicy('org-1', { agentRunsDays: 7 });

      expect(result.agentRunsDays).toBe(7);
      expect(result.conversationsDays).toBe(90);
    });

    it('accepts explicit null to reset a class back to keep-forever', async () => {
      repo.findOne.mockResolvedValue({
        id: 'p1',
        organizationId: 'org-1',
        enabled: true,
        agentRunsDays: 30,
        conversationsDays: null,
        requestLogsDays: null,
        usageMetricsDays: null,
        auditLogDays: null,
      });

      const result = await service.upsertPolicy('org-1', {
        agentRunsDays: null,
      });

      expect(result.agentRunsDays).toBeNull();
      const entry = auditLogService.log.mock.calls[0][0];
      expect(entry.changes).toEqual([
        { field: 'agentRunsDays', from: 30, to: null },
      ]);
    });

    it('does not write an audit entry for a no-op update', async () => {
      repo.findOne.mockResolvedValue({
        id: 'p1',
        organizationId: 'org-1',
        enabled: true,
        agentRunsDays: 30,
        conversationsDays: null,
        requestLogsDays: null,
        usageMetricsDays: null,
        auditLogDays: null,
      });

      await service.upsertPolicy('org-1', { agentRunsDays: 30 });

      expect(auditLogService.log).not.toHaveBeenCalled();
    });

    it('toggles the enabled flag', async () => {
      repo.findOne.mockResolvedValue({
        id: 'p1',
        organizationId: 'org-1',
        enabled: true,
        agentRunsDays: 30,
        conversationsDays: null,
        requestLogsDays: null,
        usageMetricsDays: null,
        auditLogDays: null,
      });

      const result = await service.upsertPolicy('org-1', { enabled: false });

      expect(result.enabled).toBe(false);
      const entry = auditLogService.log.mock.calls[0][0];
      expect(entry.changes).toEqual([
        { field: 'enabled', from: true, to: false },
      ]);
    });
  });
});
