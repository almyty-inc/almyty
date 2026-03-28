import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AgentRuntimeService } from '../agent-runtime.service';
import { AgentRun, AgentRunStatus, AgentMode } from '../../../entities/agent-run.entity';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { Tool } from '../../../entities/tool.entity';

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
  let mockQueue: any;

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
          if (where.id && where.organizationId) {
            return r.id === where.id && r.organizationId === where.organizationId;
          }
          return r.id === where.id;
        });
        if (found && relations?.includes('agent')) {
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
    };

    mockAgentRepo = {
      findOne: jest.fn().mockImplementation(({ where }: any) => {
        const found = agentStore.find(
          a => a.id === where.id && a.organizationId === where.organizationId,
        );
        return Promise.resolve(found || null);
      }),
      find: jest.fn().mockResolvedValue([]),
    };

    mockToolRepo = {
      findByIds: jest.fn().mockResolvedValue([]),
    };

    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRuntimeService,
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
          provide: getQueueToken('agent-runtime'),
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = module.get<AgentRuntimeService>(AgentRuntimeService);
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

      // Thread should have the user message
      expect(run.thread).toHaveLength(1);
      expect(run.thread[0].role).toBe('user');
      expect(run.thread[0].content).toBe('Do something useful');
      expect(run.thread[0].timestamp).toBeDefined();
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

      expect(run.thread[0].content).toBe(JSON.stringify({ task: 'do stuff', priority: 'high' }));
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

    it('should fail run when budget exceeded', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      run.totalCost = 200;
      run.limits = { maxCostCents: 100 };
      await mockRunRepo.save(run);

      const result = await service.processStep(run.id);

      expect(result).toBe('done');
      const updatedRun = runStore.find(r => r.id === run.id);
      expect(updatedRun!.status).toBe(AgentRunStatus.FAILED);
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

    it('should complete run when last message is assistant without tool calls', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      run.thread.push({
        role: 'assistant',
        content: 'Here is the final answer.',
        timestamp: new Date().toISOString(),
      });
      await mockRunRepo.save(run);

      const result = await service.processStep(run.id);

      expect(result).toBe('done');
      const updatedRun = runStore.find(r => r.id === run.id);
      expect(updatedRun!.status).toBe(AgentRunStatus.COMPLETED);
      expect(updatedRun!.output).toBe('Here is the final answer.');
    });

    it('should continue when last message is a user message', async () => {
      const run = await service.startRun('agent-1', 'org-1', 'user-1', 'test');
      // Thread has just the user message from startRun, so it should continue
      await mockRunRepo.save(run);

      const result = await service.processStep(run.id);

      expect(result).toBe('continue');
      const updatedRun = runStore.find(r => r.id === run.id);
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
      expect(updatedRun!.currentStep).toBe(4);
      expect(updatedRun!.executionTime).toBeGreaterThanOrEqual(500);
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
      expect(updated.thread).toHaveLength(2); // original + new
      expect(updated.thread[1].role).toBe('user');
      expect(updated.thread[1].content).toBe('Here is my input');
      expect(updated.thread[1].timestamp).toBeDefined();

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
});
