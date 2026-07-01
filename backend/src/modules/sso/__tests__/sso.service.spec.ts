import { UnauthorizedException } from '@nestjs/common';
import { SsoService } from '../sso.service';
import { OrganizationRole } from '../../../entities/user-organization.entity';

function makeService() {
  const userRepo = {
    findOne: jest.fn(),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => ({ id: 'new-user', ...x })),
  };
  const membershipRepo = {
    findOne: jest.fn(),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => ({ id: 'new-membership', ...x })),
  };
  const configService = { getDecrypted: jest.fn() } as any;
  const service = new SsoService(
    userRepo as any,
    membershipRepo as any,
    configService,
  );
  return { service, userRepo, membershipRepo, configService };
}

const samlConfig = {
  organizationId: 'org-1',
  protocol: 'saml',
  enabled: true,
  jitProvisioning: false,
  defaultRole: 'member',
  samlEntryPoint: 'https://idp/sso',
  samlIssuer: 'almyty-sp',
  samlCert: 'CERT',
} as any;

const oidcConfig = {
  organizationId: 'org-1',
  protocol: 'oidc',
  enabled: true,
  jitProvisioning: false,
  defaultRole: 'member',
  oidcIssuerUrl: 'https://idp',
  oidcClientId: 'cid',
  oidcClientSecretPlain: 'secret',
  oidcRedirectUri: 'https://api/sso/org-1/oidc/callback',
} as any;

describe('SsoService — SAML', () => {
  it('maps a valid assertion to an existing member and returns the user', async () => {
    const { service, userRepo, membershipRepo, configService } = makeService();
    configService.getDecrypted.mockResolvedValue(samlConfig);

    // Fake SAML provider returning a signed profile.
    jest.spyOn(service, 'buildSaml').mockReturnValue({
      validatePostResponseAsync: jest.fn().mockResolvedValue({
        profile: { nameID: 'alice@corp.com', email: 'alice@corp.com' },
        loggedOut: false,
      }),
    } as any);

    const existingUser = { id: 'u-1', email: 'alice@corp.com' };
    userRepo.findOne.mockResolvedValue(existingUser);
    membershipRepo.findOne.mockResolvedValue({ userId: 'u-1', organizationId: 'org-1', isActive: true });

    const user = await service.handleSamlCallback('org-1', 'BASE64', 'https://api');
    expect(user).toBe(existingUser);
  });

  it('rejects an assertion that fails signature validation', async () => {
    const { service, configService } = makeService();
    configService.getDecrypted.mockResolvedValue(samlConfig);

    jest.spyOn(service, 'buildSaml').mockReturnValue({
      validatePostResponseAsync: jest
        .fn()
        .mockRejectedValue(new Error('Invalid signature')),
    } as any);

    await expect(
      service.handleSamlCallback('org-1', 'TAMPERED', 'https://api'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a non-member when JIT provisioning is off', async () => {
    const { service, userRepo, membershipRepo, configService } = makeService();
    configService.getDecrypted.mockResolvedValue(samlConfig);
    jest.spyOn(service, 'buildSaml').mockReturnValue({
      validatePostResponseAsync: jest.fn().mockResolvedValue({
        profile: { nameID: 'stranger@corp.com', email: 'stranger@corp.com' },
        loggedOut: false,
      }),
    } as any);
    userRepo.findOne.mockResolvedValue({ id: 'u-2', email: 'stranger@corp.com' });
    membershipRepo.findOne.mockResolvedValue(null);

    await expect(
      service.handleSamlCallback('org-1', 'BASE64', 'https://api'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('SsoService — OIDC', () => {
  it('exchanges the code and maps claims to an existing member', async () => {
    const { service, userRepo, membershipRepo, configService } = makeService();
    configService.getDecrypted.mockResolvedValue(oidcConfig);

    jest.spyOn(service, 'buildOidcClient').mockResolvedValue({
      callback: jest.fn().mockResolvedValue({
        claims: () => ({ email: 'bob@corp.com', given_name: 'Bob' }),
      }),
    } as any);

    const existingUser = { id: 'u-3', email: 'bob@corp.com' };
    userRepo.findOne.mockResolvedValue(existingUser);
    membershipRepo.findOne.mockResolvedValue({ userId: 'u-3', organizationId: 'org-1', isActive: true });

    const user = await service.handleOidcCallback('org-1', { code: 'xyz' }, 'state-1');
    expect(user).toBe(existingUser);
  });

  it('rejects a failed token exchange', async () => {
    const { service, configService } = makeService();
    configService.getDecrypted.mockResolvedValue(oidcConfig);
    jest.spyOn(service, 'buildOidcClient').mockResolvedValue({
      callback: jest.fn().mockRejectedValue(new Error('invalid_grant')),
    } as any);

    await expect(
      service.handleOidcCallback('org-1', { code: 'bad' }, 'state-1'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('SsoService — resolveUser JIT provisioning', () => {
  it('provisions a brand-new user + membership when JIT is enabled', async () => {
    const { service, userRepo, membershipRepo } = makeService();
    userRepo.findOne.mockResolvedValue(null);

    const user = await service.resolveUser(
      'org-1',
      { email: 'new@corp.com', firstName: 'New', lastName: 'Hire' },
      { ...samlConfig, jitProvisioning: true, defaultRole: 'member' },
    );

    expect(userRepo.save).toHaveBeenCalled();
    expect(membershipRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        role: OrganizationRole.MEMBER,
        isActive: true,
      }),
    );
    expect(user.email).toBe('new@corp.com');
  });

  it('rejects a brand-new user when JIT is disabled', async () => {
    const { service, userRepo } = makeService();
    userRepo.findOne.mockResolvedValue(null);

    await expect(
      service.resolveUser(
        'org-1',
        { email: 'nope@corp.com' },
        { ...samlConfig, jitProvisioning: false },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a member whose access has been deactivated', async () => {
    const { service, userRepo, membershipRepo } = makeService();
    userRepo.findOne.mockResolvedValue({ id: 'u-9', email: 'gone@corp.com' });
    membershipRepo.findOne.mockResolvedValue({ userId: 'u-9', organizationId: 'org-1', isActive: false });

    await expect(
      service.resolveUser('org-1', { email: 'gone@corp.com' }, samlConfig),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
