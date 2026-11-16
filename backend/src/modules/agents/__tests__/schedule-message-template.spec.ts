/**
 * A schedule's message can say {{last_run_at}}, {{today}} and {{now}}:
 * "List the papers published since {{last_run_at}}" has to read as a real
 * date on every run, in the organization's time zone. last_run_at is the
 * start of the schedule's previous successful run; on its first run, when
 * the schedule was created.
 */
import { AgentSchedulerService } from '../agent-scheduler.service';
import { fillScheduleTemplate, scheduleTemplateValues, withFilledMessage } from '../schedule-template';
import { AgentStatus } from '../../../entities/agent.entity';
import { AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { membershipFixture } from '../../../test/execution-access.fixture';

describe('the values in a schedule message', () => {
  describe('filling them in', () => {
    const values = scheduleTemplateValues(new Date('2026-11-11T07:00:00Z'), new Date('2026-11-10T07:00:12Z'), 'Europe/Berlin');

    it('are dates in the time zone', () => {
      expect(values).toEqual({
        today: '2026-11-11',
        now: '2026-11-11T08:00:00+01:00',
        last_run_at: '2026-11-10T08:00:12+01:00',
      });
    });

    it('fills every use, with or without spaces, and leaves anything else alone', () => {
      expect(fillScheduleTemplate('Since {{last_run_at}} until {{ now }} ({{today}}), not {{input.topic}}', values)).toBe(
        'Since 2026-11-10T08:00:12+01:00 until 2026-11-11T08:00:00+01:00 (2026-11-11), not {{input.topic}}',
      );
    });

    it('fills the top-level text fields of the input, never nested values or other types', () => {
      const input = { message: 'Papers since {{last_run_at}}', invoices: 'Rates of {{today}}', days: 1, filter: { since: '{{today}}' } };
      expect(withFilledMessage(input, values)).toEqual({
        message: 'Papers since 2026-11-10T08:00:12+01:00',
        invoices: 'Rates of 2026-11-11',
        days: 1,
        filter: { since: '{{today}}' },
      });
      const notText = { message: { text: '{{today}}' } };
      expect(withFilledMessage(notText, values)).toBe(notText);
    });
  });

  describe('at a scheduled tick', () => {
    const OWNER = '11111111-1111-4111-8111-000000000001';
    const created = '2026-11-01T09:00:00.000Z';

    const build = (agent: Record<string, any>, history: { executions?: any[]; runs?: any[]; orgZone?: string | null } = {}) => {
      const access = membershipFixture();
      access.member('org-1', OWNER);
      const agents = fakeRepository<any>([agent]);
      const executions = fakeRepository<any>(history.executions ?? []);
      const runs = fakeRepository<any>(history.runs ?? []);
      const users = fakeRepository<any>([
        { id: OWNER, isActive: true, organizationMemberships: [{ organizationId: 'org-1', role: 'member', isActive: true }] },
      ]);
      const engine = { execute: jest.fn(async () => ({ id: 'exec-new', nodeResults: {} })) };
      const runtime = { startRun: jest.fn(async () => ({ id: 'run-new' })) };
      const timeZones = { configuredZoneOf: jest.fn(async () => history.orgZone ?? null) };
      const scheduler = new AgentSchedulerService(
        { getAgent: async (id: string) => agents.row(id) } as any,
        engine as any,
        agents as any,
        { add: jest.fn(), getRepeatableJobs: jest.fn(async () => []), removeRepeatableByKey: jest.fn() } as any,
        access.executionAccess,
        executions as any,
        users as any,
        undefined,
        undefined,
        runtime as any,
        runs as any,
        undefined,
        undefined,
        timeZones as any,
      );
      const tick = (input: Record<string, any>) =>
        scheduler.handleScheduledExecution({ data: { agentId: agent.id, organizationId: 'org-1', input } } as any);
      return { scheduler, engine, runtime, tick, timeZones };
    };

    const autonomous = (input: Record<string, any>) => ({
      id: 'agent-a', organizationId: 'org-1', status: AgentStatus.ACTIVE, mode: 'autonomous', visibility: 'org', createdBy: OWNER,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      settings: { schedule: { enabled: true, kind: 'interval', intervalMinutes: 1440, input, createdAt: created } },
    });
    const workflow = (input: Record<string, any>, timezone?: string) => ({
      id: 'agent-w', organizationId: 'org-1', status: AgentStatus.ACTIVE, mode: 'workflow', visibility: 'org', createdBy: OWNER,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      settings: { schedule: { enabled: true, kind: 'days', time: '08:00', days: [1], timezone, input, createdAt: created } },
    });

    afterEach(() => jest.useRealTimers());

    it('an autonomous agent is asked with the start of its last successful scheduled run, in the organization time zone', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-11T07:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      const input = { message: 'List the papers published since {{last_run_at}}. Today is {{today}}.' };
      const { runtime, tick, timeZones } = build(autonomous(input), {
        orgZone: 'Europe/Berlin',
        runs: [
          // The newest successful scheduled run: this one.
          { id: 'r2', agentId: 'agent-a', status: AgentRunStatus.COMPLETED, metadata: { triggerType: 'scheduled' }, createdAt: new Date('2026-11-10T07:00:00Z') },
          { id: 'r1', agentId: 'agent-a', status: AgentRunStatus.COMPLETED, metadata: { triggerType: 'scheduled' }, createdAt: new Date('2026-11-09T07:00:00Z') },
          // Newer, but failed, or not scheduled, or another agent's: not these.
          { id: 'r3', agentId: 'agent-a', status: AgentRunStatus.FAILED, metadata: { triggerType: 'scheduled' }, createdAt: new Date('2026-11-10T19:00:00Z') },
          { id: 'r4', agentId: 'agent-a', status: AgentRunStatus.COMPLETED, metadata: { triggerType: 'chat' }, createdAt: new Date('2026-11-10T20:00:00Z') },
          { id: 'r5', agentId: 'other', status: AgentRunStatus.COMPLETED, metadata: { triggerType: 'scheduled' }, createdAt: new Date('2026-11-10T21:00:00Z') },
        ],
      });

      await tick(input);

      expect(timeZones.configuredZoneOf).toHaveBeenCalledWith('org-1');
      expect(runtime.startRun).toHaveBeenCalledTimes(1);
      expect((runtime.startRun.mock.calls[0] as any[])[3]).toEqual({
        message: 'List the papers published since 2026-11-10T08:00:00+01:00. Today is 2026-11-11.',
      });
    });

    it('on the first run, last_run_at is when the schedule was created', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-11T07:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      const input = { message: 'Since {{last_run_at}}' };
      const { runtime, tick } = build(autonomous(input), { orgZone: 'UTC' });

      await tick(input);

      expect((runtime.startRun.mock.calls[0] as any[])[3]).toEqual({ message: 'Since 2026-11-01T09:00:00+00:00' });
    });

    it('a workflow agent reads its last successful scheduled execution, and is given the rest of the input as it was', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-11T07:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      const input = { message: 'Changes since {{last_run_at}} up to {{now}}', days: 1 };
      const { engine, tick } = build(workflow(input, 'America/New_York'), {
        // No organization time zone: the schedule's own zone is used.
        orgZone: null,
        executions: [
          { id: 'e1', agentId: 'agent-w', status: AgentExecutionStatus.COMPLETED, metadata: { triggerType: 'scheduled' }, createdAt: new Date('2026-11-04T13:00:00Z') },
          { id: 'e2', agentId: 'agent-w', status: AgentExecutionStatus.FAILED, metadata: { triggerType: 'scheduled' }, createdAt: new Date('2026-11-10T13:00:00Z') },
        ],
      });

      await tick(input);

      expect(engine.execute).toHaveBeenCalledTimes(1);
      expect((engine.execute.mock.calls[0] as any[])[3].input).toEqual({
        message: 'Changes since 2026-11-04T08:00:00-05:00 up to 2026-11-11T02:00:00-05:00',
        days: 1,
      });
    });


    it('a schedule saved as bare text is filled in the declared input field, whatever it is called', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-11T07:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      const agent = {
        ...workflow({} as any, 'UTC'),
        pipeline: { nodes: [{ id: 'input', type: 'input', data: { schema: { type: 'object', properties: { invoices: { type: 'string' } }, required: ['invoices'] } } }], edges: [] },
      };
      const { engine, tick } = build(agent, { orgZone: 'UTC' });

      await tick('Convert the invoices of {{today}}' as any);

      expect((engine.execute.mock.calls[0] as any[])[3].input).toEqual({ invoices: 'Convert the invoices of 2026-11-11' });
    });
    it('a message without values is passed on untouched', async () => {
      const input = { message: 'Write the morning summary.' };
      const { runtime, tick, timeZones } = build(autonomous(input));

      await tick(input);

      expect((runtime.startRun.mock.calls[0] as any[])[3]).toEqual({ message: 'Write the morning summary.' });
      expect(timeZones.configuredZoneOf).not.toHaveBeenCalled();
    });

    it('setting a schedule records when it was created, and keeps it across edits', async () => {
      const agent: any = { ...autonomous({ message: 'x' }), settings: {} };
      const { scheduler } = build(agent);
      const first = await scheduler.scheduleAgent('agent-a', 'org-1', { kind: 'interval', intervalMinutes: 60, input: { message: 'x' } });
      const createdAt = (first.settings as any).schedule.createdAt;
      expect(Date.parse(createdAt)).not.toBeNaN();

      const edited = await scheduler.scheduleAgent('agent-a', 'org-1', { kind: 'interval', intervalMinutes: 30, input: { message: 'y' } });
      expect((edited.settings as any).schedule.createdAt).toBe(createdAt);
    });

    // Run d0bde308: an interval schedule set up in Europe/Berlin filled
    // {{today}} and {{last_run_at}} in UTC, because an interval dropped its zone.
    it('an interval schedule keeps its zone and dates its message there', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-11T23:30:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      const input = { message: 'Since {{last_run_at}}, today {{today}}' };
      const agent: any = { ...autonomous(input), settings: {} };
      const { scheduler, runtime, tick } = build(agent, { orgZone: null });

      const saved = await scheduler.scheduleAgent('agent-a', 'org-1', {
        kind: 'interval',
        intervalMinutes: 15,
        timezone: 'Europe/Berlin',
        input,
      });
      expect((saved.settings as any).schedule).toMatchObject({ kind: 'interval', intervalMinutes: 15, timezone: 'Europe/Berlin' });

      await tick(input);
      // 23:30 UTC is already the 12th in Berlin; in UTC it would still be the 11th.
      expect((runtime.startRun.mock.calls[0] as any[])[3]).toEqual({
        message: 'Since 2026-11-12T00:30:00+01:00, today 2026-11-12',
      });
    });

    it('the zone the schedule page shows wins over the organization’s', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-11T23:30:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      const input = { message: 'Today {{today}}' };
      const agent: any = autonomous(input);
      agent.settings.schedule.timezone = 'Europe/Berlin';
      const { runtime, tick } = build(agent, { orgZone: 'America/New_York' });

      await tick(input);

      expect((runtime.startRun.mock.calls[0] as any[])[3]).toEqual({ message: 'Today 2026-11-12' });
    });
  });
});
