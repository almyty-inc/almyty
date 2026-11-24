import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';

import { AgentsService } from '../agents.service';
import { AgentSchedulerService } from '../agent-scheduler.service';
import { AGENT_SCHEDULE_SYNC } from '../agent-schedule-sync';
import { agentScheduleSyncProvider } from '../agent-schedule-sync.provider';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentAuditService } from '../agent-audit.service';
import { AgentValidationHelper } from '../agent-validation.helper';
import { AgentReadinessService } from '../agent-readiness.service';
import { AgentChannelsService } from '../../agent-channels/agent-channels.service';
import { AccessPolicyService } from '../../../common/authorization/access-policy.service';
import { ExecutionAccessService } from '../../../common/authorization/execution-access.service';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { fakeRepository } from '../../../test/fake-repository';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { AgentExecution } from '../../../entities/agent-execution.entity';
import { Organization } from '../../../entities/organization.entity';
import { User } from '../../../entities/user.entity';

/**
 * Changing an agent's schedule through a plain agent update (PATCH
 * /agents/:id with new settings.schedule) stored the new time, but the
 * live repeatable job kept the old one: the timing lives in the Bull job,
 * and only the /schedule endpoints moved it. The old time kept firing and
 * the new one never did.
 *
 * The real AgentsService and AgentSchedulerService, wired through the
 * container the way agents.module.ts wires them, over a queue that keeps
 * repeatable jobs the way Bull does: one entry per (jobId, repeat).
 */

/** Bull's repeatable-job table, enough of it to see what would fire. */
function fakeBullQueue() {
  const jobs: { key: string; id: string; cron?: string; tz?: string; every?: number; data: any }[] = [];
  return {
    jobs,
    add: jest.fn(async (_name: string, data: any, opts: any) => {
      const r = opts.repeat;
      const key = `execute-agent:${opts.jobId}:::${r.cron ?? r.every}:${r.tz ?? ''}`;
      if (!jobs.some((j) => j.key === key)) {
        jobs.push({ key, id: opts.jobId, cron: r.cron, tz: r.tz, every: r.every, data });
      }
    }),
    getRepeatableJobs: jest.fn(async () => jobs.map(({ data: _d, ...j }) => ({ ...j }))),
    removeRepeatableByKey: jest.fn(async (key: string) => {
      const i = jobs.findIndex((j) => j.key === key);
      if (i >= 0) jobs.splice(i, 1);
    }),
  };
}

const OWNER = '11111111-1111-4111-8111-000000000001';

function makeAgent(): Agent {
  const agent = new Agent();
  Object.assign(agent, {
    id: 'agent-1',
    name: 'Morning digest',
    organizationId: 'org-1',
    status: AgentStatus.ACTIVE,
    mode: 'autonomous',
    version: '1.0.0',
    pipeline: { nodes: [], edges: [] },
    settings: {},
    metadata: {},
    createdBy: OWNER,
  });
  return agent;
}

async function build() {
  let row: Agent | null = makeAgent();
  const agentRepo: any = {
    findOne: jest.fn(async () => row),
    find: jest.fn(async () => (row ? [row] : [])),
    save: jest.fn(async (a: Agent) => (row = a)),
    remove: jest.fn(async (a: Agent) => {
      row = null;
      return a;
    }),
    manager: { getRepository: () => ({ find: async () => [] }) },
  };
  const queue = fakeBullQueue();
  const access = membershipFixture();
  access.member('org-1', OWNER);

  const moduleRef = await Test.createTestingModule({
    providers: [
      AgentsService,
      AgentSchedulerService,
      agentScheduleSyncProvider,
      { provide: getRepositoryToken(Agent), useValue: agentRepo },
      { provide: getRepositoryToken(AgentExecution), useValue: fakeRepository<any>([]) },
      { provide: getRepositoryToken(Organization), useValue: fakeRepository<any>([{ id: 'org-1' }]) },
      {
        provide: getRepositoryToken(User),
        useValue: fakeRepository<any>([
          { id: OWNER, isActive: true, organizationMemberships: [{ organizationId: 'org-1', role: 'owner', isActive: true }] },
        ]),
      },
      { provide: getQueueToken('agent-scheduler'), useValue: queue },
      { provide: AgentExecutionEngine, useValue: { execute: jest.fn() } },
      { provide: ExecutionAccessService, useValue: access.executionAccess },
      { provide: AgentAuditService, useValue: { log: jest.fn() } },
      { provide: AgentValidationHelper, useValue: { validatePipeline: jest.fn() } },
      { provide: AgentReadinessService, useValue: { assertReady: jest.fn() } },
      {
        provide: AccessPolicyService,
        useValue: {
          canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
          assertCanScopeToTeam: jest.fn(),
        },
      },
      { provide: AgentChannelsService, useValue: { removeAllOf: jest.fn().mockResolvedValue(null) } },
    ],
  }).compile();

  return {
    agents: moduleRef.get(AgentsService),
    scheduler: moduleRef.get(AgentSchedulerService),
    queue,
    agentRepo,
    row: () => row,
  };
}

const daily = (time: string) => ({ kind: 'days' as const, time, days: [0, 1, 2, 3, 4, 5, 6], timezone: 'Europe/Berlin' });

describe('an agent update that changes its schedule moves the live job', () => {
  it('a new time through PATCH /agents/:id replaces the old repeatable job, not adds to it or leaves it', async () => {
    const { agents, scheduler, queue, row } = await build();
    await scheduler.scheduleAgent('agent-1', 'org-1', daily('08:00'));
    expect(queue.jobs.map((j) => j.cron)).toEqual(['0 8 * * *']);

    await agents.updateAgent(
      'agent-1',
      { settings: { ...row()!.settings, schedule: { ...row()!.settings.schedule, time: '09:30' } } },
      'org-1',
      OWNER,
    );

    expect(row()!.settings.schedule.time).toBe('09:30');
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({ id: 'schedule-agent-1', cron: '30 9 * * *', tz: 'Europe/Berlin' });
  });

  it('a new time zone or interval moves the job too', async () => {
    const { agents, scheduler, queue, row } = await build();
    await scheduler.scheduleAgent('agent-1', 'org-1', daily('08:00'));

    await agents.updateAgent(
      'agent-1',
      { settings: { schedule: { ...row()!.settings.schedule, timezone: 'America/New_York' } } },
      'org-1',
      OWNER,
    );
    expect(queue.jobs.map((j) => [j.cron, j.tz])).toEqual([['0 8 * * *', 'America/New_York']]);

    await agents.updateAgent(
      'agent-1',
      { settings: { schedule: { enabled: true, kind: 'interval', intervalMinutes: 30 } } },
      'org-1',
      OWNER,
    );
    expect(queue.jobs.map((j) => [j.cron, j.every])).toEqual([[undefined, 30 * 60 * 1000]]);
  });

  it('a new scheduled input reaches the job, which is where a tick reads it from', async () => {
    const { agents, scheduler, queue, row } = await build();
    await scheduler.scheduleAgent('agent-1', 'org-1', { ...daily('08:00'), input: { message: 'old' } });

    await agents.updateAgent(
      'agent-1',
      { settings: { schedule: { ...row()!.settings.schedule, input: { message: 'new' } } } },
      'org-1',
      OWNER,
    );
    expect(queue.jobs.map((j) => j.data.input)).toEqual([{ message: 'new' }]);
  });

  it('turning the schedule off, or dropping it from the settings, removes the job', async () => {
    const { agents, scheduler, queue, row } = await build();
    await scheduler.scheduleAgent('agent-1', 'org-1', daily('08:00'));

    await agents.updateAgent(
      'agent-1',
      { settings: { schedule: { ...row()!.settings.schedule, enabled: false } } },
      'org-1',
      OWNER,
    );
    expect(queue.jobs).toEqual([]);

    await scheduler.scheduleAgent('agent-1', 'org-1', daily('08:00'));
    await agents.updateAgent('agent-1', { settings: {} }, 'org-1', OWNER);
    expect(queue.jobs).toEqual([]);
  });

  it('an update that leaves settings and status alone does not touch the job', async () => {
    const { agents, scheduler, queue } = await build();
    await scheduler.scheduleAgent('agent-1', 'org-1', daily('08:00'));
    queue.add.mockClear();
    queue.removeRepeatableByKey.mockClear();

    await agents.updateAgent('agent-1', { description: 'Reads the news' }, 'org-1', OWNER);

    expect(queue.add).not.toHaveBeenCalled();
    expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
    expect(queue.jobs.map((j) => j.cron)).toEqual(['0 8 * * *']);
  });

  it('refuses a schedule the scheduler could not run, and saves nothing', async () => {
    const { agents, scheduler, queue, agentRepo, row } = await build();
    await scheduler.scheduleAgent('agent-1', 'org-1', daily('08:00'));
    agentRepo.save.mockClear();

    await expect(
      agents.updateAgent(
        'agent-1',
        { settings: { schedule: { ...row()!.settings.schedule, timezone: 'Mars/Olympus' } } },
        'org-1',
        OWNER,
      ),
    ).rejects.toThrow(/time zone/i);
    expect(agentRepo.save).not.toHaveBeenCalled();
    expect(queue.jobs.map((j) => j.cron)).toEqual(['0 8 * * *']);
  });

  it('deactivating stops the job now; activating puts it back on the stored time', async () => {
    const { agents, scheduler, queue } = await build();
    await scheduler.scheduleAgent('agent-1', 'org-1', daily('08:00'));

    await agents.deactivateAgent('agent-1', 'org-1', OWNER);
    expect(queue.jobs).toEqual([]);

    await agents.activateAgent('agent-1', 'org-1', OWNER);
    expect(queue.jobs.map((j) => j.cron)).toEqual(['0 8 * * *']);
  });

  it('a status change through a plain update moves the job the same way', async () => {
    const { agents, scheduler, queue } = await build();
    await scheduler.scheduleAgent('agent-1', 'org-1', daily('08:00'));

    await agents.updateAgent('agent-1', { status: AgentStatus.INACTIVE }, 'org-1', OWNER);
    expect(queue.jobs).toEqual([]);
  });

  it('deleting the agent removes its job', async () => {
    const { agents, scheduler, queue } = await build();
    await scheduler.scheduleAgent('agent-1', 'org-1', daily('08:00'));

    await agents.deleteAgent('agent-1', 'org-1', OWNER);
    expect(queue.jobs).toEqual([]);
  });
});

describe('the sync is wired in the real module', () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

  it('agents.module.ts provides AGENT_SCHEDULE_SYNC, and not as an alias of the Bull processor', () => {
    const mod = read('agents.module.ts');
    expect(mod).toMatch(/\bagentScheduleSyncProvider\]/);
    // An alias of a @Processor class is explored as a second processor and
    // the app refuses to boot: "Cannot define the same handler twice".
    expect(mod).not.toMatch(/useExisting:\s*AgentSchedulerService/);
    expect(agentScheduleSyncProvider).toMatchObject({ provide: AGENT_SCHEDULE_SYNC, inject: [AgentSchedulerService] });
    expect((agentScheduleSyncProvider as any).useExisting).toBeUndefined();
  });

  it('every AgentsService path that saves a schedule-relevant change syncs or removes the job', () => {
    const src = read('agents.service.ts');
    const body = (name: string) => {
      const start = src.indexOf(`  async ${name}(`);
      expect(start).toBeGreaterThan(-1);
      const next = src.indexOf('\n  async ', start + 1);
      return src.slice(start, next === -1 ? undefined : next);
    };
    for (const method of ['updateAgent', 'activateAgent', 'deactivateAgent']) {
      expect(body(method)).toMatch(/scheduleSyncOf\(\)\?\.syncSchedule\(saved\)/);
    }
    expect(body('deleteAgent')).toMatch(/scheduleSyncOf\(\)\?\.removeSchedule\(id\)/);
  });
});
