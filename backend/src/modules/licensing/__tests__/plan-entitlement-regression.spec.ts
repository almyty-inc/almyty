import { LicenseService } from '../license.service';
import { EE_ENTITLEMENTS } from '../license.constants';
import { Organization } from '../../../entities/organization.entity';

/**
 * T3.3 regression: EE gating must key off the signed license (LicenseService),
 * NOT the mutable `organization.plan` string. Once the code is public, `plan`
 * is trivially settable to 'enterprise' by any self-hoster; if any EE feature
 * keyed off it, the entire paywall would be bypassable. This test locks in that
 * a community deployment denies an example EE feature regardless of `plan`.
 */
describe('plan is not an entitlement source (T3.3 regression)', () => {
  it('community build denies SSO even when organization.plan claims enterprise', () => {
    const org = new Organization();
    org.plan = 'enterprise'; // attacker/self-hoster sets this freely
    org.planExpiresAt = new Date(Date.now() + 365 * 24 * 3600 * 1000);

    const license = new LicenseService();
    license.load({ token: '' }); // no signed token → community

    // The would-be gate: entitlement check, NOT `org.plan === 'enterprise'`.
    const ssoAllowed = license.has(EE_ENTITLEMENTS.SSO);

    expect(org.plan).toBe('enterprise'); // plan string is untrusted metadata
    expect(ssoAllowed).toBe(false); // ...and grants nothing
  });

  it('community build grants core features regardless of plan', () => {
    const license = new LicenseService();
    license.load({ token: '' });

    for (const core of ['agents', 'tools', 'gateways', 'byok', 'memory', 'runner']) {
      expect(license.has(core)).toBe(true);
    }
  });
});
