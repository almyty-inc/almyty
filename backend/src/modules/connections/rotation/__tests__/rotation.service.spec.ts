import { AuditAction, AuditResource } from '../../../../entities/audit-log.entity';
import { ConnectorRotation, RotationError } from '../rotation.interface';
import { RotationRegistry } from '../rotation.registry';
import { DEFAULT_MAX_AGE_DAYS, RotationConnection, RotationService, maxAgeDaysFromSetting, remindersFor } from '../rotation.service';
import { rejection } from './rotation-support';

const NOW = new Date('2026-09-08T12:00:00Z');

function provider(over: Partial<ConnectorRotation> & { calls?: string[] } = {}): ConnectorRotation & { calls: string[] } {
  const calls: string[] = over.calls ?? [];
  return {
    key: 'vendor',
    capabilities: () => ({ create: true, revoke: true, metadata: true, refresh: false }),
    requires: () => ['adminKey'],
    rotate: async (_c, ctx) => { calls.push(`rotate:${ctx.label ?? ''}`); return { next: { apiKey: 'new-key', keyId: 'k2', sessionToken: '' }, label: 'minted', expiresAt: new Date('2027-01-01T00:00:00Z') }; },
    revoke: async (c, ctx) => { calls.push(`revoke:${c.apiKey}:${ctx.successor?.apiKey ?? '-'}`); },
    describe: async (c) => { calls.push(`describe:${c.apiKey}`); return { label: 'described', createdAt: new Date('2026-01-01T00:00:00Z') }; },
    ...over,
    calls,
  } as any;
}

function harness(p?: ConnectorRotation) {
  const registry = new RotationRegistry();
  if (p) registry.register(p);
  const audit = { log: jest.fn(async (_options: any) => null as any) };
  const service = new RotationService(registry, audit as any);
  return { registry, audit, service };
}

const connection: RotationConnection = {
  id: 'conn-1', organizationId: 'org-1', connectorKey: 'vendor', name: 'Vendor prod',
  secrets: { apiKey: 'old-key', adminKey: 'admin', sessionToken: 'stale', keyId: 'k1' }, keyPageUrl: 'https://vendor.example/keys',
};

const seams = () => {
  const persisted: any[] = [];
  return {
    persisted,
    validate: jest.fn(async () => ({ ok: true, accountLabel: 'acct' })),
    persist: jest.fn(async (next: any, meta: any) => { persisted.push({ next, meta }); }),
    userId: 'user-1', now: NOW,
  };
};

describe('RotationService.rotate', () => {
  it('mints, validates, persists the merged secrets, then revokes the previous key with the successor, and audits', async () => {
    const p = provider();
    const { service, audit } = harness(p);
    const s = seams();
    const out = await service.rotate(connection, s);
    expect(out).toEqual({ manual: false, label: 'minted', accountLabel: 'acct', expiresAt: new Date('2027-01-01T00:00:00Z'), previousRevoked: true, revokeError: undefined });
    expect(p.calls).toEqual(['rotate:', 'revoke:old-key:new-key']);
    expect(s.validate).toHaveBeenCalledWith({ apiKey: 'new-key', adminKey: 'admin', keyId: 'k2' });
    expect(s.persisted).toEqual([{ next: { apiKey: 'new-key', adminKey: 'admin', keyId: 'k2' }, meta: { label: 'minted', expiresAt: new Date('2027-01-01T00:00:00Z'), rotatedAt: NOW, accountLabel: 'acct' } }]);
    expect(s.persist.mock.invocationCallOrder[0]).toBeLessThan((p as any).revokeOrder ?? Infinity);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0][0]).toMatchObject({
      organizationId: 'org-1', userId: 'user-1', action: AuditAction.CONNECTION_ROTATE, resourceType: AuditResource.CONNECTION, resourceId: 'conn-1', resourceName: 'Vendor prod',
      details: { connectorKey: 'vendor', ok: true, provider: 'vendor', label: 'minted', previousRevoked: true, revokeError: null },
    });
    expect(JSON.stringify(audit.log.mock.calls[0][0])).not.toContain('new-key');
  });

  it('passes the caller label through and keeps the previous secret when its revoke fails (best effort, audited)', async () => {
    const p = provider({ revoke: async () => { throw new RotationError('ROTATION_FAILED', 'vendor says no'); } });
    const { service, audit } = harness(p);
    const out = await service.rotate(connection, { ...seams(), label: 'prod 2026' });
    expect(p.calls).toEqual(['rotate:prod 2026']);
    expect(out).toMatchObject({ manual: false, previousRevoked: false, revokeError: 'vendor says no' });
    expect(audit.log.mock.calls[0][0].details).toMatchObject({ ok: true, previousRevoked: false, revokeError: 'vendor says no' });
  });

  it('answers manual when there is no provider, no create capability, or a required field is missing', async () => {
    const none = harness();
    expect(await none.service.rotate(connection, seams())).toEqual({ manual: true, reason: 'vendor has no rotation provider', keyPageUrl: 'https://vendor.example/keys' });
    const noCreate = harness(provider({ capabilities: () => ({ create: false, revoke: true, metadata: true, refresh: false }), rotate: undefined }));
    expect(await noCreate.service.rotate(connection, seams())).toMatchObject({ manual: true, reason: 'vendor has no key-creation API' });
    const p = provider();
    const missing = harness(p);
    expect(await missing.service.rotate({ ...connection, secrets: { apiKey: 'old-key' } }, seams())).toEqual({ manual: true, reason: 'rotation needs adminKey on the connection', keyPageUrl: 'https://vendor.example/keys' });
    expect(p.calls).toEqual([]);
    expect(missing.audit.log).not.toHaveBeenCalled();
  });

  it('turns a provider ROTATION_UNSUPPORTED into a manual outcome, and audits then rethrows ROTATION_AUTH', async () => {
    const unsupported = harness(provider({ rotate: async () => { throw new RotationError('ROTATION_UNSUPPORTED', 'only key pairs rotate'); } }));
    expect(await unsupported.service.rotate(connection, seams())).toEqual({ manual: true, reason: 'only key pairs rotate', keyPageUrl: 'https://vendor.example/keys' });
    const denied = harness(provider({ rotate: async () => { throw new RotationError('ROTATION_AUTH', 'admin key rejected', 401); } }));
    const s = seams();
    const e = await rejection(denied.service.rotate(connection, s));
    expect(e.code).toBe('ROTATION_AUTH');
    expect(s.persist).not.toHaveBeenCalled();
    expect(denied.audit.log.mock.calls[0][0].details).toMatchObject({ ok: false, stage: 'create', code: 'ROTATION_AUTH', error: 'admin key rejected' });
  });

  it('when the new secret fails validation it revokes the new secret, persists nothing, and fails with ROTATION_FAILED', async () => {
    const p = provider();
    const { service, audit } = harness(p);
    const s = seams();
    s.validate.mockResolvedValueOnce({ ok: false, error: 'provider answered 401' } as any);
    const e = await rejection(service.rotate(connection, s));
    expect(e.code).toBe('ROTATION_FAILED');
    expect(e.message).toContain('failed validation: provider answered 401');
    expect(p.calls).toEqual(['rotate:', 'revoke:new-key:-']);
    expect(s.persist).not.toHaveBeenCalled();
    expect(audit.log.mock.calls[0][0].details).toMatchObject({ ok: false, stage: 'validate', code: 'ROTATION_FAILED' });
  });

  it('a validate callback that throws counts as a failed validation, and a persist failure is audited as its own stage', async () => {
    const p = provider();
    const { service } = harness(p);
    const s = seams();
    s.validate.mockRejectedValueOnce(new Error('db down'));
    expect((await rejection(service.rotate(connection, s))).message).toContain('db down');
    const q = provider();
    const h2 = harness(q);
    const s2 = seams();
    s2.persist.mockRejectedValueOnce(new Error('write failed'));
    const e = await rejection(h2.service.rotate(connection, s2));
    expect(e.code).toBe('ROTATION_FAILED');
    expect(q.calls).toEqual(['rotate:']);
    expect(h2.audit.log.mock.calls[0][0].details).toMatchObject({ ok: false, stage: 'persist' });
  });

  it('works without an audit service', async () => {
    const registry = new RotationRegistry();
    registry.register(provider());
    const service = new RotationService(registry);
    expect(await service.rotate(connection, seams())).toMatchObject({ manual: false });
  });
});

describe('RotationService.revoke and describe', () => {
  it('reports unsupported connectors, missing fields, provider failures and success without throwing, and audits revokes', async () => {
    const none = harness();
    expect(await none.service.revoke(connection)).toEqual({ supported: false, revoked: false });
    expect(await none.service.describe(connection)).toEqual({ supported: false });
    expect(none.audit.log).not.toHaveBeenCalled();

    const p = provider();
    const h = harness(p);
    expect(await h.service.revoke({ ...connection, secrets: { apiKey: 'x' } }, { userId: 'u' })).toEqual({ supported: true, revoked: false, code: 'ROTATION_UNSUPPORTED', error: 'revoke needs adminKey on the connection' });
    expect(await h.service.revoke(connection, { userId: 'u' })).toEqual({ supported: true, revoked: true });
    expect(p.calls).toEqual(['revoke:old-key:-']);
    expect(h.audit.log).toHaveBeenCalledTimes(2);
    expect(h.audit.log.mock.calls[1][0]).toMatchObject({ action: AuditAction.CONNECTION_REVOKE, userId: 'u', resourceId: 'conn-1', details: { connectorKey: 'vendor', ok: true, provider: 'vendor', code: null, error: null } });

    const failing = harness(provider({ revoke: async () => { throw new RotationError('ROTATION_AUTH', 'nope', 403); }, describe: async () => { throw new Error('boom'); } }));
    expect(await failing.service.revoke(connection)).toEqual({ supported: true, revoked: false, code: 'ROTATION_AUTH', error: 'nope' });
    expect(await failing.service.describe(connection)).toEqual({ supported: true, code: 'ROTATION_FAILED', error: 'boom' });
    expect(await failing.service.describe({ ...connection, secrets: { apiKey: 'x' } })).toEqual({ supported: true, code: 'ROTATION_UNSUPPORTED', error: 'describe needs adminKey on the connection' });
    expect(await h.service.describe(connection)).toEqual({ supported: true, description: { label: 'described', createdAt: new Date('2026-01-01T00:00:00Z') } });
  });
});

describe('remindersFor', () => {
  const day = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

  it('splits connections into expired, expiring within the window, and stale by age, never twice', () => {
    const out = remindersFor([
      { id: 'gone', connectorKey: 'a', expiresAt: day(-1) },
      { id: 'soon', connectorKey: 'b', expiresAt: day(3) },
      { id: 'edge', expiresAt: day(7) },
      { id: 'later', expiresAt: day(8), createdAt: day(-400) },
      { id: 'old', connectorKey: 'c', createdAt: day(-120) },
      { id: 'rotated', createdAt: day(-120), rotatedAt: day(-10) },
      { id: 'fresh', createdAt: day(-89) },
      { id: 'undated' },
    ], NOW, { maxAgeDays: 90 });
    expect(out.expired).toEqual([{ id: 'gone', connectorKey: 'a', expiresAt: day(-1) }]);
    expect(out.expiring).toEqual([{ id: 'soon', connectorKey: 'b', expiresAt: day(3), daysLeft: 3 }, { id: 'edge', connectorKey: undefined, expiresAt: day(7), daysLeft: 7 }]);
    expect(out.stale).toEqual([{ id: 'old', connectorKey: 'c', issuedAt: day(-120), ageDays: 120 }]);
  });

  it('leaves the age check off unless the org sets it, honours a custom window, and ignores unparsable dates', () => {
    const rows = [{ id: 'old', createdAt: day(-120) }, { id: 'soon', expiresAt: day(10) }, { id: 'bad', expiresAt: new Date('nope') as any }];
    expect(remindersFor(rows, NOW)).toEqual({ expired: [], expiring: [], stale: [] });
    expect(remindersFor(rows, NOW, { expiryWindowDays: 14 }).expiring.map((r) => r.id)).toEqual(['soon']);
    expect(remindersFor(rows, NOW, { maxAgeDays: 30 }).stale.map((r) => r.id)).toEqual(['old']);
    expect(new RotationService(new RotationRegistry()).remindersFor(rows, NOW, { maxAgeDays: 30 }).stale).toHaveLength(1);
  });

  it('reads the org setting: off by default, true means 90 days, numbers are explicit', () => {
    expect(maxAgeDaysFromSetting(undefined)).toBeNull();
    expect(maxAgeDaysFromSetting(false)).toBeNull();
    expect(maxAgeDaysFromSetting(0)).toBeNull();
    expect(maxAgeDaysFromSetting(true)).toBe(DEFAULT_MAX_AGE_DAYS);
    expect(DEFAULT_MAX_AGE_DAYS).toBe(90);
    expect(maxAgeDaysFromSetting(45.9)).toBe(45);
    expect(maxAgeDaysFromSetting('30')).toBe(30);
  });
});
