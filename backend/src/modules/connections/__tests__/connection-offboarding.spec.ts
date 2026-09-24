import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { ConnectionOffboardingService } from '../connection-offboarding.service';
import type { ProviderRevokeOutcome } from '../connections.service';

/**
 * Offboarding a person's own connections: wiped locally in a transaction,
 * then revoked at each provider after commit, best-effort.
 *
 * The SQL runs against Postgres in
 * test/integration/resource-handover.integration.spec.ts; this pins the
 * order and the failure handling around it.
 */
describe('ConnectionOffboardingService', () => {
  type Wiped = { id: string; organizationId: string; name: string; visibility: string; connectorKey: string; metadata: any; previousConfig: any };

  function build(wipedRows: Wiped[], answer: (id: string) => ProviderRevokeOutcome) {
    const order: string[] = [];
    const manager: any = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (/UPDATE credentials/.test(sql)) {
          order.push(`wipe ${JSON.stringify(params)}`);
          return [wipedRows, wipedRows.length];
        }
        if (/DELETE FROM connection_grants/.test(sql)) return [[], 0];
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    };
    const credentials: any = {
      manager: {
        transaction: jest.fn(async (work: (m: any) => Promise<unknown>) => {
          order.push('begin');
          const out = await work(manager);
          order.push('commit');
          return out;
        }),
      },
    };
    const connections: any = {
      revokeAtProvider: jest.fn(async (row: any) => {
        order.push(`provider ${row.id}`);
        return answer(row.id);
      }),
    };
    const audit: any = {
      logInTransaction: jest.fn(async (_m: any, entry: any) => ({ id: `a-${entry.resourceId}`, ...entry })),
      publishCommitted: jest.fn(() => order.push('publish')),
      log: jest.fn(async (entry: any) => entry),
    };
    const service = new ConnectionOffboardingService(credentials, connections, audit);
    return { service, connections, audit, order, manager };
  }

  const row = (id: string, previousConfig: any): Wiped => ({
    id, organizationId: 'org-1', name: id, visibility: 'org', connectorKey: 'acme', metadata: { connectMethod: 'oauth2_code' }, previousConfig,
  });

  it('wipes in the transaction, publishes after commit, then revokes each connection at its provider with the secret it had', async () => {
    const t = build(
      [row('c-1', { accessToken: 'encrypted:1' }), row('c-2', { apiKey: 'encrypted:2' })],
      () => ({ attempted: true, revoked: true, via: 'oauth2' }),
    );

    await t.service.offboard({ organizationId: 'org-1', userId: 'leaver', actorUserId: null, reason: 'scim_deprovisioned' });

    expect(t.order).toEqual([
      'begin',
      `wipe ["org-1","leaver","the owner was deprovisioned by the identity provider"]`,
      'commit',
      'publish',
      'provider c-1',
      'provider c-2',
    ]);
    expect(t.connections.revokeAtProvider.mock.calls.map(([r]: any[]) => [r.id, r.config])).toEqual([
      ['c-1', { accessToken: 'encrypted:1' }],
      ['c-2', { apiKey: 'encrypted:2' }],
    ]);
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.CONNECTION_REVOKE,
      resourceType: AuditResource.CONNECTION,
      resourceId: 'c-1',
      details: expect.objectContaining({ reason: 'scim_deprovisioned', ownerUserId: 'leaver', stage: 'provider', revoked: true, via: 'oauth2' }),
    }));
  });

  it('audits a provider that refused, and does not throw: the local wipe stands', async () => {
    const t = build([row('c-1', { accessToken: 'encrypted:1' })], () => ({
      attempted: true, revoked: false, via: 'oauth2', error: 'access_token: HTTP 503',
    }));

    await expect(
      t.service.offboard({ organizationId: null, userId: 'gone', actorUserId: 'owner-1', reason: 'user_deleted' }),
    ).resolves.toBeUndefined();

    // Every organization: the scope has no org predicate.
    expect(t.manager.query.mock.calls[0][1]).toEqual(['gone', "the owner's account was deleted"]);
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1',
      details: expect.objectContaining({ revoked: false, error: 'access_token: HTTP 503' }),
    }));
  });

  it('asks no provider about a row that held no secret, and audits nothing for a provider with no revoke', async () => {
    const t = build(
      [row('empty', {}), row('no-revoke', { apiKey: 'encrypted:x' })],
      () => ({ attempted: false, revoked: false }),
    );

    await t.service.offboard({ organizationId: 'org-1', userId: 'leaver', actorUserId: 'admin', reason: 'member_removed' });

    expect(t.connections.revokeAtProvider.mock.calls.map(([r]: any[]) => r.id)).toEqual(['no-revoke']);
    expect(t.audit.log).not.toHaveBeenCalled();
  });

  it('does not reach any provider when the wipe fails', async () => {
    const t = build([], () => ({ attempted: true, revoked: true }));
    t.manager.query.mockRejectedValueOnce(new Error('db down'));

    await expect(
      t.service.offboard({ organizationId: 'org-1', userId: 'leaver', actorUserId: null, reason: 'scim_deprovisioned' }),
    ).rejects.toThrow('db down');
    expect(t.connections.revokeAtProvider).not.toHaveBeenCalled();
    expect(t.audit.publishCommitted).not.toHaveBeenCalled();
  });
});
