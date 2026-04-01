import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditLogService } from '../audit-log.service';
import { AuditLog, AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { User } from '../../../entities/user.entity';

/**
 * Integration tests for AuditLogService.
 *
 * Tests real logic: computeChanges() with real objects, fire-and-forget error handling,
 * convenience methods with correct field mapping. Only the TypeORM repository is mocked.
 */
describe('AuditLogService (integration)', () => {
  let service: AuditLogService;
  let logStore: AuditLog[];
  let mockRepo: any;

  beforeEach(async () => {
    logStore = [];
    let idCounter = 0;

    mockRepo = {
      create: jest.fn().mockImplementation((data: Partial<AuditLog>) => {
        const entry = new AuditLog();
        Object.assign(entry, {
          id: `log-${++idCounter}`,
          createdAt: new Date(),
          ...data,
        });
        return entry;
      }),
      save: jest.fn().mockImplementation((entry: AuditLog) => {
        logStore.push(entry);
        return Promise.resolve(entry);
      }),
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: mockRepo,
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = module.get<AuditLogService>(AuditLogService);
  });

  describe('computeChanges', () => {
    it('should detect a simple field change', () => {
      const oldObj = { name: 'Old Name', status: 'active' };
      const newObj = { name: 'New Name', status: 'active' };

      const changes = service.computeChanges(oldObj, newObj);

      expect(changes).toEqual([
        { field: 'name', from: 'Old Name', to: 'New Name' },
      ]);
    });

    it('should detect multiple field changes', () => {
      const oldObj = { name: 'A', description: 'desc1', version: '1.0' };
      const newObj = { name: 'B', description: 'desc2', version: '1.0' };

      const changes = service.computeChanges(oldObj, newObj);

      expect(changes).toHaveLength(2);
      expect(changes).toContainEqual({ field: 'name', from: 'A', to: 'B' });
      expect(changes).toContainEqual({ field: 'description', from: 'desc1', to: 'desc2' });
    });

    it('should return empty array when no changes', () => {
      const obj = { name: 'Same', count: 5, active: true };
      const changes = service.computeChanges(obj, obj);
      expect(changes).toEqual([]);
    });

    it('should detect nested object changes via JSON comparison', () => {
      const oldObj = {
        config: { temperature: 0.7, model: 'gpt-4' },
      };
      const newObj = {
        config: { temperature: 0.9, model: 'gpt-4' },
      };

      const changes = service.computeChanges(oldObj, newObj);

      expect(changes).toHaveLength(1);
      expect(changes[0].field).toBe('config');
      expect(changes[0].from).toEqual({ temperature: 0.7, model: 'gpt-4' });
      expect(changes[0].to).toEqual({ temperature: 0.9, model: 'gpt-4' });
    });

    it('should detect array changes', () => {
      const oldObj = { tags: ['a', 'b'] };
      const newObj = { tags: ['a', 'b', 'c'] };

      const changes = service.computeChanges(oldObj, newObj);

      expect(changes).toHaveLength(1);
      expect(changes[0].field).toBe('tags');
      expect(changes[0].from).toEqual(['a', 'b']);
      expect(changes[0].to).toEqual(['a', 'b', 'c']);
    });

    it('should detect field added (undefined -> value)', () => {
      const oldObj: any = { name: 'Test' };
      const newObj = { name: 'Test', description: 'added' };

      const changes = service.computeChanges(oldObj, newObj);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ field: 'description', from: undefined, to: 'added' });
    });

    it('should detect field removed (value -> undefined)', () => {
      const oldObj = { name: 'Test', description: 'will remove' };
      const newObj: any = { name: 'Test', description: undefined };

      const changes = service.computeChanges(oldObj, newObj);

      expect(changes).toHaveLength(1);
      expect(changes[0].field).toBe('description');
      expect(changes[0].from).toBe('will remove');
    });

    it('should only track specified fields when trackFields is provided', () => {
      const oldObj = { name: 'A', description: 'old', status: 'active' };
      const newObj = { name: 'B', description: 'new', status: 'inactive' };

      const changes = service.computeChanges(oldObj, newObj, ['name', 'status']);

      expect(changes).toHaveLength(2);
      // description change should NOT be tracked
      expect(changes.find(c => c.field === 'description')).toBeUndefined();
      expect(changes).toContainEqual({ field: 'name', from: 'A', to: 'B' });
      expect(changes).toContainEqual({ field: 'status', from: 'active', to: 'inactive' });
    });

    it('should handle null vs object correctly', () => {
      const oldObj = { metadata: null };
      const newObj = { metadata: { key: 'value' } };

      const changes = service.computeChanges(oldObj, newObj);

      expect(changes).toHaveLength(1);
      expect(changes[0].from).toBeNull();
      expect(changes[0].to).toEqual({ key: 'value' });
    });
  });

  describe('log (fire-and-forget)', () => {
    it('should create an audit log entry with correct fields', async () => {
      const result = await service.log({
        organizationId: 'org-1',
        userId: 'user-1',
        userEmail: 'test@example.com',
        action: AuditAction.CREATE,
        resourceType: AuditResource.AGENT,
        resourceId: 'agent-1',
        resourceName: 'My Agent',
        ipAddress: '127.0.0.1',
        userAgent: 'TestRunner/1.0',
        status: 'success',
        duration: 123.5,
        cost: 0.05,
        details: { source: 'api' },
        metadata: { env: 'test' },
      });

      expect(result).not.toBeNull();
      expect(result!.organizationId).toBe('org-1');
      expect(result!.userId).toBe('user-1');
      expect(result!.userEmail).toBe('test@example.com');
      expect(result!.action).toBe(AuditAction.CREATE);
      expect(result!.resourceType).toBe(AuditResource.AGENT);
      expect(result!.resourceId).toBe('agent-1');
      expect(result!.resourceName).toBe('My Agent');
      expect(result!.ipAddress).toBe('127.0.0.1');
      expect(result!.status).toBe('success');
      expect(result!.duration).toBe(123.5);
      expect(result!.cost).toBe(0.05);
      expect(result!.details).toEqual({ source: 'api' });
      expect(result!.metadata).toEqual({ env: 'test' });
    });

    it('should NOT throw when repository.save fails', async () => {
      mockRepo.save.mockRejectedValueOnce(new Error('DB connection lost'));

      const result = await service.log({
        organizationId: 'org-1',
        action: AuditAction.CREATE,
        resourceType: AuditResource.TOOL,
        resourceId: 'tool-1',
      });

      // Should return null, NOT throw
      expect(result).toBeNull();
    });

    it('should NOT throw when repository.create fails', async () => {
      mockRepo.create.mockImplementationOnce(() => {
        throw new Error('Unexpected create error');
      });

      const result = await service.log({
        organizationId: 'org-1',
        action: AuditAction.DELETE,
        resourceType: AuditResource.GATEWAY,
        resourceId: 'gw-1',
      });

      expect(result).toBeNull();
    });
  });

  describe('convenience methods', () => {
    it('logToolExecution with success', async () => {
      const result = await service.logToolExecution(
        'org-1', 'user-1', 'tool-1', 'Weather API',
        { parameters: { city: 'NYC' }, success: true, executionTime: 200, cost: 0.01 },
      );

      expect(result).not.toBeNull();
      expect(result!.action).toBe(AuditAction.TOOL_EXECUTE);
      expect(result!.resourceType).toBe(AuditResource.TOOL);
      expect(result!.resourceId).toBe('tool-1');
      expect(result!.resourceName).toBe('Weather API');
      expect(result!.status).toBe('success');
      expect(result!.duration).toBe(200);
      expect(result!.cost).toBe(0.01);
    });

    it('logToolExecution with failure', async () => {
      const result = await service.logToolExecution(
        'org-1', 'user-1', 'tool-1', 'Broken Tool',
        { success: false, executionTime: 50 },
      );

      expect(result!.status).toBe('error');
    });

    it('logGatewayRequest with successful status code', async () => {
      const result = await service.logGatewayRequest(
        'org-1', 'gw-1', 'Payment Gateway',
        { method: 'POST', path: '/charge', statusCode: 200, responseTime: 150 },
      );

      expect(result).not.toBeNull();
      expect(result!.action).toBe(AuditAction.INVOKE);
      expect(result!.resourceType).toBe(AuditResource.GATEWAY);
      expect(result!.resourceId).toBe('gw-1');
      expect(result!.resourceName).toBe('Payment Gateway');
      expect(result!.status).toBe('success');
      expect(result!.duration).toBe(150);
    });

    it('logGatewayRequest with error status code', async () => {
      const result = await service.logGatewayRequest(
        'org-1', 'gw-1', 'Failing Gateway',
        { method: 'GET', path: '/health', statusCode: 500, responseTime: 5000 },
      );

      expect(result!.status).toBe('error');
    });

    it('logGatewayRequest with no status code defaults to error', async () => {
      const result = await service.logGatewayRequest(
        'org-1', 'gw-1', 'Unknown Gateway',
        { method: 'GET', path: '/' },
      );

      expect(result!.status).toBe('error');
    });

    it('logRunEvent with correct action/resourceType', async () => {
      const result = await service.logRunEvent(
        'org-1', 'user-1', 'run-1', 'My Agent',
        AuditAction.RUN_START,
        { trigger: 'manual' },
      );

      expect(result).not.toBeNull();
      expect(result!.action).toBe(AuditAction.RUN_START);
      expect(result!.resourceType).toBe(AuditResource.AGENT_RUN);
      expect(result!.resourceId).toBe('run-1');
      expect(result!.resourceName).toBe('My Agent');
      expect(result!.details).toEqual({ trigger: 'manual' });
    });

    it('logCreate convenience method', async () => {
      const result = await service.logCreate('org-1', 'user-1', AuditResource.AGENT, 'agent-1', 'New Agent', { mode: 'autonomous' });

      expect(result!.action).toBe(AuditAction.CREATE);
      expect(result!.resourceType).toBe(AuditResource.AGENT);
      expect(result!.details).toEqual({ mode: 'autonomous' });
    });

    it('logUpdate convenience method', async () => {
      const changes = [{ field: 'name', from: 'Old', to: 'New' }];
      const result = await service.logUpdate('org-1', 'user-1', AuditResource.TOOL, 'tool-1', 'Updated Tool', changes);

      expect(result!.action).toBe(AuditAction.UPDATE);
      expect(result!.changes).toEqual(changes);
    });

    it('logDelete convenience method', async () => {
      const result = await service.logDelete('org-1', 'user-1', AuditResource.GATEWAY, 'gw-1', 'Deleted Gateway');

      expect(result!.action).toBe(AuditAction.DELETE);
      expect(result!.resourceType).toBe(AuditResource.GATEWAY);
    });
  });
});
