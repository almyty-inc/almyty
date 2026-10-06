import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { ModuleRef } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';

import { ExecutionAccessService } from '../../../common/authorization/execution-access.service';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { fakeRepository } from '../../../test/fake-repository';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { User } from '../../../entities/user.entity';
import { AgentSchedulerService } from '../agent-scheduler.service';
import { AgentsService } from '../agents.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { NotificationsService } from '../../notifications/notifications.service';
import { SCHEDULED_RESULT_POSTER } from '../scheduled-result-poster';

/**
 * Time-of-day schedules and "send the result to" a channel, through the
 * scheduler: what is saved, what the queue is given, what restore gives
 * it after a restart, and what a tick does with a channel on the other
 * end -- including not running at all when the channel cannot take the
 * post.
 */
describe('AgentSchedulerService: time of day and channel delivery', () => {
  const OWNER = '11111111-1111-4111-8111-000000000001';
  let service: AgentSchedulerService;
  let agentRepo: ReturnType<typeof fakeRepository>;
  let executions: ReturnType<typeof fakeRepository>;
  let queue: any;
  let agentsService: any;
  let engine: any;
  let poster: any;
  let notifications: any;
  let registered: any[];

  const agentRow = (over: Record<string, any> = {}) => ({
    id: 'agent-1',
    name: 'Morning report',
    organizationId: 'org-1',
    status: AgentStatus.ACTIVE,
    createdBy: OWNER,
    visibility: 'org',
    webhookUrl: null,
    settings: {},
    ...over,
  });

  beforeEach(async () => {
    registered = [];
    agentRepo = fakeRepository<any>([agentRow()]);
    executions = fakeRepository<any>([]);
    const users = fakeRepository<any>([
      {
        id: OWNER,
        isActive: true,
        timezone: 'Europe/Berlin',
        organizationMemberships: [{ organizationId: 'org-1', role: 'member', isActive: true }],
      },
    ]);
    queue = {
      add: jest.fn(async (_name: string, data: any, opts: any) => {
        registered.push({ data, opts });
      }),
      getRepeatableJobs: jest.fn(async () =>
        registered.map((r, i) => ({ key: `k${i}`, id: r.opts.jobId, next: Date.parse('2026-10-01T06:00:00Z'), ...r.opts.repeat })),
      ),
      removeRepeatableByKey: jest.fn(async (key: string) => {
        registered = registered.filter((_r, i) => `k${i}` !== key);
      }),
    };
    agentsService = { getAgent: jest.fn(async (id: string) => agentRepo.findOne({ where: { id } })) };
    engine = {
      execute: jest.fn(async (agent: any) => ({
        id: 'exec-1',
        agentId: agent.id,
        status: AgentExecutionStatus.COMPLETED,
        output: 'Sales were up 4%.',
        nodeResults: {},
      })),
    };
    poster = {
      destinations: jest.fn(async () => []),
      checkDestination: jest.fn(async (_agent: any, d: any) => ({ ...d, to: 'C0123ABCDEF', label: '#sales' })),
      admit: jest.fn(async () => ({ ok: true })),
      post: jest.fn(async () => ({ status: 'delivered' })),
    };
    notifications = { emit: jest.fn(async () => undefined) };
    const moduleRef = { get: jest.fn((token: string) => (token === SCHEDULED_RESULT_POSTER ? poster : null)) };

    const access = membershipFixture();
    access.member('org-1', OWNER);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentSchedulerService,
        { provide: ExecutionAccessService, useValue: access.executionAccess },
        { provide: AgentsService, useValue: agentsService },
        { provide: AgentExecutionEngine, useValue: engine },
        { provide: getRepositoryToken(Agent), useValue: agentRepo },
        { provide: getRepositoryToken(AgentExecution), useValue: executions },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getQueueToken('agent-scheduler'), useValue: queue },
        { provide: ModuleRef, useValue: moduleRef },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(AgentSchedulerService);
  });

  const stored = async () => (await agentRepo.findOne({ where: { id: 'agent-1' } }))!.settings.schedule;

  it('saves a weekday schedule and gives the queue a cron in the zone', async () => {
    await service.scheduleAgent('agent-1', 'org-1', { kind: 'days', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' });

    expect(await stored()).toMatchObject({
      enabled: true,
      kind: 'days',
      time: '08:00',
      days: [1, 2, 3, 4, 5],
      timezone: 'Europe/Berlin',
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][2]).toMatchObject({
      jobId: 'schedule-agent-1',
      repeat: { cron: '0 8 * * 1,2,3,4,5', tz: 'Europe/Berlin' },
    });
    expect(queue.add.mock.calls[0][2].repeat.every).toBeUndefined();
  });

  it("defaults the zone to the profile of the person setting the schedule", async () => {
    await service.scheduleAgent('agent-1', 'org-1', { kind: 'monthly', time: '09:00', dayOfMonth: 1 }, {}, OWNER);
    expect((await stored()).timezone).toBe('Europe/Berlin');
    expect(queue.add.mock.calls[0][2].repeat).toEqual({ cron: '0 9 1 * *', tz: 'Europe/Berlin' });
  });

  it('keeps the every-N-minutes call working unchanged', async () => {
    await service.scheduleAgent('agent-1', 'org-1', 15, { topic: 'x' });
    expect(await stored()).toMatchObject({ enabled: true, kind: 'interval', intervalMinutes: 15, input: { topic: 'x' } });
    expect(queue.add.mock.calls[0][2].repeat).toEqual({ every: 15 * 60 * 1000 });
  });

  it('restores a time-of-day schedule after a restart with its cron and zone', async () => {
    agentRepo.seed(
      agentRow({
        id: 'agent-2',
        settings: { schedule: { enabled: true, kind: 'days', time: '07:30', days: [0, 6], timezone: 'America/New_York', input: {} } },
      }),
    );
    await service.restoreSchedules();
    const job = registered.find((r) => r.opts.jobId === 'schedule-agent-2');
    expect(job?.opts.repeat).toEqual({ cron: '30 7 * * 0,6', tz: 'America/New_York' });
  });

  it('describes the schedule in plain words with its next run', async () => {
    await service.scheduleAgent('agent-1', 'org-1', { kind: 'days', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' });
    const agent = (await agentRepo.findOne({ where: { id: 'agent-1' } })) as any;
    const view = await service.describeSchedule(agent, new Date('2026-10-02T12:00:00Z')); // a Friday
    expect(view.summary).toBe('Every weekday at 8:00, Europe/Berlin');
    // Monday 5 Oct, 08:00 CEST.
    expect(view.nextRunAt).toBe('2026-10-05T06:00:00.000Z');
  });

  it('refuses a webhook delivery on an agent with no webhook URL', async () => {
    await expect(
      service.scheduleAgent('agent-1', 'org-1', { kind: 'interval', intervalMinutes: 60, deliverTo: { kind: 'webhook' } }),
    ).rejects.toThrow(BadRequestException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('stores the channel destination the poster checked', async () => {
    await service.scheduleAgent('agent-1', 'org-1', {
      kind: 'days',
      time: '08:00',
      days: [1],
      timezone: 'UTC',
      deliverTo: { kind: 'channel', channelId: 'ch-1', to: 'C0123ABCDEF' },
    });
    expect(poster.checkDestination).toHaveBeenCalled();
    expect((await stored()).deliverTo).toEqual({ kind: 'channel', channelId: 'ch-1', to: 'C0123ABCDEF', label: '#sales' });
  });

  describe('a tick with a channel on the other end', () => {
    const job = { data: { agentId: 'agent-1', organizationId: 'org-1', input: {} } } as any;
    const deliverTo = { kind: 'channel', channelId: 'ch-1', to: 'C0123ABCDEF', label: '#sales' };

    beforeEach(async () => {
      const agent = (await agentRepo.findOne({ where: { id: 'agent-1' } })) as any;
      agent.settings = { schedule: { enabled: true, kind: 'days', time: '08:00', days: [1], timezone: 'Europe/Berlin', input: {}, deliverTo } };
      await agentRepo.save(agent);
    });

    it('runs, then posts the result to the channel', async () => {
      await service.handleScheduledExecution(job);
      expect(engine.execute).toHaveBeenCalledTimes(1);
      expect(poster.post).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'agent-1' }),
        expect.objectContaining({ id: 'exec-1' }),
        deliverTo,
        { timezone: 'Europe/Berlin' },
      );
    });

    it('does not run at all when the channel cannot take the post, and says why on a run and a notification', async () => {
      poster.admit.mockResolvedValue({ ok: false, reason: 'the Slack channel has reached its spend limit for today' });
      await service.handleScheduledExecution(job);

      expect(engine.execute).not.toHaveBeenCalled();
      expect(poster.post).not.toHaveBeenCalled();
      const [row] = await executions.find({ where: { agentId: 'agent-1' } });
      expect(row).toMatchObject({
        status: AgentExecutionStatus.FAILED,
        error: 'Not run: the Slack channel has reached its spend limit for today',
      });
      expect(row.metadata.channelDelivery).toMatchObject({ status: 'skipped', channelId: 'ch-1' });
      expect(notifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'run.failed', userIds: [OWNER], title: 'Scheduled run skipped: Morning report' }),
      );
    });
  });
});
