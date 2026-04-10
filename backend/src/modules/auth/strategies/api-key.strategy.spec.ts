import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyStrategy } from './api-key.strategy';
import { AuthService } from '../auth.service';
import { Request } from 'express';

describe('ApiKeyStrategy', () => {
  let strategy: ApiKeyStrategy;
  let authService: jest.Mocked<AuthService>;

  beforeEach(async () => {
    const mockAuthService = {
      validateApiKey: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyStrategy,
        {
          provide: AuthService,
          useValue: mockAuthService,
        },
      ],
    }).compile();

    strategy = module.get<ApiKeyStrategy>(ApiKeyStrategy);
    authService = module.get(AuthService);
  });

  describe('validate', () => {
    it('should validate API key from Authorization header', async () => {
      const mockRequest = {
        headers: {
          authorization: 'Bearer almyty_test-api-key-12345',
        },
        query: {},
      } as any;

      const mockValidApiKey = {
        id: 'key-1',
        name: 'Test API Key',
        keyHash: 'hashed-key',
        keyPrefix: 'almyty_te',
        userId: 'user-1',
        organizationId: 'org-1',
        isActive: true,
        expiresAt: new Date(Date.now() + 86400000),
        lastUsedAt: new Date(),
        usageCount: 10,
        permissions: ['read', 'write'],
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        user: {
          id: 'user-1',
          email: 'test@example.com',
          passwordHash: 'hashed',
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
        },
        organization: { id: 'org-1', name: 'Test Org' },
        isExpired: jest.fn().mockReturnValue(false),
        incrementUsage: jest.fn(),
      } as any;

      authService.validateApiKey.mockResolvedValue(mockValidApiKey);

      const result = await strategy.validate(mockRequest);

      expect(result.user).toBe(mockValidApiKey.user);
      expect(result.apiKey).toBe(mockValidApiKey);
      expect(result.organization).toBe(mockValidApiKey.organization);
      expect(authService.validateApiKey).toHaveBeenCalledWith(
        expect.any(String) // SHA256 hash
      );
    });

    it('should validate API key from X-API-Key header', async () => {
      const mockRequest = {
        headers: {
          'x-api-key': 'api-key-from-header',
        },
        query: {},
      } as any;

      const mockValidApiKey = {
        id: 'key-2',
        name: 'Header API Key',
        keyHash: 'hashed-header-key',
        keyPrefix: 'api_key',
        userId: 'user-2',
        organizationId: 'org-2',
        isActive: true,
        expiresAt: null,
        lastUsedAt: new Date(),
        usageCount: 5,
        permissions: ['read'],
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        user: {
          id: 'user-2',
          email: 'user2@example.com',
          passwordHash: 'hashed',
          firstName: 'User',
          lastName: 'Two',
          isActive: true,
          isVerified: true,
          verificationToken: null,
          resetPasswordToken: null,
          resetPasswordExpires: null,
          lastLoginAt: new Date(),
          currentOrganizationId: 'org-2',
          organizationMemberships: [],
          apiKeys: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          fullName: 'User Two',
          hasPermissionInOrganization: jest.fn().mockReturnValue(true),
        },
        organization: { id: 'org-2', name: 'Test Org 2' },
        isExpired: jest.fn().mockReturnValue(false),
        incrementUsage: jest.fn(),
      } as any;

      authService.validateApiKey.mockResolvedValue(mockValidApiKey);

      const result = await strategy.validate(mockRequest);

      expect(result.user).toBe(mockValidApiKey.user);
      expect(authService.validateApiKey).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException when no API key provided', async () => {
      const mockRequest = {
        headers: {},
        query: {},
      } as any;

      await expect(strategy.validate(mockRequest)).rejects.toThrow(UnauthorizedException);
      await expect(strategy.validate(mockRequest)).rejects.toThrow('API key is required');
    });

    it('should throw UnauthorizedException for invalid API key', async () => {
      const mockRequest = {
        headers: {
          'x-api-key': 'invalid-api-key',
        },
        query: {},
      } as any;

      authService.validateApiKey.mockResolvedValue(null);

      await expect(strategy.validate(mockRequest)).rejects.toThrow(UnauthorizedException);
      await expect(strategy.validate(mockRequest)).rejects.toThrow('Invalid API key');
    });
  });
});