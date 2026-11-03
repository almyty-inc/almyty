import { UnauthorizedException } from '@nestjs/common';

import { SsoService } from '../sso.service';
import { SamlReplayCache } from '../saml-replay-cache';
import { FakeRedis } from '../../../../src/test/fake-redis';
import { OrganizationRole } from '../../../../src/entities/user-organization.entity';
import { AuditAction } from '../../../../src/entities/audit-log.entity';

/**
 * SSO sign-ins were not on the audit trail at all: neither the people who
 * came in through the IdP nor the ones refused (a deactivated member, an
 * address with no account). Both are now, with the protocol and, for a
 * refusal, why.
 */
describe('SSO sign-ins on the audit trail', () => {
  const CONFIG = { enabled: true, protocol: 'oidc', jitProvisioning: false, defaultRole: OrganizationRole.MEMBER } as any;

  function makeService(membership: any) {
    const audit = { log: jest.fn(async () => null) };
    const service = new SsoService(
      { findOne: jest.fn(async () => ({ id: 'u-1', email: 'dana@acme.example' })) } as any,
      { findOne: jest.fn(async () => membership) } as any,
      { getDecrypted: jest.fn(async () => CONFIG) } as any,
      new SamlReplayCache(new FakeRedis()),
      undefined,
      undefined,
      undefined,
      audit as any,
    );
    return { service, audit };
  }

  it('records a sign-in', async () => {
    const { service, audit } = makeService({ isActive: true, inviteAccepted: true, inviteToken: null });

    await service.completeSsoLogin('org-1', { email: 'Dana@acme.example' }, 'oidc');

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: 'u-1',
        action: AuditAction.SSO_LOGIN,
        status: 'success',
        details: { protocol: 'oidc' },
      }),
    );
  });

  it('records a deactivated member being refused, with the reason', async () => {
    const { service, audit } = makeService({ isActive: false, inviteAccepted: true, inviteToken: null });

    await expect(service.completeSsoLogin('org-1', { email: 'dana@acme.example' }, 'oidc')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.SSO_LOGIN,
        status: 'denied',
        userEmail: 'dana@acme.example',
        details: { protocol: 'oidc', reason: 'Your access to this organization has been deactivated' },
      }),
    );
  });
});
