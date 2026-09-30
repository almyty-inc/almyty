import { randomUUID } from 'crypto';

import { ConnectionGrant } from '../../../entities/connection-grant.entity';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { ConnectionsResolverService } from '../connections-resolver.service';
import { GrantsService } from '../grants/grants.service';
import { buildHarness, fakeRepo, principal } from './test-support';

/**
 * A credential for one team ("One team" in Who can use it) is the
 * organization's, for that team alone: the same rule a provider
 * connection scoped to a team has. Its members (and whoever manages the
 * organization's connections) see and use it; any other member gets the
 * not-found a missing id gets, on list, get, check, disconnect, resolve
 * and grants alike.
 */
describe('team connections', () => {
  const ORG = 'org-1';
  const TEAM = randomUUID();
  const OTHER_TEAM = randomUUID();
  const U_TEAM = randomUUID();
  const U_OFF = randomUUID();
  const U_ADMIN = randomUUID();
  const onTeam = principal(U_TEAM, ORG, OrganizationRole.MEMBER);
  const offTeam = principal(U_OFF, ORG, OrganizationRole.MEMBER);
  const admin = principal(U_ADMIN, ORG, OrganizationRole.ADMIN);
  const openai = { method: 'GET', url: 'https://api.openai.com/v1/models', handle: () => ({ status: 200, body: { data: [{ id: 'gpt-4o' }], object: 'list' } }) };

  function setup(routes: any[] = [openai]) {
    const h = buildHarness({ routes });
    const grantRows = fakeRepo<ConnectionGrant>(() => new ConnectionGrant());
    const memberships = fakeRepo<any>();
    const userTeams = fakeRepo<any>();
    const teams = fakeRepo<any>();
    for (const userId of [U_TEAM, U_OFF, U_ADMIN]) memberships.rows.push({ id: randomUUID(), userId, organizationId: ORG, isActive: true });
    teams.rows.push({ id: TEAM, organizationId: ORG, isActive: true }, { id: OTHER_TEAM, organizationId: ORG, isActive: true });
    userTeams.rows.push({ id: randomUUID(), userId: U_TEAM, teamId: TEAM, isActive: true });
    const grants = new GrantsService(grantRows as any, h.credentials as any, memberships as any, userTeams as any, teams as any, fakeRepo() as any, fakeRepo() as any, fakeRepo() as any, h.audit);
    (h.service as any).grants = grants;
    const resolver = new ConnectionsResolverService(h.service, h.catalog, h.audit, grants);
    return { ...h, grants, grantRows, resolver };
  }

  async function connectForTeam(h: ReturnType<typeof setup>) {
    const done = await h.service.connect(onTeam, ORG, 'openai', { owner: 'team', teamId: TEAM, input: { apiKey: 'sk-team-key-12345678' } });
    if (done.pending !== false) throw new Error('expected a connection');
    return done.connection;
  }

  it('a member of the team makes one: the team is stored, nobody holds it personally', async () => {
    const h = setup();
    const view = await connectForTeam(h);
    expect(view).toMatchObject({ owner: 'team', teamId: TEAM, ownerUserId: null });
    expect(h.credentials.rows[0]).toMatchObject({ visibility: 'team', teamId: TEAM, ownerUserId: null });
  });

  it('refuses a team the caller is not on, and a team that is not there, and writes nothing', async () => {
    const h = setup();
    await expect(h.service.connect(offTeam, ORG, 'openai', { owner: 'team', teamId: TEAM, input: { apiKey: 'sk-team-key-12345678' } }))
      .rejects.toMatchObject({ response: { code: 'TEAM_NOT_FOUND' } });
    await expect(h.service.connect(admin, ORG, 'openai', { owner: 'team', teamId: randomUUID(), input: { apiKey: 'sk-team-key-12345678' } }))
      .rejects.toMatchObject({ response: { code: 'TEAM_NOT_FOUND' } });
    await expect(h.service.connect(onTeam, ORG, 'openai', { owner: 'team', input: { apiKey: 'sk-team-key-12345678' } }))
      .rejects.toMatchObject({ response: { code: 'CONNECTION_TEAM_REQUIRED' } });
    expect(h.credentials.rows).toHaveLength(0);
  });

  it('an admin may make one for any team of the organization', async () => {
    const h = setup();
    const done = await h.service.connect(admin, ORG, 'openai', { owner: 'team', teamId: OTHER_TEAM, input: { apiKey: 'sk-team-key-12345678' } });
    if (done.pending !== false) throw new Error('expected a connection');
    expect(done.connection).toMatchObject({ owner: 'team', teamId: OTHER_TEAM });
  });

  it('is listed to the team and to admins, and to nobody else', async () => {
    const h = setup();
    const view = await connectForTeam(h);
    expect((await h.service.list(onTeam, ORG)).map((c) => c.id)).toContain(view.id);
    expect((await h.service.list(admin, ORG)).map((c) => c.id)).toContain(view.id);
    expect((await h.service.list(offTeam, ORG)).map((c) => c.id)).not.toContain(view.id);
  });

  it('get, check and disconnect are not found for a member outside the team', async () => {
    const h = setup();
    const view = await connectForTeam(h);
    await expect(h.service.get(offTeam, ORG, view.id)).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
    await expect(h.service.validate(offTeam, ORG, view.id)).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
    await expect(h.service.disconnect(offTeam, ORG, view.id)).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
    expect(h.credentials.rows.map((r) => r.id)).toContain(view.id);
    await expect(h.service.get(onTeam, ORG, view.id)).resolves.toMatchObject({ id: view.id });
  });

  it('the team uses it; a member outside the team cannot, and is told it does not exist', async () => {
    const h = setup();
    const view = await connectForTeam(h);
    const resolved = await h.resolver.resolveForUse(onTeam, view.id, { purpose: 'llm_call' });
    expect(resolved.config.apiKey).toBe('sk-team-key-12345678');
    await expect(h.resolver.resolveForUse(offTeam, view.id, { purpose: 'llm_call' })).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
  });

  it('no grant opens it outside the team: grants are not listed, added or used from outside', async () => {
    const h = setup();
    const view = await connectForTeam(h);
    await expect(h.grants.list(view.id, offTeam, ORG)).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
    await expect(h.grants.grant(view.id, { principalType: 'user', principalId: U_OFF }, offTeam, ORG)).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
    // Even a grant naming them, added by an admin, does not reach past the team.
    await h.grants.grant(view.id, { principalType: 'user', principalId: U_OFF }, admin, ORG);
    await expect(h.resolver.resolveForUse(offTeam, view.id, { purpose: 'llm_call' })).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
  });

  it('a sign-in connect carries the team through the callback', async () => {
    const h = setup([
      { method: 'POST', url: 'https://openrouter.ai/api/v1/auth/keys', handle: () => ({ status: 200, body: { key: 'sk-or-v1-team-secret' } }) },
      { method: 'GET', url: 'https://openrouter.ai/api/v1/key', handle: () => ({ status: 200, body: { data: { label: 'team' } } }) },
    ]);
    const start = await h.service.connect(onTeam, ORG, 'openrouter', { owner: 'team', teamId: TEAM });
    if (!start.pending || !('state' in start)) throw new Error('expected a redirect');
    const connection = await h.service.complete(start.state, 'code-1');
    expect(connection).toMatchObject({ owner: 'team', teamId: TEAM, ownerUserId: null });
    expect((await h.service.list(offTeam, ORG)).map((c) => c.id)).not.toContain(connection.id);
  });

  it('without the grants module wired, a team connection is not usable by an ordinary member', async () => {
    const h = setup();
    const view = await connectForTeam(h);
    const bare = new ConnectionsResolverService(h.service, h.catalog, h.audit);
    await expect(bare.resolveForUse(offTeam, view.id, { purpose: 'llm_call' })).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
  });

  describe('changing who can use it later', () => {
    const U_TEAMMATE = randomUUID();
    const teammate = principal(U_TEAMMATE, ORG, OrganizationRole.MEMBER);

    async function privateOf(h: ReturnType<typeof setup>, who = onTeam) {
      const done = await h.service.connect(who, ORG, 'openai', { owner: 'private', input: { apiKey: 'sk-mine-12345678' } });
      if (done.pending !== false) throw new Error('expected a connection');
      return done.connection;
    }
    const withTeammate = (h: ReturnType<typeof setup>) => {
      (h.grants as any).memberships.rows.push({ id: randomUUID(), userId: U_TEAMMATE, organizationId: ORG, isActive: true });
      (h.grants as any).userTeams.rows.push({ id: randomUUID(), userId: U_TEAMMATE, teamId: TEAM, isActive: true });
    };

    it('its owner shares a private credential with their team, and the team can use it', async () => {
      const h = setup();
      withTeammate(h);
      const mine = await privateOf(h);
      await expect(h.resolver.resolveForUse(teammate, mine.id, { purpose: 'llm_call' })).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });

      const shared = await h.service.setSharing(onTeam, ORG, mine.id, { owner: 'team', teamId: TEAM });

      expect(shared).toMatchObject({ owner: 'team', teamId: TEAM, ownerUserId: null });
      await expect(h.resolver.resolveForUse(teammate, mine.id, { purpose: 'llm_call' })).resolves.toMatchObject({ config: { apiKey: 'sk-mine-12345678' } });
      await expect(h.resolver.resolveForUse(offTeam, mine.id, { purpose: 'llm_call' })).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
      expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection_share', details: expect.objectContaining({ from: 'private', to: 'team' }) }));
    });

    it('an admin opens it to everyone; a member may not', async () => {
      const h = setup();
      const mine = await privateOf(h, admin);
      await expect(h.service.setSharing(offTeam, ORG, mine.id, { owner: 'org' })).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
      const everyone = await h.service.setSharing(admin, ORG, mine.id, { owner: 'org' });
      expect(everyone).toMatchObject({ owner: 'org', ownerUserId: null, teamId: null });
      // Everyone means every member, through the default grant.
      await expect(h.resolver.resolveForUse(offTeam, mine.id, { purpose: 'llm_call' })).resolves.toBeTruthy();
    });

    it('a member cannot open their own key to everyone, which needs connections:manage', async () => {
      const h = setup();
      const mine = await privateOf(h);
      await expect(h.service.setSharing(onTeam, ORG, mine.id, { owner: 'org' })).rejects.toMatchObject({ response: { code: 'CONNECTIONS_PERMISSION_REQUIRED' } });
      expect(h.credentials.rows[0]).toMatchObject({ visibility: 'private', ownerUserId: U_TEAM });
    });

    it('a member outside the team cannot change a team credential; it does not exist for them', async () => {
      const h = setup();
      const view = await connectForTeam(h);
      await expect(h.service.setSharing(offTeam, ORG, view.id, { owner: 'private' })).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
      expect(h.credentials.rows[0]).toMatchObject({ visibility: 'team', teamId: TEAM });
    });

    it('a team is only one the caller may use', async () => {
      const h = setup();
      const mine = await privateOf(h);
      await expect(h.service.setSharing(onTeam, ORG, mine.id, { owner: 'team', teamId: OTHER_TEAM })).rejects.toMatchObject({ response: { code: 'TEAM_NOT_FOUND' } });
      await expect(h.service.setSharing(onTeam, ORG, mine.id, { owner: 'team' })).rejects.toMatchObject({ response: { code: 'CONNECTION_TEAM_REQUIRED' } });
    });

    it('is refused, and nothing changes, when something that uses it would fall outside the new audience', async () => {
      const h = setup();
      const view = await connectForTeam(h);
      const covered = jest.fn(async (next: any) => {
        expect(next).toMatchObject({ visibility: 'private', ownerUserId: U_ADMIN });
        throw Object.assign(new Error('used by an API everyone uses'), { response: { code: 'CREDENTIAL_SCOPE' } });
      });
      await expect(h.service.setSharing(admin, ORG, view.id, { owner: 'private' }, covered)).rejects.toThrow('used by an API');
      expect(h.credentials.rows[0]).toMatchObject({ visibility: 'team', teamId: TEAM, ownerUserId: null });
    });

    it('leaves the key a provider connection keeps for itself to that connection', async () => {
      const h = setup();
      const view = await connectForTeam(h);
      h.credentials.rows[0].metadata = { ...(h.credentials.rows[0].metadata ?? {}), managedBy: { kind: 'llm_provider', id: 'p1' } };
      await expect(h.service.setSharing(admin, ORG, view.id, { owner: 'org' })).rejects.toMatchObject({ response: { code: 'CONNECTION_MANAGED' } });
    });
  });
});
