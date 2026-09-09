import { randomUUID } from 'crypto';

import { ConnectionGrant } from '../../../../entities/connection-grant.entity';
import { Credential } from '../../../../entities/credential.entity';
import { fakeAudit, fakeRepo, principal } from '../../__tests__/test-support';
import { ConnectionNotGrantedError, GRANT_CACHE_TTL_MS, GrantsService } from '../grants.service';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const U_OWNER = randomUUID();
const U_ADMIN = randomUUID();
const U_MEMBER = randomUUID();
const U_FRIEND = randomUUID();
const U_OUTSIDER = randomUUID();
const TEAM = randomUUID();
const AGENT_MINE = randomUUID();
const AGENT_THEIRS = randomUUID();
const WORKSPACE_MINE = randomUUID();
const BUDGET = randomUUID();

function harness() {
  const grants = fakeRepo<ConnectionGrant>(() => new ConnectionGrant());
  const credentials = fakeRepo<Credential>(() => new Credential());
  const memberships = fakeRepo<any>();
  const userTeams = fakeRepo<any>();
  const teams = fakeRepo<any>();
  const agents = fakeRepo<any>();
  const workspaces = fakeRepo<any>();
  const budgets = fakeRepo<any>();
  const audit = fakeAudit();
  const service = new GrantsService(grants as any, credentials as any, memberships as any, userTeams as any, teams as any, agents as any, workspaces as any, budgets as any, audit);
  let clock = Date.parse('2026-09-08T12:00:00Z');
  service.now = () => clock;
  const tick = (ms: number) => { clock += ms; };

  for (const userId of [U_OWNER, U_ADMIN, U_MEMBER, U_FRIEND]) memberships.rows.push({ id: randomUUID(), userId, organizationId: ORG, isActive: true });
  teams.rows.push({ id: TEAM, organizationId: ORG, isActive: true });
  userTeams.rows.push({ id: randomUUID(), userId: U_FRIEND, teamId: TEAM, isActive: true });
  agents.rows.push({ id: AGENT_MINE, organizationId: ORG, createdBy: U_OWNER }, { id: AGENT_THEIRS, organizationId: ORG, createdBy: U_ADMIN });
  workspaces.rows.push({ id: WORKSPACE_MINE, organizationId: ORG, ownerUserId: U_OWNER });
  budgets.rows.push({ id: BUDGET, organizationId: ORG });

  const connection = (overrides: Partial<Credential>): Credential => {
    const row = Object.assign(credentials.create({ name: 'OpenAI', organizationId: ORG, connectorKey: 'openai', visibility: 'org', teamId: null, ownerUserId: null, isActive: true, config: {} }), overrides);
    row.id = row.id ?? randomUUID();
    credentials.rows.push(row);
    return row;
  };
  const orgConn = connection({ id: randomUUID(), name: 'Org OpenAI' });
  const userConn = connection({ id: randomUUID(), name: 'My OpenAI', ownerUserId: U_OWNER });
  const teamConn = connection({ id: randomUUID(), name: 'Team OpenAI', visibility: 'team', teamId: TEAM });

  const owner = principal(U_OWNER, ORG, 'member');
  const admin = principal(U_ADMIN, ORG, 'admin');
  const member = principal(U_MEMBER, ORG, 'member');
  const friend = principal(U_FRIEND, ORG, 'member');
  const outsider = principal(U_OUTSIDER, OTHER_ORG, 'owner');

  return { service, grants, credentials, audit, tick, orgConn, userConn, teamConn, owner, admin, member, friend, outsider };
}

describe('GrantsService.principalFrom', () => {
  it('reads role and permissions from the JWT memberships, team ids from the database, agent/workspace from the context', async () => {
    const h = harness();
    const who = await h.service.principalFrom({ user: { ...h.friend, currentOrganizationId: ORG } }, { agentId: 'a-1', workspaceId: 'w-1' });
    expect(who).toEqual({ userId: U_FRIEND, roles: ['member'], permissions: [], teamIds: [TEAM], agentId: 'a-1', workspaceId: 'w-1' });
    const custom = await h.service.principalFrom({ ...principal(U_MEMBER, ORG, 'member', ['connections:manage']), currentOrganizationId: ORG });
    expect(custom).toMatchObject({ roles: ['member'], permissions: ['connections:manage'], teamIds: [] });
  });

  it('prefers the explicit organization, and refuses without any organization context', async () => {
    const h = harness();
    const who = await h.service.principalFrom({ user: h.friend }, { organizationId: ORG });
    expect(who.roles).toEqual(['member']);
    expect((await h.service.principalFrom({ user: h.friend }, { organizationId: OTHER_ORG })).roles).toEqual([]);
    await expect(h.service.principalFrom({ user: h.friend })).rejects.toMatchObject({ response: { code: 'NO_ORGANIZATION' } });
    await expect(h.service.principalFrom({} as any, { organizationId: ORG })).rejects.toMatchObject({ response: { code: 'NO_PRINCIPAL' } });
  });

  it('ignores team rows that belong to another organization', async () => {
    const h = harness();
    const foreign = randomUUID();
    (h.service as any).teams.rows.push({ id: foreign, organizationId: OTHER_ORG, isActive: true });
    (h.service as any).userTeams.rows.push({ id: randomUUID(), userId: U_FRIEND, teamId: foreign, isActive: true });
    expect((await h.service.principalFor(h.friend, ORG)).teamIds).toEqual([TEAM]);
  });
});

describe('GrantsService.grant: the manage authorisation matrix', () => {
  it('the owner grants their own user-scoped connection to their own agent without any admin role', async () => {
    const h = harness();
    const view = await h.service.grant(h.userConn.id, { principalType: 'agent', principalId: AGENT_MINE }, h.owner);
    expect(view).toMatchObject({ connectionId: h.userConn.id, principalType: 'agent', principalId: AGENT_MINE, permission: 'use', budgetId: null, grantedBy: U_OWNER, expired: false });
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'connection_grant', resourceType: 'connection', resourceId: h.userConn.id, userId: U_OWNER,
      details: expect.objectContaining({ principalType: 'agent', principalId: AGENT_MINE, permission: 'use', owner: 'user', via: 'owner', refreshed: false }),
    }));
  });

  it('without connections:manage an actor may only bind agents and workspaces they own', async () => {
    const h = harness();
    await expect(h.service.grant(h.userConn.id, { principalType: 'agent', principalId: AGENT_THEIRS }, h.owner)).rejects.toMatchObject({ response: { code: 'GRANT_AGENT_NOT_OWNED' } });
    await expect(h.service.grant(h.userConn.id, { principalType: 'workspace', principalId: WORKSPACE_MINE }, h.owner)).resolves.toMatchObject({ principalType: 'workspace' });
    const otherWorkspace = randomUUID();
    (h.service as any).workspaces.rows.push({ id: otherWorkspace, organizationId: ORG, ownerUserId: U_ADMIN });
    await expect(h.service.grant(h.userConn.id, { principalType: 'workspace', principalId: otherWorkspace }, h.owner)).rejects.toMatchObject({ response: { code: 'GRANT_WORKSPACE_NOT_OWNED' } });
    // An admin managing an org-scoped connection binds any agent in the org.
    await expect(h.service.grant(h.orgConn.id, { principalType: 'agent', principalId: AGENT_MINE }, h.admin)).resolves.toMatchObject({ principalId: AGENT_MINE });
  });

  it('admins manage org-scoped connections; members and admins cannot grant a user-scoped one', async () => {
    const h = harness();
    await expect(h.service.grant(h.orgConn.id, { principalType: 'role', principalId: 'member' }, h.admin)).resolves.toMatchObject({ principalType: 'role', principalId: 'member' });
    await expect(h.service.grant(h.orgConn.id, { principalType: 'role', principalId: 'member' }, h.member)).rejects.toMatchObject({ response: { code: 'CONNECTION_GRANT_FORBIDDEN' } });
    await expect(h.service.grant(h.userConn.id, { principalType: 'user', principalId: U_FRIEND }, h.admin)).rejects.toMatchObject({ response: { code: 'CONNECTION_GRANT_FORBIDDEN' } });
    await expect(h.service.grant(h.userConn.id, { principalType: 'user', principalId: U_FRIEND }, h.member)).rejects.toMatchObject({ response: { code: 'CONNECTION_GRANT_FORBIDDEN' } });
  });

  it('a manage grant lets its holder add further grants; a use grant does not', async () => {
    const h = harness();
    await h.service.grant(h.userConn.id, { principalType: 'user', principalId: U_FRIEND, permission: 'manage' }, h.owner);
    await expect(h.service.grant(h.userConn.id, { principalType: 'user', principalId: U_MEMBER }, h.friend)).resolves.toMatchObject({ principalId: U_MEMBER });
    await expect(h.service.grant(h.userConn.id, { principalType: 'team', principalId: TEAM }, h.member)).rejects.toMatchObject({ response: { code: 'CONNECTION_GRANT_FORBIDDEN' } });
  });

  it('team-visibility connections: a manage-grant holder outside the team is refused, an admin is not', async () => {
    const h = harness();
    await h.service.grant(h.teamConn.id, { principalType: 'user', principalId: U_MEMBER, permission: 'manage' }, h.admin);
    await expect(h.service.grant(h.teamConn.id, { principalType: 'user', principalId: U_FRIEND }, h.member)).rejects.toMatchObject({ response: { code: 'CONNECTION_GRANT_FORBIDDEN', message: 'not a member of the connection team' } });
  });

  it('validates the target: unknown users, teams, agents, workspaces, roles, non-uuid ids and foreign budgets', async () => {
    const h = harness();
    await expect(h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_OUTSIDER }, h.admin)).rejects.toMatchObject({ response: { code: 'GRANT_PRINCIPAL_NOT_FOUND' } });
    await expect(h.service.grant(h.orgConn.id, { principalType: 'team', principalId: randomUUID() }, h.admin)).rejects.toMatchObject({ response: { code: 'GRANT_PRINCIPAL_NOT_FOUND' } });
    await expect(h.service.grant(h.orgConn.id, { principalType: 'agent', principalId: randomUUID() }, h.admin)).rejects.toMatchObject({ response: { code: 'GRANT_PRINCIPAL_NOT_FOUND' } });
    await expect(h.service.grant(h.orgConn.id, { principalType: 'workspace', principalId: randomUUID() }, h.admin)).rejects.toMatchObject({ response: { code: 'GRANT_PRINCIPAL_NOT_FOUND' } });
    await expect(h.service.grant(h.orgConn.id, { principalType: 'role', principalId: 'superuser' }, h.admin)).rejects.toMatchObject({ response: { code: 'GRANT_PRINCIPAL_INVALID' } });
    await expect(h.service.grant(h.orgConn.id, { principalType: 'user', principalId: 'not-a-uuid' }, h.admin)).rejects.toMatchObject({ response: { code: 'GRANT_PRINCIPAL_INVALID' } });
    await expect(h.service.grant(h.orgConn.id, { principalType: 'robot' as any, principalId: randomUUID() }, h.admin)).rejects.toMatchObject({ response: { code: 'GRANT_PRINCIPAL_INVALID' } });
    await expect(h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER, permission: 'own' as any }, h.admin)).rejects.toMatchObject({ response: { code: 'GRANT_PERMISSION_INVALID' } });
    await expect(h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER, budgetId: randomUUID() }, h.admin)).rejects.toMatchObject({ response: { code: 'GRANT_BUDGET_NOT_FOUND' } });
    await expect(h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER, budgetId: BUDGET }, h.admin)).resolves.toMatchObject({ budgetId: BUDGET });
    expect(h.grants.rows).toHaveLength(1);
  });

  it('validates expiry: malformed and past dates are refused, future dates are stored', async () => {
    const h = harness();
    await expect(h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER, expiresAt: 'tomorrow' }, h.admin)).rejects.toMatchObject({ response: { code: 'GRANT_EXPIRES_INVALID' } });
    await expect(h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER, expiresAt: '2026-09-08T11:00:00Z' }, h.admin)).rejects.toMatchObject({ response: { code: 'GRANT_EXPIRES_IN_PAST' } });
    const view = await h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER, expiresAt: '2026-09-09T12:00:00Z' }, h.admin);
    expect(view.expiresAt?.toISOString()).toBe('2026-09-09T12:00:00.000Z');
    expect(view.expired).toBe(false);
  });

  it('re-granting the same principal refreshes the row instead of duplicating it', async () => {
    const h = harness();
    const first = await h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER }, h.admin);
    const second = await h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER, permission: 'manage', budgetId: BUDGET }, h.admin);
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ permission: 'manage', budgetId: BUDGET });
    expect(h.grants.rows).toHaveLength(1);
    expect(h.audit.log).toHaveBeenLastCalledWith(expect.objectContaining({ details: expect.objectContaining({ refreshed: true, permission: 'manage' }) }));
  });

  it('unknown connections, plain credentials, other organizations and non-members are refused', async () => {
    const h = harness();
    await expect(h.service.grant(randomUUID(), { principalType: 'user', principalId: U_MEMBER }, h.admin)).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
    const legacy = Object.assign(h.credentials.create({ organizationId: ORG, name: 'legacy', config: {} }), { id: randomUUID() });
    h.credentials.rows.push(legacy);
    await expect(h.service.grant(legacy.id, { principalType: 'user', principalId: U_MEMBER }, h.admin)).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
    await expect(h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER }, h.admin, OTHER_ORG)).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
    await expect(h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER }, h.outsider)).rejects.toMatchObject({ response: { code: 'CONNECTION_GRANT_FORBIDDEN' } });
  });
});

describe('GrantsService.list and revoke', () => {
  it('list: owner and manage holders see the grants; an admin sees a user-scoped connection but a member does not', async () => {
    const h = harness();
    await h.service.grant(h.userConn.id, { principalType: 'user', principalId: U_FRIEND }, h.owner);
    expect(await h.service.list(h.userConn.id, h.owner)).toHaveLength(1);
    expect(await h.service.list(h.userConn.id, h.admin, ORG)).toHaveLength(1);
    await expect(h.service.list(h.userConn.id, h.member)).rejects.toMatchObject({ response: { code: 'CONNECTION_GRANT_FORBIDDEN' } });
    await expect(h.service.list(h.userConn.id, h.friend)).rejects.toMatchObject({ response: { code: 'CONNECTION_GRANT_FORBIDDEN' } });
    await expect(h.service.list(h.orgConn.id, h.member)).rejects.toMatchObject({ response: { code: 'CONNECTION_GRANT_FORBIDDEN' } });
    expect(await h.service.list(h.orgConn.id, h.admin)).toEqual([]);
  });

  it('revoke: the owner revokes, an admin may revoke on a user-scoped connection, a member may not; audits the revoke', async () => {
    const h = harness();
    const g1 = await h.service.grant(h.userConn.id, { principalType: 'user', principalId: U_FRIEND }, h.owner);
    const g2 = await h.service.grant(h.userConn.id, { principalType: 'agent', principalId: AGENT_MINE }, h.owner);
    await expect(h.service.revoke(g1.id, h.member)).rejects.toMatchObject({ response: { code: 'CONNECTION_GRANT_FORBIDDEN' } });
    await expect(h.service.revoke(g1.id, h.admin)).resolves.toMatchObject({ id: g1.id, principalId: U_FRIEND });
    expect(h.audit.log).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'connection_revoke_grant', resourceId: h.userConn.id, userId: U_ADMIN,
      details: expect.objectContaining({ grantId: g1.id, principalType: 'user', via: 'connections:manage' }),
    }));
    await expect(h.service.revoke(g2.id, h.owner)).resolves.toMatchObject({ id: g2.id });
    expect(h.grants.rows).toHaveLength(0);
    await expect(h.service.revoke(g2.id, h.owner)).rejects.toMatchObject({ response: { code: 'GRANT_NOT_FOUND' } });
  });

  it('revoke refuses a grant from another organization', async () => {
    const h = harness();
    const g = await h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER }, h.admin);
    await expect(h.service.revoke(g.id, h.admin, OTHER_ORG)).rejects.toMatchObject({ response: { code: 'GRANT_NOT_FOUND' } });
    await expect(h.service.revoke(g.id, h.outsider)).rejects.toMatchObject({ response: { code: 'CONNECTION_GRANT_FORBIDDEN' } });
  });
});

describe('GrantsService.assertCanUse and the resolve audit', () => {
  it('throws the typed ConnectionNotGrantedError with the reason, and returns the decision when granted', async () => {
    const h = harness();
    const err = await h.service.assertCanUse(h.member, h.orgConn, { purpose: 'llm_call' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionNotGrantedError);
    expect(err.code).toBe('CONNECTION_NOT_GRANTED');
    expect(err.getStatus()).toBe(403);
    expect(err.reason).toContain('no grant');
    expect(err.getResponse()).toMatchObject({ code: 'CONNECTION_NOT_GRANTED', connectionId: h.orgConn.id });

    await h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER }, h.admin);
    await expect(h.service.assertCanUse(h.member, h.orgConn)).resolves.toMatchObject({ allowed: true, via: 'grant', grant: { principalId: U_MEMBER } });
    await expect(h.service.assertCanUse(h.owner, h.userConn)).resolves.toMatchObject({ via: 'owner' });
    await expect(h.service.assertCanUse(h.admin, h.orgConn)).resolves.toMatchObject({ via: 'connections:manage' });
    await expect(h.service.assertCanUse(h.admin, h.userConn)).rejects.toBeInstanceOf(ConnectionNotGrantedError);
  });

  it('accepts a prebuilt GrantPrincipal and derives agent / workspace context from the resolver context', async () => {
    const h = harness();
    await h.service.grant(h.userConn.id, { principalType: 'agent', principalId: AGENT_MINE }, h.owner);
    await expect(h.service.assertCanUse(h.member, h.userConn, { purpose: 'llm_call', resourceType: 'agent', resourceId: AGENT_MINE })).resolves.toMatchObject({ via: 'grant' });
    await expect(h.service.assertCanUse(h.member, h.userConn, { purpose: 'llm_call', resourceType: 'agent', resourceId: AGENT_THEIRS })).rejects.toBeInstanceOf(ConnectionNotGrantedError);
    await expect(h.service.assertCanUse({ userId: U_MEMBER, roles: ['member'], teamIds: [], agentId: AGENT_MINE }, h.userConn)).resolves.toMatchObject({ via: 'grant' });
    await expect(h.service.assertCanUse({ userId: U_MEMBER, roles: ['member'], teamIds: [] }, h.userConn)).rejects.toBeInstanceOf(ConnectionNotGrantedError);
  });

  it('team membership is loaded for the request user so team grants and team-visibility resolve', async () => {
    const h = harness();
    await h.service.grant(h.teamConn.id, { principalType: 'team', principalId: TEAM }, h.admin);
    await expect(h.service.assertCanUse(h.friend, h.teamConn)).resolves.toMatchObject({ via: 'grant', grant: { principalType: 'team' } });
    await expect(h.service.assertCanUse(h.member, h.teamConn)).rejects.toMatchObject({ reason: 'not a member of the connection team' });
  });

  it('caches the grant list for 30 seconds per connection and drops it on grant / revoke', async () => {
    const h = harness();
    await h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER }, h.admin);
    h.grants.find.mockClear();
    await h.service.assertCanUse(h.member, h.orgConn);
    await h.service.assertCanUse(h.member, h.orgConn);
    expect(h.grants.find).toHaveBeenCalledTimes(1);

    h.tick(GRANT_CACHE_TTL_MS - 1);
    await h.service.assertCanUse(h.member, h.orgConn);
    expect(h.grants.find).toHaveBeenCalledTimes(1);
    h.tick(1);
    await h.service.assertCanUse(h.member, h.orgConn);
    expect(h.grants.find).toHaveBeenCalledTimes(2);

    // A revoke is visible at once, not after the TTL.
    const [g] = await h.service.list(h.orgConn.id, h.admin);
    await h.service.revoke(g.id, h.admin);
    await expect(h.service.assertCanUse(h.member, h.orgConn)).rejects.toBeInstanceOf(ConnectionNotGrantedError);

    // Expiry is evaluated against the clock even while the list is cached.
    await h.service.grant(h.orgConn.id, { principalType: 'user', principalId: U_MEMBER, expiresAt: '2026-09-08T12:01:00Z' }, h.admin);
    await expect(h.service.assertCanUse(h.member, h.orgConn)).resolves.toMatchObject({ allowed: true });
    h.tick(60_000);
    await expect(h.service.assertCanUse(h.member, h.orgConn)).rejects.toBeInstanceOf(ConnectionNotGrantedError);
  });

  it('recordResolve writes CONNECTION_RESOLVE with principal x connection x run', async () => {
    const h = harness();
    await h.service.grant(h.userConn.id, { principalType: 'agent', principalId: AGENT_MINE }, h.owner);
    const context = { purpose: 'llm_call', runId: 'run-1', resourceType: 'agent', resourceId: AGENT_MINE, workspaceId: WORKSPACE_MINE };
    const decision = await h.service.assertCanUse(h.member, h.userConn, context);
    await h.service.recordResolve(h.member, h.userConn, context, decision);
    expect(h.audit.log).toHaveBeenLastCalledWith(expect.objectContaining({
      organizationId: ORG, userId: U_MEMBER, action: 'connection_resolve', resourceType: 'connection', resourceId: h.userConn.id, resourceName: 'My OpenAI',
      details: {
        principal: { userId: U_MEMBER, agentId: AGENT_MINE, workspaceId: WORKSPACE_MINE },
        connectionId: h.userConn.id, connectorKey: 'openai', owner: 'user', runId: 'run-1', agentId: AGENT_MINE, workspaceId: WORKSPACE_MINE,
        purpose: 'llm_call', via: 'grant', grantId: decision.grant?.id,
      },
    }));
    await h.service.recordResolve({ userId: U_OWNER, roles: ['member'], teamIds: [] }, h.userConn);
    expect(h.audit.log).toHaveBeenLastCalledWith(expect.objectContaining({
      userId: U_OWNER, details: expect.objectContaining({ purpose: 'use', runId: null, agentId: null, workspaceId: null, via: null, grantId: null }),
    }));
  });
});
