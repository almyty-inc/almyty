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
        // Runs in the gateway's scope (ExecutionAccessService's gateway rule).
        { principal: expect.objectContaining({ kind: 'gateway', gatewayId: 'gw-1', visibility: 'org' }) },
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

    // ── session resumption ────────────────────────────────────────────
    //
    // Every SessionUpdate we hand out carries `sessionId: run.id`. These
    // cover the round trip: the value a client got from session/new must
    // resolve back to that run on session/prompt and session/stream.

    const SESSION_UUID = '11111111-2222-4333-8444-555555555555';
    const CONVERSATION_UUID = '99999999-8888-4777-8666-555555555555';

    const waitingRun: Partial<AgentRun> = {
      id: SESSION_UUID,
      agentId: 'agent-1',
      organizationId: 'org-1',
      status: AgentRunStatus.WAITING_INPUT,
      conversationId: CONVERSATION_UUID,
      isDone: () => false,
      updatedAt: new Date('2026-01-01'),
      totalCost: 0,
      executionTime: 10,
    };

    it('resumes a waiting run when session/prompt echoes back the sessionId we issued', async () => {
      // The repo only answers a lookup BY RUN ID — which is what the
      // sessionId in a SessionUpdate is. A conversationId lookup misses.
      runRepository.findOne.mockImplementation(async (opts: any) => {
        const where = opts?.where ?? {};
        return where.id === SESSION_UUID && where.organizationId === 'org-1'
          ? waitingRun
          : null;
      });

      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        {
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 10,
          params: {
            sessionId: SESSION_UUID,
            message: { parts: [{ type: 'text', text: 'more please' }] },
          },
        },
        mockRes,
      );

      expect(agentRuntimeService.sendInput).toHaveBeenCalledWith(
        SESSION_UUID,
        'org-1',
        'more please',
      );
      expect(agentRuntimeService.startRun).not.toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 10,
          result: expect.objectContaining({ sessionId: SESSION_UUID }),
        }),
      );
    });

    it('resumes a waiting run when session/stream echoes back the sessionId we issued', async () => {
      runRepository.findOne.mockImplementation(async (opts: any) => {
        const where = opts?.where ?? {};
        return where.id === SESSION_UUID && where.organizationId === 'org-1'
          ? waitingRun
          : null;
      });
      agentRuntimeService.getRunEmitter.mockReturnValue(null);

      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        {
          jsonrpc: '2.0',
          method: 'session/stream',
          id: 11,
          params: {
            sessionId: SESSION_UUID,
            message: { parts: [{ type: 'text', text: 'keep going' }] },
          },
        },
        mockRes,
      );

      expect(agentRuntimeService.sendInput).toHaveBeenCalledWith(
        SESSION_UUID,
        'org-1',
        'keep going',
      );
      expect(agentRuntimeService.startRun).not.toHaveBeenCalled();
    });

    it('still resolves a sessionId that is a conversation id', async () => {
      runRepository.findOne.mockImplementation(async (opts: any) => {
        const where = opts?.where ?? {};
        return where.conversationId === CONVERSATION_UUID ? waitingRun : null;
      });

      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        {
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 12,
          params: {
            sessionId: CONVERSATION_UUID,
            message: { parts: [{ type: 'text', text: 'hi' }] },
          },
        },
        mockRes,
      );

      expect(agentRuntimeService.sendInput).toHaveBeenCalledWith(
        SESSION_UUID,
        'org-1',
        'hi',
      );
      expect(agentRuntimeService.startRun).not.toHaveBeenCalled();
    });

    it('never sends a non-uuid sessionId to a uuid column', async () => {
      // agent_runs.id and .conversationId are both uuid; a garbage
      // sessionId must start a new run, not raise a Postgres cast error.
      runRepository.findOne.mockResolvedValue(mockRun);
      agentRuntimeService.startRun.mockResolvedValue(mockRun);

      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        {
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 13,
          params: {
            sessionId: 'not-a-uuid',
            message: { parts: [{ type: 'text', text: 'hi' }] },
          },
        },
        mockRes,
      );

      for (const call of runRepository.findOne.mock.calls) {
        const where = call[0]?.where ?? {};
        expect(where.id).not.toBe('not-a-uuid');
        expect(where.conversationId).not.toBe('not-a-uuid');
      }
      expect(agentRuntimeService.startRun).toHaveBeenCalled();
    });

    it('bounds the conversation history it attaches and returns it oldest-first', async () => {
      const older = { role: 'user', content: 'first', createdAt: new Date('2026-01-01') };
      const newer = { role: 'assistant', content: 'second', createdAt: new Date('2026-01-02') };
      // The repo is asked for the most recent N, so it answers newest-first.
      messageRepository.find.mockResolvedValue([newer, older]);
      agentRuntimeService.startRun.mockResolvedValue(mockRun);
      runRepository.findOne.mockResolvedValue(mockRun);

      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        {
          jsonrpc: '2.0',
          method: 'session/new',
          id: 14,
          params: { message: { parts: [{ type: 'text', text: 'Hello' }] } },
        },
        mockRes,
      );

      expect(messageRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          order: { createdAt: 'DESC' },
          take: 200,
        }),
      );
      const result = mockRes.json.mock.calls[0][0].result;
      expect(result.metadata.history.map((h: any) => h.message.parts[0].text)).toEqual([
        'first',
        'second',
      ]);
    });

    it('reports SESSION_NOT_FOUND when the run vanishes while polling', async () => {
      const running = { ...mockRun, status: AgentRunStatus.RUNNING, isDone: () => false };
      agentRuntimeService.startRun.mockResolvedValue(running);
      // Skip the real 30s of sleeps; the loop body is what is under test.
      (service as any).sleep = jest.fn().mockResolvedValue(undefined);

      let calls = 0;
      runRepository.findOne.mockImplementation(async () => {
        calls++;
        return calls > 60 ? null : running;
      });

      await service.handleJsonRpc(
        mockGateway as Gateway,
        mockReq,
        {
          jsonrpc: '2.0',
          method: 'session/new',
          id: 15,
          params: { message: { parts: [{ type: 'text', text: 'Hello' }] } },
        },
        mockRes,
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: -32001, message: 'Session not found' }),
        }),
      );
    });
  });
});
