import { LicensingController } from '../licensing.controller';
import { LicenseService } from '../license.service';
import { OrgLicenseResolver } from '../org-license.resolver';
import { EDITION_COMMUNITY, EDITION_ENTERPRISE, EE_ENTITLEMENTS } from '../license.constants';

describe('LicensingController', () => {
  it('returns the per-org snapshot when the request carries org context', async () => {
    const svc = new LicenseService();
    svc.load({ token: '' }); // global = community

    const orgSnapshot = {
      edition: EDITION_ENTERPRISE,
      entitlements: ['agents', EE_ENTITLEMENTS.ADVANCED_RBAC],
      limits: { seats: 5 },
      expiresAt: null,
      issuedTo: 'paid-org',
    };
    const resolver = {
      entitlementsForOrg: jest.fn(async () => orgSnapshot),
    } as unknown as OrgLicenseResolver;

    const ctrl = new LicensingController(svc, resolver);
    const result = await ctrl.getEntitlements({
      user: { currentOrganizationId: 'org-paid' },
    });

    expect(resolver.entitlementsForOrg).toHaveBeenCalledWith('org-paid');
    expect(result.edition).toBe(EDITION_ENTERPRISE);
    expect(result.entitlements).toContain(EE_ENTITLEMENTS.ADVANCED_RBAC);
  });

  it('falls back to the global snapshot when there is no org context', async () => {
    const svc = new LicenseService();
    svc.load({ token: '' });

    const resolver = {
      entitlementsForOrg: jest.fn(),
    } as unknown as OrgLicenseResolver;

    const ctrl = new LicensingController(svc, resolver);
    const result = await ctrl.getEntitlements({ user: {} });

    expect(resolver.entitlementsForOrg).not.toHaveBeenCalled();
    expect(result.edition).toBe(EDITION_COMMUNITY);
    expect(result.entitlements).toContain('agents');
  });
});
