import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { UsersService } from './users.service';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { UpdateUserDto } from './dto/update-user.dto';

// Unmock bcrypt from global setup to test actual hashing
jest.unmock('bcryptjs');

describe('UsersService', () => {
  let service: UsersService;
  let userRepository: any;
  let userOrganizationRepository: any;
  let apiKeyRepository: any;
  let usageMetricRepository: any;


  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            save: jest.fn(),
            delete: jest.fn(),
            remove: jest.fn(),
            update: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(UserOrganization),
          useValue: {
            find: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ApiKey),
          useValue: {
            find: jest.fn(),
            update: jest.fn(),
            count: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(UsageMetric),
          useValue: {
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    userRepository = module.get(getRepositoryToken(User));
    userOrganizationRepository = module.get(getRepositoryToken(UserOrganization));
    apiKeyRepository = module.get(getRepositoryToken(ApiKey));
    usageMetricRepository = module.get(getRepositoryToken(UsageMetric));
  });

  describe('findOne', () => {
    it('should return user by id', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.findOne('user-1');

      expect(result).toBe(mockUser);
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        relations: ['organizationMemberships', 'organizationMemberships.organization', 'apiKeys'],
      });
    });

    it('should throw NotFoundException if user not found', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne('non-existent'))
        .rejects
        .toThrow(NotFoundException);
    });
  });

  describe('findByEmail', () => {
    it('should return user by email', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.findByEmail('test@example.com');

      expect(result).toBe(mockUser);
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { email: 'test@example.com' },
        relations: ['organizationMemberships', 'organizationMemberships.organization'],
      });
    });

    it('should return null if user not found', async () => {
      userRepository.findOne.mockResolvedValue(null);

      const result = await service.findByEmail('nonexistent@example.com');

      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update user successfully', async () => {
      const mockUser = {
        id: 'user-1',
        firstName: 'John',
        lastName: 'Doe',
      } as User;

      const updateData: UpdateUserDto = {
        firstName: 'Jane',
        lastName: 'Smith',
      };

      userRepository.findOne.mockResolvedValue(mockUser);
      userRepository.save.mockResolvedValue({
        ...mockUser,
        ...updateData,
      });

      const result = await service.update('user-1', updateData);

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        relations: ['organizationMemberships', 'organizationMemberships.organization', 'apiKeys'],
      });
      expect(userRepository.save).toHaveBeenCalled();
      expect(result.firstName).toBe('Jane');
    });

    it('should throw NotFoundException if user not found', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.update('non-existent', {}))
        .rejects
        .toThrow(NotFoundException);
    });

    it('should prevent email duplicate when updating', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'old@example.com',
        firstName: 'John',
      } as User;

      const mockOtherUser = {
        id: 'user-2',
        email: 'taken@example.com',
      } as User;

      userRepository.findOne
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce(mockOtherUser);

      const updateData: UpdateUserDto = {
        email: 'taken@example.com',
      };

      // Test REAL logic: existingUser && existingUser.id !== id
      await expect(service.update('user-1', updateData))
        .rejects
        .toThrow(BadRequestException);
    });

    it('should test preference merging logic', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
        preferences: {
          theme: 'dark',
          language: 'en',
        },
      } as unknown as User;

      userRepository.findOne.mockResolvedValue(mockUser);

      let savedUser: User;
      userRepository.save.mockImplementation((user) => {
        savedUser = user;
        return Promise.resolve(user);
      });

      const updateData: UpdateUserDto = {
        preferences: {
          theme: 'light',
          newSetting: 'value',
        },
      };

      await service.update('user-1', updateData);

      // Test REAL merging: { ...user.preferences, ...updateUserDto.preferences }
      expect(savedUser.preferences.theme).toBe('light');
      expect(savedUser.preferences.language).toBe('en');
      expect(savedUser.preferences.newSetting).toBe('value');
    });
  });

  describe('updatePassword', () => {
    it('should hash password with bcrypt', async () => {
      const oldPasswordHash = await bcrypt.hash('oldPassword123', 12);

      const mockUser = {
        id: 'user-1',
        passwordHash: oldPasswordHash,
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);

      let savedUser: User;
      userRepository.save.mockImplementation((user) => {
        savedUser = user;
        return Promise.resolve(user);
      });

      await service.updatePassword('user-1', 'oldPassword123', 'newPassword456');

      expect(userRepository.save).toHaveBeenCalled();
      expect(savedUser).toBeDefined();

      // Verify password hashing happened
      expect(savedUser.passwordHash).not.toBe('newPassword456');
      expect(savedUser.passwordHash).not.toBe(oldPasswordHash);

      // Verify new password validates correctly
      const isNewPasswordValid = await bcrypt.compare('newPassword456', savedUser.passwordHash);
      expect(isNewPasswordValid).toBe(true);

      // Verify old password no longer works
      const isOldPasswordStillValid = await bcrypt.compare('oldPassword123', savedUser.passwordHash);
      expect(isOldPasswordStillValid).toBe(false);
    });

    it('should throw error for invalid current password', async () => {
      const passwordHash = await bcrypt.hash('correctPassword', 12);

      const mockUser = {
        id: 'user-1',
        passwordHash,
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(service.updatePassword('user-1', 'wrongPassword', 'newpass'))
        .rejects
        .toThrow(BadRequestException);
    });
  });

  describe('deactivate', () => {
    it('should deactivate user', async () => {
      const mockUser = {
        id: 'user-1',
        isActive: true,
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);
      userRepository.save.mockResolvedValue({ ...mockUser, isActive: false });
      apiKeyRepository.update.mockResolvedValue({ affected: 1 });

      await service.deactivate('user-1');

      expect(userRepository.save).toHaveBeenCalledWith({
        ...mockUser,
        isActive: false,
      });
    });
  });

  describe('reactivate', () => {
    it('should reactivate user', async () => {
      const mockUser = {
        id: 'user-1',
        isActive: false,
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);
      userRepository.save.mockResolvedValue({ ...mockUser, isActive: true });

      await service.reactivate('user-1');

      expect(userRepository.save).toHaveBeenCalledWith({
        ...mockUser,
        isActive: true,
      });
    });
  });

  describe('getUserStats', () => {
    it('should return user statistics', async () => {
      const mockUser = {
        id: 'user-1',
        organizationMemberships: [],
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);
      apiKeyRepository.count.mockResolvedValue(0);

      const result = await service.getUserStats('user-1');

      expect(result).toEqual({
        organizationsCount: 0,
        apiKeysCount: 0,
        lastLoginAt: undefined,
      });
    });
  });

  describe('searchUsers', () => {
    it('should search users by query', async () => {
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };

      userRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.searchUsers('john');

      expect(result).toEqual([]);
      expect(mockQueryBuilder.where).toHaveBeenCalled();
    });
  });

  describe('getUserActivity', () => {
    it('should return user activity for specified days', async () => {
      const mockApiKeys = [
        { id: 'key-1', name: 'API Key 1', lastUsedAt: new Date(), createdAt: new Date() },
        { id: 'key-2', name: 'API Key 2', lastUsedAt: new Date(), createdAt: new Date() },
      ];

      apiKeyRepository.find.mockResolvedValue(mockApiKeys);

      const result = await service.getUserActivity('user-1', 30);

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('api_key_usage');
      expect(apiKeyRepository.find).toHaveBeenCalled();
    });
  });

  describe('bulkUpdate', () => {
    it('should update multiple users', async () => {
      const userIds = ['user-1', 'user-2'];
      const updateDto = { isActive: true };

      userRepository.update.mockResolvedValue({ affected: 2 });

      await service.bulkUpdate(userIds, updateDto);

      expect(userRepository.update).toHaveBeenCalledWith(
        { id: { $in: userIds } as any },
        updateDto
      );
    });
  });

  describe('delete', () => {
    it('should delete user successfully', async () => {
      const mockUser = { id: 'user-1', email: 'test@test.com' };

      userRepository.findOne.mockResolvedValue(mockUser);
      userRepository.remove.mockResolvedValue(mockUser);

      await service.delete('user-1');

      expect(userRepository.remove).toHaveBeenCalledWith(mockUser);
    });

    it('should throw NotFoundException if user not found', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.delete('non-existent')).rejects.toThrow();
    });
  });

  describe('findAll', () => {
    it('should return paginated users', async () => {
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([
          [
            { id: 'user-1', email: 'user1@test.com' },
            { id: 'user-2', email: 'user2@test.com' },
          ],
          2,
        ]),
      };

      userRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.findAll({
        page: 1,
        limit: 10,
      });

      expect(result.users).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it('should apply search filter when search param provided', async () => {
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };

      userRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.findAll({
        page: 1,
        limit: 10,
        search: 'john',
      });

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        '(user.firstName ILIKE :search OR user.lastName ILIKE :search OR user.email ILIKE :search)',
        { search: '%john%' }
      );
    });

    it('should apply organizationId filter when provided', async () => {
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };

      userRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.findAll({
        page: 1,
        limit: 10,
        organizationId: 'org-1',
      });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'organization.id = :organizationId',
        { organizationId: 'org-1' }
      );
    });

    it('should apply both search and organizationId filters', async () => {
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };

      userRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.findAll({
        page: 1,
        limit: 10,
        search: 'john',
        organizationId: 'org-1',
      });

      expect(mockQueryBuilder.where).toHaveBeenCalled();
      expect(mockQueryBuilder.andWhere).toHaveBeenCalled();
    });
  });

  describe('update - Additional Branch Coverage', () => {
    it('should update only firstName when provided', async () => {
      const mockUser = {
        id: 'user-1',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@test.com',
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);
      userRepository.save.mockImplementation(user => Promise.resolve(user));

      await service.update('user-1', { firstName: 'Jane' });

      expect(userRepository.save).toHaveBeenCalled();
      const savedUser = userRepository.save.mock.calls[0][0];
      expect(savedUser.firstName).toBe('Jane');
    });

    it('should update only lastName when provided', async () => {
      const mockUser = {
        id: 'user-1',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@test.com',
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);
      userRepository.save.mockImplementation(user => Promise.resolve(user));

      await service.update('user-1', { lastName: 'Smith' });

      expect(userRepository.save).toHaveBeenCalled();
      const savedUser = userRepository.save.mock.calls[0][0];
      expect(savedUser.lastName).toBe('Smith');
    });

    it('should update email when not taken by another user', async () => {
      const mockUser = {
        id: 'user-1',
        firstName: 'John',
        lastName: 'Doe',
        email: 'old@test.com',
      } as User;

      userRepository.findOne
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce(null);

      userRepository.save.mockImplementation(user => Promise.resolve(user));

      await service.update('user-1', { email: 'new@test.com' });

      expect(userRepository.save).toHaveBeenCalled();
      const savedUser = userRepository.save.mock.calls[0][0];
      expect(savedUser.email).toBe('new@test.com');
    });

    it('should allow user to update to their own email', async () => {
      const mockUser = {
        id: 'user-1',
        firstName: 'John',
        lastName: 'Doe',
        email: 'test@test.com',
      } as User;

      userRepository.findOne
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce(mockUser);

      userRepository.save.mockImplementation(user => Promise.resolve(user));

      await service.update('user-1', { email: 'test@test.com' });

      expect(userRepository.save).toHaveBeenCalled();
    });
  });

  describe('updatePassword - Additional Branch Coverage', () => {
    it('should throw NotFoundException when user not found', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updatePassword('non-existent', 'old', 'new')
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete - Additional Branch Coverage', () => {
    it('should delete user when not sole owner of any organization', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@test.com',
        organizationMemberships: [
          {
            organizationId: 'org-1',
            role: 'member',
            organization: { name: 'Test Org' },
          },
        ],
      } as any;

      userRepository.findOne.mockResolvedValue(mockUser);
      userRepository.remove.mockResolvedValue(mockUser);
      userOrganizationRepository.count = jest.fn().mockResolvedValue(2);

      await service.delete('user-1');

      expect(userRepository.remove).toHaveBeenCalledWith(mockUser);
    });

    it('should throw ForbiddenException when user is sole owner', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@test.com',
        organizationMemberships: [
          {
            organizationId: 'org-1',
            role: OrganizationRole.OWNER,
            organization: { name: 'Test Org' },
          },
        ],
      } as any;

      userRepository.findOne.mockResolvedValue(mockUser);
      userOrganizationRepository.count = jest.fn().mockResolvedValue(1);

      await expect(service.delete('user-1')).rejects.toThrow(
        'Cannot delete user: they are the sole owner'
      );
    });

    it('should handle user with no organizationMemberships', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@test.com',
        organizationMemberships: undefined,
      } as any;

      userRepository.findOne.mockResolvedValue(mockUser);
      userRepository.remove.mockResolvedValue(mockUser);

      await service.delete('user-1');

      expect(userRepository.remove).toHaveBeenCalledWith(mockUser);
    });

    it('should handle user with multiple ownerships where one is sole', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@test.com',
        organizationMemberships: [
          {
            organizationId: 'org-1',
            role: OrganizationRole.OWNER,
            organization: { name: 'Org 1' },
          },
          {
            organizationId: 'org-2',
            role: OrganizationRole.OWNER,
            organization: { name: 'Org 2' },
          },
        ],
      } as any;

      userRepository.findOne.mockResolvedValue(mockUser);
      userOrganizationRepository.count = jest.fn()
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);

      await expect(service.delete('user-1')).rejects.toThrow(
        'Cannot delete user: they are the sole owner of organization "Org 2"'
      );
    });
  });

  describe('searchUsers - Additional Branch Coverage', () => {
    it('should search users with organizationId filter', async () => {
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };

      userRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.searchUsers('john', 'org-1');

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'organization.id = :organizationId',
        { organizationId: 'org-1' }
      );
    });

    it('should search users without organizationId filter', async () => {
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };

      userRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.searchUsers('john');

      expect(mockQueryBuilder.where).toHaveBeenCalled();
      // Should not call andWhere with organizationId
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'user.isActive = :isActive',
        { isActive: true }
      );
    });
  });
});