import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { EventEmitter } from 'events';
import { AgentRuntimeService } from '../../modules/agents/agent-runtime.service';
import { AgentRuntimeBuilders } from '../../modules/agents/agent-runtime-builders';
import { AgentCollaborationHelper } from '../../modules/agents/agent-collaboration.helper';
import { AgentBuiltInToolsHelper } from '../../modules/agents/agent-builtin-tools.helper';
import { ApprovalsService } from '../../modules/approvals/approvals.service';
import { AgentRuntimeEventsHelper } from '../../modules/agents/agent-runtime-events.helper';
import { AgentRuntimeMiscHelper } from '../../modules/agents/agent-runtime-misc.helper';
import { AgentStepProcessor } from '../../modules/agents/agent-step-processor';
import { AgentHeartbeatHelper } from '../../modules/agents/agent-heartbeat.helper';
import { AgentRun, AgentRunStatus, AgentMode } from '../../entities/agent-run.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { Organization } from '../../entities/organization.entity';
import { Tool } from '../../entities/tool.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message, MessageRole } from '../../entities/message.entity';
import { LlmProvidersService } from '../../modules/llm-providers/llm-providers.service';
import { ToolExecutorService } from '../../modules/tools/tool-executor.service';
import { CanonicalMemoryService } from '../../modules/memory/canonical/canonical-memory.service';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';

/**
 * Integration tests for unified agent streaming.
 *
 * Verifies that the autonomous runtime emits the new enriched events
 * (llm.started, llm.response, llm.chunk, tool.started, tool.result)
 * in addition to the existing step.completed and run.completed events.
 *
 * Uses mocked repos and a mock LlmProvidersService but exercises
 * real AgentRuntimeService logic.
 */
describe('Agent Streaming (integration)', () => {
  let service: AgentRuntimeService;
  let runStore: AgentRun[];
  let agentStore: Agent[];
  let mockRunRepo: any;
  let mockAgentRepo: any;
  let mockToolRepo: any;
  let mockConversationRepo: any;
  let mockMessageRepo: any;
  let mockQueue: any;
  let mockLlmService: any;
  let mockToolExecutor: any;
  let messageStore: Message[];

  const makeAgent = (overrides: Partial<Agent> = {}): Agent => {
    const agent = new Agent();
    Object.assign(agent, {
      id: 'agent-1',
      name: 'Streaming Test Agent',
      description: 'Agent for streaming tests',
      organizationId: 'org-1',
      status: AgentStatus.ACTIVE,
      mode: 'autonomous',
      instructions: 'You are a helpful test agent.',
      toolIds: [],
      pipeline: { nodes: [], edges: [] },
      modelConfig: { providerId: 'provider-1', model: 'gpt-4', temperature: 0.7, maxTokens: 4096 },
      memoryConfig: { enabled: false },
      collaboration: null,
      ...overrides,
    });
    return agent;
  };

  const makeTool = (overrides: Partial<Tool> = {}): Tool => {
    const tool = new Tool();
    Object.assign(tool, {
      id: 'tool-1',
      name: 'web_search',
      description: 'Search the web',
      organizationId: 'org-1',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      ...overrides,
    });
    return tool;
  };

  beforeEach(async () => {
    runStore = [];
    agentStore = [makeAgent()];
    messageStore = [];
    let runIdCounter = 0;
    let convIdCounter = 0;

    mockRunRepo = {
      create: jest.fn().mockImplementation((data: Partial<AgentRun>) => {
        const run = new AgentRun();
        Object.assign(run, {
          id: `run-${++runIdCounter}`,
          totalCost: 0,
          totalTokens: 0,
          executionTime: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          workingMemory: {},
          ...data,
        });
        return run;
      }),
      save: jest.fn().mockImplementation((run: AgentRun) => {
        const existing = runStore.findIndex(r => r.id === run.id);
        if (existing >= 0) {
          runStore[existing] = run;
        } else {
          runStore.push(run);
        }
        return Promise.resolve(run);
      }),
      findOne: jest.fn().mockImplementation(({ where, relations }: any) => {
        const found = runStore.find(r => {
          if (where.id && r.id !== where.id) return false;
          if (where.organizationId && r.organizationId !== where.organizationId) return false;
          if (where.agentId && r.agentId !== where.agentId) return false;
          return true;
        });
        if (found && relations?.includes('agent')) {
          found.agent = agentStore.find(a => a.id === found.agentId) || null as any;
        }
        return Promise.resolve(found || null);
      }),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };

    const qbChain = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    mockAgentRepo = {
      findOne: jest.fn().mockImplementation(({ where }: any) => {
        const found = agentStore.find(
          a => a.id === where.id && a.organizationId === where.organizationId,
        );
        return Promise.resolve(found || null);
      }),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation((agent: Agent) => Promise.resolve(agent)),
      createQueryBuilder: jest.fn().mockReturnValue(qbChain),
    };

    mockToolRepo = {
      find: jest.fn().mockResolvedValue([]),
    };

    mockConversationRepo = {
      save: jest.fn().mockImplementation((conv: Conversation) => {
        if (!conv.id) conv.id = `conv-${++convIdCounter}`;
        return Promise.resolve(conv);
      }),
    };

    mockMessageRepo = {
      save: jest.fn().mockImplementation((msg: Message) => {
        if (!msg.id) msg.id = `msg-${messageStore.length + 1}`;
        messageStore.push(msg);
        return Promise.resolve(msg);
      }),
      find: jest.fn().mockImplementation(({ where }: any) => {
        const filtered = messageStore.filter(m => m.conversationId === where?.conversationId);
        return Promise.resolve(filtered);
      }),
    };

    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    mockLlmService = {
      chat: jest.fn().mockResolvedValue({
        message: {
          role: 'assistant',
          content: 'Test response.',
          toolCalls: [],
          finishReason: 'stop',
        },
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        cost: 0.001,
        model: 'gpt-4',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        responseTime: 100,
      }),
      chatStream: jest.fn().mockImplementation(
        async (_providerId: string, _request: any, _orgId: string, _userId?: string, onChunk?: (chunk: any) => void) => {
          // Simulate streaming by calling onChunk with content deltas
          if (onChunk) {
            onChunk({ content: 'Test ' });
            onChunk({ content: 'response.' });
          }
          return {
            message: {
              role: 'assistant',
              content: 'Test response.',
              toolCalls: [],
              finishReason: 'stop',
            },
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            cost: 0.001,
            model: 'gpt-4',
            conversationId: 'conv-1',
            messageId: 'msg-1',
            responseTime: 100,
          };
        },
      ),
    };

    mockToolExecutor = {
      executeTool: jest.fn().mockResolvedValue({
        success: true,
        data: 'tool result data',
        executionTime: 50,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRuntimeService,
        AgentRuntimeBuilders,
        AgentCollaborationHelper,
        AgentBuiltInToolsHelper,
        { provide: ApprovalsService, useValue: { create: jest.fn().mockResolvedValue({ id: 'a-stub' }) } },
        AgentHeartbeatHelper,
        AgentRuntimeEventsHelper,
        AgentRuntimeMiscHelper,
        AgentStepProcessor,
        { provide: getRepositoryToken(AgentRun), useValue: mockRunRepo },
        { provide: getRepositoryToken(Agent), useValue: mockAgentRepo },
        { provide: getRepositoryToken(Tool), useValue: mockToolRepo },
        {
          provide: getRepositoryToken(Organization),
          useValue: { findOne: jest.fn().mockResolvedValue({ id: 'org-1', agentDefaults: null }) },
        },
        { provide: getRepositoryToken(Conversation), useValue: mockConversationRepo },
        { provide: getRepositoryToken(Message), useValue: mockMessageRepo },
        { provide: getQueueToken('agent-runtime'), useValue: mockQueue },
        { provide: LlmProvidersService, useValue: mockLlmService },
        { provide: ToolExecutorService, useValue: mockToolExecutor },
        {
          provide: CanonicalMemoryService,
          useValue: {
            search: jest.fn().mockResolvedValue([]),
            put: jest.fn().mockResolvedValue({ id: 'mem-test', mode: 'memory' }),
          },
        },
        {
          provide: AuditLogService,
          useValue: {
            log: jest.fn(), logCreate: jest.fn(), logUpdate: jest.fn(),
            logDelete: jest.fn(), logToolExecution: jest.fn(),
            logGatewayRequest: jest.fn(), logRunEvent: jest.fn(),
            computeChanges: jest.fn().mockReturnValue([]),
            findAll: jest.fn().mockResolvedValue({ data: [], total: 0 }),
            getResourceHistory: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: 'default_IORedisModuleConnectionToken', useValue: { xadd: jest.fn().mockResolvedValue('id'), expire: jest.fn().mockResolvedValue(1), duplicate: jest.fn().mockReturnValue({ xread: jest.fn().mockResolvedValue(null), disconnect: jest.fn() }) } },
      ],
    }).compile();

    service = module.get<AgentRuntimeService>(AgentRuntimeService);
  });

  /**
   * Helper: start a run, subscribe to its emitter, run processStep,
   * and return all collected events.
   */
  async function runAndCollectEvents(
    llmOverride?: any,
    agentOverride?: Partial<Agent>,
  ): Promise<{ events: any[]; run: AgentRun }> {
    if (agentOverride) {
      agentStore[0] = makeAgent(agentOverride);
    }
    if (llmOverride) {
      mockLlmService.chatStream.mockImplementation(
        async (_pid: string, _req: any, _oid: string, _uid?: string, onChunk?: (chunk: any) => void) => {
          if (onChunk && llmOverride.chunks) {
            for (const c of llmOverride.chunks) {
              onChunk(c);
            }
          }
          return llmOverride.response || llmOverride;
        },
      );
    }

    const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test input');

    const emitter = service.getRunEmitter(run.id);
    expect(emitter).not.toBeNull();

    const events: any[] = [];
    emitter!.on('event', (event: any) => events.push(event));

    await service.processStep(run.id);

    return { events, run };
  }

  describe('Phase 1: enriched runtime events', () => {
    it('should emit llm.started before the LLM call', async () => {
      const { events } = await runAndCollectEvents();

      const llmStarted = events.find(e => e.type === 'llm.started');
      expect(llmStarted).toBeDefined();
      expect(llmStarted.data.step).toBe(0);
      expect(llmStarted.timestamp).toBeDefined();
    });

    it('should emit llm.response after the LLM call', async () => {
      const { events } = await runAndCollectEvents();

      const llmResponse = events.find(e => e.type === 'llm.response');
      expect(llmResponse).toBeDefined();
      expect(llmResponse.data.step).toBe(0);
      expect(llmResponse.data.content).toBe('Test response.');
      expect(llmResponse.data.usage).toEqual({
        inputTokens: 10,
        outputTokens: 20,
      });
      expect(llmResponse.data.cost).toBe(0.001);
    });

    it('should emit run.completed when LLM returns final answer', async () => {
      const { events } = await runAndCollectEvents();

      const runCompleted = events.find(e => e.type === 'run.completed');
      expect(runCompleted).toBeDefined();
      expect(runCompleted.data.output).toBe('Test response.');
    });

    it('should emit events in correct order: llm.started -> llm.response -> run.completed', async () => {
      const { events } = await runAndCollectEvents();

      const types = events.map(e => e.type);
      const llmStartedIdx = types.indexOf('llm.started');
      const llmResponseIdx = types.indexOf('llm.response');
      const runCompletedIdx = types.indexOf('run.completed');

      expect(llmStartedIdx).toBeLessThan(llmResponseIdx);
      expect(llmResponseIdx).toBeLessThan(runCompletedIdx);
    });
  });

  describe('Phase 1: tool events', () => {
    it('should emit tool.started and tool.result for built-in tools', async () => {
      mockLlmService.chatStream
        .mockImplementationOnce(async (_pid: string, _req: any, _oid: string, _uid?: string, onChunk?: any) => ({
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{
              id: 'tc-wait',
              name: 'wait',
              parameters: { seconds: 1, reason: 'testing' },
            }],
            finishReason: 'tool_calls',
          },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          cost: 0,
          model: 'gpt-4',
          conversationId: 'conv-1',
          messageId: 'msg-1',
          responseTime: 50,
        }));

      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'wait test');
      const emitter = service.getRunEmitter(run.id);
      const events: any[] = [];
      emitter!.on('event', (event: any) => events.push(event));

      await service.processStep(run.id);

      const toolStarted = events.find(e => e.type === 'tool.started');
      expect(toolStarted).toBeDefined();
      expect(toolStarted.data.tool).toBe('wait');
      expect(toolStarted.data.toolCallId).toBe('tc-wait');

      const toolResult = events.find(e => e.type === 'tool.result');
      expect(toolResult).toBeDefined();
      expect(toolResult.data.tool).toBe('wait');
      expect(toolResult.data.success).toBe(true);
      expect(toolResult.data.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should emit tool events for regular tool execution', async () => {
      const tool = makeTool();
      agentStore[0] = makeAgent({ toolIds: ['tool-1'] });
      mockToolRepo.find.mockResolvedValue([tool]);

      mockLlmService.chatStream
        .mockImplementationOnce(async () => ({
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{
              id: 'tc-1',
              name: 'web_search',
              parameters: { query: 'test query' },
            }],
            finishReason: 'tool_calls',
          },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          cost: 0.001,
          model: 'gpt-4',
          conversationId: 'conv-1',
          messageId: 'msg-1',
          responseTime: 50,
        }));

      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'search test');
      const emitter = service.getRunEmitter(run.id);
      const events: any[] = [];
      emitter!.on('event', (event: any) => events.push(event));

      await service.processStep(run.id);

      const toolStarted = events.find(e => e.type === 'tool.started');
      expect(toolStarted).toBeDefined();
      expect(toolStarted.data.tool).toBe('web_search');
      expect(toolStarted.data.toolCallId).toBe('tc-1');
      expect(toolStarted.data.step).toBe(0);

      const toolResult = events.find(e => e.type === 'tool.result');
      expect(toolResult).toBeDefined();
      expect(toolResult.data.tool).toBe('web_search');
      expect(toolResult.data.success).toBe(true);
      expect(toolResult.data.executionTime).toBeDefined();
    });

    it('should emit tool.result with success=false for missing tools', async () => {
      mockLlmService.chatStream
        .mockImplementationOnce(async () => ({
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{
              id: 'tc-missing',
              name: 'nonexistent_tool',
              parameters: {},
            }],
            finishReason: 'tool_calls',
          },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          cost: 0,
          model: 'gpt-4',
          conversationId: 'conv-1',
          messageId: 'msg-1',
          responseTime: 50,
        }));

      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'missing tool test');
      const emitter = service.getRunEmitter(run.id);
      const events: any[] = [];
      emitter!.on('event', (event: any) => events.push(event));

      await service.processStep(run.id);

      const toolResult = events.find(e => e.type === 'tool.result');
      expect(toolResult).toBeDefined();
      expect(toolResult.data.tool).toBe('nonexistent_tool');
      expect(toolResult.data.success).toBe(false);
    });
  });

  describe('Phase 3: LLM token streaming', () => {
    it('should call chatStream instead of chat', async () => {
      await runAndCollectEvents();

      expect(mockLlmService.chatStream).toHaveBeenCalledTimes(1);
      expect(mockLlmService.chat).not.toHaveBeenCalled();
    });

    it('should pass onChunk callback to chatStream', async () => {
      await runAndCollectEvents();

      const callArgs = mockLlmService.chatStream.mock.calls[0];
      // Arguments: providerId, request, orgId, userId, onChunk
      expect(callArgs[0]).toBe('provider-1'); // providerId
      expect(callArgs[2]).toBe('org-1'); // orgId
      expect(typeof callArgs[4]).toBe('function'); // onChunk callback
    });

    it('should emit llm.chunk events when onChunk is called', async () => {
      const { events } = await runAndCollectEvents({
        chunks: [
          { content: 'Hello ' },
          { content: 'world' },
        ],
        response: {
          message: {
            role: 'assistant',
            content: 'Hello world',
            toolCalls: [],
            finishReason: 'stop',
          },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          cost: 0.001,
          model: 'gpt-4',
          conversationId: 'conv-1',
          messageId: 'msg-1',
          responseTime: 50,
        },
      });

      const chunkEvents = events.filter(e => e.type === 'llm.chunk');
      expect(chunkEvents).toHaveLength(2);
      expect(chunkEvents[0].data.content).toBe('Hello ');
      expect(chunkEvents[1].data.content).toBe('world');
      expect(chunkEvents[0].data.step).toBe(0);
    });

    it('should not emit llm.chunk for empty content', async () => {
      const { events } = await runAndCollectEvents({
        chunks: [
          { content: '' },
          { content: 'data' },
        ],
        response: {
          message: {
            role: 'assistant',
            content: 'data',
            toolCalls: [],
            finishReason: 'stop',
          },
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          cost: 0,
          model: 'gpt-4',
          conversationId: 'conv-1',
          messageId: 'msg-1',
          responseTime: 50,
        },
      });

      // Only the non-empty chunk should produce an event
      const chunkEvents = events.filter(e => e.type === 'llm.chunk');
      expect(chunkEvents).toHaveLength(1);
      expect(chunkEvents[0].data.content).toBe('data');
    });
  });

  describe('backward compatibility', () => {
    it('should still emit step.completed for tool-call steps', async () => {
      mockLlmService.chatStream
        .mockImplementationOnce(async () => ({
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{
              id: 'tc-wait',
              name: 'wait',
              parameters: { seconds: 1 },
            }],
            finishReason: 'tool_calls',
          },
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          cost: 0,
          model: 'gpt-4',
          conversationId: 'conv-1',
          messageId: 'msg-1',
          responseTime: 50,
        }));

      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      const emitter = service.getRunEmitter(run.id);
      const events: any[] = [];
      emitter!.on('event', (event: any) => events.push(event));

      await service.processStep(run.id);

      // step.completed should still be emitted (backward compat)
      const stepCompleted = events.find(e => e.type === 'step.completed');
      expect(stepCompleted).toBeDefined();
    });

    it('should still emit run.failed on error', async () => {
      mockLlmService.chatStream.mockRejectedValue(new Error('LLM provider error'));

      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'fail test');
      const emitter = service.getRunEmitter(run.id);
      const events: any[] = [];
      emitter!.on('event', (event: any) => events.push(event));

      await service.processStep(run.id);

      const runFailed = events.find(e => e.type === 'run.failed');
      expect(runFailed).toBeDefined();
      expect(runFailed.data.error).toBe('LLM provider error');
    });

    it('should still emit run.completed with output', async () => {
      const { events } = await runAndCollectEvents();

      const runCompleted = events.find(e => e.type === 'run.completed');
      expect(runCompleted).toBeDefined();
      expect(runCompleted.data.output).toBe('Test response.');
    });
  });

  describe('event ordering invariants', () => {
    it('tool events should appear between llm.started and step/run completion', async () => {
      const tool = makeTool();
      agentStore[0] = makeAgent({ toolIds: ['tool-1'] });
      mockToolRepo.find.mockResolvedValue([tool]);

      mockLlmService.chatStream
        .mockImplementationOnce(async () => ({
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc-1', name: 'web_search', parameters: { query: 'test' } }],
            finishReason: 'tool_calls',
          },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          cost: 0.001,
          model: 'gpt-4',
          conversationId: 'conv-1',
          messageId: 'msg-1',
          responseTime: 50,
        }));

      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'tool order test');
      const emitter = service.getRunEmitter(run.id);
      const events: any[] = [];
      emitter!.on('event', (event: any) => events.push(event));

      await service.processStep(run.id);

      const types = events.map(e => e.type);
      const llmStartedIdx = types.indexOf('llm.started');
      const llmResponseIdx = types.indexOf('llm.response');
      const toolStartedIdx = types.indexOf('tool.started');
      const toolResultIdx = types.indexOf('tool.result');
      const stepCompletedIdx = types.indexOf('step.completed');

      // llm.started should be first
      expect(llmStartedIdx).toBe(0);

      // llm.response should come after llm.started
      expect(llmResponseIdx).toBeGreaterThan(llmStartedIdx);

      // tool events after llm.response
      expect(toolStartedIdx).toBeGreaterThan(llmResponseIdx);
      expect(toolResultIdx).toBeGreaterThan(toolStartedIdx);

      // step.completed should be last
      expect(stepCompletedIdx).toBeGreaterThan(toolResultIdx);
    });
  });
});
