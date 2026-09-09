import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { AuditAction, AuditResource } from '../../../../src/entities/audit-log.entity';
import {
  agentEnvironment,
  CONNECTIONS_AUDIT_RETENTION_ENV,
  CONNECTIONS_EXPIRED_EVENT,
  CONNECTIONS_EXPIRING_EVENT,
  CONNECTIONS_ROTATION_EVENT,
  ConnectionsGovernanceService,
  csvCell,
  POLICY_CACHE_TTL_MS,
  toCsv,
} from '../connections-governance.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-08T03:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const repo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  save: jest.fn(async (row: any) => ({ id: 'saved', ...row })),
  remove: jest.fn(async (row: any) => row),
  delete: jest.fn(async () => ({ affected: 0 })),
  create: jest.fn((row: any) => row),
});

function build(overrides: { rotator?: any; grantRevoker?: any; notifications?: any } = {}) {
  const repos = { policies: repo(), credentials: repo(), grants: repo(), agents: repo(), users: repo(), auditLogs: repo(), budgets: repo() };
  const catalog = { list: jest.fn().mockResolvedValue([{ key: 'openai', capabilities: ['rotate'] }, { key: 'anthropic' }]) };
  const auditLog = { log: jest.fn().mockResolvedValue(null) };
  const spend = { periodToDateCents: jest.fn().mockResolvedValue(0) };
  const notifications = overrides.notifications === null ? undefined : overrides.notifications ?? { emit: jest.fn().mockResolvedValue(undefined) };
  const service = new ConnectionsGovernanceService(
    repos.policies as any, repos.credentials as any, repos.grants as any, repos.agents as any, repos.users as any, repos.auditLogs as any, repos.budgets as any,
    catalog as any, auditLog as any, spend as any, notifications as any, overrides.rotator, overrides.grantRevoker,
  );
  service.now = () => NOW;
  return { service, repos, catalog, auditLog, spend, notifications };
}

describe('ConnectionsGovernanceService policies', () => {
  it('validates, stores and audits a new policy, scoped to the org', async () => {
    const { service, repos, auditLog } = build();
    const row = await service.create('org-1', 'u1', { kind: 'expiry_rule', name: '  Rotate quarterly  ', rule: { maxAgeDays: 90, warnDays: 7, enforce: true } });
    expect(repos.policies.create).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1', kind: 'expiry_rule', name: 'Rotate quarterly', createdBy: 'u1', enabled: true, rule: { maxAgeDays: 90, warnDays: 7, enforce: true } }));
    expect(row.id).toBe('saved');
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1', userId: 'u1', action: AuditAction.CREATE, resourceType: AuditResource.ORGANIZATION, resourceName: 'connection_policy:expiry_rule', details: expect.objectContaining({ policyId: 'saved' }) }));
  });

  it('refuses an invalid rule before touching the repository', async () => {
    const { service, repos } = build();
    await expect(service.create('org-1', 'u1', { kind: 'scope_rule', rule: { principalKinds: [], requireOwner: 'org' } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('org-1', 'u1', { kind: 'bogus' as any, rule: {} })).rejects.toBeInstanceOf(BadRequestException);
    expect(repos.policies.save).not.toHaveBeenCalled();
  });

  it('scopes get/update/remove to the organization and refuses a kind change', async () => {
    const { service, repos, auditLog } = build();
    await expect(service.get('org-1', 'p1')).rejects.toBeInstanceOf(NotFoundException);
    expect(repos.policies.findOne).toHaveBeenCalledWith({ where: { id: 'p1', organizationId: 'org-1' } });

    repos.policies.findOne.mockResolvedValue({ id: 'p1', organizationId: 'org-1', kind: 'connector_allowlist', rule: { connectorKeys: ['openai'] }, enabled: true });
    await expect(service.update('org-1', 'p1', 'u1', { kind: 'expiry_rule' as any })).rejects.toBeInstanceOf(BadRequestException);
    const updated = await service.update('org-1', 'p1', 'u1', { rule: { connectorKeys: ['anthropic'] }, enabled: false });
    expect(updated.rule).toEqual({ connectorKeys: ['anthropic'] });
    expect(updated.enabled).toBe(false);
    expect(auditLog.log).toHaveBeenLastCalledWith(expect.objectContaining({ action: AuditAction.UPDATE }));

    await service.remove('org-1', 'p1', 'u1');
    expect(repos.policies.remove).toHaveBeenCalled();
    expect(auditLog.log).toHaveBeenLastCalledWith(expect.objectContaining({ action: AuditAction.DELETE, details: expect.objectContaining({ policyId: 'p1' }) }));
  });

  it('caches enabled policies per org and drops the cache on writes', async () => {
    const { service, repos } = build();
    repos.policies.find.mockResolvedValue([{ id: 'p1', kind: 'expiry_rule', rule: { maxAgeDays: 30, warnDays: 1, enforce: false }, enabled: true }]);
    await service.enabledPolicies('org-1');
    await service.enabledPolicies('org-1');
    expect(repos.policies.find).toHaveBeenCalledTimes(1);
    expect(repos.policies.find).toHaveBeenCalledWith({ where: { organizationId: 'org-1', enabled: true } });
    service.invalidate('org-1');
    await service.enabledPolicies('org-1');
    expect(repos.policies.find).toHaveBeenCalledTimes(2);
    service.now = () => new Date(NOW.getTime() + POLICY_CACHE_TTL_MS + 1);
    await service.enabledPolicies('org-1');
    expect(repos.policies.find).toHaveBeenCalledTimes(3);
  });
});

describe('ConnectionsGovernanceService decisions', () => {
  it('decideUse derives the environment from the agent when the caller does not pass one', async () => {
    const { service, repos } = build();
    repos.policies.find.mockResolvedValue([{ id: 's', kind: 'scope_rule', rule: { principalKinds: ['agent'], environments: ['production'], requireOwner: 'org' }, enabled: true }]);
    repos.agents.findOne.mockResolvedValue({ id: 'a1', metadata: { tags: ['Production'] }, settings: null });
    const denied = await service.decideUse('org-1', { id: 'c1', ownerUserId: 'u1', connectorKey: 'openai' }, { userId: 'u1' }, { resourceType: 'agent', resourceId: 'a1' });
    expect(denied.allowed).toBe(false);
    expect(repos.agents.findOne).toHaveBeenCalledWith({ where: { id: 'a1', organizationId: 'org-1' } });

    repos.agents.findOne.mockResolvedValue({ id: 'a2', metadata: { environment: 'staging' } });
    const allowed = await service.decideUse('org-1', { id: 'c1', ownerUserId: 'u1', connectorKey: 'openai' }, { userId: 'u1', agentId: 'a2' });
    expect(allowed.allowed).toBe(true);
  });

  it('decideUse short-circuits when the org has no scope rule', async () => {
    const { service, repos } = build();
    repos.policies.find.mockResolvedValue([{ id: 'a', kind: 'connector_allowlist', rule: { connectorKeys: ['x'] }, enabled: true }]);
    const decision = await service.decideUse('org-1', { id: 'c1', ownerUserId: 'u1' }, { userId: 'u1', agentId: 'a1' });
    expect(decision.allowed).toBe(true);
    expect(repos.agents.findOne).not.toHaveBeenCalled();
  });

  it('assertBudget refuses an exhausted grant budget and ignores inactive or foreign budgets', async () => {
    const { service, repos, spend } = build();
    await service.assertBudget('org-1', null);
    expect(repos.budgets.findOne).not.toHaveBeenCalled();

    repos.budgets.findOne.mockResolvedValue({ id: 'b1', organizationId: 'org-1', active: true, agentId: null, periodType: 'month', limitCents: 1000 });
    spend.periodToDateCents.mockResolvedValue(999);
    await service.assertBudget('org-1', 'b1', 'agent-1');
    expect(spend.periodToDateCents).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1', agentId: 'agent-1' }));

    spend.periodToDateCents.mockResolvedValue(1000);
    await expect(service.assertBudget('org-1', 'b1')).rejects.toMatchObject({ response: { code: 'CONNECTION_BUDGET_EXHAUSTED', spentCents: 1000, limitCents: 1000 } });

    repos.budgets.findOne.mockResolvedValue({ id: 'b1', organizationId: 'org-1', active: false, periodType: 'month', limitCents: 1 });
    await service.assertBudget('org-1', 'b1');
    repos.budgets.findOne.mockResolvedValue(null);
    await service.assertBudget('org-1', 'b1');
  });

  it('agentEnvironment reads metadata, settings, then the production tag', () => {
    expect(agentEnvironment({ metadata: { environment: ' Production ' }, settings: null } as any)).toBe('production');
    expect(agentEnvironment({ metadata: null, settings: { environment: 'staging' } } as any)).toBe('staging');
    expect(agentEnvironment({ metadata: { tags: ['prod', 'PRODUCTION'] }, settings: null } as any)).toBe('production');
    expect(agentEnvironment({ metadata: {}, settings: {} } as any)).toBeNull();
  });
});

describe('ConnectionsGovernanceService review', () => {
  const connection = (id: string, extra: Record<string, unknown> = {}) => ({
    id, organizationId: 'org-1', name: `conn ${id}`, connectorKey: 'openai', ownerUserId: 'u1', accountLabel: 'acct', healthStatus: 'valid',
    healthCheckedAt: NOW, healthError: null, expiresAt: null, createdAt: daysAgo(10), metadata: null, ...extra,
  });

  it('returns user-scoped connections with their agent/workspace grants, owner, health and last resolve', async () => {
    const { service, repos } = build();
    repos.credentials.find.mockResolvedValue([connection('c1'), connection('c2')]);
    repos.grants.find.mockResolvedValue([
      { id: 'g1', connectionId: 'c1', principalType: 'agent', principalId: 'a1', permission: 'use', budgetId: null, expiresAt: null, grantedBy: 'u1', createdAt: NOW },
      { id: 'g2', connectionId: 'c1', principalType: 'workspace', principalId: 'w1', permission: 'use', budgetId: 'b1', expiresAt: null, grantedBy: 'u1', createdAt: NOW },
      { id: 'g3', connectionId: 'c1', principalType: 'agent', principalId: 'a2', permission: 'use', budgetId: null, expiresAt: daysAgo(1), grantedBy: 'u1', createdAt: NOW },
    ]);
    repos.agents.find.mockResolvedValue([{ id: 'a1', name: 'Billing bot', metadata: { environment: 'production' } }, { id: 'a2', name: 'Old', metadata: {} }]);
    repos.users.find.mockResolvedValue([{ id: 'u1', email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee' }]);
    repos.auditLogs.findOne.mockResolvedValue({ createdAt: NOW, userId: 'u1', details: { agentId: 'a1', workspaceId: null, purpose: 'llm' } });

    const rows = await service.review('org-1');
    expect(repos.credentials.find).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-1' }) }));
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.connection).toMatchObject({ id: 'c1', connectorKey: 'openai', owner: 'user', health: { status: 'valid', checkedAt: NOW, error: null }, secretSetAt: daysAgo(10) });
    expect(row.owner).toEqual({ id: 'u1', email: 'ann@example.com', name: 'Ann Lee' });
    expect(row.grants.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(row.grants[0]).toMatchObject({ principalType: 'agent', principalName: 'Billing bot', environment: 'production' });
    expect(row.grants[1]).toMatchObject({ principalType: 'workspace', principalName: null, environment: null, budgetId: 'b1' });
    expect(row.lastResolve).toEqual({ at: NOW, userId: 'u1', agentId: 'a1', workspaceId: null, purpose: 'llm' });
    expect(repos.auditLogs.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ resourceId: 'c1', action: AuditAction.CONNECTION_RESOLVE }), order: { createdAt: 'DESC' } }));
  });

  it('environment=production keeps only grants to production agents', async () => {
    const { service, repos } = build();
    repos.credentials.find.mockResolvedValue([connection('c1')]);
    repos.grants.find.mockResolvedValue([
      { id: 'g1', connectionId: 'c1', principalType: 'agent', principalId: 'a1', permission: 'use', createdAt: NOW },
      { id: 'g2', connectionId: 'c1', principalType: 'workspace', principalId: 'w1', permission: 'use', createdAt: NOW },
    ]);
    repos.agents.find.mockResolvedValue([{ id: 'a1', name: 'Billing bot', metadata: { environment: 'production' } }]);
    const rows = await service.review('org-1', 'Production');
    expect(rows[0].grants.map((g) => g.id)).toEqual(['g1']);
    repos.agents.find.mockResolvedValue([{ id: 'a1', name: 'Billing bot', metadata: {} }]);
    expect(await service.review('org-1', 'production')).toEqual([]);
  });

  it('revokeGrants goes through the grants seam when bound, else removes rows and audits', async () => {
    const seam = { revoke: jest.fn().mockResolvedValue({}), invalidate: jest.fn() };
    const withSeam = build({ grantRevoker: seam });
    withSeam.repos.credentials.findOne.mockResolvedValue(connection('c1'));
    withSeam.repos.grants.find.mockResolvedValue([{ id: 'g1', principalType: 'agent' }, { id: 'g2', principalType: 'workspace' }]);
    expect(await withSeam.service.revokeGrants('org-1', 'c1', { id: 'admin' })).toEqual({ revoked: 2, grantIds: ['g1', 'g2'] });
    expect(withSeam.repos.grants.find).toHaveBeenCalledWith({ where: expect.objectContaining({ organizationId: 'org-1', connectionId: 'c1' }) });
    expect(seam.revoke).toHaveBeenCalledWith('g1', { id: 'admin' }, 'org-1');
    expect(withSeam.repos.grants.remove).not.toHaveBeenCalled();

    const fallback = build();
    fallback.repos.credentials.findOne.mockResolvedValue(connection('c1'));
    fallback.repos.grants.find.mockResolvedValue([{ id: 'g1', principalType: 'agent', principalId: 'a1', permission: 'use' }]);
    await fallback.service.revokeGrants('org-1', 'c1', { id: 'admin' }, ['agent']);
    expect(fallback.repos.grants.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }));
    expect(fallback.auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.CONNECTION_REVOKE_GRANT, resourceId: 'c1', userId: 'admin', details: expect.objectContaining({ grantId: 'g1', via: 'governance.review', owner: 'user' }) }));

    fallback.repos.credentials.findOne.mockResolvedValue(null);
    await expect(fallback.service.revokeGrants('org-1', 'missing', { id: 'admin' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ConnectionsGovernanceService expiry', () => {
  const setup = (enforce: boolean) => {
    const ctx = build();
    ctx.repos.policies.find.mockResolvedValue([{ id: 'exp', kind: 'expiry_rule', rule: { maxAgeDays: 90, warnDays: 7, enforce }, enabled: true }]);
    ctx.repos.credentials.find.mockResolvedValue([
      { id: 'warn', organizationId: 'org-1', name: 'warn me', connectorKey: 'openai', ownerUserId: 'u1', createdAt: daysAgo(85), healthStatus: 'valid' },
      { id: 'old', organizationId: 'org-1', name: 'too old', connectorKey: 'openai', ownerUserId: null, createdAt: daysAgo(120), healthStatus: 'valid' },
    ]);
    ctx.repos.grants.find.mockResolvedValue([{ id: 'g1', principalType: 'agent', principalId: 'a1', permission: 'use' }]);
    return ctx;
  };

  it('expiring reports the warn and expire lists without changing anything', async () => {
    const { service, repos } = setup(true);
    const actions = await service.expiring('org-1');
    expect(actions.warn.map((a) => a.connectionId)).toEqual(['warn']);
    expect(actions.expire.map((a) => a.connectionId)).toEqual(['old']);
    expect(repos.credentials.save).not.toHaveBeenCalled();
  });

  it('warn mode marks expired and notifies but keeps grants', async () => {
    const { service, repos, notifications, auditLog } = setup(false);
    const result = await service.enforceExpiry('org-1');
    expect(result).toEqual({ organizationId: 'org-1', warned: 1, expired: 1, revokedGrants: 0, enforce: false });
    expect(repos.credentials.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'old', healthStatus: 'expired', healthCheckedAt: NOW }));
    expect(repos.grants.remove).not.toHaveBeenCalled();
    expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({ type: CONNECTIONS_EXPIRING_EVENT, userIds: ['u1'], organizationId: 'org-1' }));
    expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({ type: CONNECTIONS_EXPIRED_EVENT, userIds: undefined, roleTarget: { orgRoles: ['owner', 'admin'] } }));
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.CONNECTION_VALIDATE, resourceId: 'old', details: expect.objectContaining({ status: 'expired', source: 'governance.expiry', enforce: false, revokedGrants: 0 }) }));
  });

  it('enforce mode also revokes every grant on the expired connection', async () => {
    const { service, repos, auditLog } = setup(true);
    const result = await service.enforceExpiry('org-1');
    expect(result).toMatchObject({ expired: 1, revokedGrants: 1, enforce: true });
    expect(repos.grants.find).toHaveBeenCalledWith({ where: { connectionId: 'old' } });
    expect(repos.grants.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }));
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.CONNECTION_REVOKE_GRANT, details: expect.objectContaining({ via: 'governance.expiry' }) }));
  });

  it('survives a missing notification service', async () => {
    const ctx = build({ notifications: null });
    ctx.repos.policies.find.mockResolvedValue([{ id: 'exp', kind: 'expiry_rule', rule: { maxAgeDays: 1, warnDays: 0, enforce: false }, enabled: true }]);
    ctx.repos.credentials.find.mockResolvedValue([{ id: 'old', organizationId: 'org-1', name: 'x', connectorKey: 'openai', createdAt: daysAgo(5) }]);
    await expect(ctx.service.enforceExpiry('org-1')).resolves.toMatchObject({ expired: 1 });
  });
});

describe('ConnectionsGovernanceService rotation', () => {
  const setup = (rotator?: any) => {
    const ctx = build({ rotator });
    ctx.repos.policies.find.mockResolvedValue([{ id: 'rot', kind: 'rotation_rule', rule: { everyDays: 30, requireProviderApi: true }, enabled: true }]);
    ctx.repos.credentials.find.mockResolvedValue([
      { id: 'api', organizationId: 'org-1', name: 'openai key', connectorKey: 'openai', ownerUserId: null, createdAt: daysAgo(45) },
      { id: 'hand', organizationId: 'org-1', name: 'anthropic key', connectorKey: 'anthropic', ownerUserId: 'u1', createdAt: daysAgo(45) },
      { id: 'fresh', organizationId: 'org-1', name: 'new', connectorKey: 'openai', createdAt: daysAgo(2) },
    ]);
    ctx.repos.credentials.findOne.mockImplementation(async ({ where }: any) => ({ id: where.id, organizationId: 'org-1', name: where.id, connectorKey: where.id === 'api' ? 'openai' : 'anthropic', ownerUserId: where.id === 'hand' ? 'u1' : null }));
    return ctx;
  };

  it('reads capabilities from the catalog and the rotator', async () => {
    const rotator = { rotate: jest.fn(), canRotate: jest.fn((key: string) => key === 'anthropic') };
    const { service } = setup(rotator);
    expect(await service.rotationCapabilities('org-1')).toEqual({ openai: true, anthropic: true });
    expect(await build().service.rotationCapabilities('org-1')).toEqual({ openai: true, anthropic: false });
  });

  it('rotates due connections through the seam, audits, and notifies owners of manual ones', async () => {
    const rotator = { rotate: jest.fn().mockResolvedValue({ rotated: true }) };
    const { service, auditLog, notifications } = setup(rotator);
    const result = await service.rotateDue('org-1');
    expect(result).toEqual({ organizationId: 'org-1', rotated: 1, failed: 0, manual: 1 });
    expect(rotator.rotate).toHaveBeenCalledWith('api');
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.CONNECTION_ROTATE, resourceId: 'api', details: expect.objectContaining({ source: 'governance.schedule', rotated: true, policyId: 'rot' }) }));
    expect(notifications.emit).toHaveBeenCalledTimes(1);
    expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({ type: CONNECTIONS_ROTATION_EVENT, userIds: ['u1'] }));
  });

  it('counts a throwing rotator as failed and a manual outcome as manual; without a rotator everything is manual', async () => {
    const failing = setup({ rotate: jest.fn().mockRejectedValue(new Error('provider down')) });
    expect(await failing.service.rotateDue('org-1')).toMatchObject({ rotated: 0, failed: 1, manual: 1 });
    expect(failing.auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ rotated: false, error: 'provider down' }) }));

    const manual = setup({ rotate: jest.fn().mockResolvedValue({ rotated: false, manual: true }) });
    expect(await manual.service.rotateDue('org-1')).toMatchObject({ rotated: 0, failed: 0, manual: 2 });

    const none = setup(undefined);
    expect(await none.service.rotateDue('org-1')).toMatchObject({ rotated: 0, failed: 0, manual: 2 });
  });
});

describe('ConnectionsGovernanceService audit export + retention', () => {
  const rows = [
    { id: 'e1', createdAt: NOW, organizationId: 'org-1', userId: 'u1', userEmail: 'a@b.c', action: 'connection_resolve', resourceType: 'connection', resourceId: 'c1', resourceName: 'my "key", v2', status: null, ipAddress: null, details: { purpose: 'llm' } },
  ];

  it('queries connection, connector and policy events in the window', async () => {
    const { service, repos } = build();
    repos.auditLogs.find.mockResolvedValue(rows);
    const from = daysAgo(30);
    await service.collectEvents('org-1', { from, to: NOW, limit: 10 });
    const call = repos.auditLogs.find.mock.calls[0][0];
    expect(call.take).toBe(10);
    expect(call.order).toEqual({ createdAt: 'DESC' });
    expect(call.where).toHaveLength(2);
    expect(call.where[0]).toMatchObject({ organizationId: 'org-1' });
    expect(call.where[1]).toMatchObject({ organizationId: 'org-1', resourceType: AuditResource.ORGANIZATION });
    expect(call.where[0].createdAt).toBeDefined();
    await service.collectEvents('org-1', { limit: 1_000_000 });
    expect(repos.auditLogs.find.mock.calls[1][0].take).toBe(50_000);
  });

  it('writes the JSON envelope with the Annex IV mapping and retention', async () => {
    const { service, repos } = build();
    repos.auditLogs.find.mockResolvedValue(rows);
    delete process.env[CONNECTIONS_AUDIT_RETENTION_ENV];
    const result = await service.export('org-1', 'json', { from: daysAgo(1) });
    expect(result).toMatchObject({ format: 'json', contentType: 'application/json', filename: 'connections-audit-2026-09-08.json', count: 1, retentionDays: null });
    const body = JSON.parse(result.body);
    expect(body.documentType).toBe('connections-audit-export');
    expect(body.standard).toBe('EU AI Act Annex IV (informative mapping)');
    expect(body.retention).toEqual({ days: null, source: 'unlimited' });
    expect(Object.keys(body.annexIvMapping).length).toBeGreaterThan(3);
    expect(body.events[0].id).toBe('e1');
    expect(body.window.from).toBe(daysAgo(1).toISOString());
  });

  it('writes RFC 4180 CSV with the fixed column order', async () => {
    const { service, repos } = build();
    repos.auditLogs.find.mockResolvedValue(rows);
    process.env[CONNECTIONS_AUDIT_RETENTION_ENV] = '400';
    const result = await service.export('org-1', 'csv');
    expect(result).toMatchObject({ format: 'csv', contentType: 'text/csv', filename: 'connections-audit-2026-09-08.csv', retentionDays: 400 });
    const [header, line] = result.body.split('\n');
    expect(header).toBe('id,createdAt,organizationId,userId,userEmail,action,resourceType,resourceId,resourceName,status,ipAddress,details');
    expect(line).toBe(`e1,${NOW.toISOString()},org-1,u1,a@b.c,connection_resolve,connection,c1,"my ""key"", v2",,,"{""purpose"":""llm""}"`);
    expect(toCsv([])).toBe(header);
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    delete process.env[CONNECTIONS_AUDIT_RETENTION_ENV];
  });

  it('sweeps connection events older than the retention window and audits the sweep', async () => {
    const { service, repos, auditLog } = build();
    delete process.env[CONNECTIONS_AUDIT_RETENTION_ENV];
    expect(await service.sweepRetention('org-1')).toBe(0);
    expect(repos.auditLogs.delete).not.toHaveBeenCalled();

    process.env[CONNECTIONS_AUDIT_RETENTION_ENV] = 'abc';
    expect(service.retentionDays()).toBeNull();
    process.env[CONNECTIONS_AUDIT_RETENTION_ENV] = '30';
    repos.auditLogs.delete.mockResolvedValue({ affected: 7 });
    expect(await service.sweepRetention('org-1')).toBe(7);
    expect(repos.auditLogs.delete).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }));
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.RETENTION_SWEEP, resourceType: AuditResource.ORGANIZATION, details: expect.objectContaining({ removed: 7, retentionDays: 30, stream: 'connections' }) }));
    delete process.env[CONNECTIONS_AUDIT_RETENTION_ENV];
  });

  it('organizationsWithPolicies deduplicates org ids', async () => {
    const { service, repos } = build();
    repos.policies.find.mockResolvedValue([{ organizationId: 'a' }, { organizationId: 'b' }, { organizationId: 'a' }]);
    expect(await service.organizationsWithPolicies(['expiry_rule'])).toEqual(['a', 'b']);
  });
});

describe('ForbiddenException shape', () => {
  it('assertBudget throws a ForbiddenException', async () => {
    const { service, repos, spend } = build();
    repos.budgets.findOne.mockResolvedValue({ id: 'b1', organizationId: 'org-1', active: true, periodType: 'day', limitCents: 1 });
    spend.periodToDateCents.mockResolvedValue(5);
    await expect(service.assertBudget('org-1', 'b1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
