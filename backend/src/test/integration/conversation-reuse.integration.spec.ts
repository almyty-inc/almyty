import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { AgentRuntimeService } from '../../modules/agents/agent-runtime.service';
import { AgentRun, AgentRunStatus, AgentMode } from '../../entities/agent-run.entity';
import { AgentRuntimeBuilders } from '../../modules/agents/agent-runtime-builders';
import { AgentCollaborationHelper } from '../../modules/agents/agent-collaboration.helper';
import { AgentBuiltInToolsHelper } from '../../modules/agents/agent-builtin-tools.helper';
import { ApprovalsService } from '../../modules/approvals/approvals.service';
import { AgentRuntimeEventsHelper } from '../../modules/agents/agent-runtime-events.helper';
import { AgentRuntimeMiscHelper } from '../../modules/agents/agent-runtime-misc.helper';
import { AgentStepProcessor } from '../../modules/agents/agent-step-processor';
import { AgentVerifierHelper } from '../../modules/agents/agent-verifier.helper';
import { AgentHeartbeatHelper } from '../../modules/agents/agent-heartbeat.helper';
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
 * Integration tests for conversation reuse across autonomous runs.
 *
 * Verifies that passing a conversationId to startRun reuses the
 * existing conversation (and its message history) instead of creating
 * a new one. This is the backend half of multi-turn context in
 * ACP/chat sessions.
 */
describe('Conversation reuse (integration)', () => {
  let service: AgentRuntimeService;
  let conversationStore: Conversation[];
  let messageStore: Message[];
  let runStore: AgentRun[];
  let agentStore: Agent[];
  let mockConversationRepo: any;
  let mockMessageRepo: any;
  let mockRunRepo: any;
  let mockLlmService: any;

  const makeAgent = (): Agent => {
    const agent = new Agent();
    Object.assign(agent, {
      id: 'agent-1',
      name: 'Conversation Test Agent',
      description: 'Agent for conversation reuse tests',
      organizationId: 'org-1',
      status: AgentStatus.ACTIVE,
      mode: 'autonomous',
      instructions: 'You are a helpful assistant.',
      toolIds: [],
      pipeline: { nodes: [], edges: [] },
      modelConfig: { providerId: 'provider-1', model: 'gpt-4', temperature: 0.7, maxTokens: 4096 },
      memoryConfig: { enabled: false },
      collaboration: null,
    });
    return agent;
  };

  beforeEach(async () => {
    conversationStore = [];
    messageStore = [];
    runStore = [];
    agentStore = [makeAgent()];
    let runIdCounter = 0;
    let convIdCounter = 0;

    mockConversationRepo = {
      save: jest.fn().mockImplementation((conv: Conversation) => {
        if (!conv.id) conv.id = `conv-${++convIdCounter}`;
        const existing = conversationStore.findIndex(c => c.id === conv.id);
        if (existing >= 0) {
          conversationStore[existing] = conv;
        } else {
          conversationStore.push(conv);
        }
        return Promise.resolve(conv);
      }),
      findOne: jest.fn().mockImplementation(({ where }: any) => {
        const found = conversationStore.find(c => {
          if (where.id && c.id !== where.id) return false;
          if (where.organizationId && c.organizationId !== where.organizationId) return false;
          return true;
        });
        return Promise.resolve(found || null);
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
        if (existing >= 0) runStore[existing] = run;
        else runStore.push(run);
        return Promise.resolve(run);
      }),
      // commitStep() guards step writes via update(); findOne returns the
      // stored object by reference so mutations are visible — just report success.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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

    const mockAgentRepo = {
      findOne: jest.fn().mockImplementation(({ where }: any) => {
        return Promise.resolve(
          agentStore.find(a => a.id === where.id && a.organizationId === where.organizationId) || null,
        );
      }),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation((a: Agent) => Promise.resolve(a)),
      createQueryBuilder: jest.fn().mockReturnValue(qbChain),
    };

    mockLlmService = {
      chat: jest.fn().mockResolvedValue({
        message: { role: 'assistant', content: 'Response.', toolCalls: [], finishReason: 'stop' },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        cost: 0.001,
        model: 'gpt-4',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        responseTime: 100,
      }),
      chatStream: jest.fn().mockImplementation(
        async (_pid: string, _req: any, _oid: string, _uid?: string, onChunk?: (chunk: any) => void) => {
          if (onChunk) onChunk({ content: 'Response.' });
          return {
            message: { role: 'assistant', content: 'Response.', toolCalls: [], finishReason: 'stop' },
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            cost: 0.001,
            model: 'gpt-4',
            conversationId: 'conv-1',
            messageId: 'msg-1',
            responseTime: 100,
          };
        },
      ),
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
        AgentVerifierHelper,
        { provide: getRepositoryToken(AgentRun), useValue: mockRunRepo },
        { provide: getRepositoryToken(Agent), useValue: mockAgentRepo },
        { provide: getRepositoryToken(Tool), useValue: { find: jest.fn().mockResolvedValue([]) } },
        {
          provide: getRepositoryToken(Organization),
          useValue: { findOne: jest.fn().mockResolvedValue({ id: 'org-1', agentDefaults: null }) },
        },
        { provide: getRepositoryToken(Conversation), useValue: mockConversationRepo },
        { provide: getRepositoryToken(Message), useValue: mockMessageRepo },
        { provide: getQueueToken('agent-runtime'), useValue: { add: jest.fn().mockResolvedValue({ id: 'job-1' }) } },
        { provide: LlmProvidersService, useValue: mockLlmService },
        { provide: ToolExecutorService, useValue: { executeTool: jest.fn().mockResolvedValue({ success: true }) } },
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

  it('should create a new conversation when no conversationId is provided', async () => {
    const run = await service.startRun('agent-1', 'org-1', 'user-1', 'Hello');

    expect(conversationStore).toHaveLength(1);
    expect(run.conversationId).toBe(conversationStore[0].id);
  });

  it('should reuse existing conversation when conversationId is provided', async () => {
    // First run creates a conversation
    const run1 = await service.startRun('agent-1', 'org-1', 'user-1', 'Hello');
    const convId = run1.conversationId;
    expect(conversationStore).toHaveLength(1);

    // Second run reuses the conversation
    const run2 = await service.startRun('agent-1', 'org-1', 'user-1', 'Follow-up', {
      conversationId: convId,
    });

    // Should still be only 1 conversation
    expect(conversationStore).toHaveLength(1);
    expect(run2.conversationId).toBe(convId);
  });

  it('should accumulate messages in the reused conversation', async () => {
    // First run
    const run1 = await service.startRun('agent-1', 'org-1', 'user-1', 'What is Spain?');
    const convId = run1.conversationId;

    // Process the first run so it creates assistant message
    await service.processStep(run1.id);

    const messagesAfterRun1 = messageStore.filter(m => m.conversationId === convId);
    // Should have: user message from startRun + assistant message from processStep
    expect(messagesAfterRun1.length).toBeGreaterThanOrEqual(2);

    // Second run reusing same conversation
    const run2 = await service.startRun('agent-1', 'org-1', 'user-1', 'And Andorra?', {
      conversationId: convId,
    });
    expect(run2.conversationId).toBe(convId);

    // Should have added another user message to the same conversation
    const messagesAfterRun2 = messageStore.filter(m => m.conversationId === convId);
    expect(messagesAfterRun2.length).toBeGreaterThan(messagesAfterRun1.length);

    // The new user message should be "And Andorra?"
    const userMessages = messagesAfterRun2.filter(m => m.role === MessageRole.USER);
    expect(userMessages.some(m => m.content === 'And Andorra?')).toBe(true);
  });

  it('should pass conversation history to LLM on reused conversation', async () => {
    // First run
    const run1 = await service.startRun('agent-1', 'org-1', 'user-1', 'Hello');
    await service.processStep(run1.id);

    // Second run reusing conversation
    const run2 = await service.startRun('agent-1', 'org-1', 'user-1', 'Follow-up', {
      conversationId: run1.conversationId,
    });
    await service.processStep(run2.id);

    // chatStream should have been called twice
    expect(mockLlmService.chatStream).toHaveBeenCalledTimes(2);

    // The second call should have more messages than the first (it includes history)
    const firstCallMessages = mockLlmService.chatStream.mock.calls[0][1].messages;
    const secondCallMessages = mockLlmService.chatStream.mock.calls[1][1].messages;
    expect(secondCallMessages.length).toBeGreaterThan(firstCallMessages.length);
  });

  it('should reject invalid conversationId', async () => {
    await expect(
      service.startRun('agent-1', 'org-1', 'user-1', 'Hello', {
        conversationId: 'nonexistent-conv-id',
      }),
    ).rejects.toThrow('Conversation not found');
  });

  it('should reject conversationId from wrong organization', async () => {
    // Create a conversation in org-1
    const run = await service.startRun('agent-1', 'org-1', 'user-1', 'Hello');

    // The findOne mock checks organizationId, so calling with a different org
    // should fail. We need to make the mock strict about org matching.
    // The conversation was created with org-1, so looking it up with org-2 should fail.
    const convId = run.conversationId;

    // Override findOne to simulate org mismatch
    mockConversationRepo.findOne.mockImplementation(({ where }: any) => {
      const found = conversationStore.find(c => {
        if (where.id && c.id !== where.id) return false;
        if (where.organizationId && c.organizationId !== where.organizationId) return false;
        return true;
      });
      return Promise.resolve(found || null);
    });

    // Create another agent entry in org-2
    const agent2 = makeAgent();
    agent2.organizationId = 'org-2';
    agentStore.push(agent2);

    await expect(
      service.startRun('agent-1', 'org-2', 'user-2', 'Cross-org attempt', {
        conversationId: convId,
      }),
    ).rejects.toThrow();
  });

  it('should handle multiple sequential runs with the same conversation', async () => {
    // Simulate 5-turn conversation
    let convId: string | undefined;

    for (let i = 0; i < 5; i++) {
      const run = await service.startRun(
        'agent-1', 'org-1', 'user-1',
        `Message ${i + 1}`,
        convId ? { conversationId: convId } : undefined,
      );
      if (!convId) convId = run.conversationId;
      expect(run.conversationId).toBe(convId);
      await service.processStep(run.id);
    }

    // Should still be only 1 conversation
    expect(conversationStore).toHaveLength(1);

    // Should have at least 10 messages (5 user + 5 assistant)
    const convMessages = messageStore.filter(m => m.conversationId === convId);
    expect(convMessages.length).toBeGreaterThanOrEqual(10);

    // 5th LLM call should have all prior history
    expect(mockLlmService.chatStream).toHaveBeenCalledTimes(5);
    const lastCallMessages = mockLlmService.chatStream.mock.calls[4][1].messages;
    // Should include system prompt + at least 8 history messages + current user message
    expect(lastCallMessages.length).toBeGreaterThanOrEqual(9);
  });
});
