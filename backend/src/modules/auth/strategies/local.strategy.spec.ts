import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { LocalStrategy } from './local.strategy';
import { AuthService } from '../auth.service';

describe('LocalStrategy', () => {
  let strategy: LocalStrategy;
  let authService: jest.Mocked<AuthService>;

  beforeEach(async () => {
    const mockAuthService = {
      validateUser: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocalStrategy,
        {
          provide: AuthService,
          useValue: mockAuthService,
        },
      ],
    }).compile();

    strategy = module.get<LocalStrategy>(LocalStrategy);
    authService = module.get(AuthService);
  });

  describe('validate', () => {
    it('should validate user with correct credentials', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        passwordHash: 'hashed-password',
        firstName: 'Test',
        lastName: 'User',
        isActive: true,
        isVerified: true,
        verificationToken: null,
        resetPasswordToken: null,
        resetPasswordExpires: null,
        lastLoginAt: new Date(),
        currentOrganizationId: 'org-1',
        organizationMemberships: [],
        apiKeys: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        fullName: 'Test User',
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;

      authService.validateUser.mockResolvedValue(mockUser);

      const result = await strategy.validate('test@example.com', 'password123');

      expect(result).toEqual(mockUser);
      expect(authService.validateUser).toHaveBeenCalledWith('test@example.com', 'password123');
    });

    it('should throw UnauthorizedException for invalid credentials', async () => {
      authService.validateUser.mockResolvedValue(null);

      await expect(strategy.validate('test@example.com', 'wrongpassword'))
        .rejects
        .toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for non-existent user', async () => {
      authService.validateUser.mockResolvedValue(null);

      await expect(strategy.validate('nonexistent@example.com', 'password123'))
        .rejects
        .toThrow(UnauthorizedException);
    });
  });
});