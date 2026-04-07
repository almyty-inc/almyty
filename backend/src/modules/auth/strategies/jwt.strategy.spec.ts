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

      const result = await strategy.validate({ headers: {} } as any, payload);

      expect(result).toBe(mockUser);
      // Single-org user → currentOrganizationId is that one org, no header needed.
      expect((result as any).currentOrganizationId).toBe('org-1');
    });

    it('should honor X-Organization-Id header for multi-org users', async () => {
      const payload = {
        sub: 'user-1',
        email: 'multi@example.com',
        firstName: 'Multi',
        lastName: 'User',
        organizations: [
          { id: 'org-a', name: 'A', role: 'admin' as any },
          { id: 'org-b', name: 'B', role: 'member' as any },
        ],
      };
      const mockUser = {
        id: 'user-1',
        email: 'multi@example.com',
        isActive: true,
        organizationMemberships: [
          { organizationId: 'org-a', role: 'admin', organization: { id: 'org-a', name: 'A' } },
          { organizationId: 'org-b', role: 'member', organization: { id: 'org-b', name: 'B' } },
        ],
      } as any;
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await strategy.validate(
        { headers: { 'x-organization-id': 'org-b' } } as any,
        payload,
      );

      expect((result as any).currentOrganizationId).toBe('org-b');
    });

    it('should leave currentOrganizationId undefined for multi-org users without a header', async () => {
      // Regression: previously defaulted to memberships[0] which silently
      // scoped every request to the user's FIRST org. The role guard's
      // "require explicit org context" safety was defeated because the
      // field was always set.
      const payload = {
        sub: 'user-1',
        email: 'multi@example.com',
        firstName: 'Multi',
        lastName: 'User',
        organizations: [
          { id: 'org-a', name: 'A', role: 'admin' as any },
          { id: 'org-b', name: 'B', role: 'member' as any },
        ],
      };
      const mockUser = {
        id: 'user-1',
        email: 'multi@example.com',
        isActive: true,
        organizationMemberships: [
          { organizationId: 'org-a', role: 'admin', organization: { id: 'org-a', name: 'A' } },
          { organizationId: 'org-b', role: 'member', organization: { id: 'org-b', name: 'B' } },
        ],
      } as any;
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await strategy.validate({ headers: {} } as any, payload);

      expect((result as any).currentOrganizationId).toBeUndefined();
    });

    it('should reject X-Organization-Id the user is not a member of', async () => {
      const payload = {
        sub: 'user-1',
        email: 'multi@example.com',
        firstName: 'Multi',
        lastName: 'User',
        organizations: [{ id: 'org-a', name: 'A', role: 'admin' as any }],
      };
      const mockUser = {
        id: 'user-1',
        email: 'multi@example.com',
        isActive: true,
        organizationMemberships: [
          { organizationId: 'org-a', role: 'admin', organization: { id: 'org-a', name: 'A' } },
        ],
      } as any;
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        strategy.validate(
          { headers: { 'x-organization-id': 'org-other' } } as any,
          payload,
        ),
      ).rejects.toThrow(UnauthorizedException);
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        relations: [
          'organizationMemberships',
          'organizationMemberships.organization',
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

      await expect(strategy.validate({ headers: {} } as any, payload))
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

      await expect(strategy.validate({ headers: {} } as any, payload))
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

      const result = await strategy.validate({ headers: {} } as any, payload);

      expect(result).toBe(mockUser);
      expect((result as any).currentOrganizationId).toBeUndefined();
    });
  });
});