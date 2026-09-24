import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { SpendBudget } from '../../entities/spend-budget.entity';
import { SpendAlert } from '../../entities/spend-alert.entity';
import { BudgetsService } from '../../modules/budgets/budgets.service';
import { SpendService } from '../../modules/budgets/spend.service';

/**
 * Spend budgets, their breach alerts and the per-agent spend breakdown,
 * against a member's private agent. Member A ('owner') owns one private
 * agent; member B ('peer') and org admin C ('admin') must not see a
 * budget, an alert or a spend row tied to it, nor point a budget at it,
 * and A must see all of them. A call with no known viewer sees none.
 *
 * Real Postgres: the IsNull / NOT IN arms in BudgetsService and the
 * notOthersPrivateAgent fragment in SpendService are the thing under
 * test. Gated on RUN_DB_INTEGRATION=1 and isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'private_alerts_test';

jest.setTimeout(120_000);

describeIfDb('Private visibility: spend budgets, alerts and spend by agent (real Postgres)', () => {
  let ds: DataSource;
  let organizationId: string;
  const users: Record<'owner' | 'peer' | 'admin', string> = {} as any;
  const ids = {} as Record<'privateAgent' | 'orgAgent', string>;
  const budgetIds = {} as Record<'orgWide' | 'orgAgent' | 'privateAgent', string>;
  const alertIds = {} as Record<'orgWide' | 'orgAgent' | 'privateAgent', string>;

  let budgets: BudgetsService;
  let spend: SpendService;
  const mail = { send: jest.fn().mockResolvedValue(true) };

  const repo = <T extends object>(entity: new () => T) => ds.getRepository(entity);
  const insert = async (entity: new () => any, data: Record<string, unknown>): Promise<string> =>
    ((await repo(entity).save(repo(entity).create(data as any))) as any).id;

  const connection = () => ({
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  });

  beforeAll(async () => {
    const bootstrap = new DataSource(connection());
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
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

    organizationId = await insert(Organization, { name: 'Alerts Org', slug: 'alerts-org' });
    const roles: Array<[keyof typeof users, OrganizationRole]> = [
      ['owner', OrganizationRole.MEMBER],
      ['peer', OrganizationRole.MEMBER],
      ['admin', OrganizationRole.ADMIN],
    ];
    for (const [name, role] of roles) {
      users[name] = await insert(User, { email: `${name}@alerts.test`, passwordHash: 'x', firstName: name, lastName: 'T' });
      await insert(UserOrganization, { userId: users[name], organizationId, role, isActive: true, inviteAccepted: true });
    }

    const agent = (name: string, visibility: string, createdBy: string | null) => insert(Agent, {
      name, status: AgentStatus.ACTIVE, organizationId, pipeline: { nodes: [], edges: [] }, visibility, createdBy,
    });
    ids.privateAgent = await agent('Owner Private Agent', 'private', users.owner);
    ids.orgAgent = await agent('Org Agent', 'org', users.peer);

    const budget = (agentId: string | null) => insert(SpendBudget, {
      organizationId, agentId, periodType: 'month', limitCents: 1000, behavior: 'warn_log', softThresholdPct: 80, active: true,
    });
    budgetIds.orgWide = await budget(null);
    budgetIds.orgAgent = await budget(ids.orgAgent);
    budgetIds.privateAgent = await budget(ids.privateAgent);

    const alert = (budgetId: string, agentId: string | null, at: string) => insert(SpendAlert, {
      budgetId, organizationId, agentId, level: 'soft', periodType: 'month',
      periodStart: new Date('2026-09-01T00:00:00Z'), spentCents: 900, limitCents: 1000, at: new Date(at),
    });
    alertIds.orgWide = await alert(budgetIds.orgWide, null, '2026-09-10T00:00:00Z');
    alertIds.orgAgent = await alert(budgetIds.orgAgent, ids.orgAgent, '2026-09-11T00:00:00Z');
    alertIds.privateAgent = await alert(budgetIds.privateAgent, ids.privateAgent, '2026-09-12T00:00:00Z');

    for (const [agentId, totalCost] of [[ids.privateAgent, 3], [ids.orgAgent, 2]] as const) {
      await insert(AgentRun, {
        agentId, organizationId, userId: users.owner, status: AgentRunStatus.COMPLETED, totalCost,
      });
    }

    budgets = new BudgetsService(
      repo(SpendBudget), repo(SpendAlert), repo(UserOrganization), repo(User),
      {} as any, mail as any, undefined, repo(Agent),
    );
    spend = new SpendService(repo(AgentRun), repo(AgentExecution));
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const sorted = (xs: string[]) => [...xs].sort();

  describe('budgets', () => {
    it('lists a budget on the private agent to its owner only', async () => {
      const visible = [budgetIds.orgWide, budgetIds.orgAgent];
      for (const viewer of ['peer', 'admin'] as const) {
        expect(sorted((await budgets.list(organizationId, users[viewer])).map((b) => b.id))).toEqual(sorted(visible));
      }
      expect(sorted((await budgets.list(organizationId, null)).map((b) => b.id))).toEqual(sorted(visible));
      expect(sorted((await budgets.list(organizationId, users.owner)).map((b) => b.id))).toEqual(
        sorted([...visible, budgetIds.privateAgent]),
      );
    });

    it('answers 404 to anyone else for get, update and delete', async () => {
      await expect(budgets.get(budgetIds.privateAgent, organizationId, users.admin)).rejects.toThrow(NotFoundException);
      await expect(
        budgets.update(budgetIds.privateAgent, organizationId, { limitCents: 1 }, users.admin),
      ).rejects.toThrow(NotFoundException);
      await expect(budgets.remove(budgetIds.privateAgent, organizationId, users.peer)).rejects.toThrow(NotFoundException);
      expect((await repo(SpendBudget).findOneBy({ id: budgetIds.privateAgent }))?.limitCents).toBe(1000);
      await expect(budgets.get(budgetIds.privateAgent, organizationId, users.owner)).resolves.toMatchObject({
        agentId: ids.privateAgent,
      });
    });

    it('refuses a budget on the private agent from anyone but its owner', async () => {
      await expect(
        budgets.create(organizationId, { limitCents: 500, agentId: ids.privateAgent }, users.admin),
      ).rejects.toThrow(NotFoundException);
      await expect(
        budgets.update(budgetIds.orgWide, organizationId, { agentId: ids.privateAgent }, users.admin),
      ).rejects.toThrow(NotFoundException);
      expect((await repo(SpendBudget).findOneBy({ id: budgetIds.orgWide }))?.agentId).toBeNull();

      const own = await budgets.create(organizationId, { limitCents: 500, agentId: ids.privateAgent }, users.owner);
      expect(own.agentId).toBe(ids.privateAgent);
      await repo(SpendBudget).delete({ id: own.id });
    });
  });

  describe('breach alerts', () => {
    it('keeps a breach on the private agent from everyone but its owner', async () => {
      const visible = [alertIds.orgAgent, alertIds.orgWide];
      for (const viewer of ['peer', 'admin'] as const) {
        expect((await budgets.listAlerts(organizationId, users[viewer])).map((a) => a.id)).toEqual(visible);
      }
      expect((await budgets.listAlerts(organizationId, undefined)).map((a) => a.id)).toEqual(visible);
      expect((await budgets.listAlerts(organizationId, users.owner)).map((a) => a.id)).toEqual([
        alertIds.privateAgent, ...visible,
      ]);
      // The limit applies after the filter: the newest visible row, not an empty page.
      expect((await budgets.listAlerts(organizationId, users.admin, 1)).map((a) => a.id)).toEqual([alertIds.orgAgent]);
    });
  });

  describe('spend by agent', () => {
    const from = new Date('2000-01-01T00:00:00Z');

    it("drops other members' private agents from the breakdown, keeps the org total", async () => {
      for (const viewer of ['peer', 'admin'] as const) {
        const summary = await spend.getSummary(organizationId, { from, viewerId: users[viewer] });
        expect(summary.byAgent.map((r) => r.agentId)).toEqual([ids.orgAgent]);
        expect(summary.totalCents).toBe(500);
      }
      const anonymous = await spend.getSummary(organizationId, { from, viewerId: null });
      expect(anonymous.byAgent.map((r) => r.agentId)).toEqual([ids.orgAgent]);

      const own = await spend.getSummary(organizationId, { from, viewerId: users.owner });
      expect(own.byAgent.map((r) => r.agentId)).toEqual([ids.privateAgent, ids.orgAgent]);
    });
  });
});
