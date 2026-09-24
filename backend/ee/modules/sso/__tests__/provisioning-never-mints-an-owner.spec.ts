import { BadRequestException } from '@nestjs/common';

import { SsoConfigService } from '../sso-config.service';
import { SsoService } from '../sso.service';
import { ScimService } from '../scim.service';
import { OrganizationRole } from '../../../../src/entities/user-organization.entity';

/**
 * `defaultRole` is the role JIT and SCIM hand every identity they create.
 * An admin may edit the SSO settings, and an admin may not make anyone an
 * owner -- updateMemberRole and inviteUser both refuse it. But the setting
 * took any string, so an admin could set it to `owner`, point the org at
 * an IdP they control, and sign in a fresh identity of their own as an
 * owner of the organization. Provisioning never creates an owner, and the
 * setting only takes a real, non-owner role.
 */
describe('SSO/SCIM provisioning never mints an owner', () => {
  function configService(existing: any = null) {
    const repo = {
      findOne: jest.fn(async () => existing),
      create: jest.fn((row: any) => ({ ...row })),
      save: jest.fn(async (row: any) => row),
    };
    return { service: new SsoConfigService(repo as any), repo };
  }

  it.each(['owner', 'superadmin', 'OWNER'])('refuses defaultRole %p', async (role) => {
    const { service, repo } = configService();
    await expect(service.upsert('org-1', { defaultRole: role })).rejects.toThrow(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it.each(['admin', 'member', 'viewer'])('accepts defaultRole %p', async (role) => {
    const { service } = configService();
    const saved = await service.upsert('org-1', { defaultRole: role });
    expect(saved.defaultRole).toBe(role);
  });

  it('JIT provisions a member even when a stored config still says owner', async () => {
    const saved: any[] = [];
    const service = new SsoService(
      {
        findOne: jest.fn(async () => null),
        create: jest.fn((row: any) => ({ id: 'u-new', ...row })),
        save: jest.fn(async (row: any) => row),
      } as any,
      {
        findOne: jest.fn(async () => null),
        create: jest.fn((row: any) => row),
        save: jest.fn(async (row: any) => saved.push(row)),
      } as any,
      {} as any,
    );
    await service.resolveUser(
      'org-1',
      { email: 'new@idp.test' },
      { jitProvisioning: true, defaultRole: 'owner' } as any,
    );
    expect(saved[0].role).toBe(OrganizationRole.MEMBER);
  });

  it('SCIM provisions a member even when a stored config still says owner', async () => {
    const saved: any[] = [];
    const scim = new ScimService(
      {
        findOne: jest.fn(async () => null),
        create: jest.fn((row: any) => ({ id: 'u-new', ...row })),
        save: jest.fn(async (row: any) => row),
      } as any,
      {
        findOne: jest.fn(async () => null),
        create: jest.fn((row: any) => row),
        save: jest.fn(async (row: any) => {
          saved.push(row);
          return row;
        }),
      } as any,
      {} as any,
      {} as any,
      { get: jest.fn(async () => ({ defaultRole: 'owner' })) } as any,
    );
    await scim.createUser('org-1', { userName: 'new@idp.test' });
    expect(saved[0].role).toBe(OrganizationRole.MEMBER);
  });
});
