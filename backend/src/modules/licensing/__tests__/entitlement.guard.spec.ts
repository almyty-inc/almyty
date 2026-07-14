import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EntitlementGuard } from '../guards/entitlement.guard';
import { RequiresEntitlement, ENTITLEMENT_KEY } from '../decorators/requires-entitlement.decorator';
import { LicenseService } from '../license.service';
import { OrgLicenseResolver } from '../org-license.resolver';
import { EE_ENTITLEMENTS } from '../license.constants';

function contextFor(handler: any, user?: any): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

/**
 * A minimal OrgLicenseResolver stub. The guard only calls
 * `entitlementsForOrg`, so we back it with the real LicenseService's pure
 * `resolveToken` and a per-org token map — no repository/DB needed.
 */
function resolverFor(
  license: LicenseService,
  tokensByOrg: Record<string, string | null> = {},
): OrgLicenseResolver {
  return {
    entitlementsForOrg: async (organizationId: string) =>
      license.resolveToken(tokensByOrg[organizationId] ?? null),
    hasForOrg: async (organizationId: string, entitlement: string) =>
      license
        .resolveToken(tokensByOrg[organizationId] ?? null)
        .entitlements.includes(entitlement),
    invalidate: () => undefined,
  } as unknown as OrgLicenseResolver;
}

describe('EntitlementGuard', () => {
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
  });

  it('allows routes with no @RequiresEntitlement metadata', async () => {
    const svc = new LicenseService();
    svc.load({ token: '' });
    const guard = new EntitlementGuard(reflector, svc, resolverFor(svc));

    const handler = () => undefined;
    await expect(guard.canActivate(contextFor(handler))).resolves.toBe(true);
  });

  it('blocks with 402 when there is no org context and the global license lacks it', async () => {
    const svc = new LicenseService();
    svc.load({ token: '' }); // community

    class Ctrl {
      @RequiresEntitlement(EE_ENTITLEMENTS.SSO)
      handler() {}
    }
    const guard = new EntitlementGuard(reflector, svc, resolverFor(svc));
    const ctx = contextFor(Ctrl.prototype.handler); // no user → no org

    await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    try {
      await guard.canActivate(ctx);
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    }
  });

  it('allows when the global license grants the entitlement (no-org route)', async () => {
    const svc = new LicenseService();
    // Force-grant via a stub rather than minting a token — unit isolation.
    jest.spyOn(svc, 'has').mockImplementation((f: string) => f === EE_ENTITLEMENTS.SSO);

    class Ctrl {
      @RequiresEntitlement(EE_ENTITLEMENTS.SSO)
      handler() {}
    }
    const guard = new EntitlementGuard(reflector, svc, resolverFor(svc));
    await expect(
      guard.canActivate(contextFor(Ctrl.prototype.handler)),
    ).resolves.toBe(true);
  });

  it('reports every missing entitlement when several are required', async () => {
    const svc = new LicenseService();
    svc.load({ token: '' });

    class Ctrl {
      @RequiresEntitlement(EE_ENTITLEMENTS.SSO, EE_ENTITLEMENTS.BYO_KMS)
      handler() {}
    }
    const guard = new EntitlementGuard(reflector, svc, resolverFor(svc));

    try {
      await guard.canActivate(contextFor(Ctrl.prototype.handler));
      fail('expected guard to throw');
    } catch (e) {
      const body = (e as HttpException).getResponse() as any;
      expect(body.requiredEntitlements).toEqual([EE_ENTITLEMENTS.SSO, EE_ENTITLEMENTS.BYO_KMS]);
    }
  });

  it('decorator attaches the expected metadata', () => {
    class Ctrl {
      @RequiresEntitlement('sso')
      handler() {}
    }
    const meta = Reflect.getMetadata(ENTITLEMENT_KEY, Ctrl.prototype.handler);
    expect(meta).toEqual(['sso']);
  });

  // ── Per-org resolution ──────────────────────────────────────────────────

  it('allows when the requesting org has a stored token granting the entitlement', async () => {
    const { generateKeyPairSync } = require('crypto');
    const { signLicense } = require('../license-token');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.ALMYTY_LICENSE_PUBLIC_KEY = publicPem;

    const svc = new LicenseService();
    const token = signLicense(
      { entitlements: [EE_ENTITLEMENTS.SSO], limits: { seats: 5 }, expiresAt: null },
      privatePem,
    );

    class Ctrl {
      @RequiresEntitlement(EE_ENTITLEMENTS.SSO)
      handler() {}
    }
    const guard = new EntitlementGuard(
      reflector,
      svc,
      resolverFor(svc, { 'org-paid': token }),
    );

    try {
      await expect(
        guard.canActivate(
          contextFor(Ctrl.prototype.handler, { currentOrganizationId: 'org-paid' }),
        ),
      ).resolves.toBe(true);
    } finally {
      delete process.env.ALMYTY_LICENSE_PUBLIC_KEY;
    }
  });

  it('blocks with 402 when the requesting org has no stored token', async () => {
    const svc = new LicenseService();
    svc.load({ token: '' });

    class Ctrl {
      @RequiresEntitlement(EE_ENTITLEMENTS.SSO)
      handler() {}
    }
    const guard = new EntitlementGuard(reflector, svc, resolverFor(svc));

    await expect(
      guard.canActivate(
        contextFor(Ctrl.prototype.handler, { currentOrganizationId: 'org-free' }),
      ),
    ).rejects.toThrow(HttpException);
  });
});
