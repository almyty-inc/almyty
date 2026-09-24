import { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { Tool, ToolType } from '../../entities/tool.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { LlmProviderType } from '../../entities/llm-provider-type';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { ConnectionGrant } from '../../entities/connection-grant.entity';
import { Runner, RunnerIsolationTier } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace } from '../../entities/workspace.entity';
import { AuditLog, AuditAction, AuditResource } from '../../entities/audit-log.entity';

import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';
import { RunnerService } from '../../modules/runner/runner.service';
import { RunnerCapabilityPublisher } from '../../modules/runner/runner-capability.publisher';
import { OrganizationsService } from '../../modules/organizations/organizations.service';
import { ResourceHandoverHelper } from '../../modules/organizations/resource-handover.helper';
import { ConnectionOffboardingService } from '../../modules/connections/connection-offboarding.service';
import { TeamDeleteDemotesResources1750809000000 } from '../../migrations/1750809000000-TeamDeleteDemotesResources';

/**
 * What happens to resources when the thing that scoped them goes away,
 * against a real Postgres built by the migrations:
 *
 * - a member leaves the organization: their private rows move to the
 *   remover (or, when they leave on their own, to the longest-standing
 *   remaining owner) and stay private; their private runner is deleted
 *   with its published tools; every step is audited.
 * - a team is deleted: its resources become org-wide instead of the
 *   delete failing on the visibility CHECK -- through deleteTeam (audited)
 *   and through a raw DELETE (the trigger).
 *
 * Gated on RUN_DB_INTEGRATION=1 and isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'resource_handover_test';

jest.setTimeout(120_000);

type Kind = 'agent' | 'tool' | 'api' | 'gateway' | 'provider' | 'credential';

const LISTED: Array<{ kind: Kind; entity: EntityTarget<ObjectLiteral>; ownerColumn: 'createdBy' | 'ownerUserId' }> = [
  { kind: 'agent', entity: Agent, ownerColumn: 'createdBy' },
  { kind: 'tool', entity: Tool, ownerColumn: 'createdBy' },
  { kind: 'api', entity: Api, ownerColumn: 'ownerUserId' },
  { kind: 'gateway', entity: Gateway, ownerColumn: 'ownerUserId' },
  { kind: 'provider', entity: LlmProvider, ownerColumn: 'ownerUserId' },
  { kind: 'credential', entity: Credential, ownerColumn: 'ownerUserId' },
];

describeIfDb('Resource handover on member removal and team deletion (real Postgres)', () => {
  let ds: DataSource;
  let policy: AccessPolicyService;
  let runners: RunnerService;
  let orgs: OrganizationsService;
  let organizationId: string;
  let otherOrgId: string;
  let seq = 0;
  let offboarding: ConnectionOffboardingService;
  const providerRevokes: Array<{ id: string; config: unknown }> = [];

  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };

  const repo = <T extends ObjectLiteral>(entity: EntityTarget<T>) => ds.getRepository(entity);
  const save = async <T extends ObjectLiteral>(entity: EntityTarget<T>, data: Record<string, unknown>): Promise<T> =>
    (await repo(entity).save(repo(entity).create(data as any) as any)) as T;

  const makeUser = async (name: string, orgId: string, role: OrganizationRole, joinedAt: Date): Promise<string> => {
    const user = await save(User, { email: `${name}-${++seq}@handover.test`, passwordHash: 'x', firstName: name, lastName: 'T' });
    await save(UserOrganization, { userId: (user as any).id, organizationId: orgId, role, isActive: true, inviteAccepted: true, joinedAt });
    return (user as any).id;
  };

  /** One row of every listed kind with the given scope. */
  const makeResources = async (
    orgId: string,
    owner: string,
    scope: { visibility: 'org' | 'team' | 'private'; teamId?: string | null },
  ): Promise<Record<Kind, string>> => {
    const n = ++seq;
    const common = { organizationId: orgId, visibility: scope.visibility, teamId: scope.teamId ?? null };
    const agent = await save(Agent, { ...common, name: `agent ${n}`, status: AgentStatus.ACTIVE, pipeline: { nodes: [], edges: [] }, createdBy: owner });
    const tool = await save(Tool, { ...common, name: `tool_${n}`, description: 'd', type: ToolType.FUNCTION, parameters: {}, createdBy: owner });
    const api = await save(Api, { ...common, name: `api ${n}`, type: ApiType.OPENAPI, baseUrl: 'https://x.example.com', ownerUserId: owner });
    const gateway = await save(Gateway, {
      ...common, name: `gw ${n}`, type: GatewayType.MCP, kind: GatewayKind.TOOL, endpoint: `/gw-${n}`,
      status: GatewayStatus.ACTIVE, configuration: {}, ownerUserId: owner,
    });
    const provider = await save(LlmProvider, {
      ...common, name: `prov ${n}`, type: LlmProviderType.OPENAI, configuration: { model: 'm' },
      status: LlmProviderStatus.ACTIVE, ownerUserId: owner,
    });
    const credential = await save(Credential, {
      ...common, name: `cred ${n}`, type: CredentialType.API_KEY, config: { apiKey: 'k' }, isActive: true, ownerUserId: owner,
    });
    return {
      agent: (agent as any).id, tool: (tool as any).id, api: (api as any).id,
      gateway: (gateway as any).id, provider: (provider as any).id, credential: (credential as any).id,
    };
  };

  /** The ids a user's list of `kind` returns, through the real list filter. */
  const listIds = async (userId: string, orgId: string, kind: Kind): Promise<string[]> => {
    const { entity, ownerColumn } = LISTED.find((l) => l.kind === kind)!;
    const qb = repo(entity).createQueryBuilder('r');
    await policy.applyListFilter(qb, { id: userId }, orgId, 'r', { ownerColumn });
    return (await qb.getMany()).map((row: any) => row.id);
  };

  const runnerInput = (name: string, visibility: 'org' | 'private') => ({
    name,
    visibility,
    labels: {},
    runtimeInfo: {
      os: 'darwin', arch: 'arm64', hostname: 'mac', cpuCount: 8, memoryMb: 16_000,
      runnerVersion: '1.5.0', binaries: { node: 'v22' },
    },
    config: {
      defaultIsolation: RunnerIsolationTier.HOST, maxConcurrent: 2, allowedCwdRoots: [],
      denyPatterns: [], networkBlocked: false, installBlocked: true,
    },
  });

  beforeAll(async () => {
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
    await bootstrap.destroy();

    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
    });
    await ds.initialize();

    policy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));
    runners = new RunnerService(
      repo(Runner), repo(RunnerSession), repo(Workspace),
      new RunnerCapabilityPublisher(repo(Tool)),
      policy,
    );
    const audit = new AuditLogService(repo(AuditLog), repo(User));
    // The provider boundary: records what each revoke was asked with.
    const providers = {
      revokeAtProvider: async (row: Credential) => {
        providerRevokes.push({ id: row.id, config: row.config });
        return { attempted: true, revoked: true, via: 'connector' as const };
      },
    };
    offboarding = new ConnectionOffboardingService(repo(Credential), providers as any, audit);
    orgs = new OrganizationsService(
      repo(Organization), repo(UserOrganization), repo(Team), repo(UserTeam), repo(User),
      {} as any, // MailService
      {} as any, // GatewaysService
      {} as any, // OrganizationsInvitesHelper
      {} as any, // TeamMembershipHelper
      undefined, undefined, undefined,
      new ResourceHandoverHelper(audit, runners, offboarding),
      audit,
    );

    organizationId = (await save(Organization, { name: 'Handover Org', slug: 'handover-org' }) as any).id;
    otherOrgId = (await save(Organization, { name: 'Other Org', slug: 'other-org' }) as any).id;
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const auditRows = (where: Record<string, unknown>) =>
    repo(AuditLog).find({ where: { organizationId, ...where } as any });

  describe('member removal (gap 6)', () => {
    let founder: string; // longest-standing owner
    let lateOwner: string; // an owner who joined later
    let admin: string; // does the removing
    let peer: string;
    let leaver: string;
    let leaverPrivate: Record<Kind, string>;
    let leaverOrgWide: Record<Kind, string>;
    let leaverElsewhere: Record<Kind, string>;
    let runnerId: string;

    beforeAll(async () => {
      founder = await makeUser('founder', organizationId, OrganizationRole.OWNER, new Date('2024-01-01'));
      lateOwner = await makeUser('late-owner', organizationId, OrganizationRole.OWNER, new Date('2025-06-01'));
      admin = await makeUser('admin', organizationId, OrganizationRole.ADMIN, new Date('2024-03-01'));
      peer = await makeUser('peer', organizationId, OrganizationRole.MEMBER, new Date('2024-04-01'));
      leaver = await makeUser('leaver', organizationId, OrganizationRole.MEMBER, new Date('2024-05-01'));
      await save(UserOrganization, {
        userId: leaver, organizationId: otherOrgId, role: OrganizationRole.MEMBER, isActive: true, inviteAccepted: true,
      });

      leaverPrivate = await makeResources(organizationId, leaver, { visibility: 'private' });
      leaverOrgWide = await makeResources(organizationId, leaver, { visibility: 'org' });
      leaverElsewhere = await makeResources(otherOrgId, leaver, { visibility: 'private' });
      const { runner } = await runners.register(runnerInput('leaver-mac', 'private'), leaver, organizationId);
      runnerId = runner.id;
    });

    it('before removal, only the leaver sees their private rows', async () => {
      for (const { kind } of LISTED) {
        expect(await listIds(leaver, organizationId, kind)).toContain(leaverPrivate[kind]);
        for (const who of [admin, founder, peer]) {
          expect(await listIds(who, organizationId, kind)).not.toContain(leaverPrivate[kind]);
        }
      }
      const runnerTools = await repo(Tool).createQueryBuilder('t')
        .where(`t."runnerConfig"->>'runnerId' = :runnerId`, { runnerId }).getMany();
      expect(runnerTools.length).toBeGreaterThan(0);
      expect(runnerTools.every((t) => t.visibility === 'private' && t.createdBy === leaver)).toBe(true);
    });

    it('hands every private row to the remover, still private, and deletes the private runner', async () => {
      await orgs.removeMember(organizationId, leaver, admin);

      expect(await repo(UserOrganization).findOne({ where: { organizationId, userId: leaver } })).toBeNull();

      for (const { kind, entity, ownerColumn } of LISTED) {
        const row: any = await repo(entity).findOne({ where: { id: leaverPrivate[kind] } as any });
        expect(row.visibility).toBe('private');
        expect(row[ownerColumn]).toBe(admin);
        // The remover now lists it; nobody else does, owners included.
        expect(await listIds(admin, organizationId, kind)).toContain(leaverPrivate[kind]);
        for (const who of [founder, lateOwner, peer]) {
          expect(await listIds(who, organizationId, kind)).not.toContain(leaverPrivate[kind]);
        }
        // Org-wide rows keep their owner and stay visible to everyone.
        const shared: any = await repo(entity).findOne({ where: { id: leaverOrgWide[kind] } as any });
        expect(shared[ownerColumn]).toBe(leaver);
        expect(await listIds(peer, organizationId, kind)).toContain(leaverOrgWide[kind]);
        // Another organization's rows are not this removal's business.
        const elsewhere: any = await repo(entity).findOne({ where: { id: leaverElsewhere[kind] } as any });
        expect(elsewhere[ownerColumn]).toBe(leaver);
      }

      expect(await repo(Runner).findOne({ where: { id: runnerId } })).toBeNull();
      const runnerTools = await repo(Tool).createQueryBuilder('t')
        .where(`t."runnerConfig"->>'runnerId' = :runnerId`, { runnerId }).getMany();
      expect(runnerTools).toEqual([]);
    });

    it('audits every transfer and the runner deletion', async () => {
      const transfers = await auditRows({ action: AuditAction.OWNERSHIP_TRANSFER, userId: admin });
      const byResource = new Map(transfers.map((a) => [a.resourceId, a]));
      for (const { kind } of LISTED) {
        const entry = byResource.get(leaverPrivate[kind]);
        expect(entry).toBeDefined();
        expect(entry!.details).toMatchObject({ reason: 'member_removed', fromUserId: leaver, toUserId: admin });
        expect(entry!.resourceName).toBeTruthy();
      }
      // Only the private rows moved: runner tools went with the runner.
      expect(transfers).toHaveLength(LISTED.length);

      const runnerDeletes = await auditRows({ action: AuditAction.DELETE, resourceType: AuditResource.RUNNER });
      expect(runnerDeletes).toHaveLength(1);
      expect(runnerDeletes[0]).toMatchObject({ resourceId: runnerId, resourceName: 'leaver-mac', userId: admin });
      expect(runnerDeletes[0].details).toMatchObject({ reason: 'member_removed', ownerUserId: leaver });
    });

    it('a member leaving on their own hands over to the longest-standing remaining owner', async () => {
      const quitter = await makeUser('quitter', organizationId, OrganizationRole.MEMBER, new Date('2024-02-01'));
      const own = await makeResources(organizationId, quitter, { visibility: 'private' });

      await orgs.removeMember(organizationId, quitter, quitter);

      for (const { kind, entity, ownerColumn } of LISTED) {
        const row: any = await repo(entity).findOne({ where: { id: own[kind] } as any });
        expect(row.visibility).toBe('private');
        expect(row[ownerColumn]).toBe(founder);
        expect(row[ownerColumn]).not.toBe(lateOwner);
      }
      const entries = await auditRows({ action: AuditAction.OWNERSHIP_TRANSFER, userId: quitter });
      expect(entries).toHaveLength(LISTED.length);
      expect(entries.every((e) => (e.details as any).reason === 'member_left' && (e.details as any).toUserId === founder)).toBe(true);
    });

    it('rolls the handover back when the membership removal fails', async () => {
      const stayer = await makeUser('stayer', organizationId, OrganizationRole.MEMBER, new Date('2024-02-02'));
      const own = await makeResources(organizationId, stayer, { visibility: 'private' });
      // Fail the last step -- the membership delete -- after the handover
      // already ran inside the transaction.
      const membership = await repo(UserOrganization).findOne({ where: { organizationId, userId: stayer } });
      await ds.query(`
        CREATE OR REPLACE FUNCTION refuse_membership_delete() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'membership delete refused'; END; $$ LANGUAGE plpgsql`);
      await ds.query(`CREATE TRIGGER refuse_membership_delete BEFORE DELETE ON user_organizations
        FOR EACH ROW WHEN (OLD.id = '${membership!.id}') EXECUTE FUNCTION refuse_membership_delete()`);
      try {
        await expect(orgs.removeMember(organizationId, stayer, admin)).rejects.toThrow(/membership delete refused/);
      } finally {
        await ds.query(`DROP TRIGGER refuse_membership_delete ON user_organizations`);
      }

      for (const { kind, entity, ownerColumn } of LISTED) {
        const row: any = await repo(entity).findOne({ where: { id: own[kind] } as any });
        expect(row[ownerColumn]).toBe(stayer);
      }
      const entries = await repo(AuditLog).createQueryBuilder('a')
        .where('a."resourceId" IN (:...ids)', { ids: Object.values(own) }).getMany();
      expect(entries).toEqual([]);
    });
  });

  describe('member removal: runners, connections and grants', () => {
    let remover: string;
    let peer: string;
    let leaver: string;
    let runnerId: string;
    let personalConn: string;
    let privateConn: string;
    let managedConn: string;
    let orgConn: string;
    let otherOrgConn: string;

    const connectionRow = (orgId: string, extra: Record<string, unknown>) => save(Credential, {
      organizationId: orgId, name: `conn ${++seq}`, type: CredentialType.API_KEY, connectorKey: 'openai',
      config: { apiKey: 'encrypted:gcm:aa:bb:cc' }, isActive: true, healthStatus: 'valid', visibility: 'org', teamId: null, ...extra,
    });
    const grant = (connectionId: string, orgId: string, principalType: string, principalId: string) =>
      save(ConnectionGrant, { organizationId: orgId, connectionId, principalType, principalId, permission: 'use' });

    beforeAll(async () => {
      remover = await makeUser('conn-remover', organizationId, OrganizationRole.ADMIN, new Date('2024-01-05'));
      peer = await makeUser('conn-peer', organizationId, OrganizationRole.MEMBER, new Date('2024-01-06'));
      leaver = await makeUser('conn-leaver', organizationId, OrganizationRole.MEMBER, new Date('2024-01-07'));
      await save(UserOrganization, { userId: leaver, organizationId: otherOrgId, role: OrganizationRole.MEMBER, isActive: true, inviteAccepted: true });

      // An org-visible runner on the leaver's machine.
      runnerId = (await runners.register(runnerInput('leaver-shared-box', 'org'), leaver, organizationId)).runner.id;

      personalConn = (await connectionRow(organizationId, { ownerUserId: leaver }) as any).id;
      privateConn = (await connectionRow(organizationId, { ownerUserId: leaver, visibility: 'private' }) as any).id;
      managedConn = (await connectionRow(organizationId, {
        ownerUserId: leaver, visibility: 'private', metadata: { managedBy: { kind: 'llm_provider', id: 'p-1' } },
      }) as any).id;
      orgConn = (await connectionRow(organizationId, { ownerUserId: null }) as any).id;
      otherOrgConn = (await connectionRow(otherOrgId, { ownerUserId: leaver }) as any).id;

      await grant(personalConn, organizationId, 'role', 'member');
      await grant(orgConn, organizationId, 'user', leaver);
      await grant(orgConn, organizationId, 'user', peer);
      await grant(otherOrgConn, otherOrgId, 'user', leaver);
    });

    it('deregisters the leaver\'s org-visible runner with its tools', async () => {
      const toolsBefore = await repo(Tool).createQueryBuilder('t')
        .where(`t."runnerConfig"->>'runnerId' = :runnerId`, { runnerId }).getMany();
      expect(toolsBefore.length).toBeGreaterThan(0);

      await orgs.removeMember(organizationId, leaver, remover);

      expect(await repo(Runner).findOne({ where: { id: runnerId } })).toBeNull();
      const toolsAfter = await repo(Tool).createQueryBuilder('t')
        .where(`t."runnerConfig"->>'runnerId' = :runnerId`, { runnerId }).getMany();
      expect(toolsAfter).toEqual([]);
      const [deleted] = await auditRows({ action: AuditAction.DELETE, resourceType: AuditResource.RUNNER, resourceId: runnerId });
      expect(deleted.details).toMatchObject({ reason: 'member_removed', ownerUserId: leaver, visibility: 'org' });
    });

    it('revokes the leaver\'s Personal and Private connections: secret wiped, inactive, grants gone, audited', async () => {
      for (const id of [personalConn, privateConn]) {
        const row = await repo(Credential).findOne({ where: { id } });
        expect(row).toMatchObject({ isActive: false, healthStatus: 'revoked', ownerUserId: leaver });
        expect(row!.config).toEqual({});
        const [entry] = await auditRows({ action: AuditAction.CONNECTION_DISCONNECT, resourceId: id });
        expect(entry).toMatchObject({ userId: remover, resourceType: AuditResource.CONNECTION });
        expect(entry.details).toMatchObject({ reason: 'member_removed', ownerUserId: leaver, secretWiped: true, providerRevoke: 'after_commit' });
      }
      // After commit, each was revoked at the provider with the secret it
      // held before the wipe (read in the same statement that wiped it).
      expect(providerRevokes).toEqual(expect.arrayContaining([
        { id: personalConn, config: { apiKey: 'encrypted:gcm:aa:bb:cc' } },
        { id: privateConn, config: { apiKey: 'encrypted:gcm:aa:bb:cc' } },
      ]));
      expect(providerRevokes.map((r) => r.id)).not.toEqual(expect.arrayContaining([managedConn]));
      expect(providerRevokes.map((r) => r.id)).not.toEqual(expect.arrayContaining([orgConn]));
      expect(providerRevokes.map((r) => r.id)).not.toEqual(expect.arrayContaining([otherOrgConn]));
      const [revokedAtProvider] = await auditRows({ action: AuditAction.CONNECTION_REVOKE, resourceId: personalConn });
      expect(revokedAtProvider).toMatchObject({ userId: remover });
      expect(revokedAtProvider.details).toMatchObject({ stage: 'provider', revoked: true, reason: 'member_removed', ownerUserId: leaver });
      // Not handed to the remover: the account is the leaver's.
      expect((await repo(Credential).findOne({ where: { id: privateConn } }))!.visibility).toBe('private');
      expect(await repo(ConnectionGrant).find({ where: { connectionId: personalConn } })).toEqual([]);
      const [personalEntry] = await auditRows({ action: AuditAction.CONNECTION_DISCONNECT, resourceId: personalConn });
      expect(personalEntry.details).toMatchObject({ owner: 'user', grantsRemoved: 1 });
    });

    it('leaves a key an LLM provider manages to the provider handover, and org connections alone', async () => {
      const managed = await repo(Credential).findOne({ where: { id: managedConn } });
      expect(managed).toMatchObject({ isActive: true, ownerUserId: remover, visibility: 'private' });
      expect(managed!.config).toEqual({ apiKey: 'encrypted:gcm:aa:bb:cc' });

      const org = await repo(Credential).findOne({ where: { id: orgConn } });
      expect(org).toMatchObject({ isActive: true, healthStatus: 'valid' });
    });

    it('removes grants naming the leaver in this organization only, and audits them', async () => {
      const remaining = await repo(ConnectionGrant).find({ where: { connectionId: orgConn } });
      expect(remaining.map((g) => g.principalId)).toEqual([peer]);
      const [entry] = await auditRows({ action: AuditAction.CONNECTION_REVOKE_GRANT, resourceId: orgConn });
      expect(entry.details).toMatchObject({ reason: 'member_removed', principalType: 'user', principalId: leaver });

      // Another organization's connection and grant are untouched.
      expect(await repo(Credential).findOne({ where: { id: otherOrgConn } })).toMatchObject({ isActive: true, healthStatus: 'valid' });
      expect(await repo(ConnectionGrant).find({ where: { connectionId: otherOrgConn } })).toHaveLength(1);
    });

    it('on account deletion, wipes the person\'s connections in every organization and revokes them at the provider', async () => {
      providerRevokes.length = 0;

      await offboarding.offboard({ organizationId: null, userId: leaver, actorUserId: null, reason: 'user_deleted' });

      const other = await repo(Credential).findOne({ where: { id: otherOrgConn } });
      expect(other).toMatchObject({ isActive: false, healthStatus: 'revoked', healthError: "the owner's account was deleted" });
      expect(other!.config).toEqual({});
      expect(await repo(ConnectionGrant).find({ where: { connectionId: otherOrgConn } })).toEqual([]);
      // Rows wiped earlier hold no secret any more, so no provider is asked about them again.
      expect(providerRevokes).toEqual([{ id: otherOrgConn, config: { apiKey: 'encrypted:gcm:aa:bb:cc' } }]);
    });
  });

  describe('team deletion (gap 9)', () => {
    let owner: string;
    let lead: string;
    let outsider: string;

    beforeAll(async () => {
      owner = await makeUser('team-org-owner', organizationId, OrganizationRole.OWNER, new Date('2024-01-02'));
      lead = await makeUser('team-lead', organizationId, OrganizationRole.MEMBER, new Date('2024-01-03'));
      outsider = await makeUser('not-on-team', organizationId, OrganizationRole.MEMBER, new Date('2024-01-04'));
    });

    const makeTeam = async (name: string) => {
      const team = await save(Team, { name, organizationId, isDefault: false });
      await save(UserTeam, { userId: lead, teamId: (team as any).id, role: 'member', isActive: true });
      return (team as any).id as string;
    };

    const makeTeamRunner = async (teamId: string) => {
      const runnerOwner = await makeUser(`runner-owner-${teamId.slice(0, 6)}`, organizationId, OrganizationRole.MEMBER, new Date());
      const runner = await save(Runner, {
        name: `team-box-${++seq}`, ownerUserId: runnerOwner, organizationId, visibility: 'team', teamId,
      });
      return (runner as any).id as string;
    };

    const expectOrgWide = async (ids: Record<Kind, string>, runnerId: string) => {
      for (const { kind, entity } of LISTED) {
        const row: any = await repo(entity).findOne({ where: { id: ids[kind] } as any });
        expect({ kind, visibility: row.visibility, teamId: row.teamId }).toEqual({ kind, visibility: 'org', teamId: null });
        expect(await listIds(outsider, organizationId, kind)).toContain(ids[kind]);
      }
      const runner = await repo(Runner).findOne({ where: { id: runnerId } });
      expect(runner).toMatchObject({ visibility: 'org', teamId: null });
    };

    it('reproduces the failure: without the trigger, deleting a team that scopes resources hits the CHECK', async () => {
      const teamId = await makeTeam('Doomed without trigger');
      await makeResources(organizationId, lead, { visibility: 'team', teamId });

      const runner = ds.createQueryRunner();
      await runner.connect();
      try {
        await new TeamDeleteDemotesResources1750809000000().down(runner);
        await expect(ds.query(`DELETE FROM teams WHERE id = $1`, [teamId])).rejects.toThrow(/_visibility_team_chk/);
      } finally {
        await new TeamDeleteDemotesResources1750809000000().up(runner);
        await runner.release();
      }
      expect(await repo(Team).findOne({ where: { id: teamId } })).not.toBeNull();
    });

    it('deleteTeam makes the team resources org-wide and audits each one', async () => {
      const teamId = await makeTeam('Platform');
      const ids = await makeResources(organizationId, lead, { visibility: 'team', teamId });
      const runnerId = await makeTeamRunner(teamId);
      for (const { kind } of LISTED) {
        expect(await listIds(outsider, organizationId, kind)).not.toContain(ids[kind]);
      }

      await orgs.deleteTeam(organizationId, teamId, owner);

      expect(await repo(Team).findOne({ where: { id: teamId } })).toBeNull();
      await expectOrgWide(ids, runnerId);

      const entries = await auditRows({ action: AuditAction.VISIBILITY_CHANGE, userId: owner });
      const touched = new Set(entries.map((e) => e.resourceId));
      for (const id of [...Object.values(ids), runnerId]) expect(touched.has(id)).toBe(true);
      expect(entries).toHaveLength(LISTED.length + 1);
      expect(entries.every((e) => (e.details as any).teamId === teamId && (e.details as any).reason === 'team_deleted')).toBe(true);
    });

    it('a raw DELETE FROM teams (the trigger alone) also leaves the resources org-wide', async () => {
      const teamId = await makeTeam('Raw delete');
      const ids = await makeResources(organizationId, lead, { visibility: 'team', teamId });
      const runnerId = await makeTeamRunner(teamId);

      await ds.query(`DELETE FROM teams WHERE id = $1`, [teamId]);

      expect(await repo(Team).findOne({ where: { id: teamId } })).toBeNull();
      await expectOrgWide(ids, runnerId);
    });

    it('deleting an organization whose teams scope resources succeeds (teams cascade through the trigger)', async () => {
      const doomedOrg = (await save(Organization, { name: 'Doomed', slug: `doomed-${++seq}` }) as any).id;
      const member = await makeUser('doomed-member', doomedOrg, OrganizationRole.OWNER, new Date());
      const team = await save(Team, { name: 'Doomed team', organizationId: doomedOrg, isDefault: false });
      const ids = await makeResources(doomedOrg, member, { visibility: 'team', teamId: (team as any).id });

      await ds.query(`DELETE FROM organizations WHERE id = $1`, [doomedOrg]);

      expect(await repo(Team).findOne({ where: { id: (team as any).id } })).toBeNull();
      // Whatever the org delete cascades away is gone; whatever it keeps
      // is no longer scoped to a team that does not exist.
      for (const { kind, entity } of LISTED) {
        const row: any = await repo(entity).findOne({ where: { id: ids[kind] } as any });
        if (row) expect({ kind, teamId: row.teamId, visibility: row.visibility }).toEqual({ kind, teamId: null, visibility: 'org' });
      }
    });
  });
});
