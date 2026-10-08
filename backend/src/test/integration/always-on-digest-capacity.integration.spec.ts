import { randomUUID } from 'crypto';
import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentChannel } from '../../entities/agent-channel.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { AgentWake } from '../../entities/agent-wake.entity';
import { ConnectionGrant } from '../../entities/connection-grant.entity';
import { Message } from '../../entities/message.entity';
import { Organization } from '../../entities/organization.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { ExecutionAccessService } from '../../common/authorization/execution-access.service';
import { AlwaysOnService, capacityPause } from '../../modules/agents/always-on/always-on.service';
import { planCapacity } from '../../modules/agents/always-on/always-on-capacity';
import { SCHEDULED_RESULT_POSTER } from '../../modules/agents/scheduled-result-poster';
import { fakeQueue, fakeRedis } from '../../modules/agents/always-on/__tests__/always-on.harness';

/**
 * Always on's daily summary and plan capacity against real Postgres: real
 * migrations, the real `agents.alwaysOn`, `agent_wakes`, `agent_runs`,
 * `organizations.settings` and `users.timezone` columns, and the service's
 * own queries over them (the 24-hour window, the order agents count
 * against the plan, the round trip of a CAPACITY_EXHAUSTED pause). The
 * queue, Redis and the channel poster are stand-ins; nothing else is.
 *
 * Gated on RUN_DB_INTEGRATION=1. Own schema so parallel workers do not race
 * each other's DDL.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'always_on_digest_capacity_test';

jest.setTimeout(120_000);

describeIfDb('Always on daily summary and plan capacity (real Postgres)', () => {
  let ds: DataSource;
  let orgId: string;
  let ownerId: string;
  let writeToolId: string;
  let readToolId: string;
  let posted: Array<{ result: any; delivery: any; when: any }>;
  let notified: any[];
  let queue: ReturnType<typeof fakeQueue>;

  const connection = () => ({
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  });

  const save = async <T extends ObjectLiteral>(repo: Repository<T>, data: Record<string, unknown>): Promise<T> =>
    (await repo.save(repo.create(data as any))) as unknown as T;

  const service = () => {
    posted = [];
    notified = [];
    queue = fakeQueue();
    const poster = {
      destinations: async () => [],
      checkDestination: async (_a: any, d: any) => d,
      admit: async () => ({ ok: true }),
      post: async (_agent: any, result: any, delivery: any, when: any) => {
        posted.push({ result, delivery, when });
        return { status: 'delivered', channelId: delivery.channelId, at: new Date().toISOString() };
      },
    };
    const gate = new ExecutionAccessService(new AccessPolicyService(ds.getRepository(UserOrganization), ds.getRepository(UserTeam)));
    return new AlwaysOnService(
      ds.getRepository(Agent),
      ds.getRepository(AgentWake),
      ds.getRepository(AgentRun),
      ds.getRepository(AgentChannel),
      ds.getRepository(Organization),
      ds.getRepository(Tool),
      ds.getRepository(Message),
      ds.getRepository(ConnectionGrant),
      queue as any,
      fakeRedis() as any,
      { startRun: jest.fn(), sendInput: jest.fn(), executionAccess: gate, approvals: null } as any,
      { get: (token: any) => (token === SCHEDULED_RESULT_POSTER ? poster : null) } as any,
      { emit: async (n: any) => notified.push(n) } as any,
      { log: async () => undefined } as any,
      undefined,
      ds.getRepository(User),
    );
  };

  const alwaysOn = (extra: Record<string, unknown> = {}) => ({
    enabled: true,
    brief: 'Keep the refund queue empty.',
    wakeOn: { timer: { everyMinutes: 30 }, channelIds: [], connectionEvents: [] },
    ownerChannel: null,
    actMode: 'act',
    askFirstToolIds: [],
    reportTo: null,
    report: 'when_acted',
    ...extra,
  });

  const makeAgent = (name: string, extra: Record<string, unknown> = {}) =>
    save(ds.getRepository(Agent), {
      organizationId: orgId,
      name,
      status: AgentStatus.ACTIVE,
      mode: 'autonomous',
      visibility: 'org',
      createdBy: ownerId,
      pipeline: { nodes: [], edges: [] },
      toolIds: [readToolId, writeToolId],
      alwaysOn: alwaysOn(extra),
    }) as Promise<Agent>;

  beforeAll(async () => {
    const bootstrap = new DataSource(connection());
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
    await bootstrap.destroy();

    ds = new DataSource(versionsConfig({
      ...connection(),
      schema: SCHEMA,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
    }) as any);
    await ds.initialize();
    await ds.query(`SET search_path TO ${SCHEMA}, public`);
  });

  beforeEach(async () => {
    await ds.query(`TRUNCATE agent_wakes, agent_runs, agents, tools, user_organizations, users, organizations CASCADE`);
    orgId = (await save(ds.getRepository(Organization), {
      name: 'Northwind',
      slug: 'northwind-always-on',
      plan: 'pro',
      settings: { alwaysOn: { digestTime: '18:30' } },
    })).id;
    ownerId = (await save(ds.getRepository(User), {
      email: 'owner@always-on.test', passwordHash: 'x', firstName: 'Olivia', lastName: 'Owner', timezone: 'Europe/Berlin',
    })).id;
    await save(ds.getRepository(UserOrganization), { userId: ownerId, organizationId: orgId, role: OrganizationRole.OWNER, isActive: true });
    readToolId = (await save(ds.getRepository(Tool), {
      organizationId: orgId, visibility: 'org', name: 'list_refunds', type: ToolType.FUNCTION, status: ToolStatus.ACTIVE, parameters: {},
    })).id;
    // A person's override: a tool that only reads (classify() would call a function tool a write).
    await ds.getRepository(Tool).update({ id: readToolId }, { sideEffect: 'read', sideEffectSource: 'override' } as any);
    writeToolId = (await save(ds.getRepository(Tool), {
      organizationId: orgId, visibility: 'org', name: 'issue_refund', type: ToolType.FUNCTION, status: ToolStatus.ACTIVE, parameters: {}, sideEffect: 'write',
    })).id;
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  describe('plan capacity', () => {
    // Only agents whose home is a hosted machine count against the plan.
    const hosted = (extra: Record<string, unknown> = {}) => ({ home: { environmentId: randomUUID() }, ...extra });

    it('pauses the hosted-home agent turned on last when the plan has fewer places, stores the pause, and resumes it when one frees up', async () => {
      const limit = planCapacity('pro').includedAgents!;
      const hour = 3_600_000;
      const now = Date.now();
      const earlier: Agent[] = [];
      for (let i = 0; i < limit; i++) {
        earlier.push(await makeAgent(`Agent ${i + 1}`, hosted({ enabledAt: new Date(now - (limit - i + 1) * hour).toISOString() })));
      }
      // Own-machine and machine-less agents on beside them take no place.
      await makeAgent('Laptop agent', { enabledAt: new Date(now - 10 * hour).toISOString() });
      const last = await makeAgent('Support agent', hosted({ enabledAt: new Date(now - hour).toISOString() }));
      const svc = service();

      // The order the plan counts them in, read back from the real column.
      expect((await svc.hostedAgentsOn(orgId)).map((a) => a.name)).toEqual([...earlier.map((a) => a.name), 'Support agent']);

      await svc.wake(last.id, orgId, 'timer', { summary: 'the timer', dedupeKey: 't1' });
      expect(await svc.process(last.id, orgId)).toBe('paused');

      const stored = await ds.getRepository(Agent).findOneByOrFail({ id: last.id });
      expect(stored.alwaysOn.enabled).toBe(false);
      expect(stored.alwaysOn.pausedReason).toMatchObject({ code: 'CAPACITY_EXHAUSTED', message: capacityPause(limit, limit + 1).message });
      expect(await ds.getRepository(AgentWake).countBy({ agentId: last.id, status: 'dropped' })).toBe(1);
      expect(notified.map((n) => n.type)).toEqual(['agent.paused']);

      // Turning it on again, past the limit, is refused.
      await expect(svc.configure(last.id, orgId, { enabled: true })).rejects.toThrow(
        /includes 3 always-on agents on hosted machines, and 3 are on already/,
      );

      // One of the others is turned off: the paused one is back, in the database.
      await svc.configure(earlier[0].id, orgId, { enabled: false });
      const resumed = await ds.getRepository(Agent).findOneByOrFail({ id: last.id });
      expect(resumed.alwaysOn.enabled).toBe(true);
      expect(resumed.alwaysOn.pausedReason).toBeNull();
      expect(typeof resumed.alwaysOn.enabledAt).toBe('string');
      expect(notified.map((n) => n.title)).toContain('Support agent is back on');
    });

    it('the capacity check resumes it once the organization\'s plan has room', async () => {
      const limit = planCapacity('pro').includedAgents!;
      for (let i = 0; i < limit; i++) await makeAgent(`Agent ${i + 1}`, hosted());
      const paused = await makeAgent('Support agent', hosted({ enabled: false, pausedReason: capacityPause(limit, limit + 1) }));
      const svc = service();
      expect(await svc.resumeAllWithinCapacity()).toBe(0);
      await ds.getRepository(Organization).update({ id: orgId }, { plan: 'business' });
      expect(await svc.resumeAllWithinCapacity()).toBe(1);
      expect((await ds.getRepository(Agent).findOneByOrFail({ id: paused.id })).alwaysOn.enabled).toBe(true);
    });

    it('Free to Pro with more own-machine agents on than Pro includes pauses nothing', async () => {
      await ds.getRepository(Organization).update({ id: orgId }, { plan: 'free' });
      const limit = planCapacity('pro').includedAgents!;
      const agents: Agent[] = [];
      for (let i = 0; i < limit + 2; i++) agents.push(await makeAgent(`Agent ${i + 1}`));
      await ds.getRepository(Organization).update({ id: orgId }, { plan: 'pro' });
      const svc = service();
      expect(await svc.hostedAgentsOn(orgId)).toEqual([]);
      for (const a of agents) {
        await svc.wake(a.id, orgId, 'timer', { summary: 'the timer', dedupeKey: `t-${a.id}` });
        expect(await svc.process(a.id, orgId)).not.toBe('paused');
      }
      const stored = await ds.getRepository(Agent).findBy({ organizationId: orgId });
      expect(stored.every((a) => a.alwaysOn.enabled && !a.alwaysOn.pausedReason)).toBe(true);
      expect(notified.some((n) => n.type === 'agent.paused')).toBe(false);
    });
  });

  describe('daily summary', () => {
    it('schedules at the organization\'s time in the owner\'s zone, and sums up the last 24 hours from the real tables', async () => {
      const agent = await makeAgent('Support agent', { report: 'when_acted' });
      const svc = service();
      // Where reports go is the poster's to check; the stand-in takes it as given.
      const reportTo = { kind: 'channel' as const, channelId: randomUUID(), to: 'C-REPORTS' };
      await svc.configure(agent.id, orgId, { report: 'daily_digest', reportTo });
      const job = queue.repeatable.find((j) => j.name === 'always-on-digest');
      expect(job).toMatchObject({ cron: '30 18 * * *', tz: 'Europe/Berlin' });

      const now = new Date();
      const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
      const runs = ds.getRepository(AgentRun);
      const wakes = ds.getRepository(AgentWake);
      const r1 = await save(runs, {
        agentId: agent.id, organizationId: orgId, mode: 'autonomous', status: AgentRunStatus.COMPLETED,
        metadata: { triggerType: 'always_on' },
        steps: [{ type: 'tool_call', input: { toolId: writeToolId }, output: { ok: true } }, { type: 'tool_call', input: { toolId: readToolId }, output: {} }],
      });
      const r2 = await save(runs, {
        agentId: agent.id, organizationId: orgId, mode: 'autonomous', status: AgentRunStatus.FAILED, metadata: { triggerType: 'always_on' }, steps: [],
      });
      const old = await save(runs, {
        agentId: agent.id, organizationId: orgId, mode: 'autonomous', status: AgentRunStatus.COMPLETED, metadata: { triggerType: 'always_on' },
        steps: [{ type: 'tool_call', input: { toolId: writeToolId }, output: { ok: true } }],
      });
      await runs.update({ id: old.id }, { createdAt: ago(30) } as any);
      await runs.update({ id: r1.id }, { createdAt: ago(6) } as any);
      await runs.update({ id: r2.id }, { createdAt: ago(2) } as any);
      for (const [key, source, at, runId] of [
        ['t1', 'timer', ago(6), r1.id],
        ['h1', 'webhook', ago(2), r2.id],
        ['old', 'timer', ago(30), old.id],
      ] as const) {
        await wakes.insert({ organizationId: orgId, agentId: agent.id, source, summary: key, dedupeKey: key, status: 'consumed', runId, createdAt: at } as any);
      }

      expect(await svc.digest(agent.id, orgId, now)).toBe('posted');
      const text = notified.find((n) => n.type === 'agent.report')!.body as string;
      expect(text).toContain('Support agent, the last 24 hours:');
      expect(text).toContain('It was woken once by its timer and once by a webhook.');
      expect(text).toContain('It worked twice: 1 finished and 1 stopped before finishing.');
      expect(text).toContain('It did: issue_refund.');
      expect(posted).toHaveLength(1);
      expect(posted[0].delivery).toMatchObject(reportTo);
      expect(posted[0].result).toMatchObject({ kind: 'digest', output: text });
      expect(posted[0].when).toEqual({ timezone: 'Europe/Berlin' });
    });

    it('a quiet day posts nothing', async () => {
      const agent = await makeAgent('Quiet agent', { report: 'daily_digest' });
      const svc = service();
      expect(await svc.digest(agent.id, orgId, new Date())).toBe('quiet');
      expect(posted).toHaveLength(0);
      expect(notified).toHaveLength(0);
    });
  });
});
