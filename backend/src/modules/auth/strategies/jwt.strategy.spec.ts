import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { User } from '../../../entities/user.entity';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let userRepository: any;

  beforeEach(async () => {
    const mockConfigService = {
      get: jest.fn().mockReturnValue('test-secret'),
    };

    const mockUserRepository = {
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
    userRepository = module.get(getRepositoryToken(User));
  });

  describe('validate', () => {
    it('should validate JWT payload and return user', async () => {
      const payload = {
        sub: 'user-1',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        organizations: [{ id: 'org-1', name: 'Test Org', role: 'admin' as any }],
      };

      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        isActive: true,
        organizationMemberships: [
          {
            organizationId: 'org-1',
            role: 'admin',
            isActive: true,
            organization: { id: 'org-1', name: 'Test Org' },
          },
        ],
        apiKeys: [],
      } as any;

      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await strategy.validate(payload);

      expect(result).toBe(mockUser);
      expect((result as any).currentOrganizationId).toBe('org-1');
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        relations: [
          'organizationMemberships',
          'organizationMemberships.organization',
          'apiKeys'
        ],
      });
    });

    it('should throw UnauthorizedException for non-existent user', async () => {
      const payload = {
        sub: 'non-existent',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        organizations: [],
      };

      userRepository.findOne.mockResolvedValue(null);

      await expect(strategy.validate(payload))
        .rejects
        .toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for inactive user', async () => {
      const payload = {
        sub: 'user-1',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        organizations: [],
      };

      const inactiveUser = {
        id: 'user-1',
        email: 'test@example.com',
        isActive: false,
      } as User;

      userRepository.findOne.mockResolvedValue(inactiveUser);

      await expect(strategy.validate(payload))
        .rejects
        .toThrow(UnauthorizedException);
    });

    it('should handle user without organization memberships', async () => {
      const payload = {
        sub: 'user-1',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        organizations: [],
      };

      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        isActive: true,
        organizationMemberships: [],
        apiKeys: [],
      } as any;

      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await strategy.validate(payload);

      expect(result).toBe(mockUser);
      expect((result as any).currentOrganizationId).toBeUndefined();
    });
  });
});