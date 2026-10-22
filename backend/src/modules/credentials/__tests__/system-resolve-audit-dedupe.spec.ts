import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditAction } from '../../../entities/audit-log.entity';
import { Credential, CredentialType } from '../../../entities/credential.entity';
import { encryptField } from '../../../common/security/field-crypto';
import { makeCredentialRefFake } from '../../../test/credential-ref.fake';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';
import { CONNECTION_USE_POLICY, ConnectionUsePolicy, CredentialRefResolver } from '../credential-ref.resolver';
import {
  DEFAULT_SYSTEM_RESOLVE_AUDIT_INTERVAL_MS,
  SYSTEM_RESOLVE_AUDIT_INTERVAL_ENV,
  SYSTEM_RESOLVE_AUDIT_MAX_KEYS_ENV,
  SystemResolveAuditDedupe,
} from '../system-resolve-audit-dedupe';

/**
 * Background loops (hosted runner reconcile and its processor) resolve the
 * cluster connection every minute with nobody behind them. A row per call
 * buried the audit log, so a system resolve is written on first use, when
 * its outcome or the connection's state changes, and again once the
 * heartbeat interval has passed. A resolve with a user or a run behind it
 * is still written every time.
 */
describe('system resolves are audited on first use, on change and on a heartbeat', () => {
  const ctx = { purpose: 'hosted_runner_reconcile', resourceType: 'hosted_runner', resourceId: 'hr-1' };
  let nowSpy: jest.SpyInstance<number, []>;
  let now = 1_700_000_000_000;

  beforeEach(() => {
    now = 1_700_000_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    nowSpy.mockRestore();
    delete process.env[SYSTEM_RESOLVE_AUDIT_INTERVAL_ENV];
    delete process.env[SYSTEM_RESOLVE_AUDIT_MAX_KEYS_ENV];
  });

  async function build(policy?: ConnectionUsePolicy) {
    const store = makeCredentialRefFake();
    const audit = { log: jest.fn(async () => null) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CredentialRefResolver,
        { provide: getRepositoryToken(Credential), useValue: store.repo },
        { provide: EnvelopeCryptoService, useValue: makeEnvelopeCryptoMock() },
        { provide: AuditLogService, useValue: audit },
        ...(policy ? [{ provide: CONNECTION_USE_POLICY, useValue: policy }] : []),
      ],
    }).compile();
    const resolver = moduleRef.get(CredentialRefResolver);
    const row = store.seed({
      organizationId: 'org-platform', name: 'staging cluster', type: CredentialType.CUSTOM,
      connectorKey: 'kubernetes', ownerUserId: null, healthStatus: 'valid', config: { token: encryptField('kube-token') },
    } as Partial<Credential>);
    return { store, audit, resolver, row };
  }

  const rows = (audit: { log: jest.Mock }) => audit.log.mock.calls.map((c: any[]) => c[0]);

  it('writes one row for repeated system resolves with the same outcome', async () => {
    const { audit, resolver, row } = await build();
    for (let i = 0; i < 5; i++) {
      await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
      now += 60_000;
    }
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(rows(audit)[0]).toEqual(expect.objectContaining({
      action: AuditAction.CONNECTION_RESOLVE, resourceId: row.id, status: 'success',
      details: expect.objectContaining({ via: 'system', purpose: 'hosted_runner_reconcile' }),
    }));
  });

  it('keys by consumer: another hosted runner or purpose gets its own first row', async () => {
    const { audit, resolver, row } = await build();
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
    await resolver.resolve('org-platform', row.id, { principal: null, context: { ...ctx, resourceId: 'hr-2' } });
    await resolver.resolve('org-platform', row.id, { principal: null, context: { ...ctx, purpose: 'hosted_runner_provision' } });
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
    expect(audit.log).toHaveBeenCalledTimes(3);
  });

  it('writes a new row when the outcome changes: success -> failure -> success', async () => {
    const { audit, resolver, row } = await build();
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
    row.isActive = false;
    await expect(resolver.resolve('org-platform', row.id, { principal: null, context: ctx })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(resolver.resolve('org-platform', row.id, { principal: null, context: ctx })).rejects.toBeInstanceOf(ForbiddenException);
    row.isActive = true;
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });

    expect(rows(audit).map((r) => r.status)).toEqual(['success', 'error', 'success']);
    expect(rows(audit)[1]).toEqual(expect.objectContaining({
      action: AuditAction.CONNECTION_RESOLVE, resourceId: row.id,
      details: expect.objectContaining({ via: 'system', error: 'CREDENTIAL_INACTIVE' }),
    }));
  });

  it('writes a new row when the connection rotates or its health changes', async () => {
    const { audit, resolver, row } = await build();
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
    row.config = { token: encryptField('rotated-token') };
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
    row.healthStatus = 'failed';
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
    row.healthCheckedAt = new Date();
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
    expect(audit.log).toHaveBeenCalledTimes(3);
  });

  it('writes a row for every resolve with a user or a run behind it', async () => {
    const { audit, resolver, row } = await build();
    for (let i = 0; i < 3; i++) {
      await resolver.resolve('org-platform', row.id, { principal: { id: 'u-1' }, context: ctx });
    }
    for (let i = 0; i < 2; i++) {
      await resolver.resolve('org-platform', row.id, {
        principal: { kind: 'user', userId: 'u-1', source: 'session' } as any, context: ctx,
      });
    }
    expect(audit.log).toHaveBeenCalledTimes(5);
    expect(rows(audit).every((r) => r.userId === 'u-1')).toBe(true);
  });

  it('writes a fresh row once the heartbeat interval has passed', async () => {
    const { audit, resolver, row } = await build();
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
    now += DEFAULT_SYSTEM_RESOLVE_AUDIT_INTERVAL_MS - 1;
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
    expect(audit.log).toHaveBeenCalledTimes(1);
    now += 1;
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
    expect(audit.log).toHaveBeenCalledTimes(2);
  });

  it('reads the heartbeat interval from the environment', async () => {
    process.env[SYSTEM_RESOLVE_AUDIT_INTERVAL_ENV] = '1000';
    const { audit, resolver, row } = await build();
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
    now += 1000;
    await resolver.resolve('org-platform', row.id, { principal: null, context: ctx });
    expect(audit.log).toHaveBeenCalledTimes(2);
  });

  it('stays bounded: the least recently recorded key is evicted past the cap', () => {
    process.env[SYSTEM_RESOLVE_AUDIT_MAX_KEYS_ENV] = '2';
    const dedupe = new SystemResolveAuditDedupe();
    const key = (id: string) => ({ organizationId: 'o', credentialId: id, purpose: 'p' });
    expect(dedupe.shouldRecord(key('a'), 'ok')).toBe(true);
    expect(dedupe.shouldRecord(key('b'), 'ok')).toBe(true);
    expect(dedupe.shouldRecord(key('c'), 'ok')).toBe(true);
    expect(dedupe.size).toBe(2);
    expect(dedupe.shouldRecord(key('c'), 'ok')).toBe(false);
    // 'a' was evicted, so it is written again.
    expect(dedupe.shouldRecord(key('a'), 'ok')).toBe(true);
  });
});
