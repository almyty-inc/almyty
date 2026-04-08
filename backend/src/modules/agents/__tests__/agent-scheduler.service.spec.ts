import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { BadRequestException } from '@nestjs/common';

import { AgentSchedulerService } from '../agent-scheduler.service';
import { AgentsService } from '../agents.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { Agent, AgentStatus } from '../../../entities/agent.entity';

describe('AgentSchedulerService', () => {
  let service: AgentSchedulerService;
  let agentRepo: jest.Mocked<any>;
  let queue: jest.Mocked<any>;
  let agentsService: jest.Mocked<any>;
  let executionEngine: jest.Mocked<any>;

  beforeEach(async () => {
    agentRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation(a => Promise.resolve(a)),
    };
    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
    };
    agentsService = {
      getAgent: jest.fn(),
    };
    executionEngine = {
      execute: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentSchedulerService,
        { provide: AgentsService, useValue: agentsService },
        { provide: AgentExecutionEngine, useValue: executionEngine },
        { provide: getRepositoryToken(Agent), useValue: agentRepo },
        { provide: getQueueToken('agent-scheduler'), useValue: queue },
      ],
    }).compile();

    service = module.get(AgentSchedulerService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── intervalMinutes validation ──────────────────────────────────────

  describe('scheduleAgent: intervalMinutes validation', () => {
    const baseAgent = { id: 'a1', organizationId: 'org-1', settings: {}, createdBy: 'u1' };

    beforeEach(() => {
      agentsService.getAgent.mockResolvedValue(baseAgent);
    });

    it.each([
      ['zero',     0],
      ['negative', -5],
      ['NaN',      NaN],
      ['Infinity', Infinity],
      ['too large (> 1 year)', 60 * 24 * 366],
    ])('rejects %s', async (_label, value) => {
      await expect(
        service.scheduleAgent('a1', 'org-1', value as number, {}),
      ).rejects.toThrow(BadRequestException);

      // The agent must NEVER be persisted on rejection — otherwise a partial
      // schedule would survive and corrupt the next restoreSchedules() pass.
      expect(agentRepo.save).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it.each([
      ['1 minute',     1],
      ['1 hour',       60],
      ['1 day',        60 * 24],
      ['1 year',       60 * 24 * 365],
    ])('accepts %s', async (_label, value) => {
      await service.scheduleAgent('a1', 'org-1', value, {});
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('floors fractional minutes', async () => {
      await service.scheduleAgent('a1', 'org-1', 1.9, {});
      // The repeat-every value passed to BullMQ is in milliseconds, so
      // floor(1.9) = 1 minute = 60_000 ms.
      expect(queue.add.mock.calls[0][2].repeat.every).toBe(60_000);
    });
  });

  // ── handleScheduledExecution: org scoping ───────────────────────────

  describe('handleScheduledExecution: defence-in-depth org scoping', () => {
    it('looks up the agent with both id AND organizationId', async () => {
      agentRepo.findOne.mockResolvedValue({
        id: 'a1',
        organizationId: 'org-1',
        status: AgentStatus.ACTIVE,
        settings: { schedule: { enabled: true, intervalMinutes: 10, input: {} } },
      });

      await service.handleScheduledExecution({
        data: { agentId: 'a1', organizationId: 'org-1', userId: 'u1', input: {} },
      } as any);

      expect(agentRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'a1', organizationId: 'org-1' },
      });
    });

    it('drops jobs missing agentId or organizationId', async () => {
      await service.handleScheduledExecution({
        data: { agentId: 'a1', organizationId: undefined },
      } as any);
      expect(agentRepo.findOne).not.toHaveBeenCalled();
      expect(executionEngine.execute).not.toHaveBeenCalled();
    });

    it('skips and removes the repeatable job when the agent does not exist in that org', async () => {
      agentRepo.findOne.mockResolvedValue(null);
      queue.getRepeatableJobs.mockResolvedValue([
        { id: 'schedule-a1', key: 'k1' },
      ]);

      await service.handleScheduledExecution({
        data: { agentId: 'a1', organizationId: 'org-1', userId: 'u1', input: {} },
      } as any);

      expect(executionEngine.execute).not.toHaveBeenCalled();
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('k1');
    });
  });

  // ── restoreSchedules: corrupted schedule handling ──────────────────

  describe('restoreSchedules', () => {
    it('skips agents with corrupted intervalMinutes instead of crashing', async () => {
      agentRepo.find.mockResolvedValue([
        {
          id: 'good',
          organizationId: 'org-1',
          status: AgentStatus.ACTIVE,
          settings: { schedule: { enabled: true, intervalMinutes: 60, input: {} } },
        },
        {
          id: 'bad-zero',
          organizationId: 'org-1',
          status: AgentStatus.ACTIVE,
          settings: { schedule: { enabled: true, intervalMinutes: 0, input: {} } },
        },
        {
          id: 'bad-nan',
          organizationId: 'org-1',
          status: AgentStatus.ACTIVE,
          settings: { schedule: { enabled: true, intervalMinutes: NaN, input: {} } },
        },
      ]);

      await service.restoreSchedules();

      // Only the well-formed agent should have been re-enqueued
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add.mock.calls[0][1].agentId).toBe('good');
    });

    it('clears existing repeatable jobs once before restoring (no inner re-fetch per agent)', async () => {
      queue.getRepeatableJobs.mockResolvedValue([
        { id: 'schedule-x', key: 'kx' },
      ]);
      agentRepo.find.mockResolvedValue([
        {
          id: 'a1',
          organizationId: 'org-1',
          status: AgentStatus.ACTIVE,
          settings: { schedule: { enabled: true, intervalMinutes: 5, input: {} } },
        },
      ]);

      await service.restoreSchedules();

      // The whole restore should hit getRepeatableJobs exactly once — the
      // O(N^2) fix removed the per-agent re-fetch.
      expect(queue.getRepeatableJobs).toHaveBeenCalledTimes(1);
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('kx');
      expect(queue.add).toHaveBeenCalledTimes(1);
    });
  });
});
