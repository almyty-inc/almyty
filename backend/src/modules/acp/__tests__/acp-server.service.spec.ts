import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AcpServerService } from '../acp-server.service';
import { AcpDiscoveryService } from '../acp-discovery.service';
import { AgentRuntimeService } from '../../agents/agent-runtime.service';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { Conversation } from '../../../entities/conversation.entity';
import { Message } from '../../../entities/message.entity';
import { Gateway, GatewayType, GatewayKind } from '../../../entities/gateway.entity';

describe('AcpServerService', () => {
  let service: AcpServerService;
  let agentRuntimeService: any;
  let runRepository: any;
  let messageRepository: any;

  const mockGateway: Partial<Gateway> = {
    id: 'gw-1',
    agentId: 'agent-1',
    organizationId: 'org-1',
    type: GatewayType.ACP,
    kind: GatewayKind.AGENT,
    endpoint: '/test-acp',
    name: 'Test ACP Gateway',
  };

  const mockRun: Partial<AgentRun> = {
    id: 'run-1',
    agentId: 'agent-1',
    organizationId: 'org-1',
    status: AgentRunStatus.COMPLETED,
    output: 'Hello from agent',
    conversationId: 'conv-1',
    isDone: () => true,
    updatedAt: new Date('2026-01-01'),
    totalCost: 0,
    executionTime: 100,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AcpServerService,
        {
          provide: AcpDiscoveryService,
          useValue: {
            buildDiscoveryDocument: jest.fn(),
          },
        },
        {
          provide: AgentRuntimeService,
          useValue: {
            startRun: jest.fn(),
            sendInput: jest.fn(),
            cancelRun: jest.fn(),
            getRunEmitter: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(AgentRun),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Conversation),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Message),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<AcpServerService>(AcpServerService);
    agentRuntimeService = module.get(AgentRuntimeService);
    runRepository = module.get(getRepositoryToken(AgentRun));
    messageRepository = module.get(getRepositoryToken(Message));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('handleJsonRpc', () => {
    let mockRes: any;
    let mockReq: any;

    beforeEach(() => {
      mockRes = {
        json: jest.fn(),
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };
      mockReq = {
        method: 'POST',
        on: jest.fn(),
      };
    });

    it('should reject invalid JSON-RPC requests', async () => {
      await service.handleJsonRpc(mockGateway as Gateway, mockReq, {}, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          error: expect.objectContaining({
            code: -32600,
            message: expect.stringContaining('Invalid JSON-RPC request'),
          }),
        }),
      );
    });

    it('should reject requests without jsonrpc field', async () => {
      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        { method: 'initialize', id: 1 },
        mockRes,
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: -32600 }),
        }),
      );
    });

    it('should handle unknown methods', async () => {
      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        { jsonrpc: '2.0', method: 'unknown/method', id: 1, params: {} },
        mockRes,
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          error: expect.objectContaining({
            code: -32601,
            message: expect.stringContaining('Unknown method'),
          }),
        }),
      );
    });

    it('should handle initialize', async () => {
      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} },
        mockRes,
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          id: 1,
          result: expect.objectContaining({
            protocolVersion: '1.0.0',
            capabilities: expect.objectContaining({
              streaming: true,
              sessions: true,
            }),
            gatewayId: 'gw-1',
            agentId: 'agent-1',
          }),
        }),
      );
    });

    it('should handle session/new', async () => {
      agentRuntimeService.startRun.mockResolvedValue(mockRun);
      runRepository.findOne.mockResolvedValue(mockRun);

      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        {
          jsonrpc: '2.0',
          method: 'session/new',
          id: 2,
          params: {
            message: {
              parts: [{ type: 'text', text: 'Hello' }],
            },
          },
        },
        mockRes,
      );

      expect(agentRuntimeService.startRun).toHaveBeenCalledWith(
        'agent-1',
        'org-1',
        null,
        'Hello',
      );
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          id: 2,
          result: expect.objectContaining({
            sessionId: 'run-1',
            status: expect.objectContaining({
              status: 'completed',
            }),
          }),
        }),
      );
    });

    it('should reject session/new without message.parts', async () => {
      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        {
          jsonrpc: '2.0',
          method: 'session/new',
          id: 3,
          params: {},
        },
        mockRes,
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: -32602,
          }),
        }),
      );
    });

    it('should handle session/get', async () => {
      runRepository.findOne.mockResolvedValue(mockRun);

      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        {
          jsonrpc: '2.0',
          method: 'session/get',
          id: 4,
          params: { sessionId: 'run-1' },
        },
        mockRes,
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          id: 4,
          result: expect.objectContaining({
            sessionId: 'run-1',
          }),
        }),
      );
    });

    it('should return error for session/get with non-existent session', async () => {
      runRepository.findOne.mockResolvedValue(null);

      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        {
          jsonrpc: '2.0',
          method: 'session/get',
          id: 5,
          params: { sessionId: 'nonexistent' },
        },
        mockRes,
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: -32001,
            message: 'Session not found',
          }),
        }),
      );
    });

    it('should handle session/cancel', async () => {
      const cancelledRun = {
        ...mockRun,
        status: AgentRunStatus.CANCELLED,
        isDone: () => true,
      };
      agentRuntimeService.cancelRun.mockResolvedValue(cancelledRun);

      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        {
          jsonrpc: '2.0',
          method: 'session/cancel',
          id: 6,
          params: { sessionId: 'run-1' },
        },
        mockRes,
      );

      expect(agentRuntimeService.cancelRun).toHaveBeenCalledWith('run-1', 'org-1');
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          id: 6,
          result: expect.objectContaining({
            sessionId: 'run-1',
            status: expect.objectContaining({
              status: 'canceled',
            }),
          }),
        }),
      );
    });

    it('should handle session/prompt with new session', async () => {
      agentRuntimeService.startRun.mockResolvedValue(mockRun);
      runRepository.findOne.mockResolvedValue(mockRun);

      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        {
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 7,
          params: {
            message: {
              parts: [{ type: 'text', text: 'What is almyty?' }],
            },
          },
        },
        mockRes,
      );

      expect(agentRuntimeService.startRun).toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          id: 7,
          result: expect.objectContaining({
            sessionId: 'run-1',
          }),
        }),
      );
    });
  });
});
