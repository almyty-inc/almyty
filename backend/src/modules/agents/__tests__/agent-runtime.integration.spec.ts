import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AgentRuntimeService } from '../agent-runtime.service';
import { AgentRuntimeBuilders } from '../agent-runtime-builders';
import { AgentCollaborationHelper } from '../agent-collaboration.helper';
import { AgentBuiltInToolsHelper } from '../agent-builtin-tools.helper';
import { ApprovalsService } from '../../approvals/approvals.service';
import { AgentRuntimeEventsHelper } from '../agent-runtime-events.helper';
import { AgentRuntimeMiscHelper } from '../agent-runtime-misc.helper';
import { AgentStepProcessor } from '../agent-step-processor';
import { AgentHeartbeatHelper } from '../agent-heartbeat.helper';
import { AgentRun, AgentRunStatus, AgentMode } from '../../../entities/agent-run.entity';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { Organization } from '../../../entities/organization.entity';
import { Tool } from '../../../entities/tool.entity';
import { Conversation } from '../../../entities/conversation.entity';
import { Message } from '../../../entities/message.entity';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { CanonicalMemoryService } from '../../memory/canonical/canonical-memory.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AgentVerifierHelper } from '../agent-verifier.helper';
import { AgentContextCompactor } from '../agent-context-compactor.helper';
import { AgentConstraintsService } from '../../agent-constraints/agent-constraints.service';
import { BudgetsService } from '../../budgets/budgets.service';

/**
 * Integration tests for AgentRuntimeService.
 *
 * Tests REAL runtime logic: startRun state initialization, limit checks,
 * processStep decisions, cancellation, sendInput, and pagination math.
 * Mocks: TypeORM repos and BullMQ queue.
 * Real: all service logic, state transitions, and error handling.
 */
describe('AgentRuntimeService (integration)', () => {
  let service: AgentRuntimeService;
  let runStore: AgentRun[];
  let agentStore: Agent[];
  let mockRunRepo: any;
  let mockAgentRepo: any;
  let mockToolRepo: any;
  let mockConversationRepo: any;
  let mockMessageRepo: any;
  let mockQueue: any;
  let messageStore: Message[];
  let llmService: any;

  const makeAgent = (overrides: Partial<Agent> = {}): Agent => {
    const agent = new Agent();
    Object.assign(agent, {
      id: 'agent-1',
      name: 'Test Agent',
      description: 'A test agent',
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

  beforeEach(async () => {
    runStore = [];
    agentStore = [makeAgent()];
    let runIdCounter = 0;

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
        if (found && relations?.agent) {
          found.agent = agentStore.find(a => a.id === found.agentId) || null as any;
        }
        return Promise.resolve(found || null);
      }),
      findAndCount: jest.fn().mockImplementation(({ where, skip, take }: any) => {
        const filtered = runStore.filter(
          r => r.agentId === where.agentId && r.organizationId === where.organizationId,
        );
        const paged = filtered.slice(skip || 0, (skip || 0) + (take || 20));
        return Promise.resolve([paged, filtered.length]);
      }),
      findByIds: jest.fn().mockResolvedValue([]),
      // commitStep() guards step writes with a CAS via update(); findOne
      // returns the stored object by reference so mutations are already
      // visible — the mock just needs to report the row was updated.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    // bumpAgentStats uses a queryBuilder chain for an atomic
    // UPDATE. The mock's chain resolves to {affected: 1} so the
    // runtime's best-effort stats update succeeds silently.
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
      findByIds: jest.fn().mockResolvedValue([]),
    };

    messageStore = [];
    let convIdCounter = 0;
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRuntimeService,
        AgentRuntimeBuilders,
        AgentCollaborationHelper,
        AgentBuiltInToolsHelper,
        AgentHeartbeatHelper,
        AgentRuntimeEventsHelper,
        AgentRuntimeMiscHelper,
        AgentStepProcessor,
        AgentVerifierHelper,
        AgentContextCompactor,
        { provide: AgentConstraintsService, useValue: { listActiveRules: jest.fn().mockResolvedValue([]), recordFromRun: jest.fn().mockResolvedValue(null) } },
        { provide: BudgetsService, useValue: { enforceForRun: jest.fn().mockResolvedValue(undefined) } },
        { provide: 'ApprovalsService', useValue: { create: jest.fn().mockResolvedValue({ id: 'a-stub' }) } },
        { provide: ApprovalsService, useValue: { create: jest.fn().mockResolvedValue({ id: 'a-stub' }) } },
        {
          provide: getRepositoryToken(AgentRun),
          useValue: mockRunRepo,
        },
        {
          provide: getRepositoryToken(Agent),
          useValue: mockAgentRepo,
        },
        {
          provide: getRepositoryToken(Tool),
          useValue: mockToolRepo,
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: {
            findOne: jest.fn().mockResolvedValue({ id: 'org-1', agentDefaults: null }),
          },
        },
        {
          provide: getRepositoryToken(Conversation),
          useValue: mockConversationRepo,
        },
        {
          provide: getRepositoryToken(Message),
          useValue: mockMessageRepo,
        },
        {
          provide: getQueueToken('agent-runtime'),
          useValue: mockQueue,
        },
        {
          provide: LlmProvidersService,
          useValue: {
            chat: jest.fn().mockResolvedValue({
              message: {
                role: 'assistant',
                content: 'Mock LLM response.',
                toolCalls: [],
                finishReason: 'stop',
              },
              usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
              cost: 0,
              model: 'gpt-4',
              conversationId: 'conversation-1',
              messageId: 'msg-1',
              responseTime: 100,
            }),
            chatStream: jest.fn().mockResolvedValue({
              message: {
                role: 'assistant',
                content: 'Mock LLM response.',
                toolCalls: [],
                finishReason: 'stop',
              },
              usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
              cost: 0,
              model: 'gpt-4',
              conversationId: 'conversation-1',
              messageId: 'msg-1',
              responseTime: 100,
            }),
            findProviderForOrganization: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ToolExecutorService,
          useValue: {
            executeTool: jest.fn().mockResolvedValue({ success: true, data: null }),
          },
        },
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
        { provide: 'default_IORedisModuleConnectionToken', useValue: { xadd: jest.fn().mockResolvedValue('id'), expire: jest.fn().mockResolvedValue(1), duplicate: jest.fn().mockReturnValue({ xread: jest.fn().mockResolvedValue(null), disconnect: jest.fn() }) } },
      ],
    }).compile();

    service = module.get<AgentRuntimeService>(AgentRuntimeService);
    llmService = module.get(LlmProvidersService) as any;
  });

  describe('startRun', () => {
    it('should create a run with correct initial state for an autonomous agent', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'Do something useful');

      expect(run.agentId).toBe('agent-1');
      expect(run.organizationId).toBe('org-1');
      expect(run.userId).toBe('user-1');
      expect(run.mode).toBe(AgentMode.AUTONOMOUS);
      expect(run.status).toBe(AgentRunStatus.RUNNING);
      expect(run.currentStep).toBe(0);
      expect(run.steps).toEqual([]);
      expect(run.maxSteps).toBe(50); // default

      // Conversation should have been created with the user message
      expect(run.conversationId).toBeDefined();
      expect(messageStore).toHaveLength(1);
      expect(messageStore[0].role).toBe('user');
      expect(messageStore[0].content).toBe('Do something useful');
    });

    it('should create a run with custom limits', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'Task', {
        maxSteps: 10,
        maxCostCents: 50,
        maxDurationMs: 60000,
      });

      expect(run.maxSteps).toBe(10);
      expect(run.limits.maxSteps).toBe(10);
      expect(run.limits.maxCostCents).toBe(50);
      expect(run.limits.maxDurationMs).toBe(60000);
    });

    it('should enqueue the first step via BullMQ', async () => {
      await service.startRun('agent-1', 'org-1', 'user-1', 'Go');

      expect(mockQueue.add).toHaveBeenCalledWith(
        'next-step',
        expect.objectContaining({ runId: expect.any(String) }),
        expect.objectContaining({
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        }),
      );
    });

    it('should stringify non-string input', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', { task: 'do stuff', priority: 'high' });

      const lastMsg = messageStore[messageStore.length - 1];
      expect(lastMsg.content).toBe(JSON.stringify({ task: 'do stuff', priority: 'high' }));
    });

    it('should throw NotFoundException for non-existent agent', async () => {
      await expect(
        service.startRun('non-existent', 'org-1', 'user-1', 'test'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for workflow agent', async () => {
      agentStore.push(makeAgent({ id: 'workflow-agent', mode: 'workflow' }));

      await expect(
        service.startRun('workflow-agent', 'org-1', 'user-1', 'test'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should set parentRunId when provided', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'sub-task', {
        parentRunId: 'parent-run-99',
      });

      expect(run.parentRunId).toBe('parent-run-99');
    });
  });

  describe('processStep', () => {
    it('should return done without changes when run is already completed', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      run.status = AgentRunStatus.COMPLETED;
      await mockRunRepo.save(run);

      const result = await service.processStep(run.id);
      expect(result).toBe('done');
    });

    it('should return done when run is not found', async () => {
      const result = await service.processStep('non-existent-run');
      expect(result).toBe('done');
    });

    it('should fail run when max steps exceeded', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      run.currentStep = 50;
      run.maxSteps = 50;
      run.limits = { maxSteps: 50 };
      await mockRunRepo.save(run);

      const result = await service.processStep(run.id);

      expect(result).toBe('done');
      const updatedRun = runStore.find(r => r.id === run.id);
      expect(updatedRun!.status).toBe(AgentRunStatus.FAILED);
      expect(updatedRun!.error).toBe('MAX_STEPS_EXCEEDED');
    });

    it('should fail run when budget exceeded (totalCost is dollars, maxCostCents is cents)', async () => {
      // run.totalCost accumulates dollars from llmResponse.cost.
      // maxCostCents is, per its name, in cents.
      // The limit is $1 (100 cents); totalCost of $1.50 should trip it.
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      run.totalCost = 1.5; // $1.50 in real dollars
      run.limits = { maxCostCents: 100 }; // $1.00 cap
      await mockRunRepo.save(run);

      const result = await service.processStep(run.id);

      expect(result).toBe('done');
      const updatedRun = runStore.find(r => r.id === run.id);
      expect(updatedRun!.status).toBe(AgentRunStatus.FAILED);
      expect(updatedRun!.error).toBe('BUDGET_EXCEEDED');
    });

    it('should NOT trip budget when dollars are still under the cents cap', async () => {
      // Regression: previously `totalCost >= maxCostCents` compared dollars
      // to cents, so $0.50 (50 cents) triggered a 100-cent cap. The fix
      // converts totalCost to cents before the comparison.
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      run.totalCost = 0.5; // $0.50 = 50 cents
      run.limits = { maxCostCents: 100 }; // $1.00 cap
      await mockRunRepo.save(run);

      // With the buggy code (`0.5 >= 100` false) this test would also have
      // passed, so the key assertion is the *opposite* one below: a
      // previously-permitted value is still permitted, AND the next test
      // verifies that a value that SHOULD trip the limit actually does.
      const result = await service.processStep(run.id);

      const updatedRun = runStore.find(r => r.id === run.id);
      // Should NOT be BUDGET_EXCEEDED — $0.50 is under the $1.00 cap.
      expect(updatedRun!.error).not.toBe('BUDGET_EXCEEDED');
    });

    it('should trip budget at the exact cent boundary', async () => {
      // Regression: the pre-fix check `totalCost >= maxCostCents` only
      // tripped when totalCost (dollars) exceeded the RAW cents number,
      // e.g. needed totalCost ≥ 100 dollars to trip a 100-cent limit —
      // a 100x overrun. The fix compares totalCost * 100 (now cents)
      // against maxCostCents. This test pins the correct cent-based trip.
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      run.totalCost = 0.99; // 99 cents — under 100-cent cap
      run.limits = { maxCostCents: 100 };
      await mockRunRepo.save(run);

      const result = await service.processStep(run.id);
      let updatedRun = runStore.find(r => r.id === run.id);
      expect(updatedRun!.error).not.toBe('BUDGET_EXCEEDED');

      // Now bump to exactly the cap.
      updatedRun!.totalCost = 1.0; // $1.00 = 100 cents
      updatedRun!.currentStep = 0;
      updatedRun!.status = AgentRunStatus.RUNNING;
      updatedRun!.error = undefined as any;
      await mockRunRepo.save(updatedRun!);

      await service.processStep(run.id);
      updatedRun = runStore.find(r => r.id === run.id);
      expect(updatedRun!.error).toBe('BUDGET_EXCEEDED');
    });

    it('should fail run when duration exceeded', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      // Set createdAt to 2 hours ago
      run.createdAt = new Date(Date.now() - 7200000);
      run.limits = { maxDurationMs: 3600000 }; // 1 hour limit
      await mockRunRepo.save(run);

      const result = await service.processStep(run.id);

      expect(result).toBe('done');
      const updatedRun = runStore.find(r => r.id === run.id);
      expect(updatedRun!.status).toBe(AgentRunStatus.FAILED);
      expect(updatedRun!.error).toBe('TIMEOUT');
    });

    it('should complete run when LLM returns no tool calls', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      await mockRunRepo.save(run);

      const result = await service.processStep(run.id);

      expect(result).toBe('done');
      const updatedRun = runStore.find(r => r.id === run.id);
      expect(updatedRun!.status).toBe(AgentRunStatus.COMPLETED);
      expect(updatedRun!.output).toBe('Mock LLM response.');
    });

    it('should complete run and increment step when LLM returns final answer', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      // Thread has just the user message from startRun
      await mockRunRepo.save(run);

      const result = await service.processStep(run.id);

      // LLM returns no tool calls, so run completes
      expect(result).toBe('done');
      const updatedRun = runStore.find(r => r.id === run.id);
      expect(updatedRun!.status).toBe(AgentRunStatus.COMPLETED);
      expect(updatedRun!.currentStep).toBe(1);
      expect(updatedRun!.steps).toHaveLength(1);
      expect(updatedRun!.steps[0].type).toBe('llm_call');
    });

    it('should increment step counters and track execution time', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      run.currentStep = 3;
      run.executionTime = 500;
      await mockRunRepo.save(run);

      await service.processStep(run.id);

      const updatedRun = runStore.find(r => r.id === run.id);
      // LLM returns no tool calls, so run completes with currentStep incremented
      expect(updatedRun!.currentStep).toBe(4);
      expect(updatedRun!.executionTime).toBeGreaterThanOrEqual(500);
    });

    it('guards the step-completion write with an optimistic CAS on currentStep', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'cas');
      const startStep = run.currentStep;
      mockRunRepo.update.mockClear();

      await service.processStep(run.id);

      expect(mockRunRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: run.id, currentStep: startStep }),
        expect.objectContaining({ currentStep: expect.any(Number) }),
      );
    });

    it('aborts (returns done) when another worker already advanced the step', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'race');
      // Simulate the CAS losing the race: the guarded UPDATE matches 0 rows.
      mockRunRepo.update.mockResolvedValueOnce({ affected: 0 });

      const result = await service.processStep(run.id);

      expect(result).toBe('done');
    });
  });

  describe('cancelRun', () => {
    it('should cancel a running run', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'cancel me');

      const cancelled = await service.cancelRun(run.id, 'org-1');

      expect(cancelled.status).toBe(AgentRunStatus.CANCELLED);
    });

    it('should throw BadRequestException when cancelling an already completed run', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'done');
      run.status = AgentRunStatus.COMPLETED;
      await mockRunRepo.save(run);

      await expect(
        service.cancelRun(run.id, 'org-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when cancelling an already failed run', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'failed');
      run.status = AgentRunStatus.FAILED;
      await mockRunRepo.save(run);

      await expect(
        service.cancelRun(run.id, 'org-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when cancelling an already cancelled run', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'cancelled');
      run.status = AgentRunStatus.CANCELLED;
      await mockRunRepo.save(run);

      await expect(
        service.cancelRun(run.id, 'org-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException for non-existent run', async () => {
      await expect(
        service.cancelRun('non-existent', 'org-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('sendInput', () => {
    it('should add user message to thread and resume when run is waiting_input', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'initial');
      run.status = AgentRunStatus.WAITING_INPUT;
      await mockRunRepo.save(run);

      const updated = await service.sendInput(run.id, 'org-1', 'Here is my input');

      expect(updated.status).toBe(AgentRunStatus.RUNNING);
      // User message should have been persisted
      const userMessages = messageStore.filter(m => m.content === 'Here is my input');
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0].role).toBe('user');

      // Should enqueue next step
      expect(mockQueue.add).toHaveBeenCalledTimes(2); // once for startRun, once for sendInput
    });

    it('should throw BadRequestException when run is RUNNING (not waiting)', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'running');

      await expect(
        service.sendInput(run.id, 'org-1', 'unwanted input'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when run is COMPLETED', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'done');
      run.status = AgentRunStatus.COMPLETED;
      await mockRunRepo.save(run);

      await expect(
        service.sendInput(run.id, 'org-1', 'too late'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('listRuns', () => {
    beforeEach(async () => {
      // Create 25 runs
      for (let i = 0; i < 25; i++) {
        const run = mockRunRepo.create({
          agentId: 'agent-1',
          organizationId: 'org-1',
          userId: 'user-1',
          mode: AgentMode.AUTONOMOUS,
          status: AgentRunStatus.COMPLETED,
          thread: [],
          steps: [],
          currentStep: 0,
          maxSteps: 50,
          input: {},
          limits: {},
        });
        await mockRunRepo.save(run);
      }
    });

    it('should return correct pagination for page 1', async () => {
      const result = await service.listRuns('agent-1', 'org-1', 1, 10);

      expect(result.data).toHaveLength(10);
      expect(result.total).toBe(25);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(3);
    });

    it('should return correct pagination for last page', async () => {
      const result = await service.listRuns('agent-1', 'org-1', 3, 10);

      expect(result.data).toHaveLength(5);
      expect(result.total).toBe(25);
      expect(result.page).toBe(3);
      expect(result.totalPages).toBe(3);
    });

    it('should return empty data for non-existent agent', async () => {
      const result = await service.listRuns('non-existent', 'org-1', 1, 10);

      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });
  });

  describe('getRun', () => {
    it('should return a run by id and orgId', async () => {
      const created = await service.startRun('agent-1', 'org-1', 'user-1', 'get me');

      const fetched = await service.getRun(created.id, 'org-1');
      expect(fetched.id).toBe(created.id);
    });

    it('should throw NotFoundException for non-existent run', async () => {
      await expect(
        service.getRun('fake-id', 'org-1'),
      ).rejects.toThrow(NotFoundException);
    });

    // Regression: the run-scoped controller endpoints live under
    // /agents/:id/runs/:runId/... — but the previous getRun signature
    // ignored `:id` and would resolve any runId in the caller's org
    // regardless of which agent it was attached to. The optional
    // `agentId` argument asserts the binding.
    describe('agent-id binding (regression)', () => {
      beforeEach(() => {
        // Seed a second agent in the same org so the mismatch case
        // has something to compare against.
        agentStore.push(makeAgent({ id: 'agent-2', name: 'Other Agent' }));
      });

      it('returns the run when agentId matches', async () => {
        const created = await service.startRun('agent-1', 'org-1', 'user-1', 'hi');
        const fetched = await service.getRun(created.id, 'org-1', 'agent-1');
        expect(fetched.id).toBe(created.id);
      });

      it('throws NotFound when agentId does NOT match', async () => {
        const created = await service.startRun('agent-1', 'org-1', 'user-1', 'hi');
        await expect(
          service.getRun(created.id, 'org-1', 'agent-2'),
        ).rejects.toThrow(NotFoundException);
      });

      it('omitting agentId still works for unscoped lookups', async () => {
        const created = await service.startRun('agent-1', 'org-1', 'user-1', 'hi');
        const fetched = await service.getRun(created.id, 'org-1');
        expect(fetched.id).toBe(created.id);
      });
    });
  });

  describe('event emitters', () => {
    it('should create an event emitter for a new run', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      const emitter = service.getRunEmitter(run.id);
      expect(emitter).not.toBeNull();
    });

    it('should return null for unknown run id', () => {
      const emitter = service.getRunEmitter('unknown');
      expect(emitter).toBeNull();
    });
  });

  describe('autonomous verify', () => {
    const verifyAgent = (over: any = {}) =>
      makeAgent({
        id: 'verify-agent',
        agentConfig: {
          verify: {
            enabled: true,
            checkers: [{ name: 'c1', providerId: 'provider-1' }],
            ...over,
          },
        },
      });

    const checkerReply = (content: string) => ({
      message: { role: 'assistant', content },
      usage: { totalTokens: 5 },
      cost: 0.001,
    });

    it('completes the run when the checker panel passes', async () => {
      agentStore.push(verifyAgent());
      llmService.chat.mockResolvedValue(checkerReply('{"verdict":"pass"}'));
      const run = await service.startRun('verify-agent', 'org-1', 'user-1', 'do it');

      const result = await service.processStep(run.id);

      expect(result).toBe('done');
      const stored = runStore.find(r => r.id === run.id)!;
      expect(stored.status).toBe(AgentRunStatus.COMPLETED);
      expect(stored.metadata?.verify?.verdict).toBe('pass');
      expect(stored.steps.some(s => s.type === 'verify')).toBe(true);
      // No revision feedback message was injected.
      expect(
        messageStore.some(m => m.role === 'user' && String(m.content).includes('verification panel')),
      ).toBe(false);
    });

    it('sends the answer back for revision when the panel fails (within budget)', async () => {
      agentStore.push(verifyAgent());
      llmService.chat.mockResolvedValue(
        checkerReply('{"verdict":"fail","failures":[{"rule":"missing total","evidence":"no sum line"}]}'),
      );
      const run = await service.startRun('verify-agent', 'org-1', 'user-1', 'do it');

      const result = await service.processStep(run.id);

      expect(result).toBe('continue');
      const stored = runStore.find(r => r.id === run.id)!;
      expect(stored.status).toBe(AgentRunStatus.RUNNING);
      expect(stored.workingMemory?.verifyRevisions).toBe(1);
      const critique = messageStore.find(
        m => m.role === 'user' && String(m.content).includes('verification panel'),
      );
      expect(critique).toBeDefined();
      expect(String(critique!.content)).toContain('missing total');
    });

    it('completes anyway once the revision budget is exhausted', async () => {
      agentStore.push(verifyAgent({ maxReviseLoops: 1 }));
      llmService.chat.mockResolvedValue(
        checkerReply('{"verdict":"fail","failures":[{"rule":"still wrong","evidence":"x"}]}'),
      );
      const run = await service.startRun('verify-agent', 'org-1', 'user-1', 'do it');
      // Pretend one revision already happened so we are at the cap.
      run.workingMemory = { verifyRevisions: 1 };
      await mockRunRepo.save(run);

      const result = await service.processStep(run.id);

      expect(result).toBe('done');
      const stored = runStore.find(r => r.id === run.id)!;
      expect(stored.status).toBe(AgentRunStatus.COMPLETED);
      expect(stored.metadata?.verify?.exhausted).toBe(true);
    });

    it('does not run the panel when verify is disabled', async () => {
      agentStore.push(
        makeAgent({
          id: 'plain-agent',
          agentConfig: { verify: { enabled: false, checkers: [{ providerId: 'provider-1' }] } },
        }),
      );
      const run = await service.startRun('plain-agent', 'org-1', 'user-1', 'do it');

      const result = await service.processStep(run.id);

      expect(result).toBe('done');
      expect(llmService.chat).not.toHaveBeenCalled();
    });
  });

  describe('mid-loop verify', () => {
    const midAgent = (over: any) =>
      makeAgent({
        id: 'mid-agent',
        agentConfig: {
          verify: { enabled: true, checkers: [{ providerId: 'provider-1' }], ...over },
        },
      });

    it('injects advisory feedback mid-run on every_n_steps without ending the run', async () => {
      agentStore.push(midAgent({ triggers: ['every_n_steps'], everyNSteps: 1 }));
      // Agent emits a tool call (so the tool branch runs), and the checker fails.
      llmService.chatStream.mockResolvedValueOnce({
        message: {
          role: 'assistant',
          content: 'working on it',
          toolCalls: [{ id: 't1', name: 'x', parameters: {} }],
        },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        cost: 0,
      });
      llmService.chat.mockResolvedValue({
        message: {
          role: 'assistant',
          content: '{"verdict":"fail","failures":[{"rule":"off track","evidence":"wrong tool"}]}',
        },
        usage: { totalTokens: 5 },
        cost: 0.001,
      });
      const run = await service.startRun('mid-agent', 'org-1', 'user-1', 'go');

      const result = await service.processStep(run.id);

      expect(result).toBe('continue');
      const stored = runStore.find(r => r.id === run.id)!;
      expect(stored.status).toBe(AgentRunStatus.RUNNING);
      expect(stored.steps.some(s => s.type === 'verify' && s.input?.mode === 'mid_loop')).toBe(true);
      const advisory = messageStore.find(
        m => m.role === 'user' && String(m.content).includes('Mid-run verification flagged'),
      );
      expect(advisory).toBeDefined();
      expect(String(advisory!.content)).toContain('off track');
    });

    it('skips the final-output gate when on_final_output is not a configured trigger', async () => {
      agentStore.push(midAgent({ triggers: ['every_n_steps'], everyNSteps: 5 }));
      // Default chatStream → final answer, no tool calls.
      const run = await service.startRun('mid-agent', 'org-1', 'user-1', 'go');

      const result = await service.processStep(run.id);

      expect(result).toBe('done');
      const stored = runStore.find(r => r.id === run.id)!;
      expect(stored.status).toBe(AgentRunStatus.COMPLETED);
      // Final-output verify gate did not fire — no checker call.
      expect(llmService.chat).not.toHaveBeenCalled();
    });
  });
});
