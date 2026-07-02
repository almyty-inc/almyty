import { ComplianceService } from '../compliance.service';

/**
 * Unit tests for the EE compliance_pack service. The policy repo + audit
 * repo are stubbed; we assert the secure-default fallback, upsert +
 * validation, and the audit-derived report counts / posture score.
 */
describe('ComplianceService', () => {
  function makePolicyRepo(existing: any) {
    return {
      findOne: jest.fn().mockResolvedValue(existing),
      create: jest.fn((v: any) => ({ ...v })),
      save: jest.fn((v: any) => Promise.resolve({ id: 'p1', ...v })),
    };
  }

  function makeAuditRepo(rows: Array<{ action: string; count: string }>) {
    const qb: any = {};
    for (const m of ['select', 'addSelect', 'where', 'andWhere', 'groupBy']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn().mockResolvedValue(rows);
    return { createQueryBuilder: jest.fn(() => qb) };
  }

  it('returns a secure default effective policy when none is configured', async () => {
    const svc = new ComplianceService(makePolicyRepo(null) as any, makeAuditRepo([]) as any);
    const eff = await svc.getEffectivePolicy('org-1');
    expect(eff.configured).toBe(false);
    expect(eff.enforcedPlugins.sort()).toEqual(['pii-filter', 'security-scanner']);
    expect(eff.securityThreshold).toBe('medium');
    expect(eff.blockOnViolation).toBe(true);
  });

  it('returns the stored policy when configured', async () => {
    const repo = makePolicyRepo({
      organizationId: 'org-1',
      enforcedPlugins: ['pii-filter'],
      securityThreshold: 'high',
      blockOnViolation: false,
      piiCategories: ['ssn'],
    });
    const svc = new ComplianceService(repo as any, makeAuditRepo([]) as any);
    const eff = await svc.getEffectivePolicy('org-1');
    expect(eff.configured).toBe(true);
    expect(eff.enforcedPlugins).toEqual(['pii-filter']);
    expect(eff.securityThreshold).toBe('high');
    expect(eff.blockOnViolation).toBe(false);
  });

  it('creates a policy on first upsert', async () => {
    const repo = makePolicyRepo(null);
    const svc = new ComplianceService(repo as any, makeAuditRepo([]) as any);
    await svc.upsertPolicy('org-1', { securityThreshold: 'high', enforcedPlugins: ['security-scanner'] });
    expect(repo.create).toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalled();
  });

  it('rejects an unknown enforceable plugin', async () => {
    const svc = new ComplianceService(makePolicyRepo(null) as any, makeAuditRepo([]) as any);
    await expect(
      svc.upsertPolicy('org-1', { enforcedPlugins: ['bogus'] as any }),
    ).rejects.toThrow(/unknown enforceable plugin/);
  });

  it('rejects an invalid security threshold', async () => {
    const svc = new ComplianceService(makePolicyRepo(null) as any, makeAuditRepo([]) as any);
    await expect(
      svc.upsertPolicy('org-1', { securityThreshold: 'extreme' as any }),
    ).rejects.toThrow(/invalid securityThreshold/);
  });

  it('scores a report from audit activity counts', async () => {
    const repo = makePolicyRepo(null); // default = both enforced + blocking → 100
    const audit = makeAuditRepo([
      { action: 'tool_execute', count: '10' },
      { action: 'credential_use', count: '3' },
      { action: 'login', count: '5' },
    ]);
    const svc = new ComplianceService(repo as any, audit as any);
    const report = await svc.getReport('org-1', {
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-07-01T00:00:00Z'),
    });
    expect(report.activity.totalEvents).toBe(18);
    expect(report.activity.scannableEvents).toBe(10);
    expect(report.activity.credentialAccessEvents).toBe(3);
    expect(report.activity.byAction['login']).toBe(5);
    expect(report.postureScore).toBe(100);
    expect(report.enforcedControls).toHaveLength(2);
    expect(report.enforcedControls.every((c) => c.enforced)).toBe(true);
  });

  it('lowers the posture score when controls are relaxed', async () => {
    const repo = makePolicyRepo({
      organizationId: 'org-1',
      enforcedPlugins: ['pii-filter'],
      securityThreshold: 'low',
      blockOnViolation: false,
      piiCategories: [],
    });
    const svc = new ComplianceService(repo as any, makeAuditRepo([]) as any);
    const report = await svc.getReport('org-1');
    // pii-filter only (40) + no blocking (0) = 40.
    expect(report.postureScore).toBe(40);
    const scanner = report.enforcedControls.find((c) => c.plugin === 'security-scanner');
    expect(scanner?.enforced).toBe(false);
  });
});
