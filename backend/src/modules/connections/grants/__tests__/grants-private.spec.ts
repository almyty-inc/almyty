import { randomUUID } from 'crypto';

import { ConnectionGrant } from '../../../../entities/connection-grant.entity';
import { Credential } from '../../../../entities/credential.entity';
import { fakeAudit, fakeRepo, principal } from '../../__tests__/test-support';
import { ConnectionsResolverService } from '../../connections-resolver.service';
import { GrantsService } from '../grants.service';

/**
 * A private connection through the grants service and the resolver: the
 * owner cannot share it, nobody else can reach it, and every refusal to
 * anyone else is the not-found a missing id gets -- never a 403 that
 * confirms the row exists.
 */
const ORG = 'org-1';
const U_OWNER = randomUUID();
const U_ADMIN = randomUUID();
const U_MEMBER = randomUUID();

function harness() {
  const grants = fakeRepo<ConnectionGrant>(() => new ConnectionGrant());
  const credentials = fakeRepo<Credential>(() => new Credential());
  const memberships = fakeRepo<any>();
  const audit = fakeAudit();
  const service = new GrantsService(
    grants as any, credentials as any, memberships as any, fakeRepo<any>() as any, fakeRepo<any>() as any,
    fakeRepo<any>() as any, fakeRepo<any>() as any, fakeRepo<any>() as any, audit,
  );
  for (const userId of [U_OWNER, U_ADMIN, U_MEMBER]) memberships.rows.push({ id: randomUUID(), userId, organizationId: ORG, isActive: true });
  const conn = Object.assign(new Credential(), {
    id: randomUUID(), name: 'Mine', organizationId: ORG, connectorKey: 'openai', visibility: 'private', teamId: null,
    ownerUserId: U_OWNER, isActive: true, config: {},
  });
  credentials.rows.push(conn);
  // A grant row that predates the rule (or was written by hand): it must not open the connection.
  grants.rows.push(Object.assign(new ConnectionGrant(), {
    id: randomUUID(), organizationId: ORG, connectionId: conn.id, principalType: 'role', principalId: 'member', permission: 'use', expiresAt: null,
  }));
  return {
    service, credentials, grants, audit, conn,
    owner: principal(U_OWNER, ORG, 'member'),
    admin: principal(U_ADMIN, ORG, 'admin'),
    member: principal(U_MEMBER, ORG, 'member'),
  };
}

describe('grants on a private connection', () => {
  it('its owner cannot share it', async () => {
    const h = harness();
    await expect(h.service.grant(h.conn.id, { principalType: 'user', principalId: U_MEMBER }, h.owner, ORG))
      .rejects.toMatchObject({ response: { code: 'CONNECTION_PRIVATE' } });
    expect(h.grants.rows).toHaveLength(1);
  });

  it('anyone else adding, listing or revoking a grant gets not found', async () => {
    const h = harness();
    for (const who of [h.admin, h.member]) {
      await expect(h.service.grant(h.conn.id, { principalType: 'user', principalId: who.id }, who, ORG))
        .rejects.toMatchObject({ status: 404, response: { code: 'CONNECTION_NOT_FOUND' } });
      await expect(h.service.list(h.conn.id, who, ORG)).rejects.toMatchObject({ status: 404 });
      await expect(h.service.revoke(h.grants.rows[0].id, who, ORG)).rejects.toMatchObject({ status: 404 });
    }
    expect(h.grants.rows).toHaveLength(1);
  });

  it('use by anyone but the owner is not found, even holding a grant; the owner uses it', async () => {
    const h = harness();
    for (const who of [h.admin, h.member]) {
      await expect(h.service.assertCanUse(who, h.conn)).rejects.toMatchObject({ status: 404, response: { code: 'CONNECTION_NOT_FOUND' } });
    }
    await expect(h.service.assertCanUse(h.owner, h.conn)).resolves.toMatchObject({ allowed: true, via: 'owner' });
  });

  it('the resolve audit row names the tier as private', async () => {
    const h = harness();
    await h.service.recordResolve(h.owner, h.conn, { purpose: 'llm_call' });
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection_resolve', details: expect.objectContaining({ owner: 'private' }) }));
  });
});

describe('resolver on a private connection', () => {
  function resolver(conn: Credential, grants?: GrantsService) {
    const connections = { loadForResolve: jest.fn(async (id: string) => (id === conn.id ? conn : null)), decryptConfig: jest.fn(async () => ({ apiKey: 'sk' })), view: jest.fn(() => ({ id: conn.id })) };
    const catalog = { require: jest.fn(async () => ({ key: 'openai' })) };
    return new ConnectionsResolverService(connections as any, catalog as any, fakeAudit(), grants);
  }

  it('is not found to other members and admins, with or without the grants gate', async () => {
    const h = harness();
    for (const r of [resolver(h.conn), resolver(h.conn, h.service)]) {
      for (const who of [h.admin, h.member]) {
        await expect(r.resolveForUse(who, h.conn.id)).rejects.toMatchObject({ status: 404, response: { code: 'CONNECTION_NOT_FOUND' } });
      }
      await expect(r.resolveForUse(h.owner, h.conn.id)).resolves.toMatchObject({ config: { apiKey: 'sk' } });
    }
  });

  it('a system path resolves it only when it acts for the owner; no actor fails closed', async () => {
    const h = harness();
    const r = resolver(h.conn);
    await expect(r.resolveForOrg(ORG, h.conn.id, { purpose: 'deploy' })).rejects.toMatchObject({ status: 404 });
    await expect(r.resolveForOrg(ORG, h.conn.id, { purpose: 'deploy', actorUserId: U_ADMIN })).rejects.toMatchObject({ status: 404 });
    await expect(r.resolveForOrg(ORG, h.conn.id, { purpose: 'deploy', actorUserId: U_OWNER })).resolves.toBeDefined();
  });

  it('a private row with no owner is nobody\'s', async () => {
    const h = harness();
    h.conn.ownerUserId = null;
    const r = resolver(h.conn);
    for (const who of [h.owner, h.admin]) await expect(r.resolveForUse(who, h.conn.id)).rejects.toMatchObject({ status: 404 });
  });
});
