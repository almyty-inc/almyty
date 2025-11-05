import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: jest.Mocked<AuthService>;

  beforeEach(async () => {
    const mockAuthService = {
      register: jest.fn(),
      generateTokens: jest.fn(),
      refreshToken: jest.fn(),
      createApiKey: jest.fn(),
      getUserApiKeys: jest.fn(),
      revokeApiKey: jest.fn(),
      resetPassword: jest.fn(),
      confirmPasswordReset: jest.fn(),
      changePassword: jest.fn(),
      verifyEmail: jest.fn(),
      isOrganizationNameAvailable: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: mockAuthService,
        },
      ],
    })
    .overrideGuard(LocalAuthGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get(AuthService);
  });

  describe('checkOrganizationName', () => {
    it('should check organization name availability', async () => {
      authService.isOrganizationNameAvailable.mockResolvedValue(true);

      const result = await controller.checkOrganizationName('Available Name');

      expect(result).toEqual({
        available: true,
        message: 'Organization name is available',
      });
    });

    it('should return false for taken name', async () => {
      authService.isOrganizationNameAvailable.mockResolvedValue(false);

      const result = await controller.checkOrganizationName('Taken Name');

      expect(result).toEqual({
        available: false,
        message: 'Organization name is already taken',
      });
    });

    it('should throw error when name is empty', async () => {
      await expect(controller.checkOrganizationName('')).rejects.toThrow('Organization name must be at least 2 characters long');
    });

    it('should throw error when name is too short', async () => {
      await expect(controller.checkOrganizationName('a')).rejects.toThrow('Organization name must be at least 2 characters long');
    });

    it('should throw error when name is only whitespace', async () => {
      await expect(controller.checkOrganizationName('  ')).rejects.toThrow('Organization name must be at least 2 characters long');
    });

    it('should throw error when name is undefined', async () => {
      await expect(controller.checkOrganizationName(undefined)).rejects.toThrow('Organization name must be at least 2 characters long');
    });
  });

  describe('register', () => {
    it('should register user successfully', async () => {
      const createUserDto = {
        email: 'test@example.com',
        password: 'password123',
        firstName: 'Test',
        lastName: 'User',
        organizationName: 'Test Organization',
      };

      const mockTokens = {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 86400,
      };

      authService.register.mockResolvedValue(mockTokens);

      const result = await controller.register(createUserDto);

      expect(result).toEqual({
        ...mockTokens,
        message: 'User registered successfully',
      });
    });
  });

  describe('login', () => {
    it('should login user successfully', async () => {
      const mockRequest = {
        user: { id: 'user-1', email: 'test@example.com' }
      };

      const mockTokens = {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 86400,
      };

      authService.generateTokens.mockResolvedValue(mockTokens);

      const result = await controller.login(mockRequest);

      expect(result).toBe(mockTokens);
    });
  });

  describe('refresh', () => {
    it('should refresh tokens successfully', async () => {
      const refreshToken = 'refresh-token';

      const mockTokens = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 86400,
      };

      authService.refreshToken.mockResolvedValue(mockTokens);

      const result = await controller.refresh(refreshToken);

      expect(result).toBe(mockTokens);
    });

    it('should throw error when refresh token is missing', async () => {
      await expect(controller.refresh('')).rejects.toThrow('Refresh token is required');
    });

    it('should throw error when refresh token is undefined', async () => {
      await expect(controller.refresh(undefined)).rejects.toThrow('Refresh token is required');
    });

    it('should throw error when refresh token is null', async () => {
      await expect(controller.refresh(null)).rejects.toThrow('Refresh token is required');
    });
  });

  describe('getProfile', () => {
    it('should return user profile', async () => {
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
          role: 'owner',
          joinedAt: new Date(),
          organization: {
            id: 'org-1',
            name: 'Test Org',
            slug: 'test-org',
          },
        }],
      } as any;

      const result = await controller.getProfile(mockUser);

      expect(result.id).toBe('user-1');
      expect(result.email).toBe('test@example.com');
      expect('passwordHash' in result).toBe(false);
      expect(result.organizationMemberships).toHaveLength(1);
    });

    it('should return profile without memberships when undefined', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        passwordHash: 'hash',
        resetPasswordToken: 'token',
        verificationToken: 'verify',
      } as any;

      const result = await controller.getProfile(mockUser);

      expect(result.id).toBe('user-1');
      expect(result.organizationMemberships).toBeUndefined();
    });

    it('should return profile with empty memberships array', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        passwordHash: 'hash',
        resetPasswordToken: 'token',
        verificationToken: 'verify',
        organizationMemberships: [],
      } as any;

      const result = await controller.getProfile(mockUser);

      expect(result.id).toBe('user-1');
      expect(result.organizationMemberships).toEqual([]);
    });
  });

  describe('createApiKey', () => {
    it('should create API key successfully', async () => {
      const mockUser = { id: 'user-1' } as any;
      const createApiKeyDto = {
        name: 'Test API Key',
        scopes: ['read'],
      };

      const mockResult = {
        apiKey: 'api-key-value',
        keyData: {
          id: 'key-1',
          name: 'Test API Key',
          keyPrefix: 'apifai_12',
          keyHash: 'hash',
          userId: 'user-1',
          organizationId: 'org-1',
          isActive: true,
          scopes: ['read'],
          rateLimits: null,
          metadata: {},
          expiresAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      };

      authService.createApiKey.mockResolvedValue(mockResult);

      const result = await controller.createApiKey(mockUser, createApiKeyDto);

      expect(result.message).toBe('API key created successfully');
      expect(result.apiKey).toBe('api-key-value');
    });
  });

  describe('forgotPassword', () => {
    it('should handle forgot password request', async () => {
      authService.resetPassword.mockResolvedValue();

      const result = await controller.forgotPassword('test@example.com');

      expect(result.message).toBe('If a user with this email exists, a password reset link has been sent.');
    });

    it('should throw error when email is missing', async () => {
      await expect(controller.forgotPassword('')).rejects.toThrow('Email is required');
    });

    it('should throw error when email is undefined', async () => {
      await expect(controller.forgotPassword(undefined)).rejects.toThrow('Email is required');
    });

    it('should throw error when email is null', async () => {
      await expect(controller.forgotPassword(null)).rejects.toThrow('Email is required');
    });
  });

  describe('resetPassword', () => {
    it('should reset password successfully', async () => {
      authService.confirmPasswordReset.mockResolvedValue();

      const result = await controller.resetPassword('reset-token', 'newpassword');

      expect(result.message).toBe('Password reset successfully');
    });

    it('should throw error when token is missing', async () => {
      await expect(controller.resetPassword('', 'newpassword')).rejects.toThrow('Token and password are required');
    });

    it('should throw error when password is missing', async () => {
      await expect(controller.resetPassword('reset-token', '')).rejects.toThrow('Token and password are required');
    });

    it('should throw error when both are missing', async () => {
      await expect(controller.resetPassword('', '')).rejects.toThrow('Token and password are required');
    });

    it('should throw error when token is undefined', async () => {
      await expect(controller.resetPassword(undefined, 'newpassword')).rejects.toThrow('Token and password are required');
    });

    it('should throw error when password is undefined', async () => {
      await expect(controller.resetPassword('reset-token', undefined)).rejects.toThrow('Token and password are required');
    });
  });

  describe('changePassword', () => {
    it('should change password successfully', async () => {
      const mockUser = { id: 'user-1' } as any;

      authService.changePassword.mockResolvedValue();

      const result = await controller.changePassword(mockUser, 'oldpass', 'newpass');

      expect(result.message).toBe('Password changed successfully');
    });

    it('should throw error when current password is missing', async () => {
      const mockUser = { id: 'user-1' } as any;
      await expect(controller.changePassword(mockUser, '', 'newpass')).rejects.toThrow('Current password and new password are required');
    });

    it('should throw error when new password is missing', async () => {
      const mockUser = { id: 'user-1' } as any;
      await expect(controller.changePassword(mockUser, 'oldpass', '')).rejects.toThrow('Current password and new password are required');
    });

    it('should throw error when both passwords are missing', async () => {
      const mockUser = { id: 'user-1' } as any;
      await expect(controller.changePassword(mockUser, '', '')).rejects.toThrow('Current password and new password are required');
    });

    it('should throw error when current password is undefined', async () => {
      const mockUser = { id: 'user-1' } as any;
      await expect(controller.changePassword(mockUser, undefined, 'newpass')).rejects.toThrow('Current password and new password are required');
    });

    it('should throw error when new password is undefined', async () => {
      const mockUser = { id: 'user-1' } as any;
      await expect(controller.changePassword(mockUser, 'oldpass', undefined)).rejects.toThrow('Current password and new password are required');
    });
  });

  describe('verifyEmail', () => {
    it('should verify email successfully', async () => {
      authService.verifyEmail.mockResolvedValue();

      const result = await controller.verifyEmail('verify-token');

      expect(result.message).toBe('Email verified successfully');
    });

    it('should throw error when token is missing', async () => {
      await expect(controller.verifyEmail('')).rejects.toThrow('Verification token is required');
    });

    it('should throw error when token is undefined', async () => {
      await expect(controller.verifyEmail(undefined)).rejects.toThrow('Verification token is required');
    });

    it('should throw error when token is null', async () => {
      await expect(controller.verifyEmail(null)).rejects.toThrow('Verification token is required');
    });
  });

  describe('getApiKeys', () => {
    it('should return user API keys', async () => {
      const mockUser = { id: 'user-1' } as any;
      const mockApiKeys = [
        {
          id: 'key-1',
          name: 'Test Key 1',
          keyPrefix: 'apifai_12',
          isActive: true,
          createdAt: new Date(),
          lastUsedAt: null,
          expiresAt: undefined,
          scopes: undefined,
        },
        {
          id: 'key-2',
          name: 'Test Key 2',
          keyPrefix: 'apifai_34',
          isActive: true,
          createdAt: new Date(),
          lastUsedAt: new Date(),
          expiresAt: undefined,
          scopes: undefined,
        },
      ];

      authService.getUserApiKeys.mockResolvedValue(mockApiKeys as any);

      const result = await controller.getApiKeys(mockUser);

      expect(result.apiKeys).toEqual(mockApiKeys);
      expect(authService.getUserApiKeys).toHaveBeenCalledWith('user-1');
    });
  });

  describe('revokeApiKey', () => {
    it('should revoke API key successfully', async () => {
      const mockUser = { id: 'user-1' } as any;

      authService.revokeApiKey.mockResolvedValue();

      const result = await controller.revokeApiKey(mockUser, 'key-1');

      expect(result.message).toBe('API key revoked successfully');
      expect(authService.revokeApiKey).toHaveBeenCalledWith('key-1', 'user-1');
    });
  });
});