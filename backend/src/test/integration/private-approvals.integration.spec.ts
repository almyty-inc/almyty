import { NotFoundException } from '@nestjs/common';
import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { Team } from '../../entities/team.entity';
import { gatewayPrincipal } from '../../common/authorization/execution-access.service';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { ApprovalRequest } from '../../entities/approval-request.entity';
import { ApprovalPolicyApprovalRecord } from '../../entities/approval-policy-approval.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { ApprovalsService } from '../../modules/approvals/approvals.service';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';
import { ResourceHandoverHelper } from '../../modules/organizations/resource-handover.helper';

/**
 * An approval a private agent asks for is its owner's alone.
 *
 * The request carries the agent's reason and the tool call it wants to
 * make -- what the "just me" agent is doing, with its arguments. It was
 * written org-wide, so every org owner/admin was notified with the reason,
 * listed it, read it and could decide it. Private means the owner and
 * nobody else, admins included, and a refusal reads like a missing id.
 *
 * Real Postgres, built by the migrations. Gated on RUN_DB_INTEGRATION=1
 * and isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'private_approvals_test';

jest.setTimeout(120_000);

type Who = 'owner' | 'admin' | 'peer' | 'successor';

describeIfDb('approvals of a private agent are its owner\'s alone (real Postgres)', () => {
  let ds: DataSource;
  let organizationId: string;
  const users = {} as Record<Who, string>;
  let privateAgent: string;
  let orgAgent: string;
  let service: ApprovalsService;
  const sent: any[] = [];

  const connection = () => ({
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  });
  const repo = <T extends ObjectLiteral>(entity: new () => T): Repository<T> => ds.getRepository(entity);
  const insert = async (entity: new () => any, data: Record<string, unknown>): Promise<string> =>
    ((await repo(entity).save(repo(entity).create(data as any))) as any).id;
  const run = (agentId: string) =>
    insert(AgentRun, { agentId, organizationId, userId: users.owner, status: AgentRunStatus.RUNNING });
  const request = async (agentId: string) =>
    service.create({
      organizationId, teamId: null, runId: await run(agentId), agentId, toolCallId: null,
      reason: 'wire 4,000 EUR to the landlord', payload: { tool: 'bank.transfer', args: { amount: 4000 } },
    });

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

    organizationId = await insert(Organization, { name: 'Approvals Org', slug: 'approvals-org' });
    const roles: Array<[Who, OrganizationRole]> = [
      ['owner', OrganizationRole.MEMBER],
      ['admin', OrganizationRole.ADMIN],
      ['peer', OrganizationRole.MEMBER],
      ['successor', OrganizationRole.OWNER],
    ];
    for (const [who, role] of roles) {
      users[who] = await insert(User, { email: `${who}@approvals.test`, passwordHash: 'x', firstName: who, lastName: 'T' });
      await insert(UserOrganization, { userId: users[who], organizationId, role, isActive: true, inviteAccepted: true });
    }
    const agent = (visibility: 'org' | 'private') => insert(Agent, {
      name: `${visibility} agent`, status: AgentStatus.ACTIVE, organizationId, pipeline: { nodes: [], edges: [] },
      visibility, createdBy: users.owner,
    });
    privateAgent = await agent('private');
    orgAgent = await agent('org');

    const policy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));
    service = new ApprovalsService(
      repo(ApprovalRequest), repo(AgentRun), repo(ApprovalPolicyApprovalRecord), policy, undefined,
      { emit: async (input: any) => { sent.push(input); } } as any,
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(() => { sent.length = 0; });

  const pendingIds = async (who: Who) =>
    (await service.listPending({ organizationId, caller: { id: users[who] } })).map((r) => r.id);

  it('an org agent\'s approval goes to the org admins, as before', async () => {
    const row = await request(orgAgent);
    expect(row.visibility).toBe('org');
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0].roleTarget).toMatchObject({ orgRoles: ['owner', 'admin'] });
    expect(await pendingIds('admin')).toContain(row.id);
  });

  it('a private agent\'s approval is written private to the agent\'s owner and told to the owner alone', async () => {
    const row = await request(privateAgent);
    expect(row).toMatchObject({ visibility: 'private', ownerUserId: users.owner, teamId: null });
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'approval.pending', userIds: [users.owner] });
    expect(sent[0].roleTarget).toBeUndefined();
  });

  it('nobody else lists it, reads it or decides it -- an org admin included -- and the refusal is a 404', async () => {
    const row = await request(privateAgent);
    expect(await pendingIds('owner')).toContain(row.id);
    for (const who of ['admin', 'peer', 'successor'] as Who[]) {
      expect(await pendingIds(who)).not.toContain(row.id);
      await expect(service.findOne(row.id, { id: users[who] }, organizationId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.approve(row.id, { decidedBy: users[who] }, { id: users[who] }, organizationId))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(service.reject(row.id, { decidedBy: users[who] }, { id: users[who] }, organizationId))
        .rejects.toBeInstanceOf(NotFoundException);
    }
    expect((await repo(ApprovalRequest).findOneByOrFail({ id: row.id })).status).toBe('pending');

    const decided = await service.approve(row.id, { decidedBy: users.owner }, { id: users.owner }, organizationId);
    expect(decided.status).toBe('approved');
  });

  it('moves with the agent when its owner leaves the organization', async () => {
    const row = await request(privateAgent);
    const audit = new AuditLogService(repo(AuditLog), repo(User));
    const handover = new ResourceHandoverHelper(audit, { deleteForDepartedOwner: async () => undefined } as any, {
      wipeInTransaction: async () => ({ audit: [], wiped: [] }),
    } as any);
    await ds.transaction((manager) => handover.handOverPrivateResources(manager, {
      organizationId, fromUserId: users.owner, toUserId: users.successor, actorUserId: users.successor, reason: 'member_removed',
    }));

    expect(await repo(Agent).findOneByOrFail({ id: privateAgent })).toMatchObject({ visibility: 'private', createdBy: users.successor });
    expect(await repo(ApprovalRequest).findOneByOrFail({ id: row.id })).toMatchObject({ visibility: 'private', ownerUserId: users.successor });
    expect(await pendingIds('successor')).toContain(row.id);
    expect(await pendingIds('owner')).not.toContain(row.id);
  });

  it("a run through a gateway asks in the gateway's scope, and nothing decides it for a null user", async () => {
    const teamId = await insert(Team, { name: 'Payments', organizationId });
    await insert(UserTeam, { userId: users.peer, teamId, role: TeamRole.LEAD, isActive: true });
    const viaGateway = (visibility: 'org' | 'team' | 'private', over: Record<string, any> = {}) =>
      gatewayPrincipal({ id: '00000000-0000-4000-8000-0000000000ee', organizationId, visibility, ...over });
    const ask = async (principal: ReturnType<typeof viaGateway>) =>
      service.create({
        organizationId, teamId: null, runId: await run(orgAgent), agentId: orgAgent, toolCallId: null,
        reason: 'refund 90 EUR', payload: { tool: 'payments.refund' }, principal,
      });

    // An org agent run through the Payments gateway: the team's request.
    const teamRow = await ask(viaGateway('team', { teamId }));
    expect(teamRow).toMatchObject({ visibility: 'team', teamId, ownerUserId: null });
    expect(await pendingIds('peer')).toContain(teamRow.id);
    expect(await pendingIds('admin')).toContain(teamRow.id);
    expect(await pendingIds('owner')).not.toContain(teamRow.id);
    await expect(service.approve(teamRow.id, { decidedBy: users.owner }, { id: users.owner }, organizationId))
      .rejects.toBeInstanceOf(NotFoundException);

    // No caller decides nothing: the request stays pending.
    for (const nobody of [null, undefined, '']) {
      await expect(service.approve(teamRow.id, { decidedBy: nobody as any }, { id: nobody as any }, organizationId))
        .rejects.toBeInstanceOf(NotFoundException);
    }
    expect((await repo(ApprovalRequest).findOneByOrFail({ id: teamRow.id })).status).toBe('pending');
    await expect(service.approve(teamRow.id, { decidedBy: users.peer }, { id: users.peer }, organizationId))
      .resolves.toMatchObject({ status: 'approved' });

    // Through a gateway private to its owner: that owner's. Through an org gateway: the agent's scope.
    expect(await ask(viaGateway('private', { ownerUserId: users.peer }))).toMatchObject({ visibility: 'private', ownerUserId: users.peer });
    expect(await ask(viaGateway('org'))).toMatchObject({ visibility: 'org', teamId: null });
  });
});
