import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { OrganizationRole } from '../../entities/user-organization.entity';

describe('OrganizationsController', () => {
  let controller: OrganizationsController;
  let organizationsService: jest.Mocked<OrganizationsService>;

  beforeEach(async () => {
    const mockOrganizationsService = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      getMembers: jest.fn(),
      inviteUser: jest.fn(),
      updateMemberRole: jest.fn(),
      removeMember: jest.fn(),
      getTeams: jest.fn(),
      createTeam: jest.fn(),
      updateTeam: jest.fn(),
      deleteTeam: jest.fn(),
      getTeamMembers: jest.fn(),
      addTeamMember: jest.fn(),
      updateTeamMemberRole: jest.fn(),
      removeTeamMember: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [
        {
          provide: OrganizationsService,
          useValue: mockOrganizationsService,
        },
      ],
    })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .compile();

    controller = module.get<OrganizationsController>(OrganizationsController);
    organizationsService = module.get(OrganizationsService);
  });

  describe('getUserOrganizations', () => {
    it('should return user organizations', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const mockOrganizations = [
        { id: 'org-1', name: 'Organization 1' },
        { id: 'org-2', name: 'Organization 2' },
      ];

      organizationsService.findAll.mockResolvedValue(mockOrganizations as any);

      const result = await controller.getUserOrganizations(mockRequest);

      expect(result).toEqual({ success: true, data: mockOrganizations, message: 'Organizations retrieved successfully' });
      expect(organizationsService.findAll).toHaveBeenCalledWith('user-1');
    });
  });

  describe('createOrganization', () => {
    it('should create organization', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const createDto = { name: 'New Organization', description: 'Test org' };
      const mockOrganization = { id: 'org-1', ...createDto };

      organizationsService.create.mockResolvedValue(mockOrganization as any);

      const result = await controller.createOrganization(createDto, mockRequest);

      expect(result).toEqual({ success: true, data: mockOrganization, message: 'Organization created successfully' });
      expect(organizationsService.create).toHaveBeenCalledWith(createDto, 'user-1');
    });
  });

  describe('getOrganization', () => {
    it('should return organization by id', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const mockOrganization = { id: 'org-1', name: 'Test Organization' };

      organizationsService.findOne.mockResolvedValue(mockOrganization as any);

      const result = await controller.getOrganization('org-1', mockRequest);

      expect(result).toEqual({ success: true, data: mockOrganization, message: 'Organization retrieved successfully' });
      expect(organizationsService.findOne).toHaveBeenCalledWith('org-1');
    });
  });

  describe('updateOrganization', () => {
    it('should update organization', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const updateDto = { name: 'Updated Organization' };
      const mockOrganization = { id: 'org-1', ...updateDto };

      organizationsService.update.mockResolvedValue(mockOrganization as any);

      const result = await controller.updateOrganization('org-1', updateDto, mockRequest);

      expect(result).toEqual({ success: true, data: mockOrganization, message: 'Organization updated successfully' });
      expect(organizationsService.update).toHaveBeenCalledWith('org-1', updateDto);
    });
  });

  describe('deleteOrganization', () => {
    it('should delete organization', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      organizationsService.delete.mockResolvedValue();

      const result = await controller.deleteOrganization('org-1', mockRequest);

      expect(result).toEqual({ success: true, data: undefined, message: 'Organization deleted successfully' });
      expect(organizationsService.delete).toHaveBeenCalledWith('org-1');
    });
  });

  describe('getOrganizationMembers', () => {
    it('should return organization members', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const mockMembers = [
        { id: 'member-1', userId: 'user-1', role: OrganizationRole.OWNER },
        { id: 'member-2', userId: 'user-2', role: OrganizationRole.MEMBER },
      ];

      organizationsService.getMembers.mockResolvedValue(mockMembers as any);

      const result = await controller.getOrganizationMembers('org-1', mockRequest);

      expect(result).toEqual({ success: true, data: mockMembers, message: 'Members retrieved successfully' });
      expect(organizationsService.getMembers).toHaveBeenCalledWith('org-1', 'user-1');
    });
  });

  describe('inviteUserToOrganization', () => {
    it('should invite user to organization', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const inviteDto = { email: 'newuser@example.com', role: OrganizationRole.MEMBER };
      const mockInvite = { id: 'invite-1', ...inviteDto };

      organizationsService.inviteUser.mockResolvedValue(mockInvite as any);

      const result = await controller.inviteUserToOrganization('org-1', inviteDto, mockRequest);

      expect(result).toEqual({ success: true, data: mockInvite, message: 'User invited successfully' });
      expect(organizationsService.inviteUser).toHaveBeenCalledWith('org-1', inviteDto, 'user-1');
    });
  });

  describe('updateMemberRole', () => {
    it('should update member role', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const roleData = { role: OrganizationRole.ADMIN };
      const mockMember = { id: 'member-1', role: OrganizationRole.ADMIN };

      organizationsService.updateMemberRole.mockResolvedValue(mockMember as any);

      const result = await controller.updateMemberRole('org-1', 'user-2', roleData, mockRequest);

      expect(result).toEqual({ success: true, data: mockMember, message: 'Member role updated successfully' });
      expect(organizationsService.updateMemberRole).toHaveBeenCalledWith('org-1', 'user-2', OrganizationRole.ADMIN, 'user-1');
    });
  });

  describe('removeMember', () => {
    it('should remove member from organization', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      organizationsService.removeMember.mockResolvedValue();

      const result = await controller.removeMember('org-1', 'user-2', mockRequest);

      expect(result).toEqual({ success: true, data: undefined, message: 'Member removed successfully' });
      expect(organizationsService.removeMember).toHaveBeenCalledWith('org-1', 'user-2');
    });
  });

  describe('getOrganizationTeams', () => {
    it('should return organization teams', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const mockTeams = [
        { id: 'team-1', name: 'Team 1' },
        { id: 'team-2', name: 'Team 2' },
      ];

      organizationsService.getTeams.mockResolvedValue(mockTeams as any);

      const result = await controller.getOrganizationTeams('org-1', mockRequest);

      expect(result).toEqual({ success: true, data: mockTeams, message: 'Teams retrieved successfully' });
      expect(organizationsService.getTeams).toHaveBeenCalledWith('org-1');
    });
  });

  describe('createTeam', () => {
    it('should create team in organization', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const createDto = { name: 'New Team', description: 'Test team' };
      const mockTeam = { id: 'team-1', ...createDto };

      organizationsService.createTeam.mockResolvedValue(mockTeam as any);

      const result = await controller.createTeam('org-1', createDto, mockRequest);

      expect(result).toEqual({ success: true, data: mockTeam, message: 'Team created successfully' });
      expect(organizationsService.createTeam).toHaveBeenCalledWith('org-1', createDto);
    });
  });

  describe('updateTeam', () => {
    it('should update team', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const updateDto = { name: 'Updated Team', description: 'Updated description' };
      const mockTeam = { id: 'team-1', ...updateDto };

      organizationsService.updateTeam.mockResolvedValue(mockTeam as any);

      const result = await controller.updateTeam('org-1', 'team-1', updateDto, mockRequest);

      expect(result).toEqual({ success: true, data: mockTeam, message: 'Team updated successfully' });
      expect(organizationsService.updateTeam).toHaveBeenCalledWith('org-1', 'team-1', updateDto, 'user-1');
    });
  });

  describe('addMemberToTeam', () => {
    it('should add member to team', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const memberData = { userId: 'user-2', role: 'member' };
      const mockTeamMember = { id: 'team-member-1', userId: 'user-2' };

      organizationsService.addTeamMember.mockResolvedValue(mockTeamMember as any);

      const result = await controller.addMemberToTeam('org-1', 'team-1', memberData, mockRequest);

      expect(result).toEqual({ success: true, data: mockTeamMember, message: 'Member added to team successfully' });
      expect(organizationsService.addTeamMember).toHaveBeenCalledWith('org-1', 'team-1', 'user-2', undefined, 'user-1');
    });
  });

  describe('updateTeamMemberRole', () => {
    it('should update team member role', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const roleData = { role: 'admin' };
      const mockTeamMember = { id: 'team-member-1', role: 'admin' };

      organizationsService.updateTeamMemberRole.mockResolvedValue(mockTeamMember as any);

      const result = await controller.updateTeamMemberRole('org-1', 'team-1', 'user-2', roleData, mockRequest);

      expect(result).toEqual({ success: true, data: mockTeamMember, message: 'Team member role updated successfully' });
      expect(organizationsService.updateTeamMemberRole).toHaveBeenCalledWith('org-1', 'team-1', 'user-2', 'admin', 'user-1');
    });
  });

  describe('removeMemberFromTeam', () => {
    it('should remove member from team', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      organizationsService.removeTeamMember.mockResolvedValue();

      const result = await controller.removeMemberFromTeam('org-1', 'team-1', 'user-2', mockRequest);

      expect(result).toEqual({ success: true, data: undefined, message: 'Member removed from team successfully' });
      expect(organizationsService.removeTeamMember).toHaveBeenCalledWith('org-1', 'team-1', 'user-2', 'user-1');
    });
  });

  describe('deleteTeam', () => {
    it('should delete team', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      organizationsService.deleteTeam.mockResolvedValue(undefined as any);

      const result = await controller.deleteTeam('org-1', 'team-1', mockRequest);

      expect(result).toEqual({ success: true, data: undefined, message: 'Team deleted successfully' });
      expect(organizationsService.deleteTeam).toHaveBeenCalledWith('org-1', 'team-1', 'user-1');
    });
  });

  describe('getTeamMembers', () => {
    it('should return team members', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const mockMembers = [
        { id: 'tm-1', userId: 'user-2', email: 'a@example.com', role: 'lead' },
        { id: 'tm-2', userId: 'user-3', email: 'b@example.com', role: 'member' },
      ];
      organizationsService.getTeamMembers.mockResolvedValue(mockMembers as any);

      const result = await controller.getTeamMembers('org-1', 'team-1', mockRequest);

      expect(result).toEqual({ success: true, data: mockMembers, message: 'Team members retrieved successfully' });
      expect(organizationsService.getTeamMembers).toHaveBeenCalledWith('org-1', 'team-1');
    });
  });
});
