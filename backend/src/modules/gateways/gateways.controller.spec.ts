import { Test, TestingModule } from '@nestjs/testing';
import { GatewaysController } from './gateways.controller';
import { GatewaysService } from './gateways.service';
import { GatewayAuthService } from './gateway-auth.service';
import { GatewayToolService } from './gateway-tool.service';
import { SkillGeneratorService } from '../tools/skill-generator.service';
import { CliGeneratorService } from '../tools/cli-generator.service';
import { CodegenService } from '../tools/codegen.service';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';

describe('GatewaysController', () => {
  let controller: GatewaysController;
  let gatewaysService: jest.Mocked<GatewaysService>;
  let gatewayAuthService: jest.Mocked<GatewayAuthService>;
  let gatewayToolService: jest.Mocked<GatewayToolService>;
  let skillGeneratorService: jest.Mocked<SkillGeneratorService>;
  let toolExecutorService: jest.Mocked<ToolExecutorService>;

  beforeEach(async () => {
    const mockGatewaysService = {
      createGateway: jest.fn(),
      getGateways: jest.fn(),
      getGateway: jest.fn(),
      updateGateway: jest.fn(),
      deleteGateway: jest.fn(),
      performHealthCheck: jest.fn(),
      activateGateway: jest.fn(),
      deactivateGateway: jest.fn(),
      getGatewayStats: jest.fn(),
      searchSkillsAcrossGateways: jest.fn(),
      getAllUserGateways: jest.fn(),
    };

    const mockGatewayAuthService = {
      createAuth: jest.fn(),
      updateAuth: jest.fn(),
      deleteAuth: jest.fn(),
      getAuthConfigs: jest.fn(),
      createGatewayAuth: jest.fn(),
      getGatewayAuths: jest.fn(),
    };

    const mockGatewayToolService = {
      associateTools: jest.fn(),
      dissociateTools: jest.fn(),
      updateToolConfig: jest.fn(),
      getGatewayTools: jest.fn(),
      bulkAssociateTools: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GatewaysController],
      providers: [
        {
          provide: GatewaysService,
          useValue: mockGatewaysService,
        },
        {
          provide: GatewayAuthService,
          useValue: mockGatewayAuthService,
        },
        {
          provide: GatewayToolService,
          useValue: mockGatewayToolService,
        },
        {
          provide: SkillGeneratorService,
          useValue: { generateGatewaySkills: jest.fn(), generateIndividualSkills: jest.fn() },
        },
        {
          provide: CliGeneratorService,
          useValue: { generateGatewayCliBunde: jest.fn() },
        },
        {
          provide: CodegenService,
          useValue: { generateGatewaySdk: jest.fn() },
        },
        {
          provide: ToolExecutorService,
          useValue: { executeTool: jest.fn() },
        },
      ],
    })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .compile();

    controller = module.get<GatewaysController>(GatewaysController);
    gatewaysService = module.get(GatewaysService);
    gatewayAuthService = module.get(GatewayAuthService);
    gatewayToolService = module.get(GatewayToolService);
    skillGeneratorService = module.get(SkillGeneratorService);
    toolExecutorService = module.get(ToolExecutorService);
  });

  describe('getGateways', () => {
    it('should return paginated gateways', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };
      const mockResult = {
        gateways: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      };

      gatewaysService.getGateways.mockResolvedValue(mockResult);

      const result = await controller.getGateways({ page: 1, limit: 10 }, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockResult);
    });
  });

  describe('getGateway', () => {
    it('should return gateway by id', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };
      const mockGateway = {
        id: 'gateway-1',
        name: 'Test Gateway',
        organizationId: 'org-1',
        type: 'mcp' as any,
        status: 'active' as any,
        endpoint: '/test',
      } as any;

      gatewaysService.getGateway.mockResolvedValue(mockGateway);

      const result = await controller.getGateway('gateway-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockGateway);
    });
  });

  describe('createGateway', () => {
    it('should create gateway successfully', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };
      const createDto = {
        name: 'New Gateway',
        type: 'mcp' as any,
        endpoint: '/new',
        configuration: {},
      };

      const mockGateway = {
        id: 'gateway-1',
        ...createDto,
        organizationId: 'org-1',
        status: 'draft' as any,
      } as any;

      const mockApiKey = { id: 'key-1', key: 'gw_test_key' } as any;

      gatewaysService.createGateway.mockResolvedValue(mockGateway);
      (gatewayAuthService as any).generateApiKey = jest.fn().mockResolvedValue(mockApiKey);

      const result = await controller.createGateway(createDto, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(expect.objectContaining({
        id: 'gateway-1',
        name: 'New Gateway',
        organizationId: 'org-1',
        initialApiKey: 'gw_test_key',
      }));
    });
  });

  describe('updateGateway', () => {
    it('should update gateway successfully', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };
      const updateDto = { description: 'Updated' };
      const mockGateway = {
        id: 'gateway-1',
        name: 'Gateway',
        description: 'Updated',
        organizationId: 'org-1',
      } as any;

      gatewaysService.updateGateway.mockResolvedValue(mockGateway);

      const result = await controller.updateGateway('gateway-1', updateDto, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockGateway);
    });
  });

  describe('deleteGateway', () => {
    it('should delete gateway successfully', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };

      gatewaysService.deleteGateway.mockResolvedValue();

      const result = await controller.deleteGateway('gateway-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Gateway deleted successfully');
    });
  });

  describe('performHealthCheck', () => {
    it('should perform health check', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };
      const mockResult = { isHealthy: true, responseTime: 200 };

      gatewaysService.performHealthCheck.mockResolvedValue(mockResult);

      const result = await controller.performHealthCheck('gateway-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockResult);
    });
  });

  describe('activateGateway', () => {
    it('should activate gateway successfully', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };
      const mockGateway = { id: 'gateway-1', status: 'active' } as any;

      gatewaysService.activateGateway.mockResolvedValue(mockGateway);

      const result = await controller.activateGateway('gateway-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockGateway);
    });
  });

  describe('deactivateGateway', () => {
    it('should deactivate gateway successfully', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };
      const mockGateway = { id: 'gateway-1', status: 'inactive' } as any;

      gatewaysService.deactivateGateway.mockResolvedValue(mockGateway);

      const result = await controller.deactivateGateway('gateway-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockGateway);
    });
  });

  describe('getGatewayStats', () => {
    it('should return gateway statistics', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };
      const mockStats = {
        totalRequests: 1000,
        successfulRequests: 950,
        failedRequests: 50,
        averageResponseTime: 150,
        successRate: 0.95,
        activeTools: 5,
        uniqueUsers: 25,
        requestTrend: [
          { date: '2025-01-01', requests: 500, success: 475, failed: 25 },
          { date: '2025-01-02', requests: 500, success: 475, failed: 25 },
        ],
      };

      gatewaysService.getGatewayStats.mockResolvedValue(mockStats);

      const result = await controller.getGatewayStats('gateway-1', 'day', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockStats);
      expect(gatewaysService.getGatewayStats).toHaveBeenCalledWith('gateway-1', 'org-1', 'day');
    });
  });

  describe('associateTool', () => {
    it('should associate tool with gateway', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };
      const associateDto = { toolId: 'tool-1', configuration: {} };
      const mockResult = { id: 'gateway-tool-1', gatewayId: 'gateway-1', toolId: 'tool-1' };

      (gatewayToolService as any).associateTool = jest.fn().mockResolvedValue(mockResult);

      const result = await controller.associateTool('gateway-1', associateDto as any, mockRequest);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Tool associated with gateway successfully');
      expect((gatewayToolService as any).associateTool).toHaveBeenCalled();
    });
  });

  describe('getGatewayTools', () => {
    it('should return tools associated with gateway', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };
      const query = { page: 1, limit: 10 };
      const mockTools = [
        { id: 'tool-1', name: 'Tool 1' },
        { id: 'tool-2', name: 'Tool 2' },
      ];

      gatewayToolService.getGatewayTools.mockResolvedValue(mockTools as any);

      const result = await controller.getGatewayTools('gateway-1', query, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockTools);
      expect(gatewayToolService.getGatewayTools).toHaveBeenCalledWith({
        gatewayId: 'gateway-1',
        organizationId: 'org-1',
        page: 1,
        limit: 10,
      });
    });
  });

  describe('createGatewayAuth', () => {
    it('should create auth configuration for gateway', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };
      const authDto = {
        type: 'bearer' as any,
        config: { token: 'test-token' },
      };
      const mockAuthConfig = {
        id: 'auth-1',
        gatewayId: 'gateway-1',
        ...authDto,
      };

      gatewayAuthService.createGatewayAuth.mockResolvedValue(mockAuthConfig as any);

      const result = await controller.createGatewayAuth('gateway-1', authDto as any, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockAuthConfig);
    });
  });

  describe('getGatewayAuths', () => {
    it('should return gateway auth configurations', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };
      const mockAuthConfigs = [
        { id: 'auth-1', type: 'bearer', config: {} },
        { id: 'auth-2', type: 'oauth2', config: {} },
      ];

      gatewayAuthService.getGatewayAuths.mockResolvedValue(mockAuthConfigs as any);

      const result = await controller.getGatewayAuths('gateway-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockAuthConfigs);
    });
  });

  describe('bulkAssociateTools', () => {
    it('should bulk associate tools with gateway', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };
      const bulkDto = {
        toolIds: ['tool-1', 'tool-2', 'tool-3'],
        configuration: { timeout: 5000 },
      };
      const mockResult = {
        associated: ['tool-1', 'tool-2', 'tool-3'],
        skipped: [],
      };

      gatewayToolService.bulkAssociateTools.mockResolvedValue(mockResult as any);

      const result = await controller.bulkAssociateTools('gateway-1', bulkDto as any, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockResult);
      expect(result.message).toBe('3 tools associated, 0 skipped');
      expect(gatewayToolService.bulkAssociateTools).toHaveBeenCalledWith(
        'gateway-1',
        bulkDto,
        'org-1',
        'user-1'
      );
    });
  });

  describe('getAvailableTools', () => {
    it('should return available tools for gateway', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };
      const mockTools = {
        tools: [
          { id: 'tool-1', name: 'Available Tool 1', status: 'active' },
          { id: 'tool-2', name: 'Available Tool 2', status: 'active' },
        ],
        total: 2,
      };

      (gatewayToolService as any).getAvailableTools = jest.fn().mockResolvedValue(mockTools);

      const result = await controller.getAvailableTools('gateway-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockTools);
    });
  });

  describe('getGatewayToolStats', () => {
    it('should return gateway tool statistics', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };
      const mockStats = {
        totalTools: 10,
        activeTools: 8,
        inactiveTools: 2,
        totalExecutions: 1000,
        successfulExecutions: 950,
        failedExecutions: 50,
        averageExecutionTime: 120,
        topTools: [
          { toolId: 'tool-1', name: 'Tool 1', executions: 500 },
          { toolId: 'tool-2', name: 'Tool 2', executions: 300 },
        ],
      };

      (gatewayToolService as any).getGatewayToolStats = jest.fn().mockResolvedValue(mockStats);

      const result = await controller.getGatewayToolStats('gateway-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockStats);
    });
  });

  describe('getOrganizationStats', () => {
    it('should return organization gateway statistics', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };
      const mockStats = {
        totalGateways: 5,
        activeGateways: 4,
        inactiveGateways: 1,
        totalRequests: 10000,
        successfulRequests: 9500,
        failedRequests: 500,
        averageResponseTime: 150,
        totalTools: 50,
        uniqueUsers: 100,
        requestsByGateway: [
          { gatewayId: 'gateway-1', name: 'Gateway 1', requests: 5000 },
          { gatewayId: 'gateway-2', name: 'Gateway 2', requests: 3000 },
        ],
      };

      (gatewaysService as any).getOrganizationGatewayStats = jest.fn().mockResolvedValue(mockStats);

      const result = await controller.getOrganizationStats(mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockStats);
    });
  });

  describe('searchSkills', () => {
    it('should search skills across all gateways', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };
      const mockResults = [
        { toolId: 'tool-1', toolName: 'List Users', toolDescription: 'Lists users', gatewayId: 'gw-1', gatewayName: 'User API', orgSlug: 'test-org', gatewaySlug: 'user-api', skillRef: 'test-org/user-api/list-users' },
        { toolId: 'tool-2', toolName: 'Get User', toolDescription: 'Gets a user', gatewayId: 'gw-1', gatewayName: 'User API', orgSlug: 'test-org', gatewaySlug: 'user-api', skillRef: 'test-org/user-api/get-user' },
      ];

      gatewaysService.searchSkillsAcrossGateways.mockResolvedValue(mockResults);

      const result = await controller.searchSkills('user', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockResults);
      expect(result.message).toBe('Found 2 skill(s) matching "user"');
      expect(gatewaysService.searchSkillsAcrossGateways).toHaveBeenCalledWith('org-1', 'user');
    });

    it('should handle empty query', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };

      gatewaysService.searchSkillsAcrossGateways.mockResolvedValue([]);

      const result = await controller.searchSkills('', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
      expect(gatewaysService.searchSkillsAcrossGateways).toHaveBeenCalledWith('org-1', '');
    });

    it('should throw when no organization found', async () => {
      const mockRequest = { user: { organizations: [] } };

      await expect(controller.searchSkills('test', mockRequest)).rejects.toThrow();
    });
  });

  describe('getAllSkills', () => {
    it('should return skills from all user gateways', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };
      const mockGateways = [
        {
          id: 'gw-1',
          name: 'User API',
          endpoint: '/user-api',
          organization: { slug: 'test-org', name: 'Test Org' },
        },
        {
          id: 'gw-2',
          name: 'Payment API',
          endpoint: '/payment-api',
          organization: { slug: 'test-org', name: 'Test Org' },
        },
      ];
      const mockSkills1 = [{ name: 'list-users', content: '# list-users' }];
      const mockSkills2 = [{ name: 'create-payment', content: '# create-payment' }];

      gatewaysService.getAllUserGateways.mockResolvedValue(mockGateways as any);
      skillGeneratorService.generateIndividualSkills
        .mockResolvedValueOnce(mockSkills1 as any)
        .mockResolvedValueOnce(mockSkills2 as any);

      const result = await controller.getAllSkills(mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({
        gatewayId: 'gw-1',
        gatewayName: 'User API',
        orgSlug: 'test-org',
        gatewaySlug: 'user-api',
        skills: mockSkills1,
      });
      expect(result.data[1]).toEqual({
        gatewayId: 'gw-2',
        gatewayName: 'Payment API',
        orgSlug: 'test-org',
        gatewaySlug: 'payment-api',
        skills: mockSkills2,
      });
      expect(result.message).toBe('Retrieved skills from 2 gateway(s)');
      expect(gatewaysService.getAllUserGateways).toHaveBeenCalledWith('org-1');
      expect(skillGeneratorService.generateIndividualSkills).toHaveBeenCalledWith('gw-1', { orgSlug: 'test-org', gatewaySlug: 'user-api' });
      expect(skillGeneratorService.generateIndividualSkills).toHaveBeenCalledWith('gw-2', { orgSlug: 'test-org', gatewaySlug: 'payment-api' });
    });

    it('should handle gateways with no organization slug (fallback to name)', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };
      const mockGateways = [
        {
          id: 'gw-1',
          name: 'My Gateway',
          endpoint: '/my-gw',
          organization: { name: 'My Org Name' },
        },
      ];

      gatewaysService.getAllUserGateways.mockResolvedValue(mockGateways as any);
      skillGeneratorService.generateIndividualSkills.mockResolvedValue([]);

      const result = await controller.getAllSkills(mockRequest);

      expect(result.success).toBe(true);
      expect(result.data[0].orgSlug).toBe('my-org-name');
    });

    it('should return empty array when no gateways exist', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };

      gatewaysService.getAllUserGateways.mockResolvedValue([]);

      const result = await controller.getAllSkills(mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
      expect(result.message).toBe('Retrieved skills from 0 gateway(s)');
    });

    it('should throw when no organization found', async () => {
      const mockRequest = { user: { organizations: [] } };

      await expect(controller.getAllSkills(mockRequest)).rejects.toThrow();
    });
  });

  describe('executeSkill', () => {
    it('should execute a skill successfully', async () => {
      const mockRequest = { user: { id: 'user-1', sub: 'user-1', organizations: [{ id: 'org-1' }] } };
      const mockGateway = {
        id: 'gw-1',
        tools: [{ toolId: 'tool-1', isActive: true }],
      };
      const mockExecutionResult = {
        success: true,
        output: { data: 'result' },
        executionTime: 150,
      };

      gatewaysService.getGateway.mockResolvedValue(mockGateway as any);
      toolExecutorService.executeTool.mockResolvedValue(mockExecutionResult as any);

      const result = await controller.executeSkill(
        'gw-1',
        'tool-1',
        { parameters: { key: 'value' } },
        mockRequest,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockExecutionResult);
      expect(result.message).toBe('Skill executed successfully');
      expect(gatewaysService.getGateway).toHaveBeenCalledWith('gw-1', 'org-1', true);
      expect(toolExecutorService.executeTool).toHaveBeenCalledWith(
        'tool-1',
        { key: 'value' },
        { userId: 'user-1', organizationId: 'org-1' },
      );
    });

    it('should return failure message when execution fails', async () => {
      const mockRequest = { user: { id: 'user-1', sub: 'user-1', organizations: [{ id: 'org-1' }] } };
      const mockGateway = {
        id: 'gw-1',
        tools: [{ toolId: 'tool-1', isActive: true }],
      };
      const mockExecutionResult = {
        success: false,
        error: 'Execution timed out',
      };

      gatewaysService.getGateway.mockResolvedValue(mockGateway as any);
      toolExecutorService.executeTool.mockResolvedValue(mockExecutionResult as any);

      const result = await controller.executeSkill(
        'gw-1',
        'tool-1',
        { parameters: {} },
        mockRequest,
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('Skill execution failed');
    });

    it('should throw when tool is not found in gateway', async () => {
      const mockRequest = { user: { id: 'user-1', sub: 'user-1', organizations: [{ id: 'org-1' }] } };
      const mockGateway = {
        id: 'gw-1',
        tools: [{ toolId: 'tool-other', isActive: true }],
      };

      gatewaysService.getGateway.mockResolvedValue(mockGateway as any);

      await expect(
        controller.executeSkill('gw-1', 'tool-1', { parameters: {} }, mockRequest),
      ).rejects.toThrow();
    });

    it('should throw when tool is inactive in gateway', async () => {
      const mockRequest = { user: { id: 'user-1', sub: 'user-1', organizations: [{ id: 'org-1' }] } };
      const mockGateway = {
        id: 'gw-1',
        tools: [{ toolId: 'tool-1', isActive: false }],
      };

      gatewaysService.getGateway.mockResolvedValue(mockGateway as any);

      await expect(
        controller.executeSkill('gw-1', 'tool-1', { parameters: {} }, mockRequest),
      ).rejects.toThrow();
    });

    it('should throw when no organization found', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [] } };

      await expect(
        controller.executeSkill('gw-1', 'tool-1', { parameters: {} }, mockRequest),
      ).rejects.toThrow();
    });

    it('should default to empty parameters when body.parameters is undefined', async () => {
      const mockRequest = { user: { id: 'user-1', sub: 'user-1', organizations: [{ id: 'org-1' }] } };
      const mockGateway = {
        id: 'gw-1',
        tools: [{ toolId: 'tool-1', isActive: true }],
      };
      const mockExecutionResult = { success: true, output: {} };

      gatewaysService.getGateway.mockResolvedValue(mockGateway as any);
      toolExecutorService.executeTool.mockResolvedValue(mockExecutionResult as any);

      await controller.executeSkill(
        'gw-1',
        'tool-1',
        { parameters: undefined } as any,
        mockRequest,
      );

      expect(toolExecutorService.executeTool).toHaveBeenCalledWith(
        'tool-1',
        {},
        { userId: 'user-1', organizationId: 'org-1' },
      );
    });
  });

  // Error handling tests for all branches
  describe('createGateway - error handling', () => {
    it('should handle creation error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };
      const createDto = { name: 'Gateway', type: 'mcp' as any, endpoint: '', configuration: {} };

      gatewaysService.createGateway.mockRejectedValue(new Error('Creation failed'));

      await expect(controller.createGateway(createDto, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getGateways - error handling', () => {
    it('should handle retrieval error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };

      gatewaysService.getGateways.mockRejectedValue(new Error('Retrieval failed'));

      await expect(controller.getGateways({} as any, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getGateway - error handling', () => {
    it('should handle not found error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };

      gatewaysService.getGateway.mockRejectedValue(new Error('Not found'));

      await expect(controller.getGateway('gateway-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('updateGateway - error handling', () => {
    it('should handle update error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };

      gatewaysService.updateGateway.mockRejectedValue(new Error('Update failed'));

      await expect(controller.updateGateway('gateway-1', {} as any, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('deleteGateway - error handling', () => {
    it('should handle deletion error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };

      gatewaysService.deleteGateway.mockRejectedValue(new Error('Deletion failed'));

      await expect(controller.deleteGateway('gateway-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('activateGateway - error handling', () => {
    it('should handle activation error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };

      gatewaysService.activateGateway.mockRejectedValue(new Error('Activation failed'));

      await expect(controller.activateGateway('gateway-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('deactivateGateway - error handling', () => {
    it('should handle deactivation error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };

      gatewaysService.deactivateGateway.mockRejectedValue(new Error('Deactivation failed'));

      await expect(controller.deactivateGateway('gateway-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getGatewayStats - error handling', () => {
    it('should handle stats error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };

      gatewaysService.getGatewayStats.mockRejectedValue(new Error('Stats failed'));

      await expect(controller.getGatewayStats('gateway-1', 'day', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('performHealthCheck - error handling', () => {
    it('should handle health check error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };

      gatewaysService.performHealthCheck.mockRejectedValue(new Error('Health check failed'));

      await expect(controller.performHealthCheck('gateway-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('createGatewayAuth - error handling', () => {
    it('should handle auth creation error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };

      gatewayAuthService.createGatewayAuth.mockRejectedValue(new Error('Auth creation failed'));

      await expect(controller.createGatewayAuth('gateway-1', {} as any, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getGatewayAuths - error handling', () => {
    it('should handle auth retrieval error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };

      gatewayAuthService.getGatewayAuths.mockRejectedValue(new Error('Auth retrieval failed'));

      await expect(controller.getGatewayAuths('gateway-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('associateTool - error handling', () => {
    it('should handle association error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };
      (gatewayToolService as any).associateTool = jest.fn().mockRejectedValue(new Error('Association failed'));

      await expect(controller.associateTool('gateway-1', {} as any, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('bulkAssociateTools - error handling', () => {
    it('should handle bulk association error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };

      gatewayToolService.bulkAssociateTools.mockRejectedValue(new Error('Bulk association failed'));

      await expect(controller.bulkAssociateTools('gateway-1', {} as any, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getGatewayTools - error handling', () => {
    it('should handle tools retrieval error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };

      gatewayToolService.getGatewayTools.mockRejectedValue(new Error('Tools retrieval failed'));

      await expect(controller.getGatewayTools('gateway-1', {} as any, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getAvailableTools - error handling', () => {
    it('should handle available tools error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };
      (gatewayToolService as any).getAvailableTools = jest.fn().mockRejectedValue(new Error('Available tools failed'));

      await expect(controller.getAvailableTools('gateway-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getGatewayToolStats - error handling', () => {
    it('should handle stats error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };
      (gatewayToolService as any).getGatewayToolStats = jest.fn().mockRejectedValue(new Error('Stats failed'));

      await expect(controller.getGatewayToolStats('gateway-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getOrganizationStats - error handling', () => {
    it('should handle organization stats error', async () => {
      const mockRequest = { user: { id: 'user-1', organizations: [{ id: 'org-1' }] } };
      (gatewaysService as any).getOrganizationGatewayStats = jest.fn().mockRejectedValue(new Error('Org stats failed'));

      await expect(controller.getOrganizationStats(mockRequest))
        .rejects.toThrow();
    });
  });

  describe('searchSkills - error handling', () => {
    it('should handle search error', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };

      gatewaysService.searchSkillsAcrossGateways.mockRejectedValue(new Error('Search failed'));

      await expect(controller.searchSkills('test', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getAllSkills - error handling', () => {
    it('should handle retrieval error', async () => {
      const mockRequest = { user: { organizations: [{ id: 'org-1' }] } };

      gatewaysService.getAllUserGateways.mockRejectedValue(new Error('Retrieval failed'));

      await expect(controller.getAllSkills(mockRequest))
        .rejects.toThrow();
    });
  });

  describe('executeSkill - error handling', () => {
    it('should handle execution error', async () => {
      const mockRequest = { user: { id: 'user-1', sub: 'user-1', organizations: [{ id: 'org-1' }] } };
      const mockGateway = {
        id: 'gw-1',
        tools: [{ toolId: 'tool-1', isActive: true }],
      };

      gatewaysService.getGateway.mockResolvedValue(mockGateway as any);
      toolExecutorService.executeTool.mockRejectedValue(new Error('Execution failed'));

      await expect(
        controller.executeSkill('gw-1', 'tool-1', { parameters: {} }, mockRequest),
      ).rejects.toThrow();
    });
  });

});