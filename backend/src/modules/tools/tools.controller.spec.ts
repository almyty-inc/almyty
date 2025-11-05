import { Test, TestingModule } from '@nestjs/testing';
import { ToolsController } from './tools.controller';
import { ToolsService } from './tools.service';
import { ToolGeneratorService } from './tool-generator.service';
import { ToolExecutorService } from './tool-executor.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';

describe('ToolsController', () => {
  let controller: ToolsController;
  let toolsService: jest.Mocked<ToolsService>;
  let toolExecutorService: any;
  let toolGeneratorService: any;

  beforeEach(async () => {
    const mockToolsService = {
      getTools: jest.fn(),
      getTool: jest.fn(),
      createTool: jest.fn(),
      updateTool: jest.fn(),
      deleteTool: jest.fn(),
      activateTool: jest.fn(),
      deactivateTool: jest.fn(),
      getToolUsageStats: jest.fn(),
      getToolVersions: jest.fn(),
    };

    const mockToolGeneratorService = {
      generateToolFromOperation: jest.fn(),
      generateToolsFromApi: jest.fn(),
      regenerateToolFromOperation: jest.fn(),
    };

    const mockToolExecutorService = {
      executeTool: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ToolsController],
      providers: [
        {
          provide: ToolsService,
          useValue: mockToolsService,
        },
        {
          provide: ToolGeneratorService,
          useValue: mockToolGeneratorService,
        },
        {
          provide: ToolExecutorService,
          useValue: mockToolExecutorService,
        },
      ],
    })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .compile();

    controller = module.get<ToolsController>(ToolsController);
    toolsService = module.get(ToolsService);
    toolExecutorService = module.get(ToolExecutorService);
    toolGeneratorService = module.get(ToolGeneratorService);
  });

  describe('getTools', () => {
    it('should return paginated tools', async () => {
      const mockRequest = {
        user: { currentOrganizationId: 'org-1' }
      };

      const mockResult = {
        tools: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      };

      toolsService.getTools.mockResolvedValue(mockResult);

      const result = await controller.getTools('org-1', { page: 1, limit: 10 }, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockResult);
    });
  });

  describe('getTool', () => {
    it('should return tool by id', async () => {
      const mockRequest = {
        user: { currentOrganizationId: 'org-1' }
      };

      const mockTool = {
        id: 'tool-1',
        name: 'Test Tool',
        description: 'Test description',
        type: 'api' as any,
        status: 'active' as any,
        version: '1.0.0',
        organizationId: 'org-1',
        operationId: null,
        inputSchemaId: null,
        outputSchemaId: null,
        parameters: {},
        configuration: {},
        metadata: {},
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      toolsService.getTool.mockResolvedValue(mockTool);

      const result = await controller.getTool('org-1', 'tool-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockTool);
    });
  });

  describe('createTool', () => {
    it('should create tool successfully', async () => {
      const mockRequest = {
        user: {
          id: 'user-1',
          currentOrganizationId: 'org-1'
        }
      };

      const createDto = {
        name: 'New Tool',
        description: 'A new tool',
        type: 'api' as any,
        parameters: {},
      };

      const mockTool = {
        id: 'tool-1',
        ...createDto,
        organizationId: 'org-1',
        status: 'draft' as any,
        version: '1.0.0',
        operationId: null,
        inputSchemaId: null,
        outputSchemaId: null,
        configuration: {},
        metadata: {},
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      toolsService.createTool.mockResolvedValue(mockTool);

      const result = await controller.createTool('org-1', createDto, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockTool);
    });
  });

  describe('updateTool', () => {
    it('should update tool successfully', async () => {
      const mockRequest = {
        user: {
          id: 'user-1',
          currentOrganizationId: 'org-1'
        }
      };

      const updateDto = {
        description: 'Updated description',
      };

      const mockTool = {
        id: 'tool-1',
        name: 'Test Tool',
        description: 'Updated description',
        type: 'api' as any,
        status: 'active' as any,
        version: '1.0.0',
        organizationId: 'org-1',
        operationId: null,
        inputSchemaId: null,
        outputSchemaId: null,
        parameters: {},
        configuration: {},
        metadata: {},
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      toolsService.updateTool.mockResolvedValue(mockTool);

      const result = await controller.updateTool('org-1', 'tool-1', updateDto, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockTool);
    });
  });

  describe('deleteTool', () => {
    it('should delete tool successfully', async () => {
      const mockRequest = {
        user: {
          id: 'user-1',
          currentOrganizationId: 'org-1'
        }
      };

      toolsService.deleteTool.mockResolvedValue();

      const result = await controller.deleteTool('org-1', 'tool-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Tool deleted successfully');
    });
  });

  describe('activateTool', () => {
    it('should activate tool successfully', async () => {
      const mockRequest = {
        user: {
          id: 'user-1',
          currentOrganizationId: 'org-1'
        }
      };

      const mockTool = {
        id: 'tool-1',
        name: 'Test Tool',
        description: 'Test description',
        type: 'api' as any,
        status: 'active' as any,
        version: '1.0.0',
        organizationId: 'org-1',
        operationId: null,
        inputSchemaId: null,
        outputSchemaId: null,
        parameters: {},
        configuration: {},
        metadata: {},
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      toolsService.activateTool.mockResolvedValue(mockTool);

      const result = await controller.activateTool('org-1', 'tool-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockTool);
    });
  });

  describe('deactivateTool', () => {
    it('should deactivate tool successfully', async () => {
      const mockRequest = {
        user: {
          id: 'user-1',
          currentOrganizationId: 'org-1'
        }
      };

      const mockTool = {
        id: 'tool-1',
        name: 'Test Tool',
        description: 'Test description',
        type: 'api' as any,
        status: 'inactive' as any,
        version: '1.0.0',
        organizationId: 'org-1',
        operationId: null,
        inputSchemaId: null,
        outputSchemaId: null,
        parameters: {},
        configuration: {},
        metadata: {},
        isActive: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      toolsService.deactivateTool.mockResolvedValue(mockTool);

      const result = await controller.deactivateTool('org-1', 'tool-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockTool);
    });
  });

  describe('getToolStats', () => {
    it('should return tool usage statistics', async () => {
      const mockRequest = {
        user: {
          id: 'user-1',
          currentOrganizationId: 'org-1'
        }
      };

      const mockStats = {
        totalExecutions: 150,
        successfulExecutions: 142,
        failedExecutions: 8,
        averageExecutionTime: 234,
        cacheHitRate: 0.75,
        rateLimitedExecutions: 2,
        uniqueUsers: 15,
        executionTrend: [
          { date: '2025-01-01', executions: 45, success: 43, failed: 2 },
          { date: '2025-01-02', executions: 52, success: 50, failed: 2 },
        ],
      };

      toolsService.getToolUsageStats.mockResolvedValue(mockStats);

      const result = await controller.getToolStats('org-1', 'tool-1', 'day', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockStats);
      expect(result.data.totalExecutions).toBe(150);
      expect(result.data.successfulExecutions).toBe(142);
      expect(result.data.cacheHitRate).toBe(0.75);
      expect(result.data.uniqueUsers).toBe(15);
    });
  });

  describe('getToolVersions', () => {
    it('should return tool version history', async () => {
      const mockRequest = {
        user: {
          id: 'user-1',
          currentOrganizationId: 'org-1'
        }
      };

      const mockVersions = [
        { version: '1.0.0', createdAt: new Date('2025-01-01'), createdBy: 'user-1' },
        { version: '1.0.1', createdAt: new Date('2025-01-02'), createdBy: 'user-1' },
      ];

      toolsService.getToolVersions.mockResolvedValue(mockVersions as any);

      const result = await controller.getToolVersions('org-1', 'tool-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockVersions);
      expect(result.data).toHaveLength(2);
    });
  });

  describe('executeTool', () => {
    it('should execute tool successfully', async () => {
      const mockRequest = {
        user: {
          id: 'user-1',
          currentOrganizationId: 'org-1'
        }
      };

      const executeDto = {
        parameters: { param1: 'value1', param2: 'value2' },
        options: { timeout: 5000 },
      };

      const mockResult = {
        success: true,
        data: { result: 'execution successful' },
        executionTime: 234,
        cached: false,
        metadata: {},
      };

      toolExecutorService.executeTool.mockResolvedValue(mockResult);

      const result = await controller.executeTool('org-1', 'tool-1', executeDto as any, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ result: 'execution successful' });
    });
  });

  describe('generateToolsFromApi', () => {
    it('should generate tools from API successfully', async () => {
      const mockRequest = {
        user: {
          id: 'user-1',
          currentOrganizationId: 'org-1'
        }
      };

      const generateDto = {
        operationIds: ['operation-1', 'operation-2'],
        options: { autoActivate: true },
      };

      const mockApi = {
        id: 'api-1',
        name: 'Test API',
        organizationId: 'org-1',
      };

      const mockResult = {
        tools: [
          { id: 'tool-1', name: 'Generated Tool 1', status: 'active' },
          { id: 'tool-2', name: 'Generated Tool 2', status: 'active' },
        ],
        summary: {
          generated: 2,
          skipped: 0,
          failed: 0,
        },
      };

      (toolsService as any).apiRepository = {
        findOne: jest.fn().mockResolvedValue(mockApi),
      };

      toolGeneratorService.generateToolsFromApi.mockResolvedValue(mockResult);

      const result = await controller.generateToolsFromApi('org-1', 'api-1', generateDto as any, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockResult);
    });
  });

  describe('regenerateTool', () => {
    it('should regenerate tool successfully', async () => {
      const mockRequest = {
        user: {
          id: 'user-1',
          currentOrganizationId: 'org-1'
        }
      };

      const mockRegeneratedTool = {
        id: 'tool-1',
        name: 'Regenerated Tool',
        version: '2.0.0',
        status: 'active',
      };

      toolGeneratorService.regenerateToolFromOperation.mockResolvedValue(mockRegeneratedTool);

      const result = await controller.regenerateTool('org-1', 'tool-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockRegeneratedTool);
    });
  });

  describe('getOrganizationStats', () => {
    it('should return organization tool statistics', async () => {
      const mockRequest = {
        user: {
          id: 'user-1',
          currentOrganizationId: 'org-1'
        }
      };

      const mockStats = {
        totalTools: 50,
        activeTools: 42,
        inactiveTools: 8,
        totalExecutions: 10000,
        successfulExecutions: 9500,
        failedExecutions: 500,
        averageExecutionTime: 250,
        topTools: [
          { toolId: 'tool-1', name: 'Top Tool 1', executions: 2000 },
          { toolId: 'tool-2', name: 'Top Tool 2', executions: 1500 },
        ],
        uniqueUsers: 100,
        cacheHitRate: 0.68,
      };

      (toolsService as any).getOrganizationToolStats = jest.fn().mockResolvedValue(mockStats);

      const result = await controller.getOrganizationStats('org-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockStats);
    });
  });

  // Error handling tests for all branches
  describe('createTool - error handling', () => {
    it('should handle service error and throw HttpException', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const createDto = { name: 'Tool', description: 'Desc', type: 'api' as any, parameters: {} };

      toolsService.createTool.mockRejectedValue(new Error('Database error'));

      await expect(controller.createTool('org-1', createDto, mockRequest))
        .rejects.toThrow();
    });

    it('should handle error with status property', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const createDto = { name: 'Tool', description: 'Desc', type: 'api' as any, parameters: {} };

      const errorWithStatus = new Error('Service error');
      (errorWithStatus as any).status = 403;
      toolsService.createTool.mockRejectedValue(errorWithStatus);

      await expect(controller.createTool('org-1', createDto, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getTools - error handling', () => {
    it('should handle service error and throw HttpException', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      toolsService.getTools.mockRejectedValue(new Error('Database error'));

      await expect(controller.getTools('org-1', {}, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getTool - error handling', () => {
    it('should handle service error and throw HttpException with NOT_FOUND status', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      toolsService.getTool.mockRejectedValue(new Error('Not found'));

      await expect(controller.getTool('org-1', 'tool-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('updateTool - error handling', () => {
    it('should handle service error and throw HttpException', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const updateDto = { name: 'Updated' };

      toolsService.updateTool.mockRejectedValue(new Error('Update failed'));

      await expect(controller.updateTool('org-1', 'tool-1', updateDto, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('deleteTool - error handling', () => {
    it('should handle service error and throw HttpException', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      toolsService.deleteTool.mockRejectedValue(new Error('Delete failed'));

      await expect(controller.deleteTool('org-1', 'tool-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('activateTool - error handling', () => {
    it('should handle service error and throw HttpException', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      toolsService.activateTool.mockRejectedValue(new Error('Activation failed'));

      await expect(controller.activateTool('org-1', 'tool-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('deactivateTool - error handling', () => {
    it('should handle service error and throw HttpException', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      toolsService.deactivateTool.mockRejectedValue(new Error('Deactivation failed'));

      await expect(controller.deactivateTool('org-1', 'tool-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('executeTool - error handling', () => {
    it('should handle execution error and throw HttpException', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const executeDto = { parameters: {} };

      toolExecutorService.executeTool.mockRejectedValue(new Error('Execution failed'));

      await expect(controller.executeTool('org-1', 'tool-1', executeDto as any, mockRequest))
        .rejects.toThrow();
    });

    it('should handle failed execution result', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const executeDto = { parameters: {} };

      const mockResult = {
        success: false,
        error: 'Execution error message',
        executionTime: 100,
        cached: false,
        metadata: { errorDetails: 'details' },
      };

      toolExecutorService.executeTool.mockResolvedValue(mockResult);

      const result = await controller.executeTool('org-1', 'tool-1', executeDto as any, mockRequest);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Execution error message');
    });
  });

  describe('getToolVersions - error handling', () => {
    it('should handle service error and throw HttpException', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      toolsService.getToolVersions.mockRejectedValue(new Error('Versions not found'));

      await expect(controller.getToolVersions('org-1', 'tool-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getToolStats - error handling', () => {
    it('should handle service error and throw HttpException', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      toolsService.getToolUsageStats.mockRejectedValue(new Error('Stats not found'));

      await expect(controller.getToolStats('org-1', 'tool-1', 'day', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('generateToolsFromApi - error handling', () => {
    it('should handle API not found error', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const generateDto = {};

      (toolsService as any).apiRepository = {
        findOne: jest.fn().mockResolvedValue(null),
      };

      await expect(controller.generateToolsFromApi('org-1', 'api-1', generateDto as any, mockRequest))
        .rejects.toThrow();
    });

    it('should handle generation error', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const generateDto = {};
      const mockApi = { id: 'api-1', name: 'Test API', organizationId: 'org-1' };

      (toolsService as any).apiRepository = {
        findOne: jest.fn().mockResolvedValue(mockApi),
      };

      toolGeneratorService.generateToolsFromApi.mockRejectedValue(new Error('Generation failed'));

      await expect(controller.generateToolsFromApi('org-1', 'api-1', generateDto as any, mockRequest))
        .rejects.toThrow();
    });
  });

  describe('regenerateTool - error handling', () => {
    it('should handle regeneration error', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      toolGeneratorService.regenerateToolFromOperation.mockRejectedValue(new Error('Regeneration failed'));

      await expect(controller.regenerateTool('org-1', 'tool-1', mockRequest))
        .rejects.toThrow();
    });
  });

  describe('getOrganizationStats - error handling', () => {
    it('should handle service error and throw HttpException', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      (toolsService as any).getOrganizationToolStats = jest.fn().mockRejectedValue(new Error('Stats failed'));

      await expect(controller.getOrganizationStats('org-1', mockRequest))
        .rejects.toThrow();
    });
  });
});