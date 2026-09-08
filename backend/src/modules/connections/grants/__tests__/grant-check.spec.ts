import { canManage, canUse, ConnectionLike, GrantLike, GrantPrincipal, grantMatches, hasManagePermission, isExpired, matchingGrants } from '../grant-check';

const ORG = 'org-1';
const orgConnection: ConnectionLike = { id: 'c-org', organizationId: ORG, ownerUserId: null, visibility: 'org', teamId: null };
const userConnection: ConnectionLike = { id: 'c-user', organizationId: ORG, ownerUserId: 'u-owner', visibility: 'org', teamId: null };
const teamConnection: ConnectionLike = { id: 'c-team', organizationId: ORG, ownerUserId: null, visibility: 'team', teamId: 't-1' };

function who(overrides: Partial<GrantPrincipal> = {}): GrantPrincipal {
  return { userId: 'u-member', roles: ['member'], teamIds: [], ...overrides };
}

const grant = (principalType: GrantLike['principalType'], principalId: string, permission: GrantLike['permission'] = 'use', expiresAt: Date | null = null): GrantLike =>
  ({ id: `g-${principalType}-${principalId}`, principalType, principalId, permission, expiresAt });

describe('grant-check: canUse', () => {
  it('the owner of a user-scoped connection uses it without any grant', () => {
    const decision = canUse(userConnection, who({ userId: 'u-owner' }), []);
    expect(decision).toMatchObject({ allowed: true, via: 'owner' });
  });

  it('nobody else uses a user-scoped connection without a grant, admins included', () => {
    expect(canUse(userConnection, who(), [])).toMatchObject({ allowed: false, reason: expect.stringContaining('user-scoped') });
    expect(canUse(userConnection, who({ userId: 'u-admin', roles: ['admin'] }), [])).toMatchObject({ allowed: false });
    expect(canUse(userConnection, who({ userId: 'u-owner2', roles: ['owner'] }), [])).toMatchObject({ allowed: false });
  });

  it('a user grant on a user-scoped connection lets exactly that user in', () => {
    const grants = [grant('user', 'u-friend')];
    expect(canUse(userConnection, who({ userId: 'u-friend' }), grants)).toMatchObject({ allowed: true, via: 'grant', grant: { id: 'g-user-u-friend' } });
    expect(canUse(userConnection, who({ userId: 'u-stranger' }), grants)).toMatchObject({ allowed: false });
  });

  it('org-scoped connections need a grant unless the principal has connections:manage', () => {
    expect(canUse(orgConnection, who(), [])).toMatchObject({ allowed: false, reason: expect.stringContaining('org-scoped') });
    expect(canUse(orgConnection, who({ roles: ['viewer'] }), [])).toMatchObject({ allowed: false });
    expect(canUse(orgConnection, who({ roles: ['admin'] }), [])).toMatchObject({ allowed: true, via: 'connections:manage' });
    expect(canUse(orgConnection, who({ roles: ['owner'] }), [])).toMatchObject({ allowed: true, via: 'connections:manage' });
    expect(canUse(orgConnection, who({ permissions: ['connections:manage'] }), [])).toMatchObject({ allowed: true, via: 'connections:manage' });
  });

  it('a role grant matches any of the principal roles', () => {
    const grants = [grant('role', 'member')];
    expect(canUse(orgConnection, who({ roles: ['member'] }), grants)).toMatchObject({ allowed: true, via: 'grant' });
    expect(canUse(orgConnection, who({ roles: ['viewer'] }), grants)).toMatchObject({ allowed: false });
    expect(canUse(orgConnection, who({ roles: ['viewer', 'member'] }), grants)).toMatchObject({ allowed: true });
  });

  it('a team grant matches team membership', () => {
    const grants = [grant('team', 't-9')];
    expect(canUse(orgConnection, who({ teamIds: ['t-9'] }), grants)).toMatchObject({ allowed: true, via: 'grant' });
    expect(canUse(orgConnection, who({ teamIds: ['t-1'] }), grants)).toMatchObject({ allowed: false });
  });

  it('agent and workspace grants match only when the run context carries that id', () => {
    const grants = [grant('agent', 'a-1'), grant('workspace', 'w-1')];
    expect(canUse(orgConnection, who(), grants)).toMatchObject({ allowed: false });
    expect(canUse(orgConnection, who(), grants, { agentId: 'a-1' })).toMatchObject({ allowed: true, grant: { principalType: 'agent' } });
    expect(canUse(orgConnection, who(), grants, { agentId: 'a-2' })).toMatchObject({ allowed: false });
    expect(canUse(orgConnection, who(), grants, { workspaceId: 'w-1' })).toMatchObject({ allowed: true, grant: { principalType: 'workspace' } });
    expect(canUse(orgConnection, who({ agentId: 'a-1' }), grants)).toMatchObject({ allowed: true });
    // The run context wins over what the principal carried.
    expect(canUse(orgConnection, who({ agentId: 'a-1' }), grants, { agentId: 'a-2' })).toMatchObject({ allowed: false });
    // A user-scoped connection granted to an agent resolves for anyone running that agent.
    expect(canUse(userConnection, who({ userId: 'u-anyone' }), [grant('agent', 'a-1')], { agentId: 'a-1' })).toMatchObject({ allowed: true });
  });

  it('expired grants do not count', () => {
    const now = new Date('2026-09-08T12:00:00Z');
    const past = new Date('2026-09-08T11:59:59Z');
    const future = new Date('2026-09-08T12:00:01Z');
    expect(canUse(orgConnection, who(), [grant('user', 'u-member', 'use', past)], { now })).toMatchObject({ allowed: false });
    expect(canUse(orgConnection, who(), [grant('user', 'u-member', 'use', future)], { now })).toMatchObject({ allowed: true });
    expect(canUse(orgConnection, who(), [grant('user', 'u-member', 'use', now)], { now })).toMatchObject({ allowed: false });
    expect(isExpired({ ...grant('user', 'x'), expiresAt: past.toISOString() }, now)).toBe(true);
    expect(isExpired(grant('user', 'x'), now)).toBe(false);
  });

  it('team-visibility connections additionally require membership of that team', () => {
    const grants = [grant('role', 'member')];
    expect(canUse(teamConnection, who({ teamIds: [] }), grants)).toMatchObject({ allowed: false, reason: 'not a member of the connection team' });
    expect(canUse(teamConnection, who({ teamIds: ['t-1'] }), grants)).toMatchObject({ allowed: true });
    expect(canUse(teamConnection, who({ teamIds: ['t-1'] }), [])).toMatchObject({ allowed: false });
    expect(canUse(teamConnection, who({ roles: ['admin'] }), [])).toMatchObject({ allowed: true, via: 'connections:manage' });
    expect(canUse({ ...teamConnection, teamId: null }, who({ teamIds: ['t-1'] }), grants)).toMatchObject({ allowed: false, reason: 'team-scoped connection without a team' });
  });

  it('a manage grant also carries use', () => {
    expect(canUse(orgConnection, who(), [grant('user', 'u-member', 'manage')])).toMatchObject({ allowed: true, grant: { permission: 'manage' } });
  });
});

describe('grant-check: canManage', () => {
  it('the owner manages a user-scoped connection; an admin does not', () => {
    expect(canManage(userConnection, who({ userId: 'u-owner' }), [])).toMatchObject({ allowed: true, via: 'owner' });
    expect(canManage(userConnection, who({ roles: ['admin'] }), [])).toMatchObject({ allowed: false, reason: expect.stringContaining('owner or a manage grant') });
  });

  it('connections:manage manages org-scoped connections; members do not', () => {
    expect(canManage(orgConnection, who({ roles: ['admin'] }), [])).toMatchObject({ allowed: true, via: 'connections:manage' });
    expect(canManage(orgConnection, who({ roles: ['owner'] }), [])).toMatchObject({ allowed: true });
    expect(canManage(orgConnection, who(), [])).toMatchObject({ allowed: false, reason: expect.stringContaining('connections:manage or a manage grant') });
  });

  it('a manage grant manages either kind; a use grant does not', () => {
    expect(canManage(userConnection, who(), [grant('user', 'u-member', 'manage')])).toMatchObject({ allowed: true, via: 'grant' });
    expect(canManage(userConnection, who(), [grant('user', 'u-member', 'use')])).toMatchObject({ allowed: false });
    expect(canManage(orgConnection, who({ teamIds: ['t-2'] }), [grant('team', 't-2', 'manage')])).toMatchObject({ allowed: true });
    expect(canManage(orgConnection, who({ teamIds: ['t-2'] }), [grant('team', 't-2', 'use')])).toMatchObject({ allowed: false });
  });

  it('an expired manage grant and a manage grant on a team connection without membership are refused', () => {
    const now = new Date('2026-09-08T12:00:00Z');
    expect(canManage(orgConnection, who(), [grant('user', 'u-member', 'manage', new Date('2026-09-01T00:00:00Z'))], { now })).toMatchObject({ allowed: false });
    expect(canManage(teamConnection, who({ teamIds: [] }), [grant('user', 'u-member', 'manage')])).toMatchObject({ allowed: false, reason: 'not a member of the connection team' });
    expect(canManage(teamConnection, who({ teamIds: ['t-1'] }), [grant('user', 'u-member', 'manage')])).toMatchObject({ allowed: true });
  });
});

describe('grant-check helpers', () => {
  it('hasManagePermission reads roles and membership permissions', () => {
    expect(hasManagePermission(who({ roles: ['member'] }))).toBe(false);
    expect(hasManagePermission(who({ roles: ['admin'] }))).toBe(true);
    expect(hasManagePermission(who({ roles: [], permissions: ['connections:manage'] }))).toBe(true);
    expect(hasManagePermission(who({ roles: [], permissions: ['connections:read'] }))).toBe(false);
  });

  it('matchingGrants lists every matching grant, manage first, and grantMatches refuses unknown types', () => {
    const grants = [grant('role', 'member', 'use'), grant('user', 'u-member', 'manage'), grant('team', 't-x')];
    expect(matchingGrants(grants, who()).map((g) => g.permission)).toEqual(['manage', 'use']);
    expect(grantMatches({ principalType: 'robot' as any, principalId: 'x', permission: 'use' }, who())).toBe(false);
    expect(grantMatches(grant('agent', ''), who({ agentId: undefined }))).toBe(false);
  });
});
