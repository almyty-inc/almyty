import { generateKeyPairSync } from 'crypto';

import { signLicense } from '../license-token';
import { LicenseService } from '../license.service';
import { OrgLicenseResolver } from '../org-license.resolver';
import { EE_ENTITLEMENTS } from '../license.constants';

/**
 * End-to-end regression for the billing -> entitlement seam that a live
 * Stripe payment exposed and no test caught.
 *
 * The pre-existing billing spec verified the webhook mints a valid token by
 * calling `LicenseService.load({ token })` — the PROCESS-GLOBAL path. But the
 * running app never loads a per-org token globally; the guard and
 * `GET /licensing/entitlements` resolve it from the requesting org via
 * `OrgLicenseResolver`. So the token minted fine, verified fine, and unlocked
 * nothing in production while the test stayed green.
 *
 * This test walks the ACTUAL production path: token stored on
 * `org.billingInfo.licenseToken` (exactly where the webhook puts it) ->
 * `OrgLicenseResolver.hasForOrg(orgId, ...)`. It could not even compile before
 * the fix (OrgLicenseResolver did not exist) and passes with the per-org path.
 */
describe('billing -> per-org entitlement resolution (e2e regression)', () => {
  const { publicKey: publicPem, privateKey: privatePem } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // A signed token exactly like the billing webhook's mintToken() produces for
  // a pro subscription.
  const proToken = signLicense(
    { entitlements: [EE_ENTITLEMENTS.ADVANCED_RBAC, EE_ENTITLEMENTS.AUDIT_EXPORT], limits: { seats: 3 }, expiresAt: null },
    privatePem,
  );

  let license: LicenseService;
  let resolver: OrgLicenseResolver;
  let orgs: Record<string, any>;

  beforeEach(() => {
    process.env.ALMYTY_LICENSE_PUBLIC_KEY = publicPem;
    delete process.env.ALMYTY_LICENSE_KEY; // no global token — the org's token is the only source
    license = new LicenseService();
    license.load();

    orgs = {
      'org-paid': { id: 'org-paid', plan: 'pro', billingInfo: { licenseToken: proToken } },
      'org-free': { id: 'org-free', plan: 'free', billingInfo: {} },
    };
    const orgRepo = { findOne: async ({ where: { id } }: any) => orgs[id] ?? null } as any;
    resolver = new OrgLicenseResolver(orgRepo, license);
  });

  afterEach(() => {
    delete process.env.ALMYTY_LICENSE_PUBLIC_KEY;
  });

  it('a paid org unlocks its EE entitlements through the org-resolution path the guard uses', async () => {
    expect(await resolver.hasForOrg('org-paid', EE_ENTITLEMENTS.ADVANCED_RBAC)).toBe(true);
    expect(await resolver.hasForOrg('org-paid', EE_ENTITLEMENTS.AUDIT_EXPORT)).toBe(true);
    expect(await resolver.hasForOrg('org-paid', EE_ENTITLEMENTS.SSO)).toBe(false); // not in this token
  });

  it('the paid-org snapshot reports pro entitlements (what GET /licensing/entitlements returns)', async () => {
    const snap = await resolver.entitlementsForOrg('org-paid');
    expect(snap.entitlements).toEqual(
      expect.arrayContaining([EE_ENTITLEMENTS.ADVANCED_RBAC, EE_ENTITLEMENTS.AUDIT_EXPORT]),
    );
  });

  it('a free org gets only community — no EE leakage across orgs', async () => {
    expect(await resolver.hasForOrg('org-free', EE_ENTITLEMENTS.ADVANCED_RBAC)).toBe(false);
    const snap = await resolver.entitlementsForOrg('org-free');
    expect(snap.entitlements).not.toContain(EE_ENTITLEMENTS.ADVANCED_RBAC);
  });

  it('the GLOBAL license (no token) stays community — the assertion that would have caught the original bug', () => {
    // The guard used to read this global service; it is community even though
    // the org holds a valid pro token. Per-org resolution is the only unlock.
    expect(license.has(EE_ENTITLEMENTS.ADVANCED_RBAC)).toBe(false);
  });
});
