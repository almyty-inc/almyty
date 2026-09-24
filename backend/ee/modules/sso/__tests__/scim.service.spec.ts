import { NotFoundException } from '@nestjs/common';
import { ScimService } from '../scim.service';
import { OrganizationRole } from '../../../../src/entities/user-organization.entity';

function makeService() {
  const userRepo = {
    findOne: jest.fn(),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => ({ id: x.id ?? 'user-new', ...x })),
  };
  const membershipRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    // How many organizations this person belongs to. SCIM writes the
    // shared `users` row only when this one is their only home.
    count: jest.fn().mockResolvedValue(1),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => ({ id: x.id ?? 'mem-new', ...x })),
  };
  const teamRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => ({ id: x.id ?? 'team-new', ...x })),
    remove: jest.fn(),
  };
  const userTeamRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => ({ id: 'ut', ...x })),
  };
  const configService = {
    get: jest.fn().mockResolvedValue({ defaultRole: 'member' }),
  } as any;
  const offboarding = { offboard: jest.fn(async () => undefined) };
  const service = new ScimService(
    userRepo as any,
    membershipRepo as any,
    teamRepo as any,
    userTeamRepo as any,
    configService,
    undefined,
    offboarding as any,
  );
  return { service, userRepo, membershipRepo, teamRepo, userTeamRepo, offboarding };
}

describe('ScimService — Users', () => {
  it('provisions a new user + org membership', async () => {
    const { service, userRepo, membershipRepo } = makeService();
    userRepo.findOne.mockResolvedValue(null);
    membershipRepo.findOne.mockResolvedValue(null);

    const result = await service.createUser('org-1', {
      userName: 'carol@corp.com',
      name: { givenName: 'Carol', familyName: 'Danvers' },
      active: true,
    });

    expect(userRepo.save).toHaveBeenCalled();
    expect(membershipRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', role: OrganizationRole.MEMBER, isActive: true }),
    );
    expect(result.userName).toBe('carol@corp.com');
    expect(result.active).toBe(true);
    expect(result.schemas).toContain('urn:ietf:params:scim:schemas:core:2.0:User');
  });

  it('is idempotent — reactivates an existing inactive membership', async () => {
    const { service, userRepo, membershipRepo } = makeService();
    userRepo.findOne.mockResolvedValue({ id: 'u-1', email: 'carol@corp.com', firstName: 'Carol', lastName: 'D' });
    membershipRepo.findOne.mockResolvedValue({ id: 'm-1', userId: 'u-1', organizationId: 'org-1', isActive: false });

    const result = await service.createUser('org-1', { userName: 'carol@corp.com' });
    expect(membershipRepo.save).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
    expect(result.id).toBe('u-1');
  });

  it('deactivates a membership on PATCH active:false', async () => {
    const { service, userRepo, membershipRepo } = makeService();
    const membership = { id: 'm-1', userId: 'u-1', organizationId: 'org-1', isActive: true };
    membershipRepo.findOne.mockResolvedValue(membership);
    userRepo.findOne.mockResolvedValue({ id: 'u-1', email: 'carol@corp.com', firstName: 'Carol', lastName: 'D' });

    const result = await service.patchUser('org-1', 'u-1', {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(membership.isActive).toBe(false);
    expect(result.active).toBe(false);
  });

  it('handles Entra-style PATCH with a value object', async () => {
    const { service, userRepo, membershipRepo } = makeService();
    const membership = { id: 'm-1', userId: 'u-1', organizationId: 'org-1', isActive: true };
    membershipRepo.findOne.mockResolvedValue(membership);
    userRepo.findOne.mockResolvedValue({ id: 'u-1', email: 'carol@corp.com', firstName: 'Carol', lastName: 'D' });

    await service.patchUser('org-1', 'u-1', {
      Operations: [{ op: 'Replace', value: { active: false } }],
    });
    expect(membership.isActive).toBe(false);
  });

  it('deprovisions via DELETE by deactivating the membership', async () => {
    const { service, userRepo, membershipRepo } = makeService();
    const membership = { id: 'm-1', userId: 'u-1', organizationId: 'org-1', isActive: true };
    membershipRepo.findOne.mockResolvedValue(membership);
    userRepo.findOne.mockResolvedValue({ id: 'u-1', email: 'carol@corp.com', firstName: 'Carol', lastName: 'D' });

    await service.deleteUser('org-1', 'u-1');
    expect(membership.isActive).toBe(false);
  });

  /**
   * Deprovisioning is the organization saying the person left. Their own
   * connections are wiped and revoked at the provider, as a removed
   * member's are -- and before the membership is saved inactive, so a
   * failure leaves them active for the IdP's retry rather than inactive
   * with live connections.
   */
  describe('offboards the member\'s own connections', () => {
    const deprovisions: Array<[string, (s: ScimService) => Promise<unknown>]> = [
      ['PATCH active:false', (s) => s.patchUser('org-1', 'u-1', { Operations: [{ op: 'replace', path: 'active', value: false }] })],
      ['Entra-style PATCH', (s) => s.patchUser('org-1', 'u-1', { Operations: [{ op: 'Replace', value: { active: false } }] })],
      ['PUT active:false', (s) => s.replaceUser('org-1', 'u-1', { userName: 'carol@corp.com', active: false })],
      ['DELETE', (s) => s.deleteUser('org-1', 'u-1')],
    ];

    it.each(deprovisions)('on %s, before the membership goes inactive', async (_name, deprovision) => {
      const { service, userRepo, membershipRepo, offboarding } = makeService();
      const membership = { id: 'm-1', userId: 'u-1', organizationId: 'org-1', isActive: true };
      membershipRepo.findOne.mockResolvedValue(membership);
      userRepo.findOne.mockResolvedValue({ id: 'u-1', email: 'carol@corp.com', firstName: 'Carol', lastName: 'D' });
      const order: string[] = [];
      offboarding.offboard.mockImplementation(async () => { order.push('offboard'); });
      membershipRepo.save.mockImplementation(async (x: any) => { order.push(`save active=${x.isActive}`); return x; });

      await deprovision(service);

      expect(offboarding.offboard).toHaveBeenCalledWith({
        organizationId: 'org-1',
        userId: 'u-1',
        actorUserId: null,
        reason: 'scim_deprovisioned',
      });
      expect(order).toEqual(['offboard', 'save active=false']);
    });

    it('leaves the member active when the wipe fails, for the IdP to retry', async () => {
      const { service, userRepo, membershipRepo, offboarding } = makeService();
      membershipRepo.findOne.mockResolvedValue({ id: 'm-1', userId: 'u-1', organizationId: 'org-1', isActive: true });
      userRepo.findOne.mockResolvedValue({ id: 'u-1', email: 'carol@corp.com' });
      offboarding.offboard.mockRejectedValue(new Error('db down'));

      await expect(service.deleteUser('org-1', 'u-1')).rejects.toThrow('db down');
      expect(membershipRepo.save).not.toHaveBeenCalled();
    });

    it('does nothing to connections on reactivation, or for a member already inactive', async () => {
      const { service, userRepo, membershipRepo, offboarding } = makeService();
      userRepo.findOne.mockResolvedValue({ id: 'u-1', email: 'carol@corp.com' });

      membershipRepo.findOne.mockResolvedValue({ id: 'm-1', userId: 'u-1', organizationId: 'org-1', isActive: false });
      await service.patchUser('org-1', 'u-1', { Operations: [{ op: 'replace', path: 'active', value: true }] });
      membershipRepo.findOne.mockResolvedValue({ id: 'm-1', userId: 'u-1', organizationId: 'org-1', isActive: false });
      await service.deleteUser('org-1', 'u-1');

      expect(offboarding.offboard).not.toHaveBeenCalled();
    });
  });

  it('404s when patching a user that is not a member', async () => {
    const { service, membershipRepo } = makeService();
    membershipRepo.findOne.mockResolvedValue(null);
    await expect(
      service.patchUser('org-1', 'ghost', { Operations: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('filters listUsers by userName eq', async () => {
    const { service, membershipRepo } = makeService();
    membershipRepo.find.mockResolvedValue([
      { isActive: true, user: { id: 'u-1', email: 'a@corp.com', firstName: 'A', lastName: '' } },
      { isActive: true, user: { id: 'u-2', email: 'b@corp.com', firstName: 'B', lastName: '' } },
    ]);
    const result = await service.listUsers('org-1', 'userName eq "b@corp.com"');
    expect(result.totalResults).toBe(1);
    expect(result.Resources[0].userName).toBe('b@corp.com');
  });
});

describe('ScimService — Groups', () => {
  it('creates a group (team) with members', async () => {
    const { service, teamRepo, userTeamRepo, membershipRepo } = makeService();
    teamRepo.findOne.mockResolvedValue(null);
    userTeamRepo.findOne.mockResolvedValue(null);
    membershipRepo.findOne.mockResolvedValue({ userId: 'u-1', organizationId: 'org-1', isActive: true });

    const result = await service.createGroup('org-1', {
      displayName: 'Engineering',
      members: [{ value: 'u-1' }],
    });

    expect(teamRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', name: 'Engineering' }),
    );
    expect(userTeamRepo.save).toHaveBeenCalled();
    expect(result.displayName).toBe('Engineering');
    expect(result.members).toEqual([{ value: 'u-1' }]);
  });

  it('adds and removes members via PATCH', async () => {
    const { service, teamRepo, userTeamRepo, membershipRepo } = makeService();
    teamRepo.findOne.mockResolvedValue({ id: 'team-1', organizationId: 'org-1', name: 'Eng' });
    userTeamRepo.findOne.mockResolvedValue(null);
    membershipRepo.findOne.mockResolvedValue({ userId: 'u-2', organizationId: 'org-1', isActive: true });
    userTeamRepo.find.mockResolvedValue([{ userId: 'u-2', isActive: true }]);

    await service.patchGroup('org-1', 'team-1', {
      Operations: [{ op: 'add', path: 'members', value: [{ value: 'u-2' }] }],
    });
    expect(userTeamRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1', userId: 'u-2', isActive: true }),
    );
  });
});

/**
 * security.scim_deprovision notification wiring — org admins are told
 * when the IdP deactivates a member. Fake pipeline passed positionally
 * (production injects it @Optional()).
 */
describe('ScimService — deprovision notifications', () => {
  function makeNotifyingService() {
    const userRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'u-1', email: 'carol@corp.com', firstName: 'C', lastName: 'D' }),
      save: jest.fn(async (x: any) => x),
    };
    const membershipRepo = {
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
      save: jest.fn(async (x: any) => x),
    };
    const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
    const service = new ScimService(
      userRepo as any,
      membershipRepo as any,
      {} as any,
      {} as any,
      { get: jest.fn().mockResolvedValue({ defaultRole: 'member' }) } as any,
      notifications as any,
      { offboard: jest.fn(async () => undefined) } as any,
    );
    return { service, userRepo, membershipRepo, notifications };
  }

  it('DELETE deprovision emits security.scim_deprovision to org admins', async () => {
    const { service, membershipRepo, notifications } = makeNotifyingService();
    membershipRepo.findOne.mockResolvedValue({ id: 'm-1', userId: 'u-1', organizationId: 'org-1', isActive: true });

    await service.deleteUser('org-1', 'u-1');
    await new Promise((r) => setImmediate(r));

    expect(notifications.emit).toHaveBeenCalledTimes(1);
    const input = notifications.emit.mock.calls[0][0];
    expect(input).toMatchObject({
      type: 'security.scim_deprovision',
      organizationId: 'org-1',
    });
    expect(input.roleTarget.orgRoles).toEqual([OrganizationRole.OWNER, OrganizationRole.ADMIN]);
    expect(input.body).toContain('carol@corp.com');
    expect(input.email.params.memberEmail).toBe('carol@corp.com');
  });

  it('PATCH active:false emits; PATCH on an already-inactive membership does not', async () => {
    const { service, membershipRepo, notifications } = makeNotifyingService();
    membershipRepo.findOne.mockResolvedValue({ id: 'm-1', userId: 'u-1', organizationId: 'org-1', isActive: true });

    await service.patchUser('org-1', 'u-1', {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    } as any);
    await new Promise((r) => setImmediate(r));
    expect(notifications.emit).toHaveBeenCalledTimes(1);

    notifications.emit.mockClear();
    membershipRepo.findOne.mockResolvedValue({ id: 'm-1', userId: 'u-1', organizationId: 'org-1', isActive: false });
    await service.patchUser('org-1', 'u-1', {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    } as any);
    await new Promise((r) => setImmediate(r));
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('reactivation (active:true) does not emit', async () => {
    const { service, membershipRepo, notifications } = makeNotifyingService();
    membershipRepo.findOne.mockResolvedValue({ id: 'm-1', userId: 'u-1', organizationId: 'org-1', isActive: false });

    await service.patchUser('org-1', 'u-1', {
      Operations: [{ op: 'replace', path: 'active', value: true }],
    } as any);
    await new Promise((r) => setImmediate(r));
    expect(notifications.emit).not.toHaveBeenCalled();
  });
});
