import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AxiosRequestConfig } from 'axios';
import { ToolExecutorService } from './tool-executor.service';
import { ToolHttpExecutor } from './executors/tool-http.executor';
import { ToolProtocolExecutor } from './executors/tool-protocol.executor';
import { ToolScriptExecutor } from './executors/tool-script.executor';
import { ToolAuthService } from './services/tool-auth.service';
import { hashCacheObject, sleep as sleepUtil } from './tool-execution-utils';
import { Tool, ToolType, ToolStatus } from '../../entities/tool.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { User } from '../../entities/user.entity';
import { Credential } from '../../entities/credential.entity';
import { NodeSandboxService } from './node-sandbox/node-sandbox.service';
import { SdkCodeAssemblerService } from './node-sandbox/sdk-code-assembler.service';
import { GrpcCallerService } from './executors/grpc-caller.service';
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

// The retry loop in the orchestrator calls `sleep` from the shared
// utils module for its exponential backoff. Live setTimeout would
// add seconds to the test run per retry, so mock the helper with a
// resolved promise. Everything else in the utils module stays real.
jest.mock('./tool-execution-utils', () => {
  const actual = jest.requireActual('./tool-execution-utils');
  return { ...actual, sleep: jest.fn().mockResolvedValue(undefined) };
});

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

    // bumpToolStats issues an atomic SQL UPDATE via createQueryBuilder.
    // The spec doesn't need to inspect the SQL — it just needs the chain
    // to resolve so recordExecution can finish. Provide a noop chain.
    const qbUpdateChain: any = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolExecutorService,
        // Real executor + auth instances so the dispatch in
        // ToolExecutorService can call through to them. Their
        // constructor dependencies are satisfied by the mocked
        // repositories + helpers below.
        ToolHttpExecutor,
        ToolProtocolExecutor,
        ToolScriptExecutor,
        ToolAuthService,
        {
          provide: getRepositoryToken(Tool),
          useValue: {
            findOne: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(qbUpdateChain),
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
        // ModuleRef is consumed by ToolScriptExecutor (for LLM call
        // routing) and ToolAuthService (for OAuth2 refresh). The spec
        // doesn't exercise either path, so a stub that returns null
        // on `.get(...)` is fine.
        {
          provide: ModuleRef,
          useValue: { get: jest.fn().mockReturnValue(null) },
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
        // Real-gRPC executor dep + the proto-source repository its
        // operation-path needs. The spec doesn't exercise gRPC, but
        // the protocol executor's constructor pulls them.
        {
          provide: GrpcCallerService,
          useValue: {
            call: jest.fn().mockResolvedValue({ success: true, data: null, code: 0 }),
          },
        },
        {
          provide: getRepositoryToken(ApiSchema),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
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

    it('scopes tool lookup to the caller organizationId', async () => {
      // Regression: the previous version loaded tools via
      // `findOne({ where: { id: toolId } })` with NO org scoping, so a
      // user with `use_tools` in their own org could execute any tool
      // in any other org just by knowing its id. The fix adds
      // `organizationId` to the where clause so the lookup returns
      // null for cross-org ids. This test verifies the literal query
      // shape so a regression can't sneak back in.
      toolRepository.findOne.mockResolvedValue(null);

      const result = await service.executeTool('tool-in-other-org', {}, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/i);
      expect(toolRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'tool-in-other-org',
            organizationId: 'org-1',
          }),
        }),
      );
    });

    it('rejects execution when organizationId is missing', async () => {
      // Belt-and-suspenders: even if a caller constructs options with
      // an empty orgId, the executor should treat the tool as not
      // found rather than falling back to an unscoped query.
      toolRepository.findOne.mockClear();

      const result = await service.executeTool('tool-1', {}, {
        userId: 'user-1',
        organizationId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/i);
      // Should not have even attempted the lookup
      expect(toolRepository.findOne).not.toHaveBeenCalled();
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

        const cacheKey = `tool_cache:tool-1:${hashCacheObject(parameters)}`;
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

        const cacheKey = `tool_cache:tool-1:${hashCacheObject(parameters)}`;
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
      expect(sleepUtil).toHaveBeenCalledTimes(2);
      // Exponential backoff: 2^1 * 1000 = 2000ms, 2^2 * 1000 = 4000ms
      expect(sleepUtil).toHaveBeenNthCalledWith(1, 2000);
      expect(sleepUtil).toHaveBeenNthCalledWith(2, 4000);
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
      jest.spyOn(service as any, 'executeOperation')
        .mockRejectedValue(new Error('Failed'));

      const result = await service.executeTool('tool-1', {}, {
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(result.retryCount).toBe(2); // Initial + 1 retry
      expect(sleepUtil).toHaveBeenCalledTimes(1);
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