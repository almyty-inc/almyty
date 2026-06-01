import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { OrganizationsInvitesHelper } from './organizations-invites.helper';
import { TeamMembershipHelper } from './team-membership.helper';
import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { MailService } from '../mail/mail.service';
import { GatewaysService } from '../gateways/gateways.service';

describe('OrganizationsService', () => {
  let service: OrganizationsService;
  let organizationRepository: any;
  let userRepository: any;
  let userOrganizationRepository: any;
  let teamRepository: any;
  let userTeamRepository: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        OrganizationsInvitesHelper,
        { provide: TeamMembershipHelper, useValue: { joinDefaultTeam: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: getRepositoryToken(Organization),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            remove: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(UserOrganization),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            delete: jest.fn(),
            remove: jest.fn(),
            count: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Team),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            count: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(UserTeam),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            remove: jest.fn(),
          },
        },
        {
          provide: MailService,
          useValue: {
            send: jest.fn().mockResolvedValue(true),
            sendInvitation: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: GatewaysService,
          useValue: {
            ensureSystemGateway: jest.fn().mockResolvedValue({}),
          },
        },
      ],
    }).compile();

    service = module.get<OrganizationsService>(OrganizationsService);
    organizationRepository = module.get(getRepositoryToken(Organization));
    userRepository = module.get(getRepositoryToken(User));
    userOrganizationRepository = module.get(getRepositoryToken(UserOrganization));
    teamRepository = module.get(getRepositoryToken(Team));
    userTeamRepository = module.get(getRepositoryToken(UserTeam));
  });

  describe('findOne', () => {
    it('should return organization by id', async () => {
      const mockOrg = {
        id: 'org-1',
        name: 'Test Organization',
        generateSlug: jest.fn(),
        getOwners: jest.fn(),
        getAdmins: jest.fn(),
        canAddMoreApis: jest.fn(),
        canAddMoreGateways: jest.fn(),
        canAddMoreTools: jest.fn(),
      } as any;

      organizationRepository.findOne.mockResolvedValue(mockOrg);

      const result = await service.findOne('org-1');

      expect(result).toBe(mockOrg);
    });

    it('should throw NotFoundException if organization not found', async () => {
      organizationRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne('non-existent'))
        .rejects
        .toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('should create organization successfully', async () => {
      const createDto = {
        name: 'New Organization',
        description: 'A new organization',
      };

      const mockOrg = {
        id: 'org-1',
        ...createDto,
        generateSlug: jest.fn(),
        getOwners: jest.fn(),
        getAdmins: jest.fn(),
        canAddMoreApis: jest.fn(),
        canAddMoreGateways: jest.fn(),
        canAddMoreTools: jest.fn(),
      } as any;

      const mockMembership = {
        id: 'membership-1',
        userId: 'user-1',
        organizationId: 'org-1',
        role: OrganizationRole.OWNER,
      } as UserOrganization;

      // Mock the duplicate check (should return null)
      organizationRepository.findOne.mockResolvedValueOnce(null);

      organizationRepository.create.mockReturnValue(mockOrg);
      organizationRepository.save.mockResolvedValue(mockOrg);

      // Mock the findOne call at the end of create (with relations)
      organizationRepository.findOne.mockResolvedValueOnce(mockOrg);

      userOrganizationRepository.create.mockReturnValue(mockMembership);
      userOrganizationRepository.save.mockResolvedValue(mockMembership);

      const result = await service.create(createDto, 'user-1');

      expect(result).toBe(mockOrg);
      expect(organizationRepository.create).toHaveBeenCalled();
      expect(organizationRepository.save).toHaveBeenCalled();
      expect(userOrganizationRepository.create).toHaveBeenCalled();
      expect(userOrganizationRepository.save).toHaveBeenCalled();
    });

    it('should throw ConflictException when organization name already exists', async () => {
      const existingOrg = { id: 'org-1', name: 'Test Org', slug: 'test-org' };
      organizationRepository.findOne.mockResolvedValue(existingOrg);

      await expect(
        service.create({ name: 'Test Org', description: 'Duplicate' }, 'user-1')
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException when organization slug already exists', async () => {
      const existingOrg = { id: 'org-1', name: 'Other Org', slug: 'test-org' };
      organizationRepository.findOne.mockResolvedValue(existingOrg);

      await expect(
        service.create({ name: 'New Org', slug: 'test-org' }, 'user-1')
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findAll', () => {
    it('should return all organizations for a user', async () => {
      const mockMemberships = [
        { organization: { id: 'org-1', name: 'Org 1' } },
        { organization: { id: 'org-2', name: 'Org 2' } },
      ];

      userOrganizationRepository.find.mockResolvedValue(mockMemberships);

      const result = await service.findAll('user-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('org-1');
      expect(result[1].id).toBe('org-2');
    });
  });

  describe('update', () => {
    it('should update organization successfully', async () => {
      const mockOrg = { id: 'org-1', name: 'Old Name' };
      const updateDto = { name: 'New Name' };

      organizationRepository.findOne.mockResolvedValue(mockOrg);
      organizationRepository.save.mockResolvedValue({ ...mockOrg, ...updateDto });

      const result = await service.update('org-1', updateDto);

      expect(result.name).toBe('New Name');
      expect(organizationRepository.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException if organization not found', async () => {
      organizationRepository.findOne.mockResolvedValue(null);

      await expect(service.update('non-existent', { name: 'Test' }))
        .rejects
        .toThrow(NotFoundException);
    });

    it('should throw ConflictException when updating to existing name', async () => {
      const mockOrg = { id: 'org-1', name: 'Old Name' };
      const existingOrg = { id: 'org-2', name: 'New Name' };

      organizationRepository.findOne
        .mockResolvedValueOnce(mockOrg)
        .mockResolvedValueOnce(existingOrg);

      await expect(service.update('org-1', { name: 'New Name' }))
        .rejects
        .toThrow(ConflictException);
    });

    it('should throw ConflictException when updating to existing slug', async () => {
      const mockOrg = { id: 'org-1', slug: 'old-slug' };
      const existingOrg = { id: 'org-2', slug: 'new-slug' };

      organizationRepository.findOne
        .mockResolvedValueOnce(mockOrg)
        .mockResolvedValueOnce(existingOrg);

      await expect(service.update('org-1', { slug: 'new-slug' }))
        .rejects
        .toThrow(ConflictException);
    });

    it('should allow updating to same name (no conflict)', async () => {
      const mockOrg = { id: 'org-1', name: 'Test Org' };

      organizationRepository.findOne
        .mockResolvedValueOnce(mockOrg)
        .mockResolvedValueOnce(mockOrg);
      organizationRepository.save.mockResolvedValue(mockOrg);

      const result = await service.update('org-1', { name: 'Test Org' });

      expect(result).toBe(mockOrg);
      expect(organizationRepository.save).toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should delete organization successfully', async () => {
      const mockOrg = { id: 'org-1', name: 'Test Org' };

      organizationRepository.findOne.mockResolvedValue(mockOrg);
      organizationRepository.remove.mockResolvedValue(mockOrg);

      await service.delete('org-1');

      expect(organizationRepository.remove).toHaveBeenCalledWith(mockOrg);
    });

    it('should throw NotFoundException if organization not found', async () => {
      organizationRepository.findOne.mockResolvedValue(null);

      await expect(service.delete('non-existent'))
        .rejects
        .toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when deleting organization with active APIs', async () => {
      const mockOrg = {
        id: 'org-1',
        name: 'Test Org',
        apis: [{ id: 'api-1', name: 'Active API' }],
      };

      organizationRepository.findOne.mockResolvedValue(mockOrg);

      await expect(service.delete('org-1'))
        .rejects
        .toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when deleting organization with active gateways', async () => {
      const mockOrg = {
        id: 'org-1',
        name: 'Test Org',
        apis: [],
        gateways: [{ id: 'gateway-1', name: 'Active Gateway' }],
      };

      organizationRepository.findOne.mockResolvedValue(mockOrg);

      await expect(service.delete('org-1'))
        .rejects
        .toThrow(ForbiddenException);
    });
  });

  describe('getMembers', () => {
    it('should return organization members', async () => {
      const mockOrg = { id: 'org-1', name: 'Test Org' };
      const mockRequestingUserMembership = {
        userId: 'user-1',
        organizationId: 'org-1',
        role: OrganizationRole.OWNER
      };
      const mockMemberships = [
        {
          user: { id: 'user-1', email: 'user1@test.com' },
          role: OrganizationRole.OWNER,
          joinedAt: new Date()
        },
        {
          user: { id: 'user-2', email: 'user2@test.com' },
          role: OrganizationRole.MEMBER,
          joinedAt: new Date()
        },
      ];

      organizationRepository.findOne.mockResolvedValue(mockOrg);
      userOrganizationRepository.findOne.mockResolvedValue(mockRequestingUserMembership);
      userOrganizationRepository.find.mockResolvedValue(mockMemberships);

      const result = await service.getMembers('org-1', 'user-1');

      expect(result).toHaveLength(2);
      expect(userOrganizationRepository.find).toHaveBeenCalled();
    });

    it('should throw ForbiddenException when user is not a member', async () => {
      userOrganizationRepository.findOne.mockResolvedValue(null);

      await expect(service.getMembers('org-1', 'non-member'))
        .rejects
        .toThrow(ForbiddenException);
    });
  });

  describe('removeMember', () => {
    it('should remove member successfully', async () => {
      const mockOrg = { id: 'org-1', name: 'Test Org' };
      const mockMembership = { id: 'membership-1', role: OrganizationRole.MEMBER };

      organizationRepository.findOne.mockResolvedValue(mockOrg);
      userOrganizationRepository.findOne.mockResolvedValue(mockMembership);
      userOrganizationRepository.remove.mockResolvedValue(mockMembership);

      await service.removeMember('org-1', 'user-1');

      expect(userOrganizationRepository.remove).toHaveBeenCalledWith(mockMembership);
    });

    it('should throw ForbiddenException when removing last owner', async () => {
      const mockOrg = { id: 'org-1', name: 'Test Org' };
      const mockMembership = { id: 'membership-1', role: OrganizationRole.OWNER };

      organizationRepository.findOne.mockResolvedValue(mockOrg);
      userOrganizationRepository.findOne.mockResolvedValue(mockMembership);
      userOrganizationRepository.count.mockResolvedValue(1); // Only one owner

      await expect(service.removeMember('org-1', 'user-1'))
        .rejects
        .toThrow(ForbiddenException);
    });
  });

  describe('updateMemberRole', () => {
    it('should update member role successfully', async () => {
      const mockMembership = {
        id: 'membership-1',
        role: OrganizationRole.MEMBER
      };

      userOrganizationRepository.findOne.mockResolvedValue(mockMembership);
      userOrganizationRepository.save.mockResolvedValue({
        ...mockMembership,
        role: OrganizationRole.ADMIN
      });

      await service.updateMemberRole('org-1', 'user-1', OrganizationRole.ADMIN);

      expect(userOrganizationRepository.save).toHaveBeenCalled();
    });

    it('should update member role with permissions', async () => {
      const mockMembership = {
        id: 'membership-1',
        role: OrganizationRole.MEMBER,
        permissions: []
      };

      userOrganizationRepository.findOne.mockResolvedValue(mockMembership);
      userOrganizationRepository.save.mockResolvedValue({
        ...mockMembership,
        role: OrganizationRole.ADMIN,
        permissions: ['manage_apis']
      });

      await service.updateMemberRole('org-1', 'user-1', OrganizationRole.ADMIN, ['manage_apis']);

      expect(mockMembership.permissions).toEqual(['manage_apis']);
      expect(userOrganizationRepository.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException when member not found', async () => {
      userOrganizationRepository.findOne.mockResolvedValue(null);

      await expect(service.updateMemberRole('org-1', 'user-1', OrganizationRole.ADMIN))
        .rejects
        .toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when changing role of last owner', async () => {
      const mockMembership = {
        id: 'membership-1',
        role: OrganizationRole.OWNER
      };

      userOrganizationRepository.findOne.mockResolvedValue(mockMembership);
      userOrganizationRepository.count.mockResolvedValue(1); // Only one owner

      await expect(service.updateMemberRole('org-1', 'user-1', OrganizationRole.ADMIN))
        .rejects
        .toThrow(ForbiddenException);
    });
  });

  describe('getTeams', () => {
    it('returns organization teams when the default team already exists', async () => {
      const mockTeams = [
        { id: 'team-1', name: 'Team 1' },
        { id: 'team-2', name: 'Team 2' },
      ];

      teamRepository.count.mockResolvedValue(1); // default team exists → no self-heal
      teamRepository.find.mockResolvedValue(mockTeams);

      const result = await service.getTeams('org-1');

      expect(result).toEqual(mockTeams);
      expect(teamRepository.find).toHaveBeenCalled();
    });

    it('self-heals by joining the owner to the default team when none exists', async () => {
      // Pins the fix for #93. Before this self-heal, an org whose
      // default team had never been provisioned (pre-migration or
      // pre-PR-100 register flow) returned an empty teams list and
      // the Settings → Teams page rendered an empty state forever.
      const localHelper = { joinDefaultTeam: jest.fn().mockResolvedValue(undefined) };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OrganizationsService,
          OrganizationsInvitesHelper,
          { provide: TeamMembershipHelper, useValue: localHelper },
          { provide: getRepositoryToken(Organization), useValue: organizationRepository },
          { provide: getRepositoryToken(User), useValue: userRepository },
          { provide: getRepositoryToken(UserOrganization), useValue: userOrganizationRepository },
          { provide: getRepositoryToken(Team), useValue: teamRepository },
          { provide: getRepositoryToken(UserTeam), useValue: userTeamRepository },
          { provide: MailService, useValue: { send: jest.fn(), sendInvitation: jest.fn() } },
          { provide: GatewaysService, useValue: { ensureSystemGateway: jest.fn().mockResolvedValue({}) } },
        ],
      }).compile();
      const localService = module.get<OrganizationsService>(OrganizationsService);

      teamRepository.count.mockResolvedValue(0); // missing default team
      userOrganizationRepository.find.mockResolvedValue([
        { userId: 'owner-1', role: OrganizationRole.OWNER, organizationId: 'org-1', isActive: true },
      ]);
      teamRepository.find.mockResolvedValue([
        { id: 'team-default', name: 'Everyone', isDefault: true },
      ]);

      await localService.getTeams('org-1');

      expect(userOrganizationRepository.find).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', role: OrganizationRole.OWNER, isActive: true },
      });
      expect(localHelper.joinDefaultTeam).toHaveBeenCalledWith(
        'org-1',
        'owner-1',
        OrganizationRole.OWNER,
      );
    });
  });

  describe('userHasPermission', () => {
    it('should return true for owner', async () => {
      const mockMembership = {
        role: OrganizationRole.OWNER,
        hasPermission: jest.fn().mockReturnValue(true)
      };

      userOrganizationRepository.findOne.mockResolvedValue(mockMembership);

      const result = await service.userHasPermission('user-1', 'org-1', 'any');

      expect(result).toBe(true);
    });

    it('should return false for non-member', async () => {
      userOrganizationRepository.findOne.mockResolvedValue(null);

      const result = await service.userHasPermission('user-1', 'org-1', 'any');

      expect(result).toBe(false);
    });
  });

  describe('userHasRole', () => {
    it('should return true if user has role', async () => {
      const mockMembership = { role: OrganizationRole.ADMIN };

      userOrganizationRepository.findOne.mockResolvedValue(mockMembership);

      const result = await service.userHasRole('user-1', 'org-1', [OrganizationRole.ADMIN, OrganizationRole.OWNER]);

      expect(result).toBe(true);
    });

    it('should return false if user does not have role', async () => {
      const mockMembership = { role: OrganizationRole.MEMBER };

      userOrganizationRepository.findOne.mockResolvedValue(mockMembership);

      const result = await service.userHasRole('user-1', 'org-1', [OrganizationRole.ADMIN]);

      expect(result).toBe(false);
    });
  });

  describe('inviteUser', () => {
    const mockOrg = { id: 'org-1', name: 'Test Org', settings: {} };
    const mockInviter = { id: 'user-1', firstName: 'Test', lastName: 'User' };

    beforeEach(() => {
      organizationRepository.findOne.mockResolvedValue(mockOrg);
      organizationRepository.update.mockResolvedValue({});
    });

    it('should store pending invite when user email not found', async () => {
      // First call: find org, second call: find inviter, third call: find user by email
      userRepository.findOne
        .mockResolvedValueOnce(mockInviter) // inviter lookup
        .mockResolvedValueOnce(null); // user email lookup

      const result = await service.inviteUser('org-1', { email: 'nonexistent@test.com', role: OrganizationRole.MEMBER }, 'user-1');

      expect(result).toHaveProperty('inviteSent');
    });

    it('should throw ConflictException when user is already an active member', async () => {
      const mockUser = { id: 'user-2', email: 'existing@test.com' };
      const mockMembership = {
        id: 'membership-1',
        userId: 'user-2',
        organizationId: 'org-1',
        role: OrganizationRole.MEMBER,
        isActive: true,
        inviteAccepted: true,
      };

      userRepository.findOne
        .mockResolvedValueOnce(mockInviter)
        .mockResolvedValueOnce(mockUser);
      userOrganizationRepository.findOne.mockResolvedValue(mockMembership);

      await expect(
        service.inviteUser('org-1', { email: 'existing@test.com', role: OrganizationRole.ADMIN }, 'user-1')
      ).rejects.toThrow(ConflictException);
    });

    it('should update pending membership for existing user', async () => {
      const mockUser = { id: 'user-2', email: 'inactive@test.com' };
      const mockMembership = {
        id: 'membership-1',
        userId: 'user-2',
        organizationId: 'org-1',
        role: OrganizationRole.MEMBER,
        isActive: true,
        inviteAccepted: false,
      };

      userRepository.findOne
        .mockResolvedValueOnce(mockInviter)
        .mockResolvedValueOnce(mockUser);
      userOrganizationRepository.findOne.mockResolvedValue(mockMembership);
      userOrganizationRepository.save.mockResolvedValue(mockMembership);

      const result = await service.inviteUser('org-1', { email: 'inactive@test.com', role: OrganizationRole.ADMIN }, 'user-1');

      expect(userOrganizationRepository.save).toHaveBeenCalled();
      expect(result).toHaveProperty('inviteSent');
    });

    it('should create new membership for existing user not in org', async () => {
      const mockUser = { id: 'user-2', email: 'newmember@test.com' };
      const mockMembership = {
        id: 'membership-1',
        userId: 'user-2',
        organizationId: 'org-1',
        role: OrganizationRole.MEMBER,
        invitedBy: 'user-1',
        isActive: true,
        inviteAccepted: false,
      };

      userRepository.findOne
        .mockResolvedValueOnce(mockInviter)
        .mockResolvedValueOnce(mockUser);
      userOrganizationRepository.findOne.mockResolvedValue(null);
      userOrganizationRepository.create.mockReturnValue(mockMembership);
      userOrganizationRepository.save.mockResolvedValue(mockMembership);

      const result = await service.inviteUser('org-1', { email: 'newmember@test.com', role: OrganizationRole.MEMBER }, 'user-1');

      expect(userOrganizationRepository.create).toHaveBeenCalled();
      expect(userOrganizationRepository.save).toHaveBeenCalled();
      expect(result).toHaveProperty('inviteSent');
    });
  });

  describe('findBySlug', () => {
    it('should return organization by slug', async () => {
      const mockOrg = { id: 'org-1', slug: 'test-org' };
      organizationRepository.findOne.mockResolvedValue(mockOrg);

      const result = await service.findBySlug('test-org');

      expect(result).toBe(mockOrg);
    });

    it('should throw NotFoundException when slug not found', async () => {
      organizationRepository.findOne.mockResolvedValue(null);

      await expect(service.findBySlug('non-existent'))
        .rejects
        .toThrow(NotFoundException);
    });
  });

  describe('removeMember', () => {
    it('should throw NotFoundException when member not found', async () => {
      userOrganizationRepository.findOne.mockResolvedValue(null);

      await expect(service.removeMember('org-1', 'user-1'))
        .rejects
        .toThrow(NotFoundException);
    });
  });

  describe('create with slug generation', () => {
    it('should generate slug when not provided', async () => {
      const createDto = {
        name: 'New Organization!!!',
        description: 'Test',
      };

      const mockOrg = {
        id: 'org-1',
        ...createDto,
        slug: 'new-organization',
      };

      organizationRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(mockOrg);
      organizationRepository.create.mockReturnValue(mockOrg);
      organizationRepository.save.mockResolvedValue(mockOrg);
      userOrganizationRepository.create.mockReturnValue({} as any);
      userOrganizationRepository.save.mockResolvedValue({} as any);

      await service.create(createDto, 'user-1');

      expect(organizationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'new-organization',
        })
      );
    });
  });

  describe('updateTeam', () => {
    it('should update team name', async () => {
      const mockTeam = { id: 'team-1', name: 'Old Name', description: 'Desc', organizationId: 'org-1' };
      teamRepository.findOne.mockResolvedValue(mockTeam);
      teamRepository.save.mockResolvedValue({ ...mockTeam, name: 'New Name' });

      await service.updateTeam('org-1', 'team-1', { name: 'New Name' });

      expect(mockTeam.name).toBe('New Name');
      expect(teamRepository.save).toHaveBeenCalled();
    });

    it('should update team description', async () => {
      const mockTeam = { id: 'team-1', name: 'Team', description: 'Old', organizationId: 'org-1' };
      teamRepository.findOne.mockResolvedValue(mockTeam);
      teamRepository.save.mockResolvedValue({ ...mockTeam, description: 'New' });

      await service.updateTeam('org-1', 'team-1', { description: 'New' });

      expect(mockTeam.description).toBe('New');
    });

    it('should throw NotFoundException when team not found', async () => {
      teamRepository.findOne.mockResolvedValue(null);

      await expect(service.updateTeam('org-1', 'team-1', { name: 'Test' }))
        .rejects
        .toThrow(NotFoundException);
    });

    it('should throw NotFoundException when team belongs to a different org', async () => {
      // assertTeamInOrg scopes by { id, organizationId }. When the
      // caller passes a different org id than the team actually
      // belongs to, the repository's findOne returns null and the
      // service throws NotFoundException — never revealing whether
      // the id exists in another tenant.
      teamRepository.findOne.mockResolvedValue(null);

      await expect(service.updateTeam('other-org', 'team-1', { name: 'X' }))
        .rejects
        .toThrow(NotFoundException);

      expect(teamRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'team-1', organizationId: 'other-org' },
      });
    });
  });

  describe('addTeamMember', () => {
    it('should throw ConflictException when user is already a team member', async () => {
      // assertTeamInOrg runs first and must see a team that belongs
      // to the requested org before the conflict check fires.
      teamRepository.findOne.mockResolvedValue({ id: 'team-1', organizationId: 'org-1' });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OrganizationsService,
          OrganizationsInvitesHelper,
          { provide: TeamMembershipHelper, useValue: { joinDefaultTeam: jest.fn().mockResolvedValue(undefined) } },
          { provide: getRepositoryToken(Organization), useValue: organizationRepository },
          { provide: getRepositoryToken(User), useValue: userRepository },
          { provide: getRepositoryToken(UserOrganization), useValue: userOrganizationRepository },
          { provide: getRepositoryToken(Team), useValue: teamRepository },
          {
            provide: getRepositoryToken(UserTeam),
            useValue: {
              findOne: jest.fn().mockResolvedValue({ id: 'existing' }),
              create: jest.fn(),
              save: jest.fn(),
              remove: jest.fn(),
            },
          },
          {
            provide: MailService,
            useValue: { send: jest.fn().mockResolvedValue(true), sendInvitation: jest.fn().mockResolvedValue(true) },
          },
          {
            provide: GatewaysService,
            useValue: { ensureSystemGateway: jest.fn().mockResolvedValue({}) },
          },
        ],
      }).compile();

      const localService = module.get<OrganizationsService>(OrganizationsService);

      await expect(localService.addTeamMember('org-1', 'team-1', 'user-1'))
        .rejects
        .toThrow(ConflictException);
    });
  });

  describe('updateTeamMemberRole', () => {
    it('should throw BadRequestException for invalid role', async () => {
      teamRepository.findOne.mockResolvedValue({ id: 'team-1', organizationId: 'org-1' });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OrganizationsService,
          OrganizationsInvitesHelper,
          { provide: TeamMembershipHelper, useValue: { joinDefaultTeam: jest.fn().mockResolvedValue(undefined) } },
          { provide: getRepositoryToken(Organization), useValue: organizationRepository },
          { provide: getRepositoryToken(User), useValue: userRepository },
          { provide: getRepositoryToken(UserOrganization), useValue: userOrganizationRepository },
          { provide: getRepositoryToken(Team), useValue: teamRepository },
          {
            provide: getRepositoryToken(UserTeam),
            useValue: {
              findOne: jest.fn().mockResolvedValue({ id: 'membership-1' }),
              save: jest.fn(),
            },
          },
          {
            provide: MailService,
            useValue: { send: jest.fn().mockResolvedValue(true), sendInvitation: jest.fn().mockResolvedValue(true) },
          },
          {
            provide: GatewaysService,
            useValue: { ensureSystemGateway: jest.fn().mockResolvedValue({}) },
          },
        ],
      }).compile();

      const localService = module.get<OrganizationsService>(OrganizationsService);

      await expect(localService.updateTeamMemberRole('org-1', 'team-1', 'user-1', 'invalid'))
        .rejects
        .toThrow(BadRequestException);
    });
  });

  describe('removeTeamMember', () => {
    it('should throw NotFoundException when user is not a team member', async () => {
      teamRepository.findOne.mockResolvedValue({ id: 'team-1', organizationId: 'org-1' });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OrganizationsService,
          OrganizationsInvitesHelper,
          { provide: TeamMembershipHelper, useValue: { joinDefaultTeam: jest.fn().mockResolvedValue(undefined) } },
          { provide: getRepositoryToken(Organization), useValue: organizationRepository },
          { provide: getRepositoryToken(User), useValue: userRepository },
          { provide: getRepositoryToken(UserOrganization), useValue: userOrganizationRepository },
          { provide: getRepositoryToken(Team), useValue: teamRepository },
          {
            provide: getRepositoryToken(UserTeam),
            useValue: {
              findOne: jest.fn().mockResolvedValue(null),
              remove: jest.fn(),
            },
          },
          {
            provide: MailService,
            useValue: { send: jest.fn().mockResolvedValue(true), sendInvitation: jest.fn().mockResolvedValue(true) },
          },
          {
            provide: GatewaysService,
            useValue: { ensureSystemGateway: jest.fn().mockResolvedValue({}) },
          },
        ],
      }).compile();

      const localService = module.get<OrganizationsService>(OrganizationsService);

      await expect(localService.removeTeamMember('org-1', 'team-1', 'user-1'))
        .rejects
        .toThrow(NotFoundException);
    });
  });

  describe('createTeam - Branch Coverage', () => {
    it('should create a new team', async () => {
      const mockTeam = {
        id: 'team-1',
        name: 'Test Team',
        description: 'Test Description',
        organizationId: 'org-1',
      };

      teamRepository.create.mockReturnValue(mockTeam);
      teamRepository.save.mockResolvedValue(mockTeam);

      const result = await service.createTeam('org-1', {
        name: 'Test Team',
        description: 'Test Description',
      });

      expect(result).toEqual(mockTeam);
      expect(teamRepository.create).toHaveBeenCalledWith({
        name: 'Test Team',
        description: 'Test Description',
        organizationId: 'org-1',
      });
      expect(teamRepository.save).toHaveBeenCalledWith(mockTeam);
    });
  });

  describe('addTeamMember - Branch Coverage for existing member', () => {
    it('should throw ConflictException when user is already a team member', async () => {
      teamRepository.findOne.mockResolvedValue({ id: 'team-1', organizationId: 'org-1' });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OrganizationsService,
          OrganizationsInvitesHelper,
          { provide: TeamMembershipHelper, useValue: { joinDefaultTeam: jest.fn().mockResolvedValue(undefined) } },
          { provide: getRepositoryToken(Organization), useValue: organizationRepository },
          { provide: getRepositoryToken(User), useValue: userRepository },
          { provide: getRepositoryToken(UserOrganization), useValue: userOrganizationRepository },
          { provide: getRepositoryToken(Team), useValue: teamRepository },
          {
            provide: getRepositoryToken(UserTeam),
            useValue: {
              findOne: jest.fn().mockResolvedValue({ id: 'existing-membership' }),
              create: jest.fn(),
              save: jest.fn(),
            },
          },
          {
            provide: MailService,
            useValue: { send: jest.fn().mockResolvedValue(true), sendInvitation: jest.fn().mockResolvedValue(true) },
          },
          {
            provide: GatewaysService,
            useValue: { ensureSystemGateway: jest.fn().mockResolvedValue({}) },
          },
        ],
      }).compile();

      const localService = module.get<OrganizationsService>(OrganizationsService);

      await expect(localService.addTeamMember('org-1', 'team-1', 'user-1'))
        .rejects
        .toThrow();
    });
  });

  describe('updateTeamMemberRole - Branch Coverage', () => {
    it('should throw when team member not found', async () => {
      teamRepository.findOne.mockResolvedValue({ id: 'team-1', organizationId: 'org-1' });
      userTeamRepository.findOne.mockResolvedValue(null);

      await expect(service.updateTeamMemberRole('org-1', 'team-1', 'user-1', 'lead'))
        .rejects
        .toThrow(NotFoundException);
    });

    it('should throw when invalid role provided', async () => {
      teamRepository.findOne.mockResolvedValue({ id: 'team-1', organizationId: 'org-1' });
      userTeamRepository.findOne.mockResolvedValue({ id: 'membership-1' } as any);

      await expect(service.updateTeamMemberRole('org-1', 'team-1', 'user-1', 'invalid-role'))
        .rejects
        .toThrow(BadRequestException);
    });

    it('should update role successfully', async () => {
      const mockMembership = { id: 'membership-1', role: 'member' };
      teamRepository.findOne.mockResolvedValue({ id: 'team-1', organizationId: 'org-1' });
      userTeamRepository.findOne.mockResolvedValue(mockMembership as any);
      userTeamRepository.save.mockResolvedValue(mockMembership as any);

      await service.updateTeamMemberRole('org-1', 'team-1', 'user-1', 'lead');

      expect(mockMembership.role).toBe('lead');
      expect(userTeamRepository.save).toHaveBeenCalledWith(mockMembership);
    });
  });

  describe('removeTeamMember - Branch Coverage', () => {
    it('should throw when team member not found', async () => {
      teamRepository.findOne.mockResolvedValue({ id: 'team-1', organizationId: 'org-1' });
      userTeamRepository.findOne.mockResolvedValue(null);

      await expect(service.removeTeamMember('org-1', 'team-1', 'user-1'))
        .rejects
        .toThrow(NotFoundException);
    });

    it('should remove team member successfully', async () => {
      const mockMembership = { id: 'membership-1' };
      teamRepository.findOne.mockResolvedValue({ id: 'team-1', organizationId: 'org-1' });
      userTeamRepository.findOne.mockResolvedValue(mockMembership as any);
      userTeamRepository.remove.mockResolvedValue(mockMembership as any);

      await service.removeTeamMember('org-1', 'team-1', 'user-1');

      expect(userTeamRepository.remove).toHaveBeenCalledWith(mockMembership);
    });
  });

  describe('getOrganizationStats - Branch Coverage', () => {
    it('should return stats with no APIs', async () => {
      const mockOrg = {
        id: 'org-1',
        name: 'Test Org',
        plan: 'free',
        apis: null,
        gateways: [],
      };

      organizationRepository.findOne.mockResolvedValue(mockOrg as any);
      userOrganizationRepository.count.mockResolvedValue(5);
      teamRepository.count.mockResolvedValue(2);

      const result = await service.getOrganizationStats('org-1');

      expect(result.apisCount).toBe(0);
      expect(result.gatewaysCount).toBe(0);
      expect(result.membersCount).toBe(5);
      expect(result.teamsCount).toBe(2);
      expect(result.plan).toBe('free');
    });

    it('should return stats with APIs and gateways', async () => {
      const mockOrg = {
        id: 'org-1',
        name: 'Test Org',
        plan: 'pro',
        apis: [{ id: 'api-1' }, { id: 'api-2' }],
        gateways: [{ id: 'gw-1' }],
      };

      organizationRepository.findOne.mockResolvedValue(mockOrg as any);
      userOrganizationRepository.count.mockResolvedValue(10);
      teamRepository.count.mockResolvedValue(3);

      const result = await service.getOrganizationStats('org-1');

      expect(result.apisCount).toBe(2);
      expect(result.gatewaysCount).toBe(1);
      expect(result.membersCount).toBe(10);
      expect(result.teamsCount).toBe(3);
      expect(result.plan).toBe('pro');
    });
  });
  describe('deleteTeam - Branch Coverage', () => {
    it('should refuse to delete the default team with BadRequestException', async () => {
      teamRepository.findOne.mockResolvedValue({
        id: 'team-1',
        organizationId: 'org-1',
        isDefault: true,
      });

      await expect(service.deleteTeam('org-1', 'team-1'))
        .rejects
        .toThrow(BadRequestException);
    });

    it('should remove a non-default team', async () => {
      const mockTeam = { id: 'team-1', organizationId: 'org-1', isDefault: false };
      teamRepository.findOne.mockResolvedValue(mockTeam);
      teamRepository.remove = jest.fn().mockResolvedValue(mockTeam);

      await service.deleteTeam('org-1', 'team-1');

      expect(teamRepository.remove).toHaveBeenCalledWith(mockTeam);
    });

    it('should throw NotFoundException when team is in a different org', async () => {
      teamRepository.findOne.mockResolvedValue(null);

      await expect(service.deleteTeam('org-1', 'team-99'))
        .rejects
        .toThrow(NotFoundException);
    });
  });

  describe('getTeamMembers - Branch Coverage', () => {
    it('should return active team members with user details', async () => {
      teamRepository.findOne.mockResolvedValue({ id: 'team-1', organizationId: 'org-1' });

      const memberships = [
        {
          id: 'm-1',
          userId: 'u-1',
          role: 'lead',
          joinedAt: new Date('2025-01-01'),
          user: { id: 'u-1', email: 'a@example.com', firstName: 'Ann', lastName: 'A' },
        },
        {
          id: 'm-2',
          userId: 'u-2',
          role: 'member',
          joinedAt: new Date('2025-01-02'),
          user: { id: 'u-2', email: 'b@example.com', firstName: 'Bob', lastName: 'B' },
        },
      ];
      userTeamRepository.find = jest.fn().mockResolvedValue(memberships);

      const result = await service.getTeamMembers('org-1', 'team-1');

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        userId: 'u-1',
        email: 'a@example.com',
        role: 'lead',
      });
      expect(result[1]).toMatchObject({
        userId: 'u-2',
        email: 'b@example.com',
        role: 'member',
      });
    });

    it('should throw NotFoundException when team is not in the org', async () => {
      teamRepository.findOne.mockResolvedValue(null);

      await expect(service.getTeamMembers('org-1', 'team-99'))
        .rejects
        .toThrow(NotFoundException);
    });
  });

  // ----- Team-admin RBAC (assertCanManageTeam) -----------------------
  //
  // PR #71 introduced team management endpoints gated only on org
  // owner/admin. This block exercises the followup that lets a
  // TeamRole.LEAD ('team_admin') of team X manage members and rename
  // team X — but NOT delete it, and NOT touch other teams. The check
  // is enforced inline inside the service to avoid a forwardRef cycle
  // between OrganizationsService and AccessPolicyService.
  describe('team_admin RBAC', () => {
    const org = 'org-1';
    const teamA = 'team-A';
    const teamB = 'team-B';

    beforeEach(() => {
      // Most tests need the team-in-org check to pass.
      teamRepository.findOne.mockImplementation(({ where }: any) => {
        if (where?.id === teamA && where?.organizationId === org) {
          return Promise.resolve({ id: teamA, organizationId: org, isDefault: false });
        }
        if (where?.id === teamB && where?.organizationId === org) {
          return Promise.resolve({ id: teamB, organizationId: org, isDefault: false });
        }
        return Promise.resolve(null);
      });
    });

    describe('updateTeam (rename)', () => {
      it('allows org owner', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'owner-1',
          organizationId: org,
          role: OrganizationRole.OWNER,
          isActive: true,
        });
        teamRepository.save.mockImplementation((t: any) => Promise.resolve(t));

        await expect(
          service.updateTeam(org, teamA, { name: 'Renamed' }, 'owner-1'),
        ).resolves.toBeDefined();
      });

      it('allows org admin', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'admin-1',
          organizationId: org,
          role: OrganizationRole.ADMIN,
          isActive: true,
        });
        teamRepository.save.mockImplementation((t: any) => Promise.resolve(t));

        await expect(
          service.updateTeam(org, teamA, { name: 'Renamed' }, 'admin-1'),
        ).resolves.toBeDefined();
      });

      it('allows team_admin (lead) of THIS team', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'lead-1',
          organizationId: org,
          role: OrganizationRole.MEMBER,
          isActive: true,
        });
        userTeamRepository.findOne.mockResolvedValue({
          userId: 'lead-1',
          teamId: teamA,
          role: 'lead',
          isActive: true,
        });
        teamRepository.save.mockImplementation((t: any) => Promise.resolve(t));

        await expect(
          service.updateTeam(org, teamA, { name: 'Renamed' }, 'lead-1'),
        ).resolves.toBeDefined();
      });

      it('denies team_admin of a DIFFERENT team', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'lead-of-B',
          organizationId: org,
          role: OrganizationRole.MEMBER,
          isActive: true,
        });
        // userTeamRepository scoped query: lead-of-B is lead of team B,
        // so a lookup for (lead-of-B, teamA) returns null.
        userTeamRepository.findOne.mockImplementation(({ where }: any) => {
          if (where?.userId === 'lead-of-B' && where?.teamId === teamA) {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            userId: 'lead-of-B',
            teamId: teamB,
            role: 'lead',
          });
        });

        await expect(
          service.updateTeam(org, teamA, { name: 'Renamed' }, 'lead-of-B'),
        ).rejects.toThrow(ForbiddenException);
      });

      it('denies plain org member with no team_admin role', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'plain-member',
          organizationId: org,
          role: OrganizationRole.MEMBER,
          isActive: true,
        });
        userTeamRepository.findOne.mockResolvedValue(null);

        await expect(
          service.updateTeam(org, teamA, { name: 'Renamed' }, 'plain-member'),
        ).rejects.toThrow(ForbiddenException);
      });

      it('denies a team MEMBER (not lead) of the target team', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'tm-1',
          organizationId: org,
          role: OrganizationRole.MEMBER,
          isActive: true,
        });
        userTeamRepository.findOne.mockResolvedValue({
          userId: 'tm-1',
          teamId: teamA,
          role: 'member',
          isActive: true,
        });

        await expect(
          service.updateTeam(org, teamA, { name: 'Renamed' }, 'tm-1'),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe('addTeamMember (manage-members)', () => {
      it('allows team_admin of THIS team', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'lead-1',
          organizationId: org,
          role: OrganizationRole.MEMBER,
          isActive: true,
        });
        // First findOne is the lead lookup (returns lead), second is
        // the existing-membership lookup for the new user (returns null).
        let callCount = 0;
        userTeamRepository.findOne.mockImplementation(() => {
          callCount += 1;
          if (callCount === 1) {
            return Promise.resolve({
              userId: 'lead-1',
              teamId: teamA,
              role: 'lead',
              isActive: true,
            });
          }
          return Promise.resolve(null);
        });
        userTeamRepository.create.mockReturnValue({ teamId: teamA, userId: 'new-user' });
        userTeamRepository.save.mockResolvedValue({});

        await expect(
          service.addTeamMember(org, teamA, 'new-user', undefined, 'lead-1'),
        ).resolves.toBeUndefined();
      });

      it('denies team_admin of a different team', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'lead-of-B',
          organizationId: org,
          role: OrganizationRole.MEMBER,
          isActive: true,
        });
        userTeamRepository.findOne.mockResolvedValue(null);

        await expect(
          service.addTeamMember(org, teamA, 'new-user', undefined, 'lead-of-B'),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe('updateTeamMemberRole (manage-members)', () => {
      it('allows team_admin of THIS team to change a member role', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'lead-1',
          organizationId: org,
          role: OrganizationRole.MEMBER,
          isActive: true,
        });
        let call = 0;
        userTeamRepository.findOne.mockImplementation(() => {
          call += 1;
          if (call === 1) {
            // RBAC: lead lookup
            return Promise.resolve({
              userId: 'lead-1',
              teamId: teamA,
              role: 'lead',
              isActive: true,
            });
          }
          // Target membership lookup
          return Promise.resolve({ id: 'm-1', role: 'member' });
        });
        userTeamRepository.save.mockResolvedValue({});

        await expect(
          service.updateTeamMemberRole(org, teamA, 'target-user', 'lead', 'lead-1'),
        ).resolves.toBeUndefined();
      });

      it('denies plain org member with no team role', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'plain',
          organizationId: org,
          role: OrganizationRole.MEMBER,
          isActive: true,
        });
        userTeamRepository.findOne.mockResolvedValue(null);

        await expect(
          service.updateTeamMemberRole(org, teamA, 'target-user', 'lead', 'plain'),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe('removeTeamMember (manage-members)', () => {
      it('allows team_admin of THIS team', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'lead-1',
          organizationId: org,
          role: OrganizationRole.MEMBER,
          isActive: true,
        });
        let call = 0;
        userTeamRepository.findOne.mockImplementation(() => {
          call += 1;
          if (call === 1) {
            return Promise.resolve({
              userId: 'lead-1',
              teamId: teamA,
              role: 'lead',
              isActive: true,
            });
          }
          return Promise.resolve({ id: 'm-1' });
        });
        userTeamRepository.remove.mockResolvedValue({});

        await expect(
          service.removeTeamMember(org, teamA, 'target-user', 'lead-1'),
        ).resolves.toBeUndefined();
      });

      it('denies team_admin of a different team', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'lead-of-B',
          organizationId: org,
          role: OrganizationRole.MEMBER,
          isActive: true,
        });
        userTeamRepository.findOne.mockResolvedValue(null);

        await expect(
          service.removeTeamMember(org, teamA, 'target-user', 'lead-of-B'),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe('deleteTeam (delete)', () => {
      it('allows org owner', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'owner-1',
          organizationId: org,
          role: OrganizationRole.OWNER,
          isActive: true,
        });
        teamRepository.remove = jest.fn().mockResolvedValue({});

        await expect(
          service.deleteTeam(org, teamA, 'owner-1'),
        ).resolves.toBeUndefined();
      });

      it('denies team_admin of THAT team — only org owner/admin can delete', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'lead-1',
          organizationId: org,
          role: OrganizationRole.MEMBER,
          isActive: true,
        });
        userTeamRepository.findOne.mockResolvedValue({
          userId: 'lead-1',
          teamId: teamA,
          role: 'lead',
          isActive: true,
        });

        await expect(
          service.deleteTeam(org, teamA, 'lead-1'),
        ).rejects.toThrow(ForbiddenException);
      });

      it('denies plain org member', async () => {
        userOrganizationRepository.findOne.mockResolvedValue({
          userId: 'plain',
          organizationId: org,
          role: OrganizationRole.MEMBER,
          isActive: true,
        });

        await expect(
          service.deleteTeam(org, teamA, 'plain'),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe('non-member of org', () => {
      it('denies caller who is not a member of the org at all', async () => {
        userOrganizationRepository.findOne.mockResolvedValue(null);
        userTeamRepository.findOne.mockResolvedValue(null);

        await expect(
          service.updateTeam(org, teamA, { name: 'X' }, 'stranger'),
        ).rejects.toThrow(ForbiddenException);
      });
    });
  });



});