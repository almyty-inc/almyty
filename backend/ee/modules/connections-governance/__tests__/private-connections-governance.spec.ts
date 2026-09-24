import { CONNECTIONS_EXPIRING_EVENT, CONNECTIONS_ROTATION_EVENT, ConnectionsGovernanceService } from '../connections-governance.service';

/**
 * Governance is an admin surface. A member's private connection does not
 * exist for admins: it is off the review, expiry and rotation worklists
 * and its grants cannot be revoked through review. The org's rules still
 * apply to it -- it is rotated and expired on schedule -- and only its
 * owner is told.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-08T03:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const repo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  save: jest.fn(async (row: any) => row),
  remove: jest.fn(async (row: any) => row),
  delete: jest.fn(async () => ({ affected: 0 })),
  create: jest.fn((row: any) => row),
});

function build(rotator?: any) {
  const repos = { policies: repo(), credentials: repo(), grants: repo(), agents: repo(), users: repo(), auditLogs: repo(), budgets: repo() };
  const catalog = { list: jest.fn().mockResolvedValue([{ key: 'openai', capabilities: ['rotate'] }, { key: 'anthropic' }]) };
  const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
  const service = new ConnectionsGovernanceService(
    repos.policies as any, repos.credentials as any, repos.grants as any, repos.agents as any, repos.users as any, repos.auditLogs as any, repos.budgets as any,
    catalog as any, { log: jest.fn() } as any, { periodToDateCents: jest.fn() } as any, notifications as any, rotator, undefined,
  );
  service.now = () => NOW;
  return { service, repos, notifications };
}

const personal = { id: 'personal', organizationId: 'org-1', name: 'personal', connectorKey: 'anthropic', ownerUserId: 'u1', visibility: 'org', createdAt: daysAgo(85), healthStatus: 'valid' };
const secret = { id: 'secret', organizationId: 'org-1', name: 'secret', connectorKey: 'anthropic', ownerUserId: 'u2', visibility: 'private', createdAt: daysAgo(85), healthStatus: 'valid' };

describe('governance and private connections', () => {
  it('review lists personal connections but not private ones', async () => {
    const { service, repos } = build();
    repos.credentials.find.mockResolvedValue([personal, secret]);
    repos.grants.find.mockResolvedValue([
      { id: 'g1', connectionId: 'personal', principalType: 'agent', principalId: 'a1', permission: 'use', expiresAt: null, createdAt: NOW },
      { id: 'g2', connectionId: 'secret', principalType: 'agent', principalId: 'a1', permission: 'use', expiresAt: null, createdAt: NOW },
    ]);
    const rows = await service.review('org-1');
    expect(rows.map((r) => r.connection.id)).toEqual(['personal']);
  });

  it('revoking grants through review on a private connection is not found and removes nothing', async () => {
    const { service, repos } = build();
    repos.credentials.findOne.mockResolvedValue(secret);
    repos.grants.find.mockResolvedValue([{ id: 'g2', connectionId: 'secret', principalType: 'agent', principalId: 'a1' }]);
    await expect(service.revokeGrants('org-1', 'secret', { id: 'admin' })).rejects.toMatchObject({ status: 404 });
    expect(repos.grants.remove).not.toHaveBeenCalled();
  });

  it('the expiry worklist leaves private connections out; enforcement still warns their owner alone', async () => {
    const { service, repos, notifications } = build();
    repos.policies.find.mockResolvedValue([{ id: 'exp', kind: 'expiry_rule', rule: { maxAgeDays: 90, warnDays: 7, enforce: false }, enabled: true }]);
    repos.credentials.find.mockResolvedValue([personal, secret]);
    expect((await service.expiring('org-1')).warn.map((a) => a.connectionId)).toEqual(['personal']);

    await service.enforceExpiry('org-1');
    const toSecret = notifications.emit.mock.calls.map(([e]: any[]) => e).filter((e: any) => e.params?.connectionId === 'secret' || e.email?.params?.connectionId === 'secret');
    expect(toSecret).toEqual([expect.objectContaining({ type: CONNECTIONS_EXPIRING_EVENT, userIds: ['u2'], roleTarget: undefined })]);
  });

  it('the rotation worklist leaves private connections out; the schedule still rotates them', async () => {
    const rotator = { rotate: jest.fn().mockResolvedValue({ rotated: false, manual: true }) };
    const { service, repos, notifications } = build(rotator);
    repos.policies.find.mockResolvedValue([{ id: 'rot', kind: 'rotation_rule', rule: { everyDays: 30 }, enabled: true }]);
    repos.credentials.find.mockResolvedValue([personal, secret]);
    repos.credentials.findOne.mockImplementation(async ({ where }: any) => [personal, secret].find((c) => c.id === where.id) ?? null);
    const list = await service.rotationCandidates('org-1');
    expect([...list.due, ...list.manual].map((c) => c.connectionId)).toEqual(['personal']);

    await service.rotateDue('org-1');
    const toSecret = notifications.emit.mock.calls.map(([e]: any[]) => e).filter((e: any) => e.email?.params?.connectionId === 'secret');
    expect(toSecret).toEqual([expect.objectContaining({ type: CONNECTIONS_ROTATION_EVENT, userIds: ['u2'] })]);
  });

  it('a private connection with no owner notifies nobody (never the admins)', async () => {
    const { service, repos, notifications } = build();
    repos.policies.find.mockResolvedValue([{ id: 'exp', kind: 'expiry_rule', rule: { maxAgeDays: 90, warnDays: 7, enforce: false }, enabled: true }]);
    repos.credentials.find.mockResolvedValue([{ ...secret, ownerUserId: null }]);
    await service.enforceExpiry('org-1');
    expect(notifications.emit).not.toHaveBeenCalled();
  });
});
