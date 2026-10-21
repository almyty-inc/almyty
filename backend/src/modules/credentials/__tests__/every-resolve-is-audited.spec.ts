import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { Credential, CredentialType } from '../../../entities/credential.entity';
import { encryptField } from '../../../common/security/field-crypto';
import { makeCredentialRefFake } from '../../../test/credential-ref.fake';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';
import { CONNECTION_USE_POLICY, ConnectionUsePolicy, CredentialRefResolver } from '../credential-ref.resolver';

/**
 * Every use of a stored secret is written to the audit log
 * (docs/connections.md, "Where secrets live"). The consumer seam,
 * CredentialRefResolver, wrote nothing: hosted runner provisioning
 * resolved the platform `kubernetes` connection on every reconcile and
 * left no row for it. The resolver writes one CONNECTION_RESOLVE row per
 * successful resolve, whoever the principal is, and none for a refused
 * one. Built through Nest so the global AuditLogService really reaches it.
 */
describe('every CredentialRefResolver resolve is audited once', () => {
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
    return { store, audit, resolver: moduleRef.get(CredentialRefResolver) };
  }

  it('writes one row for the hosted runner cluster connection resolved with no principal', async () => {
    const { store, audit, resolver } = await build();
    const row = store.seed({
      organizationId: 'org-platform', name: 'staging cluster', type: CredentialType.CUSTOM,
      connectorKey: 'kubernetes', ownerUserId: null, config: { token: encryptField('kube-token') },
    } as Partial<Credential>);

    await resolver.resolve('org-platform', row.id, {
      principal: null,
      context: { purpose: 'hosted_runner_provision', resourceType: 'hosted_runner', resourceId: 'hr-1' },
    });

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-platform',
      action: AuditAction.CONNECTION_RESOLVE,
      resourceType: AuditResource.CONNECTION,
      resourceId: row.id,
      resourceName: 'staging cluster',
      details: expect.objectContaining({
        connectorKey: 'kubernetes',
        owner: 'org',
        purpose: 'hosted_runner_provision',
        resourceType: 'hosted_runner',
        resourceId: 'hr-1',
      }),
    }));
    const call = (audit.log.mock.calls[0] as any[])[0];
    expect(call.userId).toBeUndefined();
  });

  it('names the user and the grant that allowed the use', async () => {
    const { store, audit, resolver } = await build({ assertCanUse: async () => ({ via: 'grant', grant: { id: 'g-1' } }) });
    const row = store.seed({ organizationId: 'org-1', connectorKey: 'openai', config: { apiKey: encryptField('sk') } } as Partial<Credential>);

    await resolver.resolve('org-1', row.id, { principal: { id: 'u-1' }, context: { purpose: 'llm_call', resourceType: 'agent', resourceId: 'a-1' } });

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-1',
      details: expect.objectContaining({ purpose: 'llm_call', resourceType: 'agent', resourceId: 'a-1', via: 'grant', grantId: 'g-1', agentId: 'a-1' }),
    }));
  });

  it('tryResolve writes exactly one row too', async () => {
    const { store, audit, resolver } = await build();
    const row = store.seed({ organizationId: 'org-1', config: { apiKey: 'x' } });
    await resolver.tryResolve('org-1', row.id, { principal: null, context: { purpose: 'spec' } });
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for a refused or missing resolve', async () => {
    const { store, audit, resolver } = await build({ assertCanUse: async () => { throw new ForbiddenException({ code: 'CONNECTION_NOT_GRANTED' }); } });
    const row = store.seed({ organizationId: 'org-1', connectorKey: 'openai', config: { apiKey: 'x' } } as Partial<Credential>);
    await expect(resolver.resolve('org-1', row.id, { principal: { id: 'u-1' }, context: { purpose: 'llm_call' } })).rejects.toBeDefined();
    await expect(resolver.resolve('org-1', 'missing', { principal: null })).rejects.toBeDefined();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
