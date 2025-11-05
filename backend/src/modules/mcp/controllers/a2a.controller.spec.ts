import { Test, TestingModule } from '@nestjs/testing';
import { A2AController } from './a2a.controller';
import { A2AService } from '../a2a.service';
import { HttpException, HttpStatus } from '@nestjs/common';
import { A2AAgentType } from '../types/a2a.types';

describe('A2AController - Real Business Logic', () => {
  let controller: A2AController;
  let a2aService: jest.Mocked<A2AService>;

  beforeEach(async () => {
    const mockA2AService = {
      discoverAgents: jest.fn(),
      getAgent: jest.fn(),
      listAgents: jest.fn(),
      registerAgent: jest.fn(),
      deregisterAgent: jest.fn(),
      updateAgent: jest.fn(),
      sendMessage: jest.fn(),
      getSession: jest.fn(),
      createSession: jest.fn(),
      endSession: jest.fn(),
      processMessage: jest.fn(),
      handleToolCall: jest.fn(),
      registerAgentTool: jest.fn(),
      orchestrateAgents: jest.fn(),
      createAgentCluster: jest.fn(),
      getAgentMetrics: jest.fn(),
      getA2AStats: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [A2AController],
      providers: [
        {
          provide: A2AService,
          useValue: mockA2AService,
        },
      ],
    }).compile();

    controller = module.get<A2AController>(A2AController);
    a2aService = module.get(A2AService);
  });

  const createMockRequest = (organizationId: string = 'org-1', userId: string = 'user-1') => ({
    user: {
      id: userId,
      currentOrganizationId: organizationId,
    },
  });

  describe('Discovery and Metadata', () => {
    describe('discovery', () => {
      it('should return A2A discovery information', async () => {
        const result = await controller.discovery();

        expect(result.protocol).toBe('a2a');
        expect(result.version).toBeDefined();
        expect(result.server).toBeDefined();
        expect(result.endpoints).toBeDefined();
        expect(result.capabilities).toBeDefined();
        expect(result.experimental).toBeDefined();
      });
    });

    describe('getCapabilities', () => {
      it('should return A2A capabilities', async () => {
        const result = await controller.getCapabilities();

        expect(result.protocol).toBe('a2a');
        expect(result.version).toBeDefined();
        expect(Array.isArray(result.supportedMessageTypes)).toBe(true);
        expect(Array.isArray(result.supportedAgentTypes)).toBe(true);
        expect(Array.isArray(result.features)).toBe(true);
      });
    });

    describe('health', () => {
      it('should return A2A health status', async () => {
        const result = await controller.health();

        expect(result.protocol).toBe('a2a');
        expect(result.status).toBeDefined();
        expect(result.uptime).toBeGreaterThanOrEqual(0);
        expect(result.features).toBeDefined();
        expect(result.server).toBe('apifai');
        expect(result.version).toBeDefined();
      });
    });
  });

  describe('Agent Management - Real CRUD operations', () => {
    describe('registerAgent', () => {
      it('should register agent successfully', async () => {
        const agentData = {
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'http://localhost:8000',
        };

        const mockAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'http://localhost:8000',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        a2aService.registerAgent.mockResolvedValue(mockAgent);

        const req = createMockRequest();
        const result = await controller.registerAgent(req, agentData);

        expect(result).toEqual(mockAgent);
        expect(a2aService.registerAgent).toHaveBeenCalledWith('org-1', agentData);
      });

      it('should throw when organization context is missing', async () => {
        const req = { user: {} };

        await expect(
          controller.registerAgent(req, {})
        ).rejects.toThrow(
          new HttpException('Organization context required', HttpStatus.BAD_REQUEST)
        );
      });
    });

    describe('listAgents', () => {
      it('should list agents for organization', async () => {
        const mockAgents = [
          {
            id: 'agent-1',
            name: 'Agent 1',
            type: A2AAgentType.CUSTOM_LLM,
            endpoint: 'http://localhost:8001',
            organizationId: 'org-1',
            isActive: true,
            lastSeen: new Date(),
            capabilities: {} as any,
            configuration: {} as any,
            metadata: {},
          },
        ];

        a2aService.listAgents.mockResolvedValue(mockAgents);

        const req = createMockRequest();
        const result = await controller.listAgents(req);

        expect(result).toEqual(mockAgents);
        expect(a2aService.listAgents).toHaveBeenCalledWith('org-1');
      });

      it('should throw when organization context is missing', async () => {
        const req = { user: {} };

        await expect(controller.listAgents(req)).rejects.toThrow(
          new HttpException('Organization context required', HttpStatus.BAD_REQUEST)
        );
      });
    });

    describe('getAgent', () => {
      it('should get agent by ID', async () => {
        const mockAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'http://localhost:8000',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        a2aService.getAgent.mockResolvedValue(mockAgent);

        const req = createMockRequest();
        const result = await controller.getAgent('agent-1', req);

        expect(result).toEqual(mockAgent);
        expect(a2aService.getAgent).toHaveBeenCalledWith('agent-1');
      });

      it('should throw when agent not found', async () => {
        a2aService.getAgent.mockResolvedValue(null);

        const req = createMockRequest();

        await expect(controller.getAgent('nonexistent', req)).rejects.toThrow(
          new HttpException('Agent not found', HttpStatus.NOT_FOUND)
        );
      });

      it('should throw when accessing agent from different organization', async () => {
        const mockAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'http://localhost:8000',
          organizationId: 'org-2',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        a2aService.getAgent.mockResolvedValue(mockAgent);

        const req = createMockRequest('org-1');

        await expect(controller.getAgent('agent-1', req)).rejects.toThrow(
          new HttpException('Access denied', HttpStatus.FORBIDDEN)
        );
      });
    });

    describe('updateAgent', () => {
      it('should update agent successfully', async () => {
        const updates = { isActive: false };

        const mockAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'http://localhost:8000',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        const mockUpdatedAgent = {
          ...mockAgent,
          isActive: false,
        };

        a2aService.getAgent.mockResolvedValue(mockAgent);
        a2aService.updateAgent.mockResolvedValue(mockUpdatedAgent);

        const req = createMockRequest();
        const result = await controller.updateAgent('agent-1', updates, req);

        expect(result).toEqual(mockUpdatedAgent);
        expect(a2aService.updateAgent).toHaveBeenCalledWith('agent-1', updates);
      });

      it('should throw when agent not found', async () => {
        a2aService.getAgent.mockResolvedValue(null);

        const req = createMockRequest();

        await expect(controller.updateAgent('nonexistent', {}, req)).rejects.toThrow(
          new HttpException('Agent not found', HttpStatus.NOT_FOUND)
        );
      });

      it('should throw when update fails', async () => {
        const mockAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'http://localhost:8000',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        a2aService.getAgent.mockResolvedValue(mockAgent);
        a2aService.updateAgent.mockResolvedValue(null);

        const req = createMockRequest();

        await expect(controller.updateAgent('agent-1', {}, req)).rejects.toThrow(
          new HttpException('Failed to update agent', HttpStatus.INTERNAL_SERVER_ERROR)
        );
      });
    });

    describe('deregisterAgent', () => {
      it('should deregister agent successfully', async () => {
        const mockAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'http://localhost:8000',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        a2aService.getAgent.mockResolvedValue(mockAgent);
        a2aService.deregisterAgent.mockResolvedValue(true);

        const req = createMockRequest();
        await controller.deregisterAgent('agent-1', req);

        expect(a2aService.deregisterAgent).toHaveBeenCalledWith('agent-1');
      });

      it('should throw when deregister fails', async () => {
        const mockAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'http://localhost:8000',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        a2aService.getAgent.mockResolvedValue(mockAgent);
        a2aService.deregisterAgent.mockResolvedValue(false);

        const req = createMockRequest();

        await expect(controller.deregisterAgent('agent-1', req)).rejects.toThrow(
          new HttpException('Failed to deregister agent', HttpStatus.INTERNAL_SERVER_ERROR)
        );
      });
    });
  });

  describe('Messaging - Real communication', () => {
    describe('sendMessage', () => {
      it('should send message successfully', async () => {
        const messageData = {
          fromAgentId: 'agent-1',
          toAgentId: 'agent-2',
          content: { text: 'Hello' },
        };

        a2aService.sendMessage.mockResolvedValue(undefined);

        const req = createMockRequest();
        await controller.sendMessage(req, messageData);

        expect(a2aService.sendMessage).toHaveBeenCalledWith(
          'agent-1',
          'agent-2',
          { text: 'Hello' },
          undefined,
          undefined
        );
      });

      it('should throw when organization context is missing', async () => {
        const req = { user: {} };

        await expect(controller.sendMessage(req, {
          toAgentId: 'agent-1',
          content: { text: 'Hello' },
        })).rejects.toThrow(
          new HttpException('Organization context required', HttpStatus.BAD_REQUEST)
        );
      });
    });

    describe('getAgentMessages', () => {
      it('should get agent messages', async () => {
        const mockAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'http://localhost:8000',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        a2aService.getAgent.mockResolvedValue(mockAgent);

        const req = createMockRequest();
        const result = await controller.getAgentMessages('agent-1', req);

        // Controller returns empty array as TODO
        expect(result).toEqual([]);
        expect(a2aService.getAgent).toHaveBeenCalledWith('agent-1');
      });
    });
  });

  describe('Session Management - Real orchestration', () => {
    describe('createSession', () => {
      it('should create session successfully', async () => {
        const sessionData = {
          participantAgentIds: ['agent-1', 'agent-2'],
        };

        const mockSession = {
          id: 'session-1',
          organizationId: 'org-1',
          participantAgents: ['agent-1', 'agent-2'],
          status: 'active' as any,
          startedAt: new Date(),
          lastActivity: new Date(),
          messageCount: 0,
          metadata: {},
        };

        a2aService.createSession.mockResolvedValue(mockSession);

        const req = createMockRequest();
        const result = await controller.createSession(req, sessionData);

        expect(result).toEqual(mockSession);
        expect(a2aService.createSession).toHaveBeenCalledWith('org-1', ['agent-1', 'agent-2'], undefined);
      });

      it('should throw when organization context is missing', async () => {
        const req = { user: {} };

        await expect(controller.createSession(req, {
          participantAgentIds: ['agent-1'],
        })).rejects.toThrow(
          new HttpException('Organization context required', HttpStatus.BAD_REQUEST)
        );
      });
    });

    describe('getSession', () => {
      it('should get session by ID', async () => {
        const mockSession = {
          id: 'session-1',
          organizationId: 'org-1',
          participantAgents: ['agent-1'],
          status: 'active' as any,
          startedAt: new Date(),
          lastActivity: new Date(),
          messageCount: 0,
          metadata: {},
        };

        a2aService.getSession.mockResolvedValue(mockSession);

        const req = createMockRequest();
        const result = await controller.getSession('session-1', req);

        expect(result).toEqual(mockSession);
        expect(a2aService.getSession).toHaveBeenCalledWith('session-1');
      });

      it('should throw when session not found', async () => {
        a2aService.getSession.mockResolvedValue(null);

        const req = createMockRequest();

        await expect(controller.getSession('nonexistent', req)).rejects.toThrow(
          new HttpException('Session not found', HttpStatus.NOT_FOUND)
        );
      });

      it('should throw when accessing session from different organization', async () => {
        const mockSession = {
          id: 'session-1',
          organizationId: 'org-2',
          participantAgents: ['agent-1'],
          status: 'active' as any,
          startedAt: new Date(),
          lastActivity: new Date(),
          messageCount: 0,
          metadata: {},
        };

        a2aService.getSession.mockResolvedValue(mockSession);

        const req = createMockRequest('org-1');

        await expect(controller.getSession('session-1', req)).rejects.toThrow(
          new HttpException('Access denied', HttpStatus.FORBIDDEN)
        );
      });
    });
  });

  describe('Advanced Features - Real orchestration', () => {
    describe('registerAgentTool', () => {
      it('should register tool for agent', async () => {
        const mockAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'http://localhost:8000',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        const toolData = {
          agentId: 'agent-1',
          toolName: 'search',
          inputSchema: { type: 'object', properties: {} },
          endpoint: 'http://localhost:8000/search',
          method: 'POST' as any,
          description: 'Search tool',
        };

        a2aService.getAgent.mockResolvedValue(mockAgent);
        a2aService.registerAgentTool.mockResolvedValue(undefined);

        const req = createMockRequest();
        await controller.registerAgentTool('agent-1', toolData, req);

        expect(a2aService.registerAgentTool).toHaveBeenCalledWith('agent-1', toolData);
      });
    });

    describe('createWorkflow', () => {
      it('should create workflow successfully', async () => {
        const workflowData = {
          name: 'Test Workflow',
          steps: [{ agentId: 'agent-1', action: 'process' }],
        };

        a2aService.orchestrateAgents.mockResolvedValue('workflow-1');

        const req = createMockRequest();
        const result = await controller.createWorkflow(req, workflowData);

        expect(result).toEqual({ workflowId: 'workflow-1' });
        expect(a2aService.orchestrateAgents).toHaveBeenCalledWith('org-1', workflowData);
      });

      it('should throw when organization context is missing', async () => {
        const req = { user: {} };

        await expect(controller.createWorkflow(req, {})).rejects.toThrow(
          new HttpException('Organization context required', HttpStatus.BAD_REQUEST)
        );
      });
    });

    describe('discoverAgents', () => {
      it('should discover agents', async () => {
        const mockAgents = [
          {
            id: 'agent-1',
            name: 'Agent 1',
            type: A2AAgentType.CUSTOM_LLM,
            endpoint: 'http://localhost:8001',
            organizationId: 'org-1',
            isActive: true,
            lastSeen: new Date(),
            capabilities: {} as any,
            configuration: {} as any,
            metadata: {},
          },
        ];

        a2aService.discoverAgents.mockResolvedValue(mockAgents);

        const req = createMockRequest();
        const result = await controller.discoverAgents(req);

        expect(result).toEqual(mockAgents);
        expect(a2aService.discoverAgents).toHaveBeenCalledWith('org-1');
      });

      it('should throw when organization context is missing', async () => {
        const req = { user: {} };

        await expect(controller.discoverAgents(req)).rejects.toThrow(
          new HttpException('Organization context required', HttpStatus.BAD_REQUEST)
        );
      });
    });

    describe('createAgentCluster', () => {
      it('should create agent cluster', async () => {
        const clusterData = {
          name: 'Processing Cluster',
          agentIds: ['agent-1', 'agent-2'],
        };

        a2aService.createAgentCluster.mockResolvedValue('cluster-1');

        const req = createMockRequest();
        const result = await controller.createAgentCluster(req, clusterData);

        expect(result).toEqual({ clusterId: 'cluster-1' });
        expect(a2aService.createAgentCluster).toHaveBeenCalledWith('org-1', clusterData);
      });

      it('should throw when organization context is missing', async () => {
        const req = { user: {} };

        await expect(controller.createAgentCluster(req, {})).rejects.toThrow(
          new HttpException('Organization context required', HttpStatus.BAD_REQUEST)
        );
      });
    });
  });

  describe('Monitoring and Stats - Real metrics', () => {
    describe('getAgentMetrics', () => {
      it('should get agent metrics', async () => {
        const mockAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'http://localhost:8000',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        const mockMetrics = {
          agentId: 'agent-1',
          totalMessages: 100,
          successfulMessages: 95,
          failedMessages: 5,
          averageResponseTime: 250,
          lastActivity: new Date(),
          capabilities: {
            functionsUsed: ['search'],
            toolsUsed: ['tool-1'],
            workflowsParticipated: ['workflow-1'],
          },
          performance: {
            uptime: 99.5,
            errorRate: 5,
            throughput: 10,
          },
        };

        a2aService.getAgent.mockResolvedValue(mockAgent);
        a2aService.getAgentMetrics.mockResolvedValue(mockMetrics);

        const req = createMockRequest();
        const result = await controller.getAgentMetrics('agent-1', req);

        expect(result).toEqual(mockMetrics);
        expect(a2aService.getAgentMetrics).toHaveBeenCalledWith('agent-1');
      });
    });

    describe('getA2AStats', () => {
      it('should get A2A stats for organization', async () => {
        const mockStats = {
          totalAgents: 5,
          activeAgents: 4,
          activeSessions: 2,
          totalMessages: 150,
          activeWorkflows: 1,
        };

        a2aService.getA2AStats.mockResolvedValue(mockStats);

        const req = createMockRequest();
        const result = await controller.getA2AStats(req);

        expect(result).toEqual(mockStats);
        expect(a2aService.getA2AStats).toHaveBeenCalledWith('org-1');
      });

      it('should throw when organization context is missing', async () => {
        const req = { user: {} };

        await expect(controller.getA2AStats(req)).rejects.toThrow(
          new HttpException('Organization context required', HttpStatus.BAD_REQUEST)
        );
      });
    });
  });
});