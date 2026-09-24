import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { Gateway, GatewayType } from '../../entities/gateway.entity';
import { Organization } from '../../entities/organization.entity';
import { Team } from '../../entities/team.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import {
  ExecutionAccessService,
  gatewayPrincipal,
  userPrincipal,
} from '../../common/authorization/execution-access.service';

/**
 * The execution gate (ExecutionAccessService) against real Postgres: real
 * migrations (so the visibility CHECK constraints hold on every seeded row),
 * the real AccessPolicyService over real user_organizations / user_teams
 * repositories, and no mocks anywhere in the decision.
 *
 * What it proves:
 * - team scope is an execution boundary for users: team members and org
 *   owners/admins run a team resource, other members, departed members and
 *   outsiders do not; private is the owner's alone, admins included;
 * - a gateway runs only what its own scope covers, re-evaluated on every
 *   call (a private gateway whose owner leaves the team stops serving it);
 * - read and execute never disagree: for every user x every agent and tool,
 *   canExecute equals "applyListFilter returns the row".
 *
 * Gated on RUN_DB_INTEGRATION=1. Own schema so parallel workers do not race
 * each other's DDL.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'execution_access_test';

jest.setTimeout(120_000);

type UserKey = 'ownerRole' | 'admin' | 'teamMember' | 'otherMember' | 'exMember' | 'outsider';
type ResourceKey = 'org' | 'teamT1' | 'teamT2' | 'privateMine' | 'privateOther' | 'orgB';

describeIfDb('execution access gate (real Postgres)', () => {
  let ds: DataSource;
  let policy: AccessPolicyService;
  let gate: ExecutionAccessService;

  let orgA: string;
  let orgB: string;
  let t1: string;
  let t2: string;
  const users = {} as Record<UserKey, string>;
  const agents = {} as Record<ResourceKey, Agent>;
  const tools = {} as Record<ResourceKey, Tool>;
  const gateways = {} as Record<
    'org' | 'teamT1' | 'teamT2' | 'privateTeamMember' | 'privateOther' | 'orgB' | 'system',
    Gateway
  >;

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

    orgA = (await save(ds.getRepository(Organization), { name: 'Org A', slug: 'exec-org-a' })).id;
    orgB = (await save(ds.getRepository(Organization), { name: 'Org B', slug: 'exec-org-b' })).id;
    t1 = (await save(ds.getRepository(Team), { name: 'T1', organizationId: orgA })).id;
    t2 = (await save(ds.getRepository(Team), { name: 'T2', organizationId: orgA })).id;

    const cast: Record<UserKey, { org: string; role: OrganizationRole }> = {
      ownerRole: { org: orgA, role: OrganizationRole.OWNER },
      admin: { org: orgA, role: OrganizationRole.ADMIN },
      teamMember: { org: orgA, role: OrganizationRole.MEMBER },
      otherMember: { org: orgA, role: OrganizationRole.MEMBER },
      exMember: { org: orgA, role: OrganizationRole.MEMBER },
      outsider: { org: orgB, role: OrganizationRole.MEMBER },
    };
    for (const key of Object.keys(cast) as UserKey[]) {
      users[key] = (await save(ds.getRepository(User), {
        email: `${key}@exec.test`, passwordHash: 'x', firstName: key, lastName: 'T',
      })).id;
      await save(ds.getRepository(UserOrganization), {
        userId: users[key], organizationId: cast[key].org, role: cast[key].role, isActive: true,
      });
    }
    const userTeams = ds.getRepository(UserTeam);
    await save(userTeams, { userId: users.teamMember, teamId: t1, role: TeamRole.MEMBER, isActive: true });
    await save(userTeams, { userId: users.otherMember, teamId: t2, role: TeamRole.MEMBER, isActive: true });
    await save(userTeams, { userId: users.exMember, teamId: t1, role: TeamRole.MEMBER, isActive: false });

    const scopes: Record<ResourceKey, Record<string, unknown>> = {
      org: { organizationId: orgA, visibility: 'org', teamId: null, createdBy: users.admin },
      teamT1: { organizationId: orgA, visibility: 'team', teamId: t1, createdBy: users.teamMember },
      teamT2: { organizationId: orgA, visibility: 'team', teamId: t2, createdBy: users.otherMember },
      privateMine: { organizationId: orgA, visibility: 'private', teamId: null, createdBy: users.teamMember },
      privateOther: { organizationId: orgA, visibility: 'private', teamId: null, createdBy: users.otherMember },
      orgB: { organizationId: orgB, visibility: 'org', teamId: null, createdBy: users.outsider },
    };
    for (const key of Object.keys(scopes) as ResourceKey[]) {
      const agent = await save(ds.getRepository(Agent), {
        ...scopes[key], name: `agent ${key}`, status: AgentStatus.ACTIVE, pipeline: { nodes: [], edges: [] },
      });
      const tool = await save(ds.getRepository(Tool), {
        ...scopes[key], name: `tool_${key}`, type: ToolType.FUNCTION, status: ToolStatus.ACTIVE, parameters: {},
      });
      // Reload: the gate sees rows exactly as the executors load them.
      agents[key] = await ds.getRepository(Agent).findOneByOrFail({ id: agent.id });
      tools[key] = await ds.getRepository(Tool).findOneByOrFail({ id: tool.id });
    }

    const gw = (key: keyof typeof gateways, fields: Record<string, unknown>) =>
      save(ds.getRepository(Gateway), {
        name: `gw ${key}`, type: GatewayType.MCP, endpoint: `/gw-${key}`, configuration: {}, ...fields,
      }).then((row) => { gateways[key] = row; });
    await gw('org', { organizationId: orgA, visibility: 'org' });
    await gw('teamT1', { organizationId: orgA, visibility: 'team', teamId: t1 });
    await gw('teamT2', { organizationId: orgA, visibility: 'team', teamId: t2 });
    await gw('privateTeamMember', { organizationId: orgA, visibility: 'private', ownerUserId: users.teamMember });
    await gw('privateOther', { organizationId: orgA, visibility: 'private', ownerUserId: users.otherMember });
    await gw('orgB', { organizationId: orgB, visibility: 'org' });
    await gw('system', { organizationId: orgA, visibility: 'org', isSystem: true });

    policy = new AccessPolicyService(ds.getRepository(UserOrganization), ds.getRepository(UserTeam));
    gate = new ExecutionAccessService(policy);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const allowed = async (principal: Parameters<ExecutionAccessService['canExecute']>[0], row: Agent | Tool) =>
    (await gate.canExecute(principal, row)).allowed;
  const asUser = (key: UserKey) => userPrincipal(users[key]);
  // Denials are 404s with the missing-resource message, never 403s.
  const expectNotFound = async (pending: Promise<unknown>, kind: 'Agent' | 'Tool') => {
    const err = await pending.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as Error).message).toBe(`${kind} not found`);
  };

  // ── User principals ───────────────────────────────────────────────────

  describe('user principals', () => {
    it('runs a team resource for its team members and org owners/admins only', async () => {
      for (const row of [agents.teamT1, tools.teamT1]) {
        expect(await allowed(asUser('teamMember'), row)).toBe(true);
        expect(await allowed(asUser('admin'), row)).toBe(true);
        expect(await allowed(asUser('ownerRole'), row)).toBe(true);
        expect(await allowed(asUser('otherMember'), row)).toBe(false);
        expect(await allowed(asUser('exMember'), row)).toBe(false);
        expect(await allowed(asUser('outsider'), row)).toBe(false);
      }
    });

    it('answers a denied team run with "not found", never 403', async () => {
      await expect(gate.assertCanExecute(asUser('teamMember'), agents.teamT1, 'Agent')).resolves.toBeUndefined();
      await expectNotFound(gate.assertCanExecute(asUser('otherMember'), agents.teamT1, 'Agent'), 'Agent');
      await expectNotFound(gate.assertCanExecute(asUser('exMember'), tools.teamT1, 'Tool'), 'Tool');
      await expectNotFound(gate.assertCanExecute(asUser('outsider'), tools.teamT1, 'Tool'), 'Tool');
      await expectNotFound(gate.assertCanExecute(asUser('teamMember'), null, 'Tool'), 'Tool');
    });

    it('runs a private resource for its owner only, org owner and admin included in the refusal', async () => {
      for (const row of [agents.privateMine, tools.privateMine]) {
        expect(await allowed(asUser('teamMember'), row)).toBe(true);
        for (const other of ['admin', 'ownerRole', 'otherMember', 'exMember', 'outsider'] as const) {
          expect(await allowed(asUser(other), row)).toBe(false);
        }
      }
      await expectNotFound(gate.assertCanExecute(asUser('admin'), agents.privateMine, 'Agent'), 'Agent');
      await expectNotFound(gate.assertCanExecute(asUser('ownerRole'), tools.privateMine, 'Tool'), 'Tool');
    });

    it('runs an org resource for every member of the org and nobody outside it', async () => {
      for (const row of [agents.org, tools.org]) {
        for (const member of ['ownerRole', 'admin', 'teamMember', 'otherMember', 'exMember'] as const) {
          expect(await allowed(asUser(member), row)).toBe(true);
        }
        expect(await allowed(asUser('outsider'), row)).toBe(false);
      }
    });

    it('runs only org resources for nobody (null or a non-uuid "system" id)', async () => {
      for (const nobody of [userPrincipal(null), userPrincipal('system')]) {
        expect(nobody.userId).toBeNull();
        for (const kind of [agents, tools]) {
          expect(await allowed(nobody, kind.org)).toBe(true);
          expect(await allowed(nobody, kind.teamT1)).toBe(false);
          expect(await allowed(nobody, kind.privateMine)).toBe(false);
        }
      }
    });
  });

  // ── Read and execute agree ────────────────────────────────────────────

  describe('read and execute never disagree', () => {
    const readable = async (alias: string, repo: Repository<Agent> | Repository<Tool>, userId: string, row: Agent | Tool) => {
      const qb = (repo as Repository<ObjectLiteral>).createQueryBuilder(alias).where(`${alias}.id = :rowId`, { rowId: row.id });
      try {
        await policy.applyListFilter(qb, { id: userId }, row.organizationId, alias, { ownerColumn: 'createdBy' });
      } catch (err) {
        // A non-member of the row's org is refused the list outright.
        expect(err).toBeInstanceOf(ForbiddenException);
        return false;
      }
      return (await qb.getCount()) === 1;
    };

    for (const [label, pick, alias] of [
      ['agents', () => ({ rows: agents, repo: ds.getRepository(Agent) }), 'a'],
      ['tools', () => ({ rows: tools, repo: ds.getRepository(Tool) }), 't'],
    ] as const) {
      it(`canExecute equals applyListFilter for every user x every ${label}`, async () => {
        const { rows, repo } = pick();
        const mismatches: string[] = [];
        let allowedCount = 0;
        let deniedCount = 0;
        for (const userKey of Object.keys(users) as UserKey[]) {
          for (const rowKey of Object.keys(rows) as ResourceKey[]) {
            const row = rows[rowKey];
            const read = await readable(alias, repo, users[userKey], row);
            const run = await allowed(asUser(userKey), row);
            if (read !== run) mismatches.push(`${userKey} x ${rowKey}: read=${read} execute=${run}`);
            if (run) allowedCount++;
            else deniedCount++;
          }
        }
        expect(mismatches).toEqual([]);
        // The matrix is not trivially all-yes or all-no.
        expect(allowedCount).toBeGreaterThan(5);
        expect(deniedCount).toBeGreaterThan(5);
      });
    }
  });

  // ── Gateway principals ────────────────────────────────────────────────

  describe('gateway principals', () => {
    const viaGateway = (key: keyof typeof gateways, callerUserId?: string | null) =>
      gatewayPrincipal(gateways[key], callerUserId);

    it('an org gateway runs org resources, never team or private ones', async () => {
      for (const kind of [agents, tools]) {
        expect(await allowed(viaGateway('org'), kind.org)).toBe(true);
        expect(await allowed(viaGateway('org'), kind.teamT1)).toBe(false);
        expect(await allowed(viaGateway('org'), kind.privateMine)).toBe(false);
      }
    });

    it('a team gateway runs its own team\'s resources and not another team\'s', async () => {
      for (const kind of [agents, tools]) {
        expect(await allowed(viaGateway('teamT1'), kind.teamT1)).toBe(true);
        expect(await allowed(viaGateway('teamT1'), kind.teamT2)).toBe(false);
        expect(await allowed(viaGateway('teamT2'), kind.teamT1)).toBe(false);
        expect(await allowed(viaGateway('teamT1'), kind.org)).toBe(true);
      }
    });

    it('a private gateway runs what its owner may run: their team\'s and their own private resources', async () => {
      for (const kind of [agents, tools]) {
        expect(await allowed(viaGateway('privateTeamMember'), kind.teamT1)).toBe(true);
        expect(await allowed(viaGateway('privateTeamMember'), kind.privateMine)).toBe(true);
        expect(await allowed(viaGateway('privateTeamMember'), kind.privateOther)).toBe(false);
        expect(await allowed(viaGateway('privateOther'), kind.teamT1)).toBe(false);
        expect(await allowed(viaGateway('privateOther'), kind.privateMine)).toBe(false);
      }
    });

    it('re-evaluates at call time: the owner leaving the team stops their private gateway serving it', async () => {
      const principal = viaGateway('privateTeamMember');
      expect(await allowed(principal, agents.teamT1)).toBe(true);
      await ds.getRepository(UserTeam).update({ userId: users.teamMember, teamId: t1 }, { isActive: false });
      try {
        expect(await allowed(principal, agents.teamT1)).toBe(false);
        expect(await allowed(principal, tools.teamT1)).toBe(false);
        await expectNotFound(gate.assertCanExecute(principal, agents.teamT1, 'Agent'), 'Agent');
        // Their own private resource does not depend on the team.
        expect(await allowed(principal, agents.privateMine)).toBe(true);
      } finally {
        await ds.getRepository(UserTeam).update({ userId: users.teamMember, teamId: t1 }, { isActive: true });
      }
      expect(await allowed(principal, agents.teamT1)).toBe(true);
    });

    it('a gateway of another organization runs nothing of this one', async () => {
      for (const kind of [agents, tools]) {
        expect(await allowed(viaGateway('orgB'), kind.org)).toBe(false);
        expect(await allowed(viaGateway('orgB'), kind.orgB)).toBe(true);
      }
    });

    it('the system gateway acts as its caller', async () => {
      expect(viaGateway('system', users.teamMember)).toEqual(userPrincipal(users.teamMember, 'system_gateway'));
      for (const kind of [agents, tools]) {
        expect(await allowed(viaGateway('system', users.teamMember), kind.teamT1)).toBe(true);
        expect(await allowed(viaGateway('system', users.teamMember), kind.privateMine)).toBe(true);
        expect(await allowed(viaGateway('system', users.otherMember), kind.teamT1)).toBe(false);
        expect(await allowed(viaGateway('system', users.admin), kind.privateMine)).toBe(false);
        expect(await allowed(viaGateway('system', null), kind.org)).toBe(true);
        expect(await allowed(viaGateway('system', null), kind.teamT1)).toBe(false);
      }
    });
  });

  // ── Publish time ──────────────────────────────────────────────────────

  describe('assertGatewayMayServe', () => {
    it('refuses a team resource on an org gateway with a 400 that says what to change', async () => {
      await expect(gate.assertGatewayMayServe(gateways.org, agents.teamT1, users.teamMember, 'Agent'))
        .rejects.toBeInstanceOf(BadRequestException);
      await expect(gate.assertGatewayMayServe(gateways.org, tools.teamT1, users.teamMember, 'Tool'))
        .rejects.toThrow(/visible to its team only/);
    });

    it('lets a team member attach their team\'s resource to their team\'s gateway', async () => {
      await expect(gate.assertGatewayMayServe(gateways.teamT1, agents.teamT1, users.teamMember, 'Agent')).resolves.toBeUndefined();
      await expect(gate.assertGatewayMayServe(gateways.teamT1, tools.teamT1, users.teamMember, 'Tool')).resolves.toBeUndefined();
    });

    it('answers "not found" to an actor who could not run the resource themselves', async () => {
      await expectNotFound(gate.assertGatewayMayServe(gateways.teamT1, agents.teamT1, users.otherMember, 'Agent'), 'Agent');
      await expectNotFound(gate.assertGatewayMayServe(gateways.teamT1, tools.teamT1, users.otherMember, 'Tool'), 'Tool');
    });
  });
});
