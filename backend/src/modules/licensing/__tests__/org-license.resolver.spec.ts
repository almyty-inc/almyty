import { generateKeyPairSync } from 'crypto';
import { Repository } from 'typeorm';
import { OrgLicenseResolver } from '../org-license.resolver';
import { LicenseService } from '../license.service';
import { signLicense } from '../license-token';
import { EDITION_COMMUNITY, EDITION_ENTERPRISE, EE_ENTITLEMENTS } from '../license.constants';
import { Organization } from '../../../entities/organization.entity';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Fake repo backed by a plain map of orgId → billingInfo.licenseToken. */
function repoFor(tokens: Record<string, string | null>): {
  repo: Repository<Organization>;
  findCalls: () => number;
} {
  let calls = 0;
  const repo = {
    findOne: jest.fn(async ({ where: { id } }: any) => {
      calls++;
      if (!(id in tokens)) return null;
      const org = new Organization();
      org.id = id;
      org.billingInfo = tokens[id] ? { licenseToken: tokens[id] } : {};
      return org;
    }),
  } as unknown as Repository<Organization>;
  return { repo, findCalls: () => calls };
}

describe('OrgLicenseResolver', () => {
  const PUBLIC_KEY_ENV = 'ALMYTY_LICENSE_PUBLIC_KEY';
  const TOKEN_ENV = 'ALMYTY_LICENSE_KEY';

  afterEach(() => {
    delete process.env[PUBLIC_KEY_ENV];
    delete process.env[TOKEN_ENV];
  });

  it('grants EE entitlements for an org with a valid stored pro token', async () => {
    const { publicPem, privatePem } = keypair();
    process.env[PUBLIC_KEY_ENV] = publicPem;
    const token = signLicense(
      { entitlements: [EE_ENTITLEMENTS.ADVANCED_RBAC], limits: { seats: 5 }, expiresAt: null },
      privatePem,
    );

    const { repo } = repoFor({ 'org-paid': token });
    const resolver = new OrgLicenseResolver(repo, new LicenseService());

    const snap = await resolver.entitlementsForOrg('org-paid');
    expect(snap.edition).toBe(EDITION_ENTERPRISE);
    expect(snap.entitlements).toContain(EE_ENTITLEMENTS.ADVANCED_RBAC);
    expect(snap.entitlements).toContain('agents');

    await expect(resolver.hasForOrg('org-paid', EE_ENTITLEMENTS.ADVANCED_RBAC)).resolves.toBe(
      true,
    );
    await expect(resolver.hasForOrg('org-paid', EE_ENTITLEMENTS.SSO)).resolves.toBe(false);
  });

  it('resolves community for an org with no stored token', async () => {
    const { repo } = repoFor({ 'org-free': null });
    const resolver = new OrgLicenseResolver(repo, new LicenseService());

    const snap = await resolver.entitlementsForOrg('org-free');
    expect(snap.edition).toBe(EDITION_COMMUNITY);
    expect(snap.entitlements).toContain('agents');
    await expect(resolver.hasForOrg('org-free', EE_ENTITLEMENTS.ADVANCED_RBAC)).resolves.toBe(
      false,
    );
  });

  it('resolves community for an unknown org id', async () => {
    const { repo } = repoFor({});
    const resolver = new OrgLicenseResolver(repo, new LicenseService());

    const snap = await resolver.entitlementsForOrg('missing');
    expect(snap.edition).toBe(EDITION_COMMUNITY);
  });

  it('caches per org and only hits the repo once within the TTL window', async () => {
    const { publicPem, privatePem } = keypair();
    process.env[PUBLIC_KEY_ENV] = publicPem;
    const token = signLicense(
      { entitlements: [EE_ENTITLEMENTS.SSO], limits: {}, expiresAt: null },
      privatePem,
    );
    const { repo, findCalls } = repoFor({ 'org-paid': token });
    const resolver = new OrgLicenseResolver(repo, new LicenseService());

    await resolver.entitlementsForOrg('org-paid');
    await resolver.entitlementsForOrg('org-paid');
    await resolver.hasForOrg('org-paid', EE_ENTITLEMENTS.SSO);

    expect(findCalls()).toBe(1); // subsequent reads served from cache
  });

  it('invalidate() forces a fresh repo read', async () => {
    const { repo, findCalls } = repoFor({ 'org-x': null });
    const resolver = new OrgLicenseResolver(repo, new LicenseService());

    await resolver.entitlementsForOrg('org-x');
    resolver.invalidate('org-x');
    await resolver.entitlementsForOrg('org-x');

    expect(findCalls()).toBe(2);
  });

  it('falls back to global/community when the repo lookup throws', async () => {
    const repo = {
      findOne: jest.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as Repository<Organization>;
    const resolver = new OrgLicenseResolver(repo, new LicenseService());

    const snap = await resolver.entitlementsForOrg('org-any');
    expect(snap.edition).toBe(EDITION_COMMUNITY);
    expect(snap.entitlements).toContain('agents');
  });
});
