import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AxiosRequestConfig } from 'axios';
import { ToolExecutorService } from './tool-executor.service';
import { Tool, ToolType, ToolStatus } from '../../entities/tool.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { Operation } from '../../entities/operation.entity';
import { User } from '../../entities/user.entity';
import { Credential } from '../../entities/credential.entity';
import { CustomCodeExecutorService } from './custom-code-executor.service';
import { NodeSandboxService } from './node-sandbox/node-sandbox.service';
import { SdkCodeAssemblerService } from './node-sandbox/sdk-code-assembler.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import axios from 'axios';

jest.mock('axios', () => {
  const mockAxios: any = jest.fn();
  mockAxios.isAxiosError = jest.fn();
  return {
    __esModule: true,
    default: mockAxios,
  };
});
const mockedAxios = axios as unknown as jest.MockedFunction<any>;

describe('ToolExecutorService', () => {
  let service: ToolExecutorService;
  let toolRepository: any;
  let toolExecutionRepository: any;
  let userRepository: any;
  let apiRepository: any;
  let operationRepository: any;
  let credentialRepository: any;
  let mockRedis: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockRedis = {
      get: jest.fn(),
      set: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      incr: jest.fn(),
      expire: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolExecutorService,
        {
          provide: getRepositoryToken(Tool),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ToolExecution),
          useValue: {
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Api),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Operation),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Credential),
          useValue: {
            findOne: jest.fn(),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
          },
        },
        {
          provide: 'default_IORedisModuleConnectionToken',
          useValue: mockRedis,
        },
        {
          provide: CustomCodeExecutorService,
          useValue: {
            executeCode: jest.fn().mockResolvedValue({ success: true, data: null, executionTime: 0 }),
            validateCode: jest.fn().mockReturnValue({ valid: true }),
          },
        },
        {
          provide: NodeSandboxService,
          useValue: {
            execute: jest.fn().mockResolvedValue({ success: true, data: null, executionTimeMs: 0 }),
          },
        },
        {
          provide: SdkCodeAssemblerService,
          useValue: {
            assemble: jest.fn().mockReturnValue('return null;'),
          },
        },
        {
          provide: AuditLogService,
          useValue: {
            log: jest.fn().mockResolvedValue(null),
            logCreate: jest.fn().mockResolvedValue(null),
            logUpdate: jest.fn().mockResolvedValue(null),
            logDelete: jest.fn().mockResolvedValue(null),
            logToolExecution: jest.fn().mockResolvedValue(null),
            logGatewayRequest: jest.fn().mockResolvedValue(null),
            logRunEvent: jest.fn().mockResolvedValue(null),
            computeChanges: jest.fn().mockReturnValue([]),
            findAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 }),
            getResourceHistory: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<ToolExecutorService>(ToolExecutorService);
    toolRepository = module.get(getRepositoryToken(Tool));
    toolExecutionRepository = module.get(getRepositoryToken(ToolExecution));
    userRepository = module.get(getRepositoryToken(User));
    apiRepository = module.get(getRepositoryToken(Api));
    operationRepository = module.get(getRepositoryToken(Operation));
    credentialRepository = module.get(getRepositoryToken(Credential));
  });

  describe('executeTool', () => {
    it('should handle tool not found', async () => {
      toolRepository.findOne.mockResolvedValue(null);

      const parameters = {};
      const options = {
        userId: 'user-1',
        organizationId: 'org-1',
      };

      const result = await service.executeTool('non-existent', parameters, options);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle inactive tool', async () => {
      const inactiveTool = {
        id: 'tool-1',
        status: ToolStatus.INACTIVE,
        isActive: jest.fn().mockReturnValue(false),
      } as any;

      toolRepository.findOne.mockResolvedValue(inactiveTool);

      const parameters = {};
      const options = {
        userId: 'user-1',
        organizationId: 'org-1',
      };

      const result = await service.executeTool('tool-1', parameters, options);

      expect(result.success).toBe(false);
      expect(result.error).toContain('inactive');
    });

    it('should handle user permission errors', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
        isActive: jest.fn().mockReturnValue(true),
        organizationId: 'org-1',
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false),
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);

      const parameters = {};
      const options = {
        userId: 'user-1',
        organizationId: 'org-1',
      };

      const result = await service.executeTool('tool-1', parameters, options);

      expect(result.success).toBe(false);
      expect(result.error).toContain('permission');
    });

  });

  describe('getToolExecutionStats', () => {
    it('should return tool execution statistics', async () => {
      const mockExecutions = [
        { success: true, executionTime: 100, cached: false },
        { success: true, executionTime: 200, cached: true },
        { success: false, executionTime: 150, cached: false },
        { success: false, executionTime: 50, cached: false },
      ];

      toolExecutionRepository.find.mockResolvedValue(mockExecutions);

      const result = await service.getToolExecutionStats('tool-1', 'org-1');

      expect(result.totalExecutions).toBe(4);
      expect(result.successfulExecutions).toBe(2);
      expect(result.failedExecutions).toBe(2);
      expect(result.averageExecutionTime).toBe(125); // (100+200+150+50)/4
      expect(result.cacheHitRate).toBe(25); // 1/4 cached
    });

    it('should handle empty execution history', async () => {
      toolExecutionRepository.find.mockResolvedValue([]);

      const result = await service.getToolExecutionStats('tool-1', 'org-1');

      expect(result.totalExecutions).toBe(0);
      expect(result.successfulExecutions).toBe(0);
      expect(result.failedExecutions).toBe(0);
      expect(result.averageExecutionTime).toBe(0);
      expect(result.cacheHitRate).toBe(0);
    });

    it('should use a TypeORM MoreThanOrEqual operator on createdAt (not Mongo $gte)', async () => {
      // Regression: the previous implementation passed `{ $gte: since }`
      // as the createdAt value, which TypeORM treats as a literal object
      // comparison — silently matching zero rows regardless of timeframe.
      // The fix uses TypeORM's MoreThanOrEqual operator. This test
      // inspects the `find` call to verify the query shape.
      toolExecutionRepository.find.mockResolvedValue([]);

      await service.getToolExecutionStats('tool-1', 'org-1', 'day');

      expect(toolExecutionRepository.find).toHaveBeenCalledTimes(1);
      const findArgs = toolExecutionRepository.find.mock.calls[0][0];
      expect(findArgs.where.toolId).toBe('tool-1');
      expect(findArgs.where.organizationId).toBe('org-1');
      // TypeORM operator objects have a `_type` / `_value` internal shape.
      // A plain `{$gte: ...}` object does NOT — so checking for a
      // recognizable operator shape catches a regression to Mongo syntax.
      const createdAt = findArgs.where.createdAt;
      expect(createdAt).not.toHaveProperty('$gte');
      expect(typeof createdAt).toBe('object');
      expect(createdAt).toBeTruthy();
    });
  });

  describe('successful tool execution', () => {
    it('should successfully execute a REST API tool', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
        operation: {
          id: 'op-1',
          method: 'GET',
          endpoint: '/users/{id}',
          api: {
            id: 'api-1',
            type: 'openapi',
            baseUrl: 'https://api.example.com',
            authentication: { type: 'none' },
          },
        },
        configuration: {},
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolExecutionRepository.create.mockReturnValue({});
      toolExecutionRepository.save.mockResolvedValue({});

      // Mock axios to return success
      jest.spyOn(service as any, 'executeOperation').mockResolvedValue({
        success: true,
        data: { id: '123', name: 'John' },
      });
      jest.spyOn(service as any, 'validateParameters').mockResolvedValue({ isValid: true, errors: [] });

      const result = await service.executeTool('tool-1', { id: '123' }, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: '123', name: 'John' });
      expect(result.cached).toBe(false);
      expect(result.rateLimited).toBe(false);
    });
  });

  describe('parameter validation', () => {
    it('should reject invalid parameters', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);

      jest.spyOn(service as any, 'validateParameters').mockResolvedValue({
        isValid: false,
        errors: ['Missing required parameter: id'],
      });

      const result = await service.executeTool('tool-1', {}, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid parameters');
    });
  });

  describe('rate limiting', () => {
    it('should enforce rate limits', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      jest.spyOn(service as any, 'validateParameters').mockResolvedValue({ isValid: true, errors: [] });
      jest.spyOn(service as any, 'checkRateLimit').mockResolvedValue({
        limited: true,
        message: 'Rate limit of 100 requests per minute exceeded',
      });

      const result = await service.executeTool('tool-1', { id: '123' }, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result.success).toBe(false);
      expect(result.rateLimited).toBe(true);
      expect(result.error).toContain('Rate limit exceeded');
    });

    it('should skip rate limiting when skipRateLimit is true', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
        operation: {
          api: { type: 'openapi', baseUrl: 'https://api.example.com', authentication: { type: 'none' } },
        },
        configuration: {},
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolExecutionRepository.create.mockReturnValue({});
      toolExecutionRepository.save.mockResolvedValue({});
      jest.spyOn(service as any, 'validateParameters').mockResolvedValue({ isValid: true, errors: [] });
      jest.spyOn(service as any, 'executeOperation').mockResolvedValue({ success: true, data: {} });

      const checkRateLimitSpy = jest.spyOn(service as any, 'checkRateLimit');

      await service.executeTool('tool-1', { id: '123' }, {
        userId: 'user-1',
        organizationId: 'org-1',
        skipRateLimit: true,
      });

      expect(checkRateLimitSpy).not.toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('should return cached result when available', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
        configuration: {
          cache: {
            enabled: true,
            ttl: 3600,
          },
        },
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      const cachedResult = {
        success: true,
        data: { id: '123', name: 'Cached John' },
      };

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolExecutionRepository.create.mockReturnValue({});
      toolExecutionRepository.save.mockResolvedValue({});
      jest.spyOn(service as any, 'validateParameters').mockResolvedValue({ isValid: true, errors: [] });
      jest.spyOn(service as any, 'checkRateLimit').mockResolvedValue({ limited: false });
      jest.spyOn(service as any, 'getCachedResult').mockResolvedValue(cachedResult);

      const result = await service.executeTool('tool-1', { id: '123' }, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result.success).toBe(true);
      expect(result.cached).toBe(true);
      expect(result.data.name).toBe('Cached John');
    });

    it('should skip cache when skipCache is true', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
        operation: {
          api: { type: 'openapi', baseUrl: 'https://api.example.com', authentication: { type: 'none' } },
        },
        configuration: {
          cache: {
            enabled: true,
            ttl: 3600,
          },
        },
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolExecutionRepository.create.mockReturnValue({});
      toolExecutionRepository.save.mockResolvedValue({});
      jest.spyOn(service as any, 'validateParameters').mockResolvedValue({ isValid: true, errors: [] });
      jest.spyOn(service as any, 'checkRateLimit').mockResolvedValue({ limited: false });
      jest.spyOn(service as any, 'executeOperation').mockResolvedValue({ success: true, data: {} });

      const getCachedResultSpy = jest.spyOn(service as any, 'getCachedResult');

      await service.executeTool('tool-1', { id: '123' }, {
        userId: 'user-1',
        organizationId: 'org-1',
        skipCache: true,
      });

      expect(getCachedResultSpy).not.toHaveBeenCalled();
    });
  });

  describe('retry logic', () => {
    it('should retry on failure with exponential backoff', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
        operation: {
          api: { type: 'openapi', baseUrl: 'https://api.example.com', authentication: { type: 'none' } },
        },
        configuration: {
          retries: 2,
        },
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolExecutionRepository.create.mockReturnValue({});
      toolExecutionRepository.save.mockResolvedValue({});
      jest.spyOn(service as any, 'validateParameters').mockResolvedValue({ isValid: true, errors: [] });
      jest.spyOn(service as any, 'checkRateLimit').mockResolvedValue({ limited: false });
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      const executeOpSpy = jest.spyOn(service as any, 'executeOperation')
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockRejectedValueOnce(new Error('Temporary failure 2'))
        .mockResolvedValueOnce({ success: true, data: { recovered: true } });

      const result = await service.executeTool('tool-1', { id: '123' }, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result.success).toBe(true);
      expect(result.retryCount).toBe(2);
      expect(executeOpSpy).toHaveBeenCalledTimes(3);
    });

    it('should return failure after max retries exceeded', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
        operation: {
          api: { type: 'openapi', baseUrl: 'https://api.example.com', authentication: { type: 'none' } },
        },
        configuration: {
          retries: 1,
        },
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolExecutionRepository.create.mockReturnValue({});
      toolExecutionRepository.save.mockResolvedValue({});
      jest.spyOn(service as any, 'validateParameters').mockResolvedValue({ isValid: true, errors: [] });
      jest.spyOn(service as any, 'checkRateLimit').mockResolvedValue({ limited: false });
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      jest.spyOn(service as any, 'executeOperation').mockRejectedValue(new Error('Persistent failure'));

      const result = await service.executeTool('tool-1', { id: '123' }, {
        userId: 'user-1',
        organizationId: 'org-1',
        retries: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Execution failed after');
      expect(result.error).toContain('Persistent failure');
    });
  });

  describe('generateCacheKey', () => {
    it('should generate consistent cache key for same parameters', () => {
      const params1 = { userId: '123', filter: 'active' };
      const params2 = { userId: '123', filter: 'active' };

      const key1 = service['generateCacheKey']('tool-1', params1);
      const key2 = service['generateCacheKey']('tool-1', params2);

      expect(key1).toBe(key2);
      expect(key1).toContain('tool_cache:tool-1:');
    });

    it('should generate different keys for different parameters', () => {
      const params1 = { userId: '123', filter: 'active' };
      const params2 = { userId: '456', filter: 'active' };

      const key1 = service['generateCacheKey']('tool-1', params1);
      const key2 = service['generateCacheKey']('tool-1', params2);

      expect(key1).not.toBe(key2);
    });

    it('should generate different keys for different tool IDs', () => {
      const params = { userId: '123' };

      const key1 = service['generateCacheKey']('tool-1', params);
      const key2 = service['generateCacheKey']('tool-2', params);

      expect(key1).not.toBe(key2);
    });

    it('should handle parameter order consistently', () => {
      const params1 = { a: '1', b: '2', c: '3' };
      const params2 = { c: '3', a: '1', b: '2' };

      const key1 = service['generateCacheKey']('tool-1', params1);
      const key2 = service['generateCacheKey']('tool-1', params2);

      expect(key1).toBe(key2);
    });
  });

  describe('hashObject', () => {
    it('should generate consistent hash for same object', () => {
      const obj = { name: 'John', age: 30, city: 'NYC' };

      const hash1 = service['hashObject'](obj);
      const hash2 = service['hashObject'](obj);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(32); // MD5 hash length
    });

    it('should handle key order consistently', () => {
      const obj1 = { a: 1, b: 2, c: 3 };
      const obj2 = { c: 3, b: 2, a: 1 };

      const hash1 = service['hashObject'](obj1);
      const hash2 = service['hashObject'](obj2);

      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different values', () => {
      const obj1 = { value: 'test1' };
      const obj2 = { value: 'test2' };

      const hash1 = service['hashObject'](obj1);
      const hash2 = service['hashObject'](obj2);

      expect(hash1).not.toBe(hash2);
    });

    it('should handle nested objects', () => {
      const obj1 = { user: { name: 'John', age: 30 }, active: true };
      const obj2 = { user: { name: 'John', age: 30 }, active: true };

      const hash1 = service['hashObject'](obj1);
      const hash2 = service['hashObject'](obj2);

      expect(hash1).toBe(hash2);
    });

    it('should produce DIFFERENT hashes when nested values differ (cache-collision regression)', () => {
      // Regression: the previous implementation was
      // `JSON.stringify(obj, Object.keys(obj).sort())`, which interprets
      // the array as a KEY FILTER at every level of nesting. Any key not
      // at the top level got dropped, so nested values were invisible to
      // the hash. These two objects would incorrectly hash identically.
      const obj1 = { filter: { name: 'alice' }, tenant: 'acme' };
      const obj2 = { filter: { name: 'bob' }, tenant: 'acme' };

      expect(service['hashObject'](obj1)).not.toBe(service['hashObject'](obj2));
    });

    it('should produce DIFFERENT hashes when deeply nested scalars differ', () => {
      const obj1 = { outer: { inner: { value: 1 } } };
      const obj2 = { outer: { inner: { value: 2 } } };

      expect(service['hashObject'](obj1)).not.toBe(service['hashObject'](obj2));
    });

    it('should be stable across key-order changes at any nesting level', () => {
      const obj1 = { a: { x: 1, y: 2 }, b: 3 };
      const obj2 = { b: 3, a: { y: 2, x: 1 } };

      expect(service['hashObject'](obj1)).toBe(service['hashObject'](obj2));
    });
  });

  describe('escapeXml (SOAP body XML-injection protection)', () => {
    it('should escape the five XML predefined entities', () => {
      const escape = (v: string) => service['escapeXml'](v);
      expect(escape('&')).toBe('&amp;');
      expect(escape('<')).toBe('&lt;');
      expect(escape('>')).toBe('&gt;');
      expect(escape('"')).toBe('&quot;');
      expect(escape("'")).toBe('&apos;');
    });

    it('should neutralize a SOAP-element break-out payload', () => {
      // Regression: SOAP body templates used to raw-interpolate parameter
      // values, so a payload containing `</soap:Body>` could terminate
      // the element early and inject arbitrary XML into the outbound
      // request (e.g. forging headers or auth assertions).
      const payload = 'alice</soap:Body><injected>gotcha</injected><soap:Body>';
      const escaped = service['escapeXml'](payload);
      expect(escaped).not.toContain('</soap:Body>');
      expect(escaped).not.toContain('<injected>');
      expect(escaped).toContain('&lt;/soap:Body&gt;');
    });

    it('should escape ampersands before other characters (to avoid double-escape)', () => {
      expect(service['escapeXml']('a & <b>')).toBe('a &amp; &lt;b&gt;');
    });

    it('should handle arrays', () => {
      const obj1 = { tags: ['javascript', 'typescript', 'node'] };
      const obj2 = { tags: ['javascript', 'typescript', 'node'] };

      const hash1 = service['hashObject'](obj1);
      const hash2 = service['hashObject'](obj2);

      expect(hash1).toBe(hash2);
    });
  });

  describe('generateRequestId', () => {
    it('should generate unique request IDs', () => {
      const id1 = service['generateRequestId']();
      const id2 = service['generateRequestId']();

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^req_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^req_\d+_[a-z0-9]+$/);
    });

    it('should include timestamp in request ID', () => {
      const beforeTime = Date.now();
      const id = service['generateRequestId']();
      const afterTime = Date.now();

      const timestamp = parseInt(id.split('_')[1]);
      expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('should include random component in request ID', () => {
      const id = service['generateRequestId']();
      const parts = id.split('_');

      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe('req');
      expect(parts[1]).toMatch(/^\d+$/);
      expect(parts[2]).toMatch(/^[a-z0-9]+$/);
      expect(parts[2].length).toBeGreaterThan(0);
    });
  });

  describe('Real Business Logic - Caching System', () => {
    describe('getCachedResult', () => {
      it('should return cached result when available', async () => {
        const mockTool = {
          id: 'tool-1',
          configuration: { cache: { enabled: true, ttl: 300 } },
        } as any;

        const parameters = { id: '123', type: 'user' };
        const cachedData = {
          success: true,
          data: { id: '123', name: 'John' },
          executionTime: 150,
          cached: false,
          rateLimited: false,
          retryCount: 0,
        };

        const cacheKey = `tool_cache:tool-1:${service['hashObject'](parameters)}`;
        mockRedis.get.mockResolvedValue(JSON.stringify(cachedData));

        const result = await service['getCachedResult'](mockTool, parameters);

        expect(result).toEqual(cachedData);
        expect(mockRedis.get).toHaveBeenCalledWith(cacheKey);
      });

      it('should return null when cache is empty', async () => {
        const mockTool = {
          id: 'tool-1',
          configuration: { cache: { enabled: true } },
        } as any;

        mockRedis.get.mockResolvedValue(null);

        const result = await service['getCachedResult'](mockTool, { id: '123' });

        expect(result).toBeNull();
      });

      it('should return null on cache read error', async () => {
        const mockTool = {
          id: 'tool-1',
          configuration: { cache: { enabled: true } },
        } as any;

        mockRedis.get.mockRejectedValue(new Error('Redis connection failed'));

        const result = await service['getCachedResult'](mockTool, { id: '123' });

        expect(result).toBeNull();
      });

      it('should handle invalid JSON in cache gracefully', async () => {
        const mockTool = {
          id: 'tool-1',
          configuration: { cache: { enabled: true } },
        } as any;

        mockRedis.get.mockResolvedValue('invalid json {{{');

        const result = await service['getCachedResult'](mockTool, { id: '123' });

        expect(result).toBeNull();
      });
    });

    describe('cacheResult', () => {
      it('should cache successful result with configured TTL', async () => {
        const mockTool = {
          id: 'tool-1',
          configuration: { cache: { enabled: true, ttl: 600 } },
        } as any;

        const parameters = { id: '123' };
        const result = {
          success: true,
          data: { id: '123', name: 'John' },
          executionTime: 200,
          cached: false,
          rateLimited: false,
          retryCount: 0,
        };

        mockRedis.setex.mockResolvedValue('OK');

        await service['cacheResult'](mockTool, parameters, result);

        const cacheKey = `tool_cache:tool-1:${service['hashObject'](parameters)}`;
        expect(mockRedis.setex).toHaveBeenCalledWith(cacheKey, 600, JSON.stringify(result));
      });

      it('should use default TTL when not configured', async () => {
        const mockTool = {
          id: 'tool-1',
          configuration: { cache: { enabled: true } },
        } as any;

        mockRedis.setex.mockResolvedValue('OK');

        await service['cacheResult'](mockTool, { id: '123' }, {
          success: true,
          data: {},
          executionTime: 0,
          cached: false,
          rateLimited: false,
          retryCount: 0,
        });

        expect(mockRedis.setex).toHaveBeenCalledWith(expect.any(String), 300, expect.any(String)); // Default 5 min
      });

      it('should not cache failed results', async () => {
        const mockTool = {
          id: 'tool-1',
          configuration: { cache: { enabled: true } },
        } as any;

        const result = {
          success: false,
          error: 'API error',
          executionTime: 0,
          cached: false,
          rateLimited: false,
          retryCount: 0,
        };

        await service['cacheResult'](mockTool, { id: '123' }, result);

        expect(mockRedis.set).not.toHaveBeenCalled();
      });
    });
  });

  describe('Real Business Logic - Rate Limiting System', () => {
    describe('checkRateLimit', () => {
      it('should allow requests under rate limit', async () => {
        const mockTool = {
          id: 'tool-1',
          configuration: {
            rateLimit: { maxRequests: 100, windowMs: 60000 },
          },
        } as any;

        const options = {
          userId: 'user-1',
          organizationId: 'org-1',
        };

        mockRedis.incr.mockResolvedValue(50); // 50 requests in current window
        mockRedis.expire.mockResolvedValue(1);

        const result = await service['checkRateLimit'](mockTool, options);

        expect(result.limited).toBe(false);
      });

      it('should block requests exceeding rate limit', async () => {
        const mockTool = {
          id: 'tool-1',
          configuration: {
            rateLimit: { requestsPerMinute: 100 },
          },
        } as any;

        const options = {
          userId: 'user-1',
          organizationId: 'org-1',
        };

        mockRedis.incr.mockResolvedValue(101); // Exceeds limit
        mockRedis.expire.mockResolvedValue(1);

        const result = await service['checkRateLimit'](mockTool, options);

        expect(result.limited).toBe(true);
        expect(result.message).toContain('100');
      });

      it('should create separate rate limits per user', async () => {
        const mockTool = {
          id: 'tool-1',
          configuration: {
            rateLimit: { requestsPerMinute: 50 },
          },
        } as any;

        mockRedis.incr.mockResolvedValue(1);
        mockRedis.expire.mockResolvedValue(1);

        await service['checkRateLimit'](mockTool, { userId: 'user-1', organizationId: 'org-1' });
        await service['checkRateLimit'](mockTool, { userId: 'user-2', organizationId: 'org-1' });

        expect(mockRedis.incr).toHaveBeenCalledTimes(2);
        expect(mockRedis.incr).toHaveBeenCalledWith(expect.stringContaining('user-1'));
        expect(mockRedis.incr).toHaveBeenCalledWith(expect.stringContaining('user-2'));
      });

      it('should allow requests when rate limiting is not configured', async () => {
        const mockTool = {
          id: 'tool-1',
          configuration: {},
        } as any;

        const result = await service['checkRateLimit'](mockTool, {
          userId: 'user-1',
          organizationId: 'org-1',
        });

        expect(result.limited).toBe(false);
        expect(mockRedis.incr).not.toHaveBeenCalled();
      });

      it('should allow requests on Redis error (fail open)', async () => {
        const mockTool = {
          id: 'tool-1',
          configuration: {
            rateLimit: { requestsPerMinute: 100 },
          },
        } as any;

        mockRedis.incr.mockRejectedValue(new Error('Redis connection failed'));

        const result = await service['checkRateLimit'](mockTool, {
          userId: 'user-1',
          organizationId: 'org-1',
        });

        expect(result.limited).toBe(false);
      });
    });
  });

  describe('Real Business Logic - Retry Mechanism with Exponential Backoff', () => {
    it('should retry failed operations with exponential backoff', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
        operation: {
          id: 'op-1',
          method: 'GET',
          endpoint: '/unstable',
          api: {
            type: 'openapi',
            baseUrl: 'https://api.example.com',
            authentication: { type: 'none' },
          },
        },
        configuration: { retries: 3 },
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolExecutionRepository.create.mockReturnValue({});
      toolExecutionRepository.save.mockResolvedValue({});

      jest.spyOn(service as any, 'validateParameters').mockResolvedValue({ isValid: true, errors: [] });
      jest.spyOn(service as any, 'checkRateLimit').mockResolvedValue({ limited: false });
      jest.spyOn(service as any, 'getCachedResult').mockResolvedValue(null);
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      // First 2 attempts fail, 3rd succeeds
      jest.spyOn(service as any, 'executeOperation')
        .mockRejectedValueOnce(new Error('Connection timeout'))
        .mockRejectedValueOnce(new Error('Connection timeout'))
        .mockResolvedValueOnce({
          success: true,
          data: { id: '123' },
        });

      const result = await service.executeTool('tool-1', { id: '123' }, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result.success).toBe(true);
      expect(result.retryCount).toBe(2);
      expect(service['sleep']).toHaveBeenCalledTimes(2);
      // Exponential backoff: 2^1 * 1000 = 2000ms, 2^2 * 1000 = 4000ms
      expect(service['sleep']).toHaveBeenNthCalledWith(1, 2000);
      expect(service['sleep']).toHaveBeenNthCalledWith(2, 4000);
    });

    it('should fail after exhausting all retries', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
        operation: {
          api: { type: 'openapi' },
        },
        configuration: { retries: 2 },
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolExecutionRepository.create.mockReturnValue({});
      toolExecutionRepository.save.mockResolvedValue({});

      jest.spyOn(service as any, 'validateParameters').mockResolvedValue({ isValid: true, errors: [] });
      jest.spyOn(service as any, 'checkRateLimit').mockResolvedValue({ limited: false });
      jest.spyOn(service as any, 'getCachedResult').mockResolvedValue(null);
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      jest.spyOn(service as any, 'executeOperation')
        .mockRejectedValue(new Error('Service unavailable'));

      const result = await service.executeTool('tool-1', {}, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('failed after');
      expect(result.error).toContain('Service unavailable');
      expect(result.retryCount).toBe(3); // Initial + 2 retries
    });

    it('should respect custom retry configuration', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
        operation: { api: { type: 'openapi' } },
        configuration: { retries: 1 }, // Only 1 retry
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolExecutionRepository.create.mockReturnValue({});
      toolExecutionRepository.save.mockResolvedValue({});

      jest.spyOn(service as any, 'validateParameters').mockResolvedValue({ isValid: true, errors: [] });
      jest.spyOn(service as any, 'checkRateLimit').mockResolvedValue({ limited: false });
      jest.spyOn(service as any, 'getCachedResult').mockResolvedValue(null);
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      jest.spyOn(service as any, 'executeOperation')
        .mockRejectedValue(new Error('Failed'));

      const result = await service.executeTool('tool-1', {}, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result.retryCount).toBe(2); // Initial + 1 retry
      expect(service['sleep']).toHaveBeenCalledTimes(1);
    });
  });

  describe('Real-World Integration Scenarios', () => {
    it('should serve cached result on second identical request', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
        operation: {
          api: { type: 'openapi', baseUrl: 'https://api.example.com' },
          method: 'GET',
          endpoint: '/users/{id}',
        },
        configuration: {
          cache: { enabled: true, ttl: 300 },
        },
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      const parameters = { id: '123' };
      const expectedData = { id: '123', name: 'John' };

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolExecutionRepository.create.mockReturnValue({});
      toolExecutionRepository.save.mockResolvedValue({});

      jest.spyOn(service as any, 'validateParameters').mockResolvedValue({ isValid: true, errors: [] });
      jest.spyOn(service as any, 'checkRateLimit').mockResolvedValue({ limited: false });

      // First call: no cache
      mockRedis.get.mockResolvedValueOnce(null);
      mockRedis.set.mockResolvedValue('OK');
      mockRedis.expire.mockResolvedValue(1);
      jest.spyOn(service as any, 'executeOperation').mockResolvedValueOnce({
        success: true,
        data: expectedData,
      });

      const result1 = await service.executeTool('tool-1', parameters, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result1.cached).toBe(false);
      expect(result1.data).toEqual(expectedData);

      // Second call: cached
      mockRedis.get.mockResolvedValueOnce(JSON.stringify({
        success: true,
        data: expectedData,
        executionTime: 150,
        cached: false,
        rateLimited: false,
        retryCount: 0,
      }));

      const result2 = await service.executeTool('tool-1', parameters, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result2.cached).toBe(true);
      expect(result2.data).toEqual(expectedData);
      expect(service['executeOperation']).toHaveBeenCalledTimes(1); // Only first call
    });
  });

  describe('GraphQL Execution', () => {
    it('should execute GraphQL operation successfully', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'GraphQL Tool',
        type: ToolType.API,
        status: ToolStatus.ACTIVE,
        configuration: { timeout: 5000 },
        operation: {
          id: 'op-1',
          name: 'getUser',
          metadata: { query: 'query getUser($id: ID!) { user(id: $id) { id name } }' },
          api: {
            type: 'graphql',
            baseUrl: 'https://api.example.com/graphql',
            authentication: null,
          },
        },
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);

      const mockResponse = {
        status: 200,
        headers: { 'x-request-id': 'req-123' },
        data: {
          data: { user: { id: '1', name: 'John' } },
        },
      };

      mockedAxios.mockResolvedValue(mockResponse as any);

      const parameters = {
        query: 'query getUser($id: ID!) { user(id: $id) { id name } }',
        variables: { id: '1' },
      };

      const result = await service['executeGraphQLOperation'](
        mockTool,
        mockTool.operation,
        mockTool.operation.api,
        parameters,
        { userId: 'user-1', organizationId: 'org-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ user: { id: '1', name: 'John' } });
      expect(result.metadata.httpStatus).toBe(200);
    });

    it('should NOT leak query/operationName into variables when no explicit variables object is passed', async () => {
      // Regression: previously `variables: parameters.variables || parameters`
      // fell back to the entire parameters object, so a caller passing
      // `{ id: 'x', query: '...' }` ended up sending the GraphQL query string
      // as a `query` GraphQL variable.
      const mockTool = {
        configuration: { timeout: 5000 },
        operation: {
          metadata: {},
          api: { type: 'graphql', baseUrl: 'https://api.example.com/graphql', authentication: null },
        },
      } as any;

      mockedAxios.mockResolvedValue({
        status: 200,
        headers: {},
        data: { data: { ok: true } },
      } as any);

      await service['executeGraphQLOperation'](
        mockTool,
        mockTool.operation,
        mockTool.operation.api,
        {
          query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
          operationName: 'GetUser',
          id: 'abc',
        },
        { userId: 'user-1', organizationId: 'org-1' },
      );

      const callConfig = mockedAxios.mock.calls[0][0] as any;
      expect(callConfig.data.variables).toEqual({ id: 'abc' });
      expect(callConfig.data.variables.query).toBeUndefined();
      expect(callConfig.data.variables.operationName).toBeUndefined();
      expect(callConfig.data.query).toContain('query GetUser');
      expect(callConfig.data.operationName).toBe('GetUser');
    });

    it('should pass an explicit variables object through verbatim', async () => {
      const mockTool = {
        configuration: { timeout: 5000 },
        operation: {
          metadata: { query: 'query GetUser($id: ID!) { user(id: $id) { name } }' },
          api: { type: 'graphql', baseUrl: 'https://api.example.com/graphql', authentication: null },
        },
      } as any;

      mockedAxios.mockResolvedValue({
        status: 200,
        headers: {},
        data: { data: { ok: true } },
      } as any);

      await service['executeGraphQLOperation'](
        mockTool,
        mockTool.operation,
        mockTool.operation.api,
        { variables: { id: 'xyz' } },
        { userId: 'user-1', organizationId: 'org-1' },
      );

      const callConfig = mockedAxios.mock.calls[0][0] as any;
      expect(callConfig.data.variables).toEqual({ id: 'xyz' });
    });

    it('should handle GraphQL errors in response', async () => {
      const mockTool = {
        configuration: { timeout: 5000 },
        operation: {
          metadata: { query: 'query { invalid }' },
          api: { type: 'graphql', baseUrl: 'https://api.example.com/graphql' },
        },
      } as any;

      const mockResponse = {
        status: 200,
        headers: {},
        data: {
          errors: [
            { message: 'Field does not exist' },
            { message: 'Syntax error' },
          ],
          data: null,
        },
      };

      mockedAxios.mockResolvedValue(mockResponse as any);

      const result = await service['executeGraphQLOperation'](
        mockTool,
        mockTool.operation,
        mockTool.operation.api,
        { query: 'query { invalid }' },
        { userId: 'user-1', organizationId: 'org-1' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('GraphQL errors');
      expect(result.error).toContain('Field does not exist');
      expect(result.error).toContain('Syntax error');
    });

  });

  describe('SOAP Execution', () => {
    it('should execute SOAP operation successfully', async () => {
      const mockTool = {
        id: 'tool-1',
        configuration: { timeout: 5000 },
        operation: {
          id: 'op-1',
          name: 'GetUser',
          metadata: {
            soapAction: 'http://example.com/GetUser',
            namespace: 'http://example.com/services',
          },
          api: {
            type: 'soap',
            baseUrl: 'https://api.example.com/soap',
            authentication: null,
          },
        },
      } as any;

      const mockResponse = {
        status: 200,
        headers: { 'x-request-id': 'req-456' },
        data: `<?xml version="1.0"?>
          <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
            <soap:Body>
              <GetUserResponse>
                <id>1</id>
                <name>John</name>
              </GetUserResponse>
            </soap:Body>
          </soap:Envelope>`,
      };

      mockedAxios.mockResolvedValue(mockResponse as any);

      const parameters = {
        userId: '1',
      };

      const result = await service['executeSOAPOperation'](
        mockTool,
        mockTool.operation,
        mockTool.operation.api,
        parameters,
        { userId: 'user-1', organizationId: 'org-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.metadata.httpStatus).toBe(200);
    });

  });

  describe('Authentication Handling', () => {
    describe('addAuthentication', () => {
      it('should add Bearer token authentication', async () => {
        const config: any = { headers: {} };
        const api = {
          id: 'api-1',
          authentication: {
            type: 'bearer',
            config: { token: 'test-token-123' },
          },
        } as any;

        await service['addAuthentication'](config, api, { userId: "user-1", organizationId: "org-1" });

        expect(config.headers.Authorization).toBe('Bearer test-token-123');
      });

      it('should add Basic authentication with encoded credentials', async () => {
        const config: any = { headers: {} };
        const api = {
          id: 'api-1',
          authentication: {
            type: 'basic',
            config: { username: 'testuser', password: 'testpass' },
          },
        } as any;

        await service['addAuthentication'](config, api, { userId: "user-1", organizationId: "org-1" });

        const expectedAuth = 'Basic ' + Buffer.from('testuser:testpass').toString('base64');
        expect(config.headers.Authorization).toBe(expectedAuth);
      });

      it('should add API key in header', async () => {
        const config: any = { headers: {} };
        const api = {
          id: 'api-1',
          authentication: {
            type: 'api_key',
            config: { location: 'header', name: 'X-API-Key', value: 'my-api-key' },
          },
        } as any;

        await service['addAuthentication'](config, api, { userId: "user-1", organizationId: "org-1" });

        expect(config.headers['X-API-Key']).toBe('my-api-key');
      });

      it('should add API key in query params', async () => {
        const config: any = { headers: {} };
        const api = {
          id: 'api-1',
          authentication: {
            type: 'api_key',
            config: { location: 'query', name: 'apiKey', value: 'my-api-key' },
          },
        } as any;

        await service['addAuthentication'](config, api, { userId: "user-1", organizationId: "org-1" });

        expect(config.params.apiKey).toBe('my-api-key');
      });

      it('should add OAuth2 access token', async () => {
        const config: any = { headers: {} };
        const api = {
          id: 'api-1',
          authentication: {
            type: 'oauth2',
            config: { accessToken: 'oauth-access-token' },
          },
        } as any;

        await service['addAuthentication'](config, api, { userId: "user-1", organizationId: "org-1" });

        expect(config.headers.Authorization).toBe('Bearer oauth-access-token');
      });

      it('should not add authentication when type is none', async () => {
        const config: any = { headers: {} };
        const api = {
          id: 'api-1',
          authentication: { type: 'none', config: {} },
        } as any;

        await service['addAuthentication'](config, api, { userId: "user-1", organizationId: "org-1" });

        expect(config.headers.Authorization).toBeUndefined();
      });
    });

    describe('Credential entity integration', () => {
      it('should use Credential entity when one exists (instead of legacy api.authentication)', async () => {
        const mockCredential = {
          id: 'cred-1',
          type: 'api_key',
          isExpired: jest.fn().mockReturnValue(false),
          getAuthHeaders: jest.fn().mockReturnValue({ 'X-API-Key': 'cred-api-key' }),
          getQueryParams: jest.fn().mockReturnValue({}),
        };
        credentialRepository.findOne.mockResolvedValue(mockCredential);

        const config: any = { headers: {} };
        const api = {
          id: 'api-1',
          authentication: {
            type: 'bearer',
            config: { token: 'legacy-token' },
          },
        } as any;

        await service['addAuthentication'](config, api, { userId: 'user-1', organizationId: 'org-1' });

        // Should use credential entity, NOT legacy api.authentication
        expect(config.headers['X-API-Key']).toBe('cred-api-key');
        expect(config.headers.Authorization).toBeUndefined();
      });

      it('should fall back to legacy api.authentication when no Credential entity exists', async () => {
        credentialRepository.findOne.mockResolvedValue(null);

        const config: any = { headers: {} };
        const api = {
          id: 'api-1',
          authentication: {
            type: 'bearer',
            config: { token: 'legacy-token' },
          },
        } as any;

        await service['addAuthentication'](config, api, { userId: 'user-1', organizationId: 'org-1' });

        expect(config.headers.Authorization).toBe('Bearer legacy-token');
      });

      it('should query credentials scoped to api + org + active', async () => {
        credentialRepository.findOne.mockResolvedValue(null);

        const config: any = { headers: {} };
        const api = { id: 'api-42', authentication: null } as any;

        await service['addAuthentication'](config, api, { userId: 'user-1', organizationId: 'org-99' });

        expect(credentialRepository.findOne).toHaveBeenCalledWith({
          where: {
            apiId: 'api-42',
            organizationId: 'org-99',
            isActive: true,
          },
          order: { createdAt: 'DESC' },
        });
      });

      it('should apply query params from credential', async () => {
        const mockCredential = {
          id: 'cred-1',
          type: 'api_key',
          isExpired: jest.fn().mockReturnValue(false),
          getAuthHeaders: jest.fn().mockReturnValue({}),
          getQueryParams: jest.fn().mockReturnValue({ api_key: 'query-key-value' }),
        };
        credentialRepository.findOne.mockResolvedValue(mockCredential);

        const config: any = { headers: {}, params: { existing: 'param' } };
        const api = { id: 'api-1', authentication: null } as any;

        await service['addAuthentication'](config, api, { userId: 'user-1', organizationId: 'org-1' });

        expect(config.params.api_key).toBe('query-key-value');
        expect(config.params.existing).toBe('param');
      });

      it('should mark credential as used after applying', async () => {
        const mockCredential = {
          id: 'cred-1',
          type: 'api_key',
          isExpired: jest.fn().mockReturnValue(false),
          getAuthHeaders: jest.fn().mockReturnValue({ Authorization: 'Bearer x' }),
          getQueryParams: jest.fn().mockReturnValue({}),
        };
        credentialRepository.findOne.mockResolvedValue(mockCredential);
        credentialRepository.update.mockResolvedValue({ affected: 1 });

        const config: any = { headers: {} };
        const api = { id: 'api-1', authentication: null } as any;

        await service['addAuthentication'](config, api, { userId: 'user-1', organizationId: 'org-1' });

        expect(credentialRepository.update).toHaveBeenCalledWith(
          'cred-1',
          expect.objectContaining({ lastUsedAt: expect.any(Date) }),
        );
      });

      it('should not add auth when no credential AND no legacy authentication', async () => {
        credentialRepository.findOne.mockResolvedValue(null);

        const config: any = { headers: {} };
        const api = { id: 'api-1', authentication: null } as any;

        await service['addAuthentication'](config, api, { userId: 'user-1', organizationId: 'org-1' });

        expect(config.headers.Authorization).toBeUndefined();
        expect(config.params).toBeUndefined();
      });
    });
  });

  describe('Parameter Validation', () => {
    describe('validateParameters', () => {
      it('should validate required parameters successfully', async () => {
        const mockTool = {
          id: 'tool-1',
          parameters: {
            required: ['userId', 'action'],
          },
        } as any;

        const parameters = { userId: '123', action: 'create' };

        const result = await service['validateParameters'](mockTool, parameters);

        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should detect missing required parameters', async () => {
        const mockTool = {
          id: 'tool-1',
          parameters: {
            required: ['userId', 'action'],
          },
        } as any;

        const parameters = { userId: '123' }; // missing 'action'

        const result = await service['validateParameters'](mockTool, parameters);

        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Missing required parameter: action');
      });

      it('should use inputSchema validation when available', async () => {
        const mockTool = {
          id: 'tool-1',
          inputSchema: {
            validate: jest.fn().mockResolvedValue({
              isValid: true,
              errors: [],
            }),
          },
        } as any;

        const parameters = { userId: '123' };

        const result = await service['validateParameters'](mockTool, parameters);

        expect(mockTool.inputSchema.validate).toHaveBeenCalledWith(parameters);
        expect(result.isValid).toBe(true);
      });

      it('should handle validation errors gracefully', async () => {
        const mockTool = {
          id: 'tool-1',
          inputSchema: {
            validate: jest.fn().mockResolvedValue({
              isValid: false,
              errors: ['Parameter validation error: Schema validation failed'],
            }),
          },
        } as any;

        const parameters = { userId: '123' };

        const result = await service['validateParameters'](mockTool, parameters);

        expect(result.isValid).toBe(false);
        expect(result.errors[0]).toContain('Parameter validation error');
      });

      it('should pass validation when no required parameters defined', async () => {
        const mockTool = {
          id: 'tool-1',
          parameters: {},
        } as any;

        const parameters = { anyParam: 'value' };

        const result = await service['validateParameters'](mockTool, parameters);

        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });
  });

  describe('Rate Limiting Per-Hour Logic', () => {
    it('should block requests exceeding hourly limit', async () => {
      const mockTool = {
        id: 'tool-1',
        configuration: {
          rateLimit: {
            enabled: true,
            requestsPerMinute: 100,
            requestsPerHour: 5,
          },
        },
      } as any;

      const userId = 'user-1';

      // Mock Redis to simulate 6 requests (exceeds limit of 5)
      mockRedis.incr.mockResolvedValue(6);

      const result = await service['checkRateLimit'](mockTool, { userId, organizationId: 'org-1' });

      expect(result.limited).toBe(true);
      expect(result.message).toContain('5 requests per hour');
    });

    it('should allow requests under hourly limit', async () => {
      const mockTool = {
        id: 'tool-1',
        configuration: {
          rateLimit: {
            enabled: true,
            requestsPerMinute: 100,
            requestsPerHour: 10,
          },
        },
      } as any;

      const userId = 'user-1';

      // Mock Redis to simulate 8 requests (under limit of 10)
      mockRedis.incr.mockResolvedValueOnce(5).mockResolvedValueOnce(8);

      const result = await service['checkRateLimit'](mockTool, { userId, organizationId: 'org-1' });

      expect(result.limited).toBe(false);
    });
  });

  describe('Cache Disabled Scenario', () => {
    it('should not cache result when cache is disabled', async () => {
      const mockTool = {
        id: 'tool-1',
        configuration: {
          cache: {
            enabled: false,
          },
        },
      } as any;

      const parameters = { userId: '123' };
      const result = { success: true, data: { result: 'test' } } as any;

      await service['cacheResult'](mockTool, parameters, result);

      expect(mockRedis.setex).not.toHaveBeenCalled();
    });

    it('should not cache result when cache config is missing', async () => {
      const mockTool = {
        id: 'tool-1',
        configuration: {},
      } as any;

      const parameters = { userId: '123' };
      const result = { success: true, data: { result: 'test' } } as any;

      await service['cacheResult'](mockTool, parameters, result);

      expect(mockRedis.setex).not.toHaveBeenCalled();
    });

    it('should log warning when cache storage fails', async () => {
      const mockTool = {
        id: 'tool-1',
        configuration: {
          cache: {
            enabled: true,
            ttl: 300,
          },
        },
      } as any;

      const parameters = { userId: '123' };
      const result = { success: true, data: { result: 'test' } } as any;

      mockRedis.setex.mockRejectedValue(new Error('Redis connection error'));

      await service['cacheResult'](mockTool, parameters, result);

      // Should not throw, just log warning
      expect(mockRedis.setex).toHaveBeenCalled();
    });
  });

  describe('REST path parameter substitution (regression)', () => {
    it('should replace EVERY occurrence of a repeated path parameter, not just the first', async () => {
      // Regression: previous code used `url.replace(\`{${key}}\`, value)`
      // which only replaces the first occurrence. A weird-but-valid path
      // template like `/orgs/{org}/repos/{org}-archive` would leave the
      // second `{org}` unsubstituted.
      const mockTool = {
        id: 'tool-1',
        operation: {
          id: 'op-1',
          method: 'GET',
          endpoint: '/orgs/{org}/repos/{org}-archive',
          api: {
            id: 'api-1',
            type: ApiType.OPENAPI,
            baseUrl: 'https://api.example.com',
            authentication: { type: 'none', config: {} },
          },
          parameters: [],
        },
        configuration: {},
      } as any;

      mockedAxios.mockResolvedValue({ status: 200, data: {}, headers: {} });

      await service['executeRestOperation'](
        mockTool,
        mockTool.operation,
        mockTool.operation.api,
        { path: { org: 'almyty' } },
        { userId: 'user-1', organizationId: 'org-1' },
      );

      const callConfig = mockedAxios.mock.calls[0][0] as any;
      expect(callConfig.url).toBe('https://api.example.com/orgs/almyty/repos/almyty-archive');
      expect(callConfig.url).not.toContain('{org}');
    });

    it('should truncate huge upstream error bodies in the surfaced error message', async () => {
      // Regression: a 500 with a 5MB JSON body used to inline the whole
      // body into result.error, bloating logs and LLM context windows.
      const mockTool = {
        id: 'tool-1',
        operation: {
          id: 'op-1',
          method: 'GET',
          endpoint: '/users',
          api: {
            id: 'api-1',
            type: ApiType.OPENAPI,
            baseUrl: 'https://api.example.com',
            authentication: { type: 'none', config: {} },
          },
          parameters: [],
        },
        configuration: {},
      } as any;

      const hugeBody = 'X'.repeat(50_000);
      const axiosError = {
        isAxiosError: true,
        message: 'Request failed',
        response: { status: 500, data: hugeBody, headers: {} },
      };
      mockedAxios.mockRejectedValue(axiosError);
      ((axios.isAxiosError as any) as jest.Mock).mockReturnValue(true);

      const result = await service['executeRestOperation'](
        mockTool,
        mockTool.operation,
        mockTool.operation.api,
        {},
        { userId: 'user-1', organizationId: 'org-1' },
      );

      expect(result.success).toBe(false);
      expect(result.error!.length).toBeLessThan(700); // 500 chars + the suffix marker
      expect(result.error).toContain('truncated');
      // The full body is still preserved on `data`.
      expect(result.data).toBe(hugeBody);
    });
  });

  describe('REST Operation with Body Data', () => {
    it('should include body data in POST requests', async () => {
      const mockTool = {
        id: 'tool-1',
        operation: {
          id: 'op-1',
          method: 'POST',
          endpoint: '/users',
          api: {
            id: 'api-1',
            type: ApiType.OPENAPI,
            baseUrl: 'https://api.example.com',
            authentication: { type: 'none', config: {} },
          },
          parameters: [],
        },
        configuration: {},
      } as any;

      const parameters = { body: { name: 'John', email: 'john@example.com' } };

      mockedAxios.mockResolvedValue({
        status: 201,
        data: { id: '123', name: 'John' },
        headers: {},
      });

      const result = await service['executeRestOperation'](
        mockTool,
        mockTool.operation,
        mockTool.operation.api,
        parameters,
        { userId: 'user-1', organizationId: 'org-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: '123', name: 'John' });
      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'post',
          data: { name: 'John', email: 'john@example.com' },
        })
      );
    });

    it('should include body data in PUT requests', async () => {
      const mockTool = {
        id: 'tool-1',
        operation: {
          id: 'op-1',
          method: 'PUT',
          endpoint: '/users/{id}',
          api: {
            id: 'api-1',
            type: ApiType.OPENAPI,
            baseUrl: 'https://api.example.com',
            authentication: { type: 'none', config: {} },
          },
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        },
        configuration: {},
      } as any;

      const parameters = {
        path: { id: '123' },
        body: { name: 'John Updated' }
      };

      mockedAxios.mockResolvedValue({
        status: 200,
        data: { id: '123', name: 'John Updated' },
        headers: {},
      });

      const result = await service['executeRestOperation'](
        mockTool,
        mockTool.operation,
        mockTool.operation.api,
        parameters,
        { userId: 'user-1', organizationId: 'org-1' }
      );

      expect(result.success).toBe(true);
      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'put',
          data: { name: 'John Updated' },
        })
      );
    });

    it('should include body data in PATCH requests', async () => {
      const mockTool = {
        id: 'tool-1',
        operation: {
          id: 'op-1',
          method: 'PATCH',
          endpoint: '/users/{id}',
          api: {
            id: 'api-1',
            type: ApiType.OPENAPI,
            baseUrl: 'https://api.example.com',
            authentication: { type: 'none', config: {} },
          },
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        },
        configuration: {},
      } as any;

      const parameters = {
        path: { id: '123' },
        body: { email: 'newemail@example.com' }
      };

      mockedAxios.mockResolvedValue({
        status: 200,
        data: { id: '123', email: 'newemail@example.com' },
        headers: {},
      });

      const result = await service['executeRestOperation'](
        mockTool,
        mockTool.operation,
        mockTool.operation.api,
        parameters,
        { userId: 'user-1', organizationId: 'org-1' }
      );

      expect(result.success).toBe(true);
      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'patch',
          data: { email: 'newemail@example.com' },
        })
      );
    });
  });

  describe('Error Handling in Execution Methods', () => {
    describe('REST operation error handling', () => {
      it('should handle HTTP errors with axios', async () => {
        const mockTool = {
          id: 'tool-1',
          name: 'Test Tool',
          operation: {
            id: 'op-1',
            method: 'GET',
            endpoint: '/users/{id}',
            api: {
              id: 'api-1',
              type: ApiType.OPENAPI,
              baseUrl: 'https://api.example.com',
              authentication: { type: 'none', config: {} },
            },
          },
          configuration: {},
        } as any;

        const parameters = { path: { id: '123' } };

        const axiosError = {
          isAxiosError: true,
          response: {
            status: 404,
            data: { message: 'User not found' },
            headers: { 'x-request-id': 'req-123' },
          },
        };

        // Mock axios to throw error
        mockedAxios.mockRejectedValue(axiosError);
        ((axios.isAxiosError as any) as jest.Mock).mockReturnValue(true);

        const result = await service['executeRestOperation'](
          mockTool,
          mockTool.operation,
          mockTool.operation.api,
          parameters,
          { userId: 'user-1', organizationId: 'org-1' }
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('404');
        expect(result.metadata.httpStatus).toBe(404);
      });

      it('should throw non-axios errors', async () => {
        const mockTool = {
          id: 'tool-1',
          operation: {
            id: 'op-1',
            method: 'GET',
            endpoint: '/users',
            api: {
              id: 'api-1',
              type: ApiType.OPENAPI,
              baseUrl: 'https://api.example.com',
              authentication: { type: 'none', config: {} },
            },
          },
          configuration: {},
        } as any;

        mockedAxios.mockRejectedValue(new Error('Network error'));
        ((axios.isAxiosError as any) as jest.Mock).mockReturnValue(false);

        await expect(
          service['executeRestOperation'](
            mockTool,
            mockTool.operation,
            mockTool.operation.api,
            {},
            { userId: 'user-1', organizationId: 'org-1' }
          )
        ).rejects.toThrow('Network error');
      });
    });

    describe('GraphQL operation error handling', () => {
      it('should handle GraphQL HTTP errors with axios', async () => {
        const mockTool = {
          id: 'tool-1',
          operation: {
            id: 'op-1',
            name: 'getUser',
            api: {
              id: 'api-1',
              type: ApiType.GRAPHQL,
              baseUrl: 'https://api.example.com/graphql',
              authentication: { type: 'none', config: {} },
            },
          },
          configuration: {},
        } as any;

        const parameters = { variables: { id: '123' } };

        const axiosError = {
          isAxiosError: true,
          response: {
            status: 500,
            data: { message: 'Internal server error' },
            headers: {},
          },
        };

        mockedAxios.mockRejectedValue(axiosError);
        ((axios.isAxiosError as any) as jest.Mock).mockReturnValue(true);

        const result = await service['executeGraphQLOperation'](
          mockTool,
          mockTool.operation,
          mockTool.operation.api,
          parameters,
          { userId: 'user-1', organizationId: 'org-1' }
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('GraphQL request failed');
        expect(result.metadata.httpStatus).toBe(500);
      });

      it('should throw non-axios errors in GraphQL', async () => {
        const mockTool = {
          id: 'tool-1',
          operation: {
            id: 'op-1',
            name: 'getUser',
            api: {
              id: 'api-1',
              type: ApiType.GRAPHQL,
              baseUrl: 'https://api.example.com/graphql',
              authentication: { type: 'none', config: {} },
            },
          },
          configuration: {},
        } as any;

        mockedAxios.mockRejectedValue(new Error('Network timeout'));
        ((axios.isAxiosError as any) as jest.Mock).mockReturnValue(false);

        await expect(
          service['executeGraphQLOperation'](
            mockTool,
            mockTool.operation,
            mockTool.operation.api,
            {},
            { userId: 'user-1', organizationId: 'org-1' }
          )
        ).rejects.toThrow('Network timeout');
      });
    });

    describe('SOAP operation error handling', () => {
      it('should handle SOAP HTTP errors with axios', async () => {
        const mockTool = {
          id: 'tool-1',
          operation: {
            id: 'op-1',
            name: 'getUser',
            api: {
              id: 'api-1',
              type: ApiType.SOAP,
              baseUrl: 'https://api.example.com/soap',
              authentication: { type: 'none', config: {} },
            },
          },
          configuration: {},
        } as any;

        const parameters = {
          action: 'getUser',
          envelope: '<soap:Envelope>...</soap:Envelope>',
        };

        const axiosError = {
          isAxiosError: true,
          response: {
            status: 500,
            data: '<soap:Fault>...</soap:Fault>',
            headers: {},
          },
        };

        mockedAxios.mockRejectedValue(axiosError);
        ((axios.isAxiosError as any) as jest.Mock).mockReturnValue(true);

        const result = await service['executeSOAPOperation'](
          mockTool,
          mockTool.operation,
          mockTool.operation.api,
          parameters,
          { userId: 'user-1', organizationId: 'org-1' }
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('SOAP request failed');
        expect(result.metadata.httpStatus).toBe(500);
      });

      it('should throw non-axios errors in SOAP', async () => {
        const mockTool = {
          id: 'tool-1',
          operation: {
            id: 'op-1',
            name: 'getUser',
            api: {
              id: 'api-1',
              type: ApiType.SOAP,
              baseUrl: 'https://api.example.com/soap',
              authentication: { type: 'none', config: {} },
            },
          },
          configuration: {},
        } as any;

        mockedAxios.mockRejectedValue(new Error('Connection refused'));
        ((axios.isAxiosError as any) as jest.Mock).mockReturnValue(false);

        await expect(
          service['executeSOAPOperation'](
            mockTool,
            mockTool.operation,
            mockTool.operation.api,
            {},
            { userId: 'user-1', organizationId: 'org-1' }
          )
        ).rejects.toThrow('Connection refused');
      });
    });

    describe('Protobuf operation error handling', () => {
      it('should handle gRPC HTTP errors with axios', async () => {
        const mockTool = {
          id: 'tool-1',
          operation: {
            id: 'op-1',
            name: 'getUser',
            endpoint: '/api.UserService/GetUser',
            api: {
              id: 'api-1',
              type: ApiType.GRPC,
              baseUrl: 'https://api.example.com',
              authentication: { type: 'none', config: {} },
            },
          },
          configuration: {},
        } as any;

        const parameters = { userId: '123' };

        const axiosError = {
          isAxiosError: true,
          response: {
            status: 503,
            data: { error: 'Service unavailable' },
            headers: {},
          },
        };

        mockedAxios.mockRejectedValue(axiosError);
        ((axios.isAxiosError as any) as jest.Mock).mockReturnValue(true);

        const result = await service['executeProtobufOperation'](
          mockTool,
          mockTool.operation,
          mockTool.operation.api,
          parameters,
          { userId: 'user-1', organizationId: 'org-1' }
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('gRPC request failed');
        expect(result.metadata.httpStatus).toBe(503);
      });

      it('should throw non-axios errors in Protobuf', async () => {
        const mockTool = {
          id: 'tool-1',
          operation: {
            id: 'op-1',
            name: 'getUser',
            endpoint: '/api.UserService/GetUser',
            api: {
              id: 'api-1',
              type: ApiType.GRPC,
              baseUrl: 'https://api.example.com',
              authentication: { type: 'none', config: {} },
            },
          },
          configuration: {},
        } as any;

        mockedAxios.mockRejectedValue(new Error('gRPC connection error'));
        ((axios.isAxiosError as any) as jest.Mock).mockReturnValue(false);

        await expect(
          service['executeProtobufOperation'](
            mockTool,
            mockTool.operation,
            mockTool.operation.api,
            {},
            { userId: 'user-1', organizationId: 'org-1' }
          )
        ).rejects.toThrow('gRPC connection error');
      });
    });
  });

  describe('Operation Router Logic', () => {
    it('should route to REST execution for OpenAPI type', async () => {
      const mockTool = {
        id: 'tool-1',
        operation: {
          api: { type: ApiType.OPENAPI },
        },
      } as any;

      jest.spyOn(service as any, 'executeRestOperation').mockResolvedValue({ success: true });

      await service['executeOperation'](mockTool, {}, { userId: 'user-1', organizationId: 'org-1' });

      expect(service['executeRestOperation']).toHaveBeenCalled();
    });

    it('should route to GraphQL execution for GraphQL type', async () => {
      const mockTool = {
        id: 'tool-1',
        operation: {
          api: { type: ApiType.GRAPHQL },
        },
      } as any;

      jest.spyOn(service as any, 'executeGraphQLOperation').mockResolvedValue({ success: true });

      await service['executeOperation'](mockTool, {}, { userId: 'user-1', organizationId: 'org-1' });

      expect(service['executeGraphQLOperation']).toHaveBeenCalled();
    });

    it('should route to SOAP execution for SOAP type', async () => {
      const mockTool = {
        id: 'tool-1',
        operation: {
          api: { type: ApiType.SOAP },
        },
      } as any;

      jest.spyOn(service as any, 'executeSOAPOperation').mockResolvedValue({ success: true });

      await service['executeOperation'](mockTool, {}, { userId: 'user-1', organizationId: 'org-1' });

      expect(service['executeSOAPOperation']).toHaveBeenCalled();
    });

    it('should route to Protobuf execution for gRPC type', async () => {
      const mockTool = {
        id: 'tool-1',
        operation: {
          api: { type: ApiType.GRPC },
        },
      } as any;

      jest.spyOn(service as any, 'executeProtobufOperation').mockResolvedValue({ success: true });

      await service['executeOperation'](mockTool, {}, { userId: 'user-1', organizationId: 'org-1' });

      expect(service['executeProtobufOperation']).toHaveBeenCalled();
    });

    it('should throw error for unsupported API type', async () => {
      const mockTool = {
        id: 'tool-1',
        operation: {
          api: { type: 'UNKNOWN_TYPE' },
        },
      } as any;

      await expect(
        service['executeOperation'](mockTool, {}, { userId: 'user-1', organizationId: 'org-1' })
      ).rejects.toThrow('Unsupported API type');
    });
  });

  describe('Record Execution Error Handling', () => {
    it('should handle recordExecution save failures gracefully', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
        operation: {
          api: { type: 'openapi', baseUrl: 'https://api.example.com', authentication: { type: 'none' } },
        },
        configuration: {},
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);
      toolExecutionRepository.create.mockReturnValue({ id: 'exec-1' });
      toolExecutionRepository.save.mockRejectedValue(new Error('Database connection failed'));

      jest.spyOn(service as any, 'validateParameters').mockResolvedValue({ isValid: true, errors: [] });
      jest.spyOn(service as any, 'checkRateLimit').mockResolvedValue({ limited: false });
      jest.spyOn(service as any, 'executeOperation').mockResolvedValue({
        success: true,
        data: { result: 'test' },
      });

      // Should not throw even if recording fails
      const result = await service.executeTool('tool-1', {}, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ result: 'test' });
    });

    it('should handle recordExecution create failures on error path', async () => {
      const mockTool = {
        id: 'tool-1',
        status: ToolStatus.ACTIVE,
        operation: {
          api: { type: 'openapi' },
        },
        inputSchema: {
          validate: jest.fn().mockResolvedValue({ isValid: true, errors: [] }),
        },
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);
      userRepository.findOne.mockResolvedValue(mockUser);

      // Make save fail for both success and error recording paths
      toolExecutionRepository.save.mockRejectedValue(new Error('Database connection failed'));

      // Mock executeOperation to return an error
      jest.spyOn(service as any, 'executeOperation').mockResolvedValue({
        success: false,
        error: 'API Error',
      });

      const result = await service.executeTool('tool-1', {}, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('API Error');
    });
  });
});