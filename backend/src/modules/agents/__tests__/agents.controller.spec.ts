import { Test, TestingModule } from '@nestjs/testing';
import { AgentsController } from '../agents.controller';
import { AgentsService } from '../agents.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentRuntimeService } from '../agent-runtime.service';
import { AgentSchedulerService } from '../agent-scheduler.service';
import { AgentAuditService } from '../agent-audit.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AgentStatus } from '../../../entities/agent.entity';

describe('AgentsController', () => {
  let controller: AgentsController;
  let agentsService: jest.Mocked<AgentsService>;
  let executionEngine: jest.Mocked<AgentExecutionEngine>;

  const mockRequest = {
    user: {
      sub: 'user-1',
      id: 'user-1',
      currentOrganizationId: 'org-1',
      organizations: [{ id: 'org-1' }],
    },
  };

  beforeEach(async () => {
    const mockAgentsService = {
      createAgent: jest.fn(),
      getAgents: jest.fn(),
      getAgent: jest.fn(),
      updateAgent: jest.fn(),
      deleteAgent: jest.fn(),
      activateAgent: jest.fn(),
      deactivateAgent: jest.fn(),
      getAgentExecutions: jest.fn(),
      getTemplates: jest.fn(),
      importAgent: jest.fn(),
      exportAgent: jest.fn(),
      estimateCost: jest.fn(),
      saveVersion: jest.fn(),
      getVersionHistory: jest.fn(),
      rollbackToVersion: jest.fn(),
    };

    const mockExecutionEngine = {
      execute: jest.fn(),
    };

    const mockSchedulerService = {
      scheduleAgent: jest.fn(),
      unscheduleAgent: jest.fn(),
      restoreSchedules: jest.fn(),
      getScheduledAgentIds: jest.fn().mockReturnValue([]),
    };

    const mockAuditService = {
      log: jest.fn(),
      getAuditLog: jest.fn().mockResolvedValue([]),
    };

    const mockRuntimeService = {
      startRun: jest.fn(),
      listRuns: jest.fn(),
      getRun: jest.fn(),
      cancelRun: jest.fn(),
      sendInput: jest.fn(),
      getRunEmitter: jest.fn().mockReturnValue(null),
      processStep: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [
        {
          provide: AgentsService,
          useValue: mockAgentsService,
        },
        {
          provide: AgentExecutionEngine,
          useValue: mockExecutionEngine,
        },
        {
          provide: AgentRuntimeService,
          useValue: mockRuntimeService,
        },
        {
          provide: AgentSchedulerService,
          useValue: mockSchedulerService,
        },
        {
          provide: AgentAuditService,
          useValue: mockAuditService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = module.get<AgentsController>(AgentsController);
    agentsService = module.get(AgentsService);
    executionEngine = module.get(AgentExecutionEngine);
  });

  describe('createAgent', () => {
    it('should create agent successfully', async () => {
      const createDto = {
        name: 'Test Agent',
        description: 'A test agent',
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', position: { x: 0, y: 0 }, config: {}, data: {} },
            { id: 'output_1', type: 'output', position: { x: 300, y: 0 }, config: {}, data: {} },
          ],
          edges: [{ id: 'e1', source: 'input_1', target: 'output_1' }],
        },
      };

      const mockAgent = {
        id: 'agent-1',
        ...createDto,
        organizationId: 'org-1',
        status: AgentStatus.DRAFT,
      } as any;

      agentsService.createAgent.mockResolvedValue(mockAgent);

      const result = await controller.createAgent(createDto as any, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockAgent);
      expect(result.message).toBe('Agent created successfully');
      expect(agentsService.createAgent).toHaveBeenCalledWith(
        createDto,
        'org-1',
        'user-1',
      );
    });

    it('should throw when no organization found', async () => {
      const noOrgRequest = { user: { sub: 'user-1', organizations: [] } };
      const createDto = { name: 'Test', pipeline: { nodes: [], edges: [] } };

      await expect(
        controller.createAgent(createDto as any, noOrgRequest),
      ).rejects.toThrow();
    });

    it('should handle creation error', async () => {
      agentsService.createAgent.mockRejectedValue(new Error('Creation failed'));

      await expect(
        controller.createAgent({ name: 'Test', pipeline: { nodes: [], edges: [] } } as any, mockRequest),
      ).rejects.toThrow();
    });
  });

  describe('getAgents', () => {
    it('should return paginated agents', async () => {
      const mockResult = {
        data: [
          { id: 'agent-1', name: 'Agent 1' },
          { id: 'agent-2', name: 'Agent 2' },
        ],
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
      };

      agentsService.getAgents.mockResolvedValue(mockResult as any);

      const result = await controller.getAgents({} as any, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockResult.data);
      expect(result.pagination).toEqual({
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
    });

    it('should throw when no organization found', async () => {
      const noOrgRequest = { user: { organizations: [] } };
      await expect(controller.getAgents({} as any, noOrgRequest)).rejects.toThrow();
    });

    it('should handle retrieval error', async () => {
      agentsService.getAgents.mockRejectedValue(new Error('Retrieval failed'));
      await expect(controller.getAgents({} as any, mockRequest)).rejects.toThrow();
    });
  });

  describe('getAgent', () => {
    it('should return agent by id', async () => {
      const mockAgent = {
        id: 'agent-1',
        name: 'Test Agent',
        organizationId: 'org-1',
        status: AgentStatus.ACTIVE,
      } as any;

      agentsService.getAgent.mockResolvedValue(mockAgent);

      const result = await controller.getAgent('agent-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockAgent);
      expect(agentsService.getAgent).toHaveBeenCalledWith('agent-1', 'org-1');
    });

    it('should handle not found error', async () => {
      agentsService.getAgent.mockRejectedValue(new Error('Not found'));

      await expect(controller.getAgent('agent-1', mockRequest)).rejects.toThrow();
    });
  });

  describe('updateAgent', () => {
    it('should update agent successfully', async () => {
      const updateDto = { description: 'Updated description' };
      const mockAgent = {
        id: 'agent-1',
        name: 'Test Agent',
        description: 'Updated description',
        organizationId: 'org-1',
      } as any;

      agentsService.updateAgent.mockResolvedValue(mockAgent);

      const result = await controller.updateAgent('agent-1', updateDto as any, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockAgent);
      expect(result.message).toBe('Agent updated successfully');
      expect(agentsService.updateAgent).toHaveBeenCalledWith('agent-1', updateDto, 'org-1', 'user-1');
    });

    it('should handle update error', async () => {
      agentsService.updateAgent.mockRejectedValue(new Error('Update failed'));

      await expect(
        controller.updateAgent('agent-1', {} as any, mockRequest),
      ).rejects.toThrow();
    });
  });

  describe('deleteAgent', () => {
    it('should delete agent successfully', async () => {
      agentsService.deleteAgent.mockResolvedValue();

      const result = await controller.deleteAgent('agent-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Agent deleted successfully');
      expect(agentsService.deleteAgent).toHaveBeenCalledWith('agent-1', 'org-1', 'user-1');
    });

    it('should handle deletion error', async () => {
      agentsService.deleteAgent.mockRejectedValue(new Error('Deletion failed'));

      await expect(controller.deleteAgent('agent-1', mockRequest)).rejects.toThrow();
    });
  });

  describe('invokeAgent', () => {
    it('should invoke agent and return execution result', async () => {
      const invokeDto = { input: { message: 'Hello' } };
      const mockAgent = {
        id: 'agent-1',
        status: AgentStatus.ACTIVE,
        pipeline: { nodes: [], edges: [] },
      } as any;

      const mockExecution = {
        id: 'exec-1',
        status: 'completed',
        output: { result: 'Hello back!' },
      } as any;

      agentsService.getAgent.mockResolvedValue(mockAgent);
      executionEngine.execute.mockResolvedValue(mockExecution);

      const result = await controller.invokeAgent('agent-1', invokeDto as any, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockExecution);
      expect(result.message).toBe('Agent executed successfully');
      expect(executionEngine.execute).toHaveBeenCalledWith(
        mockAgent,
        'org-1',
        'user-1',
        {
          input: invokeDto.input,
          variables: undefined,
          metadata: undefined,
        },
      );
    });

    it('should return failure message when execution fails', async () => {
      const invokeDto = { input: { message: 'Hello' } };
      const mockAgent = {
        id: 'agent-1',
        status: AgentStatus.ACTIVE,
      } as any;

      const mockExecution = {
        id: 'exec-1',
        status: 'failed',
        error: 'LLM call failed',
      } as any;

      agentsService.getAgent.mockResolvedValue(mockAgent);
      executionEngine.execute.mockResolvedValue(mockExecution);

      const result = await controller.invokeAgent('agent-1', invokeDto as any, mockRequest);

      expect(result.success).toBe(false);
      expect(result.data).toBe(mockExecution);
    });

    it('should throw when agent is not active', async () => {
      const invokeDto = { input: { message: 'Hello' } };
      const mockAgent = {
        id: 'agent-1',
        status: AgentStatus.DRAFT,
      } as any;

      agentsService.getAgent.mockResolvedValue(mockAgent);

      await expect(
        controller.invokeAgent('agent-1', invokeDto as any, mockRequest),
      ).rejects.toThrow();
    });

    it('should throw when no organization found', async () => {
      const noOrgRequest = { user: { sub: 'user-1', organizations: [] } };
      const invokeDto = { input: {} };

      await expect(
        controller.invokeAgent('agent-1', invokeDto as any, noOrgRequest),
      ).rejects.toThrow();
    });
  });

  describe('activateAgent', () => {
    it('should activate agent successfully', async () => {
      const mockAgent = { id: 'agent-1', status: AgentStatus.ACTIVE } as any;
      agentsService.activateAgent.mockResolvedValue(mockAgent);

      const result = await controller.activateAgent('agent-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockAgent);
      expect(result.message).toBe('Agent activated successfully');
      expect(agentsService.activateAgent).toHaveBeenCalledWith('agent-1', 'org-1');
    });

    it('should handle activation error', async () => {
      agentsService.activateAgent.mockRejectedValue(new Error('Activation failed'));

      await expect(controller.activateAgent('agent-1', mockRequest)).rejects.toThrow();
    });
  });

  describe('deactivateAgent', () => {
    it('should deactivate agent successfully', async () => {
      const mockAgent = { id: 'agent-1', status: AgentStatus.INACTIVE } as any;
      agentsService.deactivateAgent.mockResolvedValue(mockAgent);

      const result = await controller.deactivateAgent('agent-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockAgent);
      expect(result.message).toBe('Agent deactivated successfully');
      expect(agentsService.deactivateAgent).toHaveBeenCalledWith('agent-1', 'org-1');
    });

    it('should handle deactivation error', async () => {
      agentsService.deactivateAgent.mockRejectedValue(new Error('Deactivation failed'));

      await expect(controller.deactivateAgent('agent-1', mockRequest)).rejects.toThrow();
    });
  });

  describe('getTemplates', () => {
    it('should return agent templates', () => {
      const mockTemplates = [
        { id: 'simple-chat', name: 'Simple Chat', description: 'Basic chat', category: 'basic' },
        { id: 'research', name: 'Research', description: 'Research agent', category: 'advanced' },
      ];

      agentsService.getTemplates.mockReturnValue(mockTemplates as any);

      const result = controller.getTemplates();

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockTemplates);
    });
  });

  describe('getAgentExecutions', () => {
    it('should return paginated executions', async () => {
      const mockResult = {
        data: [{ id: 'exec-1' }, { id: 'exec-2' }],
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
      };

      agentsService.getAgentExecutions.mockResolvedValue(mockResult as any);

      const result = await controller.getAgentExecutions('agent-1', undefined, undefined, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockResult.data);
      expect(result.pagination).toEqual({
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
    });

    it('should handle retrieval error', async () => {
      agentsService.getAgentExecutions.mockRejectedValue(new Error('Fetch failed'));

      await expect(
        controller.getAgentExecutions('agent-1', undefined, undefined, mockRequest),
      ).rejects.toThrow();
    });
  });

  describe('importAgent', () => {
    it('should import agent from JSON', async () => {
      const importData = {
        name: 'Imported Agent',
        pipeline: { nodes: [], edges: [] },
      };
      const mockAgent = { id: 'agent-1', name: 'Imported Agent (Imported)' } as any;

      agentsService.importAgent.mockResolvedValue(mockAgent);

      const result = await controller.importAgent(importData, mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockAgent);
      expect(result.message).toBe('Agent imported successfully');
    });

    it('should handle import error', async () => {
      agentsService.importAgent.mockRejectedValue(new Error('Import failed'));

      await expect(controller.importAgent({}, mockRequest)).rejects.toThrow();
    });
  });

  describe('exportAgent', () => {
    it('should export agent as JSON', async () => {
      const mockExport = {
        name: 'Test Agent',
        pipeline: { nodes: [], edges: [] },
        exportedAt: '2026-03-20T00:00:00Z',
      };

      agentsService.exportAgent.mockResolvedValue(mockExport);

      const result = await controller.exportAgent('agent-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockExport);
    });
  });

  describe('saveVersion', () => {
    it('should save version successfully', async () => {
      agentsService.saveVersion.mockResolvedValue();

      const result = await controller.saveVersion(
        'agent-1',
        { changelog: 'Added new node' },
        mockRequest,
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('Version saved successfully');
      expect(agentsService.saveVersion).toHaveBeenCalledWith('agent-1', 'org-1', 'Added new node', 'user-1');
    });
  });

  describe('getVersionHistory', () => {
    it('should return version history', async () => {
      const mockVersions = [
        { version: '1.0.0', savedAt: '2026-03-20T00:00:00Z', changelog: 'Initial' },
      ];

      agentsService.getVersionHistory.mockResolvedValue(mockVersions as any);

      const result = await controller.getVersionHistory('agent-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockVersions);
    });
  });

  describe('rollbackToVersion', () => {
    it('should rollback agent to a version', async () => {
      const mockAgent = { id: 'agent-1', version: '1.0.0' } as any;
      agentsService.rollbackToVersion.mockResolvedValue(mockAgent);

      const result = await controller.rollbackToVersion('agent-1', '0', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockAgent);
      expect(result.message).toBe('Agent rolled back successfully');
      expect(agentsService.rollbackToVersion).toHaveBeenCalledWith('agent-1', 'org-1', 0, 'user-1');
    });

    it('should throw for invalid version index', async () => {
      await expect(
        controller.rollbackToVersion('agent-1', 'not-a-number', mockRequest),
      ).rejects.toThrow();
    });
  });

  describe('getCostEstimate', () => {
    it('should return cost estimate', async () => {
      const mockEstimate = {
        estimatedLlmCalls: 2,
        estimatedToolCalls: 1,
        estimatedCostRange: { low: 1, high: 20 },
      };

      agentsService.estimateCost.mockResolvedValue(mockEstimate);

      const result = await controller.getCostEstimate('agent-1', mockRequest);

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockEstimate);
    });
  });

  // Error handling for no organization across all endpoints
  describe('no organization error handling', () => {
    const noOrgRequest = { user: { sub: 'user-1', organizations: [] } };

    it('getAgent throws without organization', async () => {
      await expect(controller.getAgent('agent-1', noOrgRequest)).rejects.toThrow();
    });

    it('updateAgent throws without organization', async () => {
      await expect(controller.updateAgent('agent-1', {} as any, noOrgRequest)).rejects.toThrow();
    });

    it('deleteAgent throws without organization', async () => {
      await expect(controller.deleteAgent('agent-1', noOrgRequest)).rejects.toThrow();
    });

    it('activateAgent throws without organization', async () => {
      await expect(controller.activateAgent('agent-1', noOrgRequest)).rejects.toThrow();
    });

    it('deactivateAgent throws without organization', async () => {
      await expect(controller.deactivateAgent('agent-1', noOrgRequest)).rejects.toThrow();
    });
  });
});
