import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { User } from '../../entities/user.entity';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { OrganizationRole } from '../../entities/user-organization.entity';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: jest.Mocked<UsersService>;

  beforeEach(async () => {
    const mockUsersService = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      findOneInOrg: jest.fn(),
      update: jest.fn(),
      updateInOrg: jest.fn(),
      deactivate: jest.fn(),
      deactivateInOrg: jest.fn(),
      reactivate: jest.fn(),
      reactivateInOrg: jest.fn(),
      delete: jest.fn(),
      deleteInOrg: jest.fn(),
      getUserStats: jest.fn(),
      getUserStatsInOrg: jest.fn(),
      getUserActivity: jest.fn(),
      getUserActivityInOrg: jest.fn(),
      searchUsers: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: mockUsersService,
        },
      ],
    })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .compile();

    controller = module.get<UsersController>(UsersController);
    usersService = module.get(UsersService);
  });

  // Tiny helper that builds the request shape the controller actually uses
  // (just `req.user.currentOrganizationId` — same field the JWT strategy
  // populates from X-Organization-Id).
  const reqWithOrg = (organizationId = 'org-1') =>
    ({ user: { currentOrganizationId: organizationId } } as any);

  describe('findAll', () => {
    it('should return paginated users scoped to the caller current org', async () => {
      const queryDto: QueryUsersDto = {
        page: 1,
        limit: 10,
        search: 'search',
        organizationId: 'attacker-supplied-org', // must be ignored
      };
      const mockResult = {
        users: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      };

      usersService.findAll.mockResolvedValue(mockResult);

      const result = await controller.findAll(queryDto, reqWithOrg('caller-org'));

      expect(result).toBe(mockResult);
      // The DTO's caller-supplied organizationId is ignored — the controller
      // forces the current org from the JWT.
      expect(usersService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'caller-org' }),
      );
    });

    it('rejects when no organization context is set', async () => {
      await expect(controller.findAll({} as any, { user: {} } as any))
        .rejects.toThrow('Organization context required');
    });
  });

  describe('findOne', () => {
    it('returns the caller own profile via the unscoped findOne', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        organizationMemberships: [{ role: OrganizationRole.ADMIN }],
      } as User;
      const mockStats = { apiKeysCount: 0, organizationsCount: 1, lastLoginAt: null };

      usersService.findOne.mockResolvedValue(mockUser);
      usersService.getUserStats.mockResolvedValue(mockStats);

      const currentUser = { id: 'user-1' } as User;

      const result = await controller.findOne('user-1', currentUser, reqWithOrg());

      expect(result).toEqual(expect.objectContaining({ id: 'user-1', stats: mockStats }));
      expect(usersService.findOne).toHaveBeenCalledWith('user-1');
      expect(usersService.findOneInOrg).not.toHaveBeenCalled();
    });

    it('looks up another user via findOneInOrg with the caller current org', async () => {
      const mockUser = {
        id: 'user-2',
        email: 'other@example.com',
        firstName: 'Other',
        lastName: 'User',
      } as User;
      const mockStats = { apiKeysCount: 0, organizationsCount: 1, lastLoginAt: null };

      usersService.findOneInOrg.mockResolvedValue(mockUser);
      usersService.getUserStatsInOrg.mockResolvedValue(mockStats);

      const currentUser = { id: 'user-1' } as User;

      const result = await controller.findOne('user-2', currentUser, reqWithOrg('caller-org'));

      expect(result).toEqual(expect.objectContaining({ id: 'user-2', stats: mockStats }));
      expect(usersService.findOneInOrg).toHaveBeenCalledWith('user-2', 'caller-org');
      expect(usersService.findOne).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should update user via the org-scoped path', async () => {
      const updateDto: UpdateUserDto = { firstName: 'Updated' };
      const mockUser = {
        id: 'user-1',
        firstName: 'Updated',
        passwordHash: 'hash',
        resetPasswordToken: 'token',
        verificationToken: 'verify'
      } as User;

      usersService.updateInOrg.mockResolvedValue(mockUser);

      const result = await controller.update('user-1', updateDto, reqWithOrg('org-1'));

      expect(result.message).toBe('User updated successfully');
      expect(result.user).toEqual({ id: 'user-1', firstName: 'Updated' });
      expect(usersService.updateInOrg).toHaveBeenCalledWith('user-1', 'org-1', updateDto);
      expect(usersService.update).not.toHaveBeenCalled();
    });
  });


  describe('deactivate', () => {
    it('should deactivate user via the org-scoped path', async () => {
      usersService.deactivateInOrg.mockResolvedValue();

      const result = await controller.deactivate('user-1', reqWithOrg('org-1'));

      expect(result.message).toBe('User deactivated successfully');
      expect(usersService.deactivateInOrg).toHaveBeenCalledWith('user-1', 'org-1');
    });
  });

  describe('reactivate', () => {
    it('should reactivate user via the org-scoped path', async () => {
      usersService.reactivateInOrg.mockResolvedValue();

      const result = await controller.reactivate('user-1', reqWithOrg('org-1'));

      expect(result.message).toBe('User reactivated successfully');
      expect(usersService.reactivateInOrg).toHaveBeenCalledWith('user-1', 'org-1');
    });
  });

  describe('getUserStats', () => {
    it('should return user stats via the org-scoped path', async () => {
      const mockStats = {
        apiKeysCount: 5,
        organizationsCount: 2,
        lastLoginAt: new Date(),
      };

      usersService.getUserStatsInOrg.mockResolvedValue(mockStats);

      const result = await controller.getUserStats('user-1', reqWithOrg('org-1'));

      expect(result.stats).toBe(mockStats);
      expect(usersService.getUserStatsInOrg).toHaveBeenCalledWith('user-1', 'org-1');
    });
  });

  describe('searchUsers', () => {
    it('should search users using the caller current org (caller-supplied org id ignored)', async () => {
      const mockUsers = [{
        id: 'user-1',
        email: 'john@example.com',
        firstName: 'John',
        lastName: 'Doe',
        fullName: 'John Doe',
        isActive: true
      }] as User[];

      usersService.searchUsers.mockResolvedValue(mockUsers);

      const result = await controller.searchUsers('john', reqWithOrg('caller-org'));

      expect(result.users).toHaveLength(1);
      expect(usersService.searchUsers).toHaveBeenCalledWith('john', 'caller-org');
    });

    it('should return empty users for short query', async () => {
      const result = await controller.searchUsers('j', reqWithOrg());

      expect(result.users).toEqual([]);
      expect(usersService.searchUsers).not.toHaveBeenCalled();
    });

    it('rejects when no organization context is set', async () => {
      await expect(controller.searchUsers('john', { user: {} } as any))
        .rejects.toThrow('Organization context required');
    });
  });

  describe('getCurrentUser', () => {
    it('should return current user profile', async () => {
      const currentUser = { id: 'user-1' } as User;
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        passwordHash: 'hash',
        resetPasswordToken: 'token',
        verificationToken: 'verify',
        organizationMemberships: [{
          id: 'membership-1',
          role: OrganizationRole.ADMIN,
          joinedAt: new Date(),
          isActive: true,
          organization: {
            id: 'org-1',
            name: 'Test Org',
            slug: 'test-org',
            description: 'Test Organization'
          }
        }]
      } as any;
      const mockStats = { apiKeysCount: 0, organizationsCount: 1, lastLoginAt: null };

      usersService.findOne.mockResolvedValue(mockUser);
      usersService.getUserStats.mockResolvedValue(mockStats);

      const result = await controller.getCurrentUser(currentUser);

      expect(result.id).toBe('user-1');
      expect(result.stats).toBe(mockStats);
      expect('passwordHash' in result).toBe(false);
      expect(usersService.findOne).toHaveBeenCalledWith('user-1');
      expect(usersService.getUserStats).toHaveBeenCalledWith('user-1');
    });
  });

  describe('getCurrentUserActivity', () => {
    it('should return current user activity', async () => {
      const currentUser = { id: 'user-1' } as User;
      const mockActivity = [{ date: '2024-01-01', count: 5 }];

      usersService.getUserActivity.mockResolvedValue(mockActivity);

      const result = await controller.getCurrentUserActivity(currentUser, 7);

      expect(result.activity).toBe(mockActivity);
      expect(usersService.getUserActivity).toHaveBeenCalledWith('user-1', 7);
    });
  });

  describe('updateCurrentUser', () => {
    it('should update current user profile', async () => {
      const currentUser = { id: 'user-1' } as User;
      const updateDto: UpdateUserDto = { firstName: 'Updated' };
      const mockUser = {
        id: 'user-1',
        firstName: 'Updated',
        passwordHash: 'hash',
        resetPasswordToken: 'token',
        verificationToken: 'verify'
      } as User;

      usersService.update.mockResolvedValue(mockUser);

      const result = await controller.updateCurrentUser(currentUser, updateDto);

      expect(result.message).toBe('Profile updated successfully');
      expect(result.user).toEqual({ id: 'user-1', firstName: 'Updated' });
      expect(usersService.update).toHaveBeenCalledWith('user-1', updateDto);
    });
  });

  describe('remove', () => {
    it('should delete user successfully via the org-scoped path', async () => {
      usersService.deleteInOrg.mockResolvedValue();

      const result = await controller.remove('user-1', reqWithOrg('org-1'));

      expect(result.message).toBe('User deleted successfully');
      expect(usersService.deleteInOrg).toHaveBeenCalledWith('user-1', 'org-1');
    });
  });

  describe('getUserActivity', () => {
    it('should return user activity via the org-scoped path', async () => {
      const mockActivity = [
        { type: 'api_key_usage', date: '2025-01-01', count: 10 },
        { type: 'login', date: '2025-01-02', count: 2 },
      ];

      usersService.getUserActivityInOrg.mockResolvedValue(mockActivity);

      const result = await controller.getUserActivity('user-1', reqWithOrg('org-1'), 7);

      expect(result.activity).toBe(mockActivity);
      expect(usersService.getUserActivityInOrg).toHaveBeenCalledWith('user-1', 'org-1', 7);
    });
  });

  describe('findAll - error handling', () => {
    it('should handle service errors', async () => {
      const queryDto: QueryUsersDto = { page: 1, limit: 10 };

      usersService.findAll.mockRejectedValue(new Error('Database error'));

      await expect(controller.findAll(queryDto, reqWithOrg()))
        .rejects.toThrow('Database error');
    });
  });

  describe('update - error handling', () => {
    it('should handle update errors', async () => {
      const updateDto: UpdateUserDto = { firstName: 'Updated' };

      usersService.updateInOrg.mockRejectedValue(new Error('Update failed'));

      await expect(controller.update('user-1', updateDto, reqWithOrg()))
        .rejects.toThrow('Update failed');
    });
  });

  describe('deactivate - error handling', () => {
    it('should handle deactivation errors', async () => {
      usersService.deactivateInOrg.mockRejectedValue(new Error('Deactivation failed'));

      await expect(controller.deactivate('user-1', reqWithOrg()))
        .rejects.toThrow('Deactivation failed');
    });
  });

  describe('reactivate - error handling', () => {
    it('should handle reactivation errors', async () => {
      usersService.reactivateInOrg.mockRejectedValue(new Error('Reactivation failed'));

      await expect(controller.reactivate('user-1', reqWithOrg()))
        .rejects.toThrow('Reactivation failed');
    });
  });

  describe('remove - error handling', () => {
    it('should handle deletion errors', async () => {
      usersService.deleteInOrg.mockRejectedValue(new Error('Deletion failed'));

      await expect(controller.remove('user-1', reqWithOrg()))
        .rejects.toThrow('Deletion failed');
    });
  });

  describe('getUserStats - error handling', () => {
    it('should handle stats retrieval errors', async () => {
      usersService.getUserStatsInOrg.mockRejectedValue(new Error('Stats failed'));

      await expect(controller.getUserStats('user-1', reqWithOrg()))
        .rejects.toThrow('Stats failed');
    });
  });

  describe('searchUsers - error handling', () => {
    it('should handle search errors', async () => {
      usersService.searchUsers.mockRejectedValue(new Error('Search failed'));

      await expect(controller.searchUsers('john', reqWithOrg('org-1')))
        .rejects.toThrow('Search failed');
    });
  });

  describe('getCurrentUser - error handling', () => {
    it('should handle user not found', async () => {
      const currentUser = { id: 'user-1' } as User;

      usersService.findOne.mockRejectedValue(new Error('User not found'));

      await expect(controller.getCurrentUser(currentUser))
        .rejects.toThrow('User not found');
    });
  });

  describe('getCurrentUserActivity - error handling', () => {
    it('should handle activity retrieval errors', async () => {
      const currentUser = { id: 'user-1' } as User;

      usersService.getUserActivity.mockRejectedValue(new Error('Activity failed'));

      await expect(controller.getCurrentUserActivity(currentUser, 7))
        .rejects.toThrow('Activity failed');
    });
  });

  describe('updateCurrentUser - error handling', () => {
    it('should handle update errors', async () => {
      const currentUser = { id: 'user-1' } as User;
      const updateDto: UpdateUserDto = { firstName: 'Updated' };

      usersService.update.mockRejectedValue(new Error('Update failed'));

      await expect(controller.updateCurrentUser(currentUser, updateDto))
        .rejects.toThrow('Update failed');
    });
  });

  describe('getUserActivity - error handling', () => {
    it('should handle activity errors', async () => {
      usersService.getUserActivityInOrg.mockRejectedValue(new Error('Activity failed'));

      await expect(controller.getUserActivity('user-1', reqWithOrg(), 7))
        .rejects.toThrow('Activity failed');
    });
  });
});