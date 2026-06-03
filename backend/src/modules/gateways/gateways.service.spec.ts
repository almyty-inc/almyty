import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GatewaysService } from './gateways.service';
import { GatewaysStatsHelper } from './gateways-stats.helper';
import { GatewayInitHelper } from './gateway-init.helper';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { GatewayAuth } from '../../entities/gateway-auth.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';

describe('GatewaysService', () => {
  let service: GatewaysService;
  let gatewayRepository: any;
  let gatewayToolRepository: any;
  let gatewayAuthRepository: any;
  let userRepository: any;
  let organizationRepository: any;
  let usageMetricRepository: any;
  let accessPolicy: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GatewaysStatsHelper,
        GatewayInitHelper,
        GatewaysService,
        {
          provide: getRepositoryToken(Gateway),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            remove: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(GatewayTool),
          useValue: {
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(GatewayAuth),
          useValue: {
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(UsageMetric),
          useValue: {
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
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
        {
          provide: AccessPolicyService,
          useValue: {
            canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
            applyListFilter: jest.fn().mockResolvedValue({ bypass: true, teamIds: [] }),
            assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<GatewaysService>(GatewaysService);
    gatewayRepository = module.get(getRepositoryToken(Gateway));
    gatewayToolRepository = module.get(getRepositoryToken(GatewayTool));
    gatewayAuthRepository = module.get(getRepositoryToken(GatewayAuth));
    userRepository = module.get(getRepositoryToken(User));
    organizationRepository = module.get(getRepositoryToken(Organization));
    usageMetricRepository = module.get(getRepositoryToken(UsageMetric));
    accessPolicy = module.get(AccessPolicyService);
  });

  describe('createGateway', () => {
    it('should throw error if organization not found', async () => {
      const createDto = {
        name: 'Test Gateway',
        type: 'mcp' as any,
        endpoint: '/test',
        description: 'Test gateway',
        configuration: {
          capabilities: {},
          transport: 'http',
          protocols: ['mcp']
        },
      };

      organizationRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createGateway(createDto, 'org-1', 'user-1')
      ).rejects.toThrow();
    });

    it('should throw error if user lacks permissions', async () => {
      const createDto = {
        name: 'Test Gateway',
        type: 'mcp' as any,
        endpoint: '/test',
        description: 'Test gateway',
        configuration: {
          capabilities: {},
          transport: 'http',
          protocols: ['mcp']
        },
      };

      const mockOrganization = {
        id: 'org-1',
        name: 'Test Org',
        canAddMoreGateways: jest.fn().mockReturnValue(true),
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false)
      } as any;

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.createGateway(createDto, 'org-1', 'user-1')
      ).rejects.toThrow();
    });

    it('should throw error if gateway limit reached', async () => {
      const createDto = {
        name: 'Test Gateway',
        type: 'mcp' as any,
        endpoint: '/test',
        description: 'Test gateway',
        configuration: {
          capabilities: {},
          transport: 'http',
          protocols: ['mcp']
        },
      };

      const mockOrganization = {
        id: 'org-1',
        name: 'Test Org',
        canAddMoreGateways: jest.fn().mockReturnValue(false),
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true)
      } as any;

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.createGateway(createDto, 'org-1', 'user-1')
      ).rejects.toThrow();
    });

    it('should create gateway successfully', async () => {
      const createDto = {
        name: 'Test Gateway',
        type: 'mcp' as any,
        endpoint: '/test',
        description: 'Test gateway',
        configuration: {
          capabilities: {},
          transport: 'http',
          protocols: ['mcp']
        },
      };

      const mockOrganization = {
        id: 'org-1',
        name: 'Test Org',
        canAddMoreGateways: jest.fn().mockReturnValue(true),
      } as any;

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true)
      } as any;

      const mockGateway = {
        id: 'gateway-1',
        ...createDto,
        organizationId: 'org-1',
        status: 'draft',
        canAcceptRequests: jest.fn().mockReturnValue(true),
        supportsProtocol: jest.fn().mockReturnValue(true),
        getActiveTools: jest.fn().mockReturnValue([]),
      } as any;

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayRepository.create.mockReturnValue(mockGateway);
      gatewayRepository.save.mockResolvedValue(mockGateway);

      const result = await service.createGateway(createDto, 'org-1', 'user-1');

      expect(result).toBe(mockGateway);
      expect(gatewayRepository.create).toHaveBeenCalled();
      expect(gatewayRepository.save).toHaveBeenCalled();
    });
  });

  describe('getGateway', () => {
    it('should return gateway by id', async () => {
      const mockGateway = {
        id: 'gateway-1',
        name: 'Test Gateway',
        organizationId: 'org-1',
        canAcceptRequests: jest.fn().mockReturnValue(true),
        supportsProtocol: jest.fn().mockReturnValue(true),
        getActiveTools: jest.fn().mockReturnValue([]),
      } as any;

      gatewayRepository.findOne.mockResolvedValue(mockGateway);

      const result = await service.getGateway('gateway-1', 'org-1');

      expect(result).toBe(mockGateway);
    });
  });

  describe('updateGateway', () => {
    it('should throw error if gateway not found', async () => {
      const updateDto = { name: 'Updated Gateway' };

      gatewayRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateGateway('gateway-1', updateDto, 'org-1', 'user-1')
      ).rejects.toThrow();
    });

    it('should throw error if user lacks permissions', async () => {
      const updateDto = { name: 'Updated Gateway' };
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false)
      };
      const mockGateway = {
        id: 'gateway-1',
        name: 'Old Gateway',
        organizationId: 'org-1',
      } as any;

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      accessPolicy.canAccess.mockResolvedValueOnce({ allowed: false, reason: 'denied' });

      await expect(
        service.updateGateway('gateway-1', updateDto, 'org-1', 'user-1')
      ).rejects.toThrow();
    });

    it('should update gateway successfully', async () => {
      const updateDto = { name: 'Updated Gateway' };
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true)
      };
      const mockGateway = {
        id: 'gateway-1',
        name: 'Old Gateway',
        organizationId: 'org-1',
        canAcceptRequests: jest.fn().mockReturnValue(true),
        supportsProtocol: jest.fn().mockReturnValue(true),
        getActiveTools: jest.fn().mockReturnValue([]),
      } as any;

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayRepository.save.mockResolvedValue({ ...mockGateway, ...updateDto });

      const result = await service.updateGateway('gateway-1', updateDto, 'org-1', 'user-1');

      expect(result.name).toBe('Updated Gateway');
      expect(gatewayRepository.save).toHaveBeenCalled();
    });

    it('flips visibility from team back to org and clears the dangling teamId', async () => {
      const mockGateway: any = {
        id: 'gateway-1',
        name: 'GW',
        organizationId: 'org-1',
        visibility: 'team',
        teamId: 'team-old',
        canAcceptRequests: jest.fn().mockReturnValue(true),
        supportsProtocol: jest.fn().mockReturnValue(true),
        getActiveTools: jest.fn().mockReturnValue([]),
      };
      const mockUser = { id: 'user-1', hasPermissionInOrganization: jest.fn().mockReturnValue(true) };
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayRepository.save.mockImplementation((g: any) => Promise.resolve(g));

      await service.updateGateway('gateway-1', { visibility: 'org' } as any, 'org-1', 'user-1');

      expect(mockGateway.visibility).toBe('org');
      expect(mockGateway.teamId).toBeNull();
    });
  });

  describe('deleteGateway', () => {
    it('should throw error if gateway not found', async () => {
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true)
      };

      gatewayRepository.findOne.mockResolvedValue(null);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.deleteGateway('gateway-1', 'org-1', 'user-1')
      ).rejects.toThrow();
    });

    it('should throw error if user lacks permissions', async () => {
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false)
      };
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        status: 'active',
      } as any;

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      accessPolicy.canAccess.mockResolvedValueOnce({ allowed: false, reason: 'denied' });

      await expect(
        service.deleteGateway('gateway-1', 'org-1', 'user-1')
      ).rejects.toThrow();
    });

    it('should delete gateway successfully', async () => {
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true)
      };
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        status: 'active',
      } as any;

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayRepository.remove.mockResolvedValue();

      await service.deleteGateway('gateway-1', 'org-1', 'user-1');

      expect(gatewayRepository.remove).toHaveBeenCalledWith(mockGateway);
    });
  });

  describe('getGateways', () => {
    it('should return paginated gateways', async () => {
      const mockGateways = [
        { id: 'gateway-1', name: 'Gateway 1' },
        { id: 'gateway-2', name: 'Gateway 2' },
      ];

      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([mockGateways, 2]),
        getCount: jest.fn().mockResolvedValue(2),
        getMany: jest.fn().mockResolvedValue(mockGateways),
      };

      gatewayRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getGateways({
        organizationId: 'org-1',
        page: 1,
        limit: 10,
        caller: { id: 'user-1' },
      });

      expect(result.gateways).toBe(mockGateways);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });
  });

  describe('activateGateway', () => {
    it('should throw error if user lacks permissions', async () => {
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false)
      };
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        status: 'draft',
      } as any;

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      accessPolicy.canAccess.mockResolvedValueOnce({ allowed: false, reason: 'denied' });

      await expect(
        service.activateGateway('gateway-1', 'org-1', 'user-1')
      ).rejects.toThrow();
    });

    it('should return gateway unchanged if already active', async () => {
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true)
      };
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        status: 'active',
        canAcceptRequests: jest.fn().mockReturnValue(true),
        supportsProtocol: jest.fn().mockReturnValue(true),
        getActiveTools: jest.fn().mockReturnValue([]),
      } as any;

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.activateGateway('gateway-1', 'org-1', 'user-1');

      expect(result).toBe(mockGateway);
      expect(result.status).toBe('active');
      expect(gatewayRepository.save).not.toHaveBeenCalled();
    });

    it('should activate gateway successfully', async () => {
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true)
      };
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        status: 'draft',
        canAcceptRequests: jest.fn().mockReturnValue(true),
      } as any;

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayRepository.save.mockResolvedValue({ ...mockGateway, status: 'active' });

      const result = await service.activateGateway('gateway-1', 'org-1', 'user-1');

      expect(result.status).toBe('active');
      expect(gatewayRepository.save).toHaveBeenCalled();
    });
  });

  describe('deactivateGateway', () => {
    it('should throw error if user lacks permissions', async () => {
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(false)
      };
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        status: 'active',
      } as any;

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      accessPolicy.canAccess.mockResolvedValueOnce({ allowed: false, reason: 'denied' });

      await expect(
        service.deactivateGateway('gateway-1', 'org-1', 'user-1')
      ).rejects.toThrow();
    });

    it('should return gateway unchanged if already inactive', async () => {
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true)
      };
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        status: 'inactive',
        canAcceptRequests: jest.fn().mockReturnValue(true),
        supportsProtocol: jest.fn().mockReturnValue(true),
        getActiveTools: jest.fn().mockReturnValue([]),
      } as any;

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.deactivateGateway('gateway-1', 'org-1', 'user-1');

      expect(result).toBe(mockGateway);
      expect(result.status).toBe('inactive');
      expect(gatewayRepository.save).not.toHaveBeenCalled();
    });

    it('should deactivate gateway successfully', async () => {
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true)
      };
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        status: 'active',
      } as any;

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayRepository.save.mockResolvedValue({ ...mockGateway, status: 'inactive' });

      const result = await service.deactivateGateway('gateway-1', 'org-1', 'user-1');

      expect(result.status).toBe('inactive');
      expect(gatewayRepository.save).toHaveBeenCalled();
    });
  });

  describe('performHealthCheck', () => {
    it('should perform health check successfully', async () => {
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        status: 'active',
        endpoint: '/test',
        configuration: { healthCheck: { enabled: true } },
      } as any;

      gatewayRepository.findOne.mockResolvedValue(mockGateway);

      const result = await service.performHealthCheck('gateway-1', 'org-1');

      expect(result).toEqual({
        isHealthy: expect.any(Boolean),
      });
    });
  });

  describe('getGatewayStats', () => {
    it('should return gateway statistics', async () => {
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        tools: [{ id: 'tool-1' }],
        getActiveTools: jest.fn().mockReturnValue([{ id: 'tool-1' }]),
      } as any;

      const mockMetrics = [
        { metricType: 'request', value: 100, createdAt: new Date() },
        { metricType: 'response_time', value: 250, createdAt: new Date() },
      ];

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      usageMetricRepository.find.mockResolvedValue(mockMetrics);

      const result = await service.getGatewayStats('gateway-1', 'org-1', 'day');

      expect(result).toEqual({
        totalRequests: expect.any(Number),
        successfulRequests: expect.any(Number),
        failedRequests: expect.any(Number),
        averageResponseTime: expect.any(Number),
        activeTools: expect.any(Number),
        successRate: expect.any(Number),
        uniqueUsers: expect.any(Number),
        requestTrend: expect.any(Array),
      });
    });

    it('uses TypeORM MoreThanOrEqual on createdAt (regression for dead $gte)', async () => {
      // Pre-fix this used the MongoDB-style `{ $gte: since }`
      // operator, which TypeORM ignored — the where clause matched
      // zero rows and the stats were silently empty. Pin the new
      // operator shape so a regression to `$gte` trips here.
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        tools: [],
        getActiveTools: jest.fn().mockReturnValue([]),
      } as any;

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      usageMetricRepository.find.mockResolvedValue([]);

      await service.getGatewayStats('gateway-1', 'org-1', 'day');

      const whereArg = (usageMetricRepository.find.mock.calls[0][0] as any).where;
      expect(whereArg.createdAt).not.toHaveProperty('$gte');
      expect(whereArg.createdAt).toHaveProperty('_type', 'moreThanOrEqual');
    });
  });

  describe('getOrganizationGatewayStats', () => {
    it('should return organization-wide gateway statistics', async () => {
      const mockGateways = [
        {
          id: 'gateway-1',
          organizationId: 'org-1',
          status: 'active',
          totalRequests: 100,
          successfulRequests: 90,
          tools: [{ id: 'tool-1' }],
          getActiveTools: jest.fn().mockReturnValue([{ id: 'tool-1' }]),
        },
        {
          id: 'gateway-2',
          organizationId: 'org-1',
          status: 'active',
          totalRequests: 50,
          successfulRequests: 45,
          tools: [{ id: 'tool-2' }],
          getActiveTools: jest.fn().mockReturnValue([{ id: 'tool-2' }]),
        },
      ];

      const mockMetrics = [
        { type: 'response_time', value: 250, organizationId: 'org-1' },
        { type: 'response_time', value: 150, organizationId: 'org-1' },
      ];

      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { gateway_status: 'active', count: '2' },
        ]),
      };

      gatewayRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
      gatewayRepository.find.mockResolvedValue(mockGateways);
      usageMetricRepository.find.mockResolvedValue(mockMetrics);

      const result = await service.getOrganizationGatewayStats('org-1');

      expect(result).toEqual({
        totalGateways: expect.any(Number),
        activeGateways: expect.any(Number),
        inactiveGateways: expect.any(Number),
        totalRequests: expect.any(Number),
        averageResponseTime: expect.any(Number),
        successRate: expect.any(Number),
        topGateways: expect.any(Array),
      });
    });
  });

  describe('createGateway - untested branches', () => {
    it('should throw error if endpoint already exists', async () => {
      const createDto = {
        name: 'Test Gateway',
        type: 'mcp' as any,
        endpoint: '/duplicate',
        configuration: { transport: 'http' },
      };

      const mockOrganization = {
        id: 'org-1',
        canAddMoreGateways: jest.fn().mockReturnValue(true),
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      const existingGateway = {
        id: 'existing-gateway-1',
        endpoint: '/duplicate',
      };

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      userRepository.findOne.mockResolvedValue(mockUser);
      gatewayRepository.findOne.mockResolvedValue(existingGateway);

      await expect(
        service.createGateway(createDto, 'org-1', 'user-1')
      ).rejects.toThrow('Endpoint already exists');
    });
  });

  describe('updateGateway - untested branches', () => {
    it('should validate configuration when updating', async () => {
      const updateDto = {
        configuration: { transport: 'invalid-transport' },
      };

      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      const mockGateway = {
        id: 'gateway-1',
        name: 'Test Gateway',
        type: 'mcp' as any,
        organizationId: 'org-1',
        configuration: { transport: 'http' },
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);
      accessPolicy.canAccess.mockResolvedValueOnce({ allowed: false, reason: 'denied' });

      await expect(
        service.updateGateway('gateway-1', updateDto, 'org-1', 'user-1')
      ).rejects.toThrow();
    });
  });

  describe('getGateways - filter branches', () => {
    it('should filter by search term', async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(1),
        getMany: jest.fn().mockResolvedValue([]),
      };

      gatewayRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.getGateways({
        organizationId: 'org-1',
        search: 'test gateway',
        caller: { id: 'user-1' },
      });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(gateway.name ILIKE :search OR gateway.description ILIKE :search)',
        { search: '%test gateway%' }
      );
    });

    it('should filter by type', async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(1),
        getMany: jest.fn().mockResolvedValue([]),
      };

      gatewayRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.getGateways({
        organizationId: 'org-1',
        type: 'mcp' as any,
        caller: { id: 'user-1' },
      });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('gateway.type = :type', { type: 'mcp' });
    });

    it('should filter by status', async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(1),
        getMany: jest.fn().mockResolvedValue([]),
      };

      gatewayRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.getGateways({
        organizationId: 'org-1',
        status: 'active' as any,
        caller: { id: 'user-1' },
      });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('gateway.status = :status', { status: 'active' });
    });
  });

  describe('getGatewayStats - untested branches', () => {
    it('should handle empty metrics', async () => {
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        getActiveTools: jest.fn().mockReturnValue([]),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      usageMetricRepository.find.mockResolvedValue([]);

      const result = await service.getGatewayStats('gateway-1', 'org-1', 'day');

      expect(result.totalRequests).toBe(0);
      expect(result.averageResponseTime).toBe(0);
      expect(result.successRate).toBe(0);
    });

    it('should calculate stats for hour timeframe', async () => {
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        getActiveTools: jest.fn().mockReturnValue([{ id: 'tool-1' }]),
      };

      const mockMetrics = [
        {
          type: 'request_count',
          value: 10,
          status: 'success',
          userId: 'user-1',
          createdAt: new Date(),
        },
        {
          type: 'response_time',
          value: 250,
          createdAt: new Date(),
        },
      ];

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      usageMetricRepository.find.mockResolvedValue(mockMetrics);

      const result = await service.getGatewayStats('gateway-1', 'org-1', 'hour');

      expect(result.totalRequests).toBe(10);
      expect(result.requestTrend.length).toBeGreaterThan(0);
    });

    it('should calculate stats for week timeframe', async () => {
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        getActiveTools: jest.fn().mockReturnValue([]),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      usageMetricRepository.find.mockResolvedValue([]);

      const result = await service.getGatewayStats('gateway-1', 'org-1', 'week');

      expect(result.requestTrend.length).toBe(12);
    });

    it('should calculate stats for month timeframe', async () => {
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        getActiveTools: jest.fn().mockReturnValue([]),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      usageMetricRepository.find.mockResolvedValue([]);

      const result = await service.getGatewayStats('gateway-1', 'org-1', 'month');

      expect(result.requestTrend.length).toBe(12);
    });
  });

  describe('performHealthCheck', () => {
    it('should return healthy when health check disabled', async () => {
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        healthCheck: { enabled: false },
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);

      const result = await service.performHealthCheck('gateway-1', 'org-1');

      expect(result.isHealthy).toBe(true);
    });

    it('should perform health check when enabled', async () => {
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        healthCheck: { enabled: true },
        getActiveTools: jest.fn().mockReturnValue([{ id: 'tool-1' }]),
        canAcceptRequests: jest.fn().mockReturnValue(true),
        updateHealthStatus: jest.fn(),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayRepository.save.mockResolvedValue(mockGateway);

      const result = await service.performHealthCheck('gateway-1', 'org-1');

      expect(result.isHealthy).toBe(true);
      expect(result.responseTime).toBeDefined();
      expect(mockGateway.updateHealthStatus).toHaveBeenCalledWith(true);
    });

    it('should handle health check failure', async () => {
      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        healthCheck: { enabled: true },
        getActiveTools: jest.fn().mockImplementation(() => {
          throw new Error('Health check failed');
        }),
        updateHealthStatus: jest.fn(),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayRepository.save.mockResolvedValue(mockGateway);

      const result = await service.performHealthCheck('gateway-1', 'org-1');

      expect(result.isHealthy).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockGateway.updateHealthStatus).toHaveBeenCalledWith(false);
    });
  });

  describe('validateGatewayConfiguration', () => {
    it('should validate MCP gateway configuration - missing transport', () => {
      expect(() => {
        service['init'].validateGatewayConfiguration('mcp' as any, {});
      }).toThrow('MCP gateway requires transport configuration');
    });

    it('should validate MCP gateway configuration - invalid transport', () => {
      expect(() => {
        service['init'].validateGatewayConfiguration('mcp' as any, { transport: 'invalid' });
      }).toThrow('Invalid MCP transport type');
    });

    it('should validate MCP gateway configuration - valid', () => {
      expect(() => {
        service['init'].validateGatewayConfiguration('mcp' as any, { transport: 'http' });
      }).not.toThrow();

      expect(() => {
        service['init'].validateGatewayConfiguration('mcp' as any, { transport: 'sse' });
      }).not.toThrow();

      expect(() => {
        service['init'].validateGatewayConfiguration('mcp' as any, { transport: 'websocket' });
      }).not.toThrow();
    });

    it('should accept A2A gateway configuration without special requirements', () => {
      expect(() => {
        service['init'].validateGatewayConfiguration('a2a' as any, {});
      }).not.toThrow();
    });

    it('should validate UTCP gateway configuration - missing protocol', () => {
      expect(() => {
        service['init'].validateGatewayConfiguration('utcp' as any, {});
      }).toThrow('UTCP gateway requires protocol configuration');
    });

    it('should validate UTCP gateway configuration - invalid protocol', () => {
      expect(() => {
        service['init'].validateGatewayConfiguration('utcp' as any, { protocol: 'invalid' });
      }).toThrow('Invalid UTCP protocol type');
    });

    it('should validate UTCP gateway configuration - valid', () => {
      expect(() => {
        service['init'].validateGatewayConfiguration('utcp' as any, { protocol: 'http' });
      }).not.toThrow();

      expect(() => {
        service['init'].validateGatewayConfiguration('utcp' as any, { protocol: 'tcp' });
      }).not.toThrow();
    });
  });

  describe('calculateRequestTrend - timeframe branches', () => {
    it('should calculate trend for hour timeframe', () => {
      const now = new Date();
      const metrics = [
        {
          type: 'request_count',
          value: 5,
          status: 'success',
          createdAt: now,
        } as any,
      ];

      const result = service['calculateRequestTrend'](metrics, 'hour');

      expect(result.length).toBe(24);
      expect(result[0].date).toBeDefined();
    });

    it('should calculate trend for day timeframe', () => {
      const now = new Date();
      const metrics = [
        {
          type: 'request_count',
          value: 5,
          status: 'success',
          createdAt: now,
        } as any,
      ];

      const result = service['calculateRequestTrend'](metrics, 'day');

      expect(result.length).toBe(30);
    });

    it('should calculate trend for week timeframe', () => {
      const now = new Date();
      const metrics = [
        {
          type: 'request_count',
          value: 5,
          status: 'success',
          createdAt: now,
        } as any,
      ];

      const result = service['calculateRequestTrend'](metrics, 'week');

      expect(result.length).toBe(12);
    });

    it('should calculate trend for month timeframe', () => {
      const now = new Date();
      const metrics = [
        {
          type: 'request_count',
          value: 5,
          status: 'success',
          createdAt: now,
        } as any,
      ];

      const result = service['calculateRequestTrend'](metrics, 'month');

      expect(result.length).toBe(12);
    });
  });

  describe('getWeekNumber', () => {
    it('should calculate week number correctly', () => {
      const date1 = new Date('2024-01-01');
      const week1 = service['getWeekNumber'](date1);
      expect(week1).toBeGreaterThan(0);

      const date2 = new Date('2024-06-15');
      const week2 = service['getWeekNumber'](date2);
      expect(week2).toBeGreaterThan(week1);
    });
  });

  describe('activateGateway', () => {
    it('should return gateway if already active', async () => {
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        status: 'active',
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.activateGateway('gateway-1', 'org-1', 'user-1');

      expect(result.status).toBe('active');
      expect(gatewayRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('deactivateGateway', () => {
    it('should return gateway if already inactive', async () => {
      const mockUser = {
        id: 'user-1',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      };

      const mockGateway = {
        id: 'gateway-1',
        organizationId: 'org-1',
        status: 'inactive',
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.deactivateGateway('gateway-1', 'org-1', 'user-1');

      expect(result.status).toBe('inactive');
      expect(gatewayRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('searchSkillsAcrossGateways', () => {
    it('should return matching tools with skillRef in org/gateway/skill format', async () => {
      const mockOrganization = {
        id: 'org-1',
        name: 'Test Org',
        slug: 'test-org',
      };

      const mockGateways = [
        {
          id: 'gateway-1',
          name: 'My Gateway',
          endpoint: '/my-gateway',
          status: 'active',
          tools: [
            {
              isActive: true,
              tool: {
                id: 'tool-1',
                name: 'Get Users',
                description: 'Fetches all users from the API',
              },
            },
          ],
        },
      ];

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      gatewayRepository.find.mockResolvedValue(mockGateways);

      const results = await service.searchSkillsAcrossGateways('org-1', 'users');

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        toolId: 'tool-1',
        toolName: 'Get Users',
        toolDescription: 'Fetches all users from the API',
        gatewayId: 'gateway-1',
        gatewayName: 'My Gateway',
        orgSlug: 'test-org',
        gatewaySlug: 'my-gateway',
        skillRef: 'test-org/my-gateway/get-users',
      });
    });

    it('should match by tool name (case insensitive)', async () => {
      const mockOrganization = {
        id: 'org-1',
        name: 'Test Org',
        slug: 'test-org',
      };

      const mockGateways = [
        {
          id: 'gateway-1',
          name: 'API Gateway',
          endpoint: '/api-gateway',
          status: 'active',
          tools: [
            {
              isActive: true,
              tool: {
                id: 'tool-1',
                name: 'Create Invoice',
                description: 'Creates a new invoice',
              },
            },
            {
              isActive: true,
              tool: {
                id: 'tool-2',
                name: 'List Orders',
                description: 'Lists all orders',
              },
            },
          ],
        },
      ];

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      gatewayRepository.find.mockResolvedValue(mockGateways);

      const results = await service.searchSkillsAcrossGateways('org-1', 'INVOICE');

      expect(results).toHaveLength(1);
      expect(results[0].toolName).toBe('Create Invoice');
    });

    it('should match by tool description', async () => {
      const mockOrganization = {
        id: 'org-1',
        name: 'Test Org',
        slug: 'test-org',
      };

      const mockGateways = [
        {
          id: 'gateway-1',
          name: 'API Gateway',
          endpoint: '/api-gateway',
          status: 'active',
          tools: [
            {
              isActive: true,
              tool: {
                id: 'tool-1',
                name: 'Send Email',
                description: 'Sends a notification email to the user',
              },
            },
          ],
        },
      ];

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      gatewayRepository.find.mockResolvedValue(mockGateways);

      const results = await service.searchSkillsAcrossGateways('org-1', 'notification');

      expect(results).toHaveLength(1);
      expect(results[0].toolName).toBe('Send Email');
    });

    it('should return empty array when no matches', async () => {
      const mockOrganization = {
        id: 'org-1',
        name: 'Test Org',
        slug: 'test-org',
      };

      const mockGateways = [
        {
          id: 'gateway-1',
          name: 'API Gateway',
          endpoint: '/api-gateway',
          status: 'active',
          tools: [
            {
              isActive: true,
              tool: {
                id: 'tool-1',
                name: 'Get Users',
                description: 'Fetches users',
              },
            },
          ],
        },
      ];

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      gatewayRepository.find.mockResolvedValue(mockGateways);

      const results = await service.searchSkillsAcrossGateways('org-1', 'nonexistent');

      expect(results).toEqual([]);
    });

    it('should only search active gateways', async () => {
      const mockOrganization = {
        id: 'org-1',
        name: 'Test Org',
        slug: 'test-org',
      };

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      gatewayRepository.find.mockResolvedValue([]);

      await service.searchSkillsAcrossGateways('org-1', 'test');

      expect(gatewayRepository.find).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', status: 'active' },
        relations: ['tools', 'tools.tool'],
      });
    });

    it('should only include active tools', async () => {
      const mockOrganization = {
        id: 'org-1',
        name: 'Test Org',
        slug: 'test-org',
      };

      const mockGateways = [
        {
          id: 'gateway-1',
          name: 'API Gateway',
          endpoint: '/api-gateway',
          status: 'active',
          tools: [
            {
              isActive: true,
              tool: {
                id: 'tool-1',
                name: 'Active Tool',
                description: 'This tool is active',
              },
            },
            {
              isActive: false,
              tool: {
                id: 'tool-2',
                name: 'Inactive Tool',
                description: 'This tool is inactive',
              },
            },
          ],
        },
      ];

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      gatewayRepository.find.mockResolvedValue(mockGateways);

      const results = await service.searchSkillsAcrossGateways('org-1', 'tool');

      expect(results).toHaveLength(1);
      expect(results[0].toolName).toBe('Active Tool');
    });
  });

  describe('getAllUserGateways', () => {
    it('should return all active gateways with tools and organization loaded', async () => {
      const mockGateways = [
        {
          id: 'gateway-1',
          name: 'Gateway One',
          organizationId: 'org-1',
          status: 'active',
          tools: [{ id: 'gt-1', tool: { id: 'tool-1', name: 'Tool 1' } }],
          organization: { id: 'org-1', name: 'Test Org' },
        },
        {
          id: 'gateway-2',
          name: 'Gateway Two',
          organizationId: 'org-1',
          status: 'active',
          tools: [],
          organization: { id: 'org-1', name: 'Test Org' },
        },
      ];

      gatewayRepository.find.mockResolvedValue(mockGateways);

      const result = await service.getAllUserGateways('org-1');

      expect(result).toEqual(mockGateways);
      expect(result).toHaveLength(2);
      expect(gatewayRepository.find).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', status: 'active' },
        relations: ['tools', 'tools.tool', 'organization'],
      });
    });

    it('should return empty array when no gateways', async () => {
      gatewayRepository.find.mockResolvedValue([]);

      const result = await service.getAllUserGateways('org-1');

      expect(result).toEqual([]);
      expect(gatewayRepository.find).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', status: 'active' },
        relations: ['tools', 'tools.tool', 'organization'],
      });
    });
  });
});