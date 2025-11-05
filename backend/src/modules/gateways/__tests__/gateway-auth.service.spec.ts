import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { NotFoundException, BadRequestException } from '@nestjs/common';

import { GatewayAuthService } from '../gateway-auth.service';
import { GatewayAuth, GatewayAuthType } from '../../../entities/gateway-auth.entity';
import { Gateway } from '../../../entities/gateway.entity';
import { User } from '../../../entities/user.entity';
import { ApiKey } from '../../../entities/api-key.entity';

describe('GatewayAuthService', () => {
  let service: GatewayAuthService;
  let gatewayAuthRepository: Repository<GatewayAuth>;
  let gatewayRepository: Repository<Gateway>;
  let userRepository: Repository<User>;
  let apiKeyRepository: Repository<ApiKey>;
  let jwtService: JwtService;

  const mockGateway = {
    id: 'gateway-1',
    organizationId: 'org-1',
    name: 'Test Gateway',
  };

  const mockGatewayAuth = {
    id: 'auth-1',
    gatewayId: 'gateway-1',
    type: GatewayAuthType.API_KEY,
    isRequired: true,
    isActive: true,
    configuration: { keyHeader: 'x-api-key' },
    validationRules: {},
    gateway: mockGateway,
  };

  const mockUser = {
    id: 'user-1',
    email: 'test@example.com',
    passwordHash: '$2b$10$hashedpassword',
    isActive: true,
    organizationMemberships: [
      { organizationId: 'org-1', role: 'admin' },
    ],
  };

  const mockApiKey = {
    id: 'key-1',
    name: 'Test Key',
    keyHash: 'hashed-key',
    userId: 'user-1',
    organizationId: 'org-1',
    scopes: ['read', 'write'],
    isActive: true,
    user: mockUser,
    isExpired: jest.fn().mockReturnValue(false),
    lastUsedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GatewayAuthService,
        {
          provide: getRepositoryToken(GatewayAuth),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
            remove: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Gateway),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ApiKey),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: {
            verify: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<GatewayAuthService>(GatewayAuthService);
    gatewayAuthRepository = module.get(getRepositoryToken(GatewayAuth));
    gatewayRepository = module.get(getRepositoryToken(Gateway));
    userRepository = module.get(getRepositoryToken(User));
    apiKeyRepository = module.get(getRepositoryToken(ApiKey));
    jwtService = module.get<JwtService>(JwtService);
  });

  describe('createGatewayAuth', () => {
    it('should create gateway auth successfully', async () => {
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(mockGateway as any);
      jest.spyOn(gatewayAuthRepository, 'create').mockReturnValue(mockGatewayAuth as any);
      jest.spyOn(gatewayAuthRepository, 'save').mockResolvedValue(mockGatewayAuth as any);

      const result = await service.createGatewayAuth('gateway-1', {
        type: GatewayAuthType.API_KEY,
        isRequired: true,
        isActive: true,
        configuration: { keyHeader: 'x-api-key' },
      }, 'org-1');

      expect(result).toEqual(mockGatewayAuth);
    });

    it('should throw NotFoundException when gateway not found', async () => {
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.createGatewayAuth('gateway-1', {
          type: GatewayAuthType.API_KEY,
          isRequired: true,
          isActive: true,
          configuration: {},
        }, 'org-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should validate API_KEY auth requires keyHeader or keyQuery', async () => {
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(mockGateway as any);

      await expect(
        service.createGatewayAuth('gateway-1', {
          type: GatewayAuthType.API_KEY,
          isRequired: true,
          isActive: true,
          configuration: {},
        }, 'org-1')
      ).rejects.toThrow(BadRequestException);
    });

    it('should validate JWT auth requires secret', async () => {
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(mockGateway as any);
      const originalEnv = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;

      await expect(
        service.createGatewayAuth('gateway-1', {
          type: GatewayAuthType.JWT,
          isRequired: true,
          isActive: true,
          configuration: {},
        }, 'org-1')
      ).rejects.toThrow(BadRequestException);

      process.env.JWT_SECRET = originalEnv;
    });

    it('should validate CUSTOM auth requires headerName or queryName', async () => {
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(mockGateway as any);

      await expect(
        service.createGatewayAuth('gateway-1', {
          type: GatewayAuthType.CUSTOM,
          isRequired: true,
          isActive: true,
          configuration: {},
        }, 'org-1')
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateGatewayAuth', () => {
    it('should update gateway auth successfully', async () => {
      const updatedAuth = { ...mockGatewayAuth, isActive: false };
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(mockGatewayAuth as any);
      jest.spyOn(gatewayAuthRepository, 'save').mockResolvedValue(updatedAuth as any);

      const result = await service.updateGatewayAuth('auth-1', { isActive: false }, 'org-1');

      expect(result.isActive).toBe(false);
    });

    it('should throw NotFoundException when auth not found', async () => {
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.updateGatewayAuth('auth-1', { isActive: false }, 'org-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when organization mismatch', async () => {
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(mockGatewayAuth as any);

      await expect(
        service.updateGatewayAuth('auth-1', { isActive: false }, 'wrong-org')
      ).rejects.toThrow(NotFoundException);
    });

    it('should validate configuration when updated', async () => {
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(mockGatewayAuth as any);

      await expect(
        service.updateGatewayAuth('auth-1', {
          configuration: {},
        }, 'org-1')
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getGatewayAuths', () => {
    it('should return gateway auths', async () => {
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(mockGateway as any);
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([mockGatewayAuth] as any);

      const result = await service.getGatewayAuths('gateway-1', 'org-1');

      expect(result).toEqual([mockGatewayAuth]);
    });

    it('should throw NotFoundException when gateway not found', async () => {
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.getGatewayAuths('gateway-1', 'org-1')
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteGatewayAuth', () => {
    it('should delete gateway auth successfully', async () => {
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(mockGatewayAuth as any);
      jest.spyOn(gatewayAuthRepository, 'remove').mockResolvedValue(mockGatewayAuth as any);

      await service.deleteGatewayAuth('auth-1', 'org-1');

      expect(gatewayAuthRepository.remove).toHaveBeenCalledWith(mockGatewayAuth);
    });

    it('should throw NotFoundException when auth not found', async () => {
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.deleteGatewayAuth('auth-1', 'org-1')
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('authenticateRequest', () => {
    it('should return valid when no auth required', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([]);

      const result = await service.authenticateRequest('gateway-1', {}, {});

      expect(result.isValid).toBe(true);
    });

    it('should skip non-required auth configs', async () => {
      const optionalAuth = { ...mockGatewayAuth, isRequired: false };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([optionalAuth] as any);

      const result = await service.authenticateRequest('gateway-1', {}, {});

      expect(result.isValid).toBe(false);
    });

    it('should return error when all auth methods fail', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([mockGatewayAuth] as any);

      const result = await service.authenticateRequest('gateway-1', {}, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle authentication system errors', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockRejectedValue(new Error('DB error'));

      const result = await service.authenticateRequest('gateway-1', {}, {});

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('SYSTEM_ERROR');
    });

    it('should validate IP restrictions', async () => {
      const authWithIp = {
        ...mockGatewayAuth,
        validationRules: {
          allowedIpRanges: ['192.168.1.0/24'],
        },
      };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([authWithIp] as any);

      const result = await service.authenticateRequest('gateway-1', {}, {}, undefined, '10.0.0.1');

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('IP_RESTRICTED');
    });

    it('should allow wildcard IP', async () => {
      const authWithWildcard = {
        ...mockGatewayAuth,
        type: GatewayAuthType.NONE,
        validationRules: {
          allowedIpRanges: ['*'],
        },
      };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([authWithWildcard] as any);

      const result = await service.authenticateRequest('gateway-1', {}, {}, undefined, '10.0.0.1');

      expect(result.isValid).toBe(true);
    });

    it('should check required headers', async () => {
      const authWithHeaders = {
        ...mockGatewayAuth,
        validationRules: {
          requiredHeaders: ['X-Custom-Header'],
        },
      };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([authWithHeaders] as any);

      const result = await service.authenticateRequest('gateway-1', {}, {});

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('MISSING_HEADERS');
    });

    it('should pass when required headers present', async () => {
      const authWithHeaders = {
        ...mockGatewayAuth,
        type: GatewayAuthType.NONE,
        validationRules: {
          requiredHeaders: ['X-Custom-Header'],
        },
      };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([authWithHeaders] as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { 'x-custom-header': 'value' },
        {}
      );

      expect(result.isValid).toBe(true);
    });
  });

  describe('validateApiKey', () => {
    it('should validate API key from header', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([mockGatewayAuth] as any);
      jest.spyOn(apiKeyRepository, 'findOne').mockResolvedValue(mockApiKey as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { 'x-api-key': 'test-key' },
        {}
      );

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('user-1');
    });

    it('should validate API key from query', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([mockGatewayAuth] as any);
      jest.spyOn(apiKeyRepository, 'findOne').mockResolvedValue(mockApiKey as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        {},
        { api_key: 'test-key' }
      );

      expect(result.isValid).toBe(true);
    });

    it('should return error when API key missing', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([mockGatewayAuth] as any);

      const result = await service.authenticateRequest('gateway-1', {}, {});

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('API_KEY_MISSING');
    });

    it('should validate key format with minKeyLength', async () => {
      const authWithValidation = {
        ...mockGatewayAuth,
        validationRules: {
          minKeyLength: 20,
        },
      };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([authWithValidation] as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { 'x-api-key': 'short' },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('API_KEY_INVALID_FORMAT');
    });

    it('should validate key format with maxKeyLength', async () => {
      const authWithValidation = {
        ...mockGatewayAuth,
        validationRules: {
          maxKeyLength: 5,
        },
      };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([authWithValidation] as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { 'x-api-key': 'toolongkey' },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('API_KEY_INVALID_FORMAT');
    });

    it('should validate key format with regex', async () => {
      const authWithValidation = {
        ...mockGatewayAuth,
        validationRules: {
          keyFormat: '^gw_[a-z0-9]+$',
        },
      };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([authWithValidation] as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { 'x-api-key': 'invalid-format' },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('API_KEY_INVALID_FORMAT');
    });

    it('should return error when API key invalid', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([mockGatewayAuth] as any);
      jest.spyOn(apiKeyRepository, 'findOne').mockResolvedValue(null);

      const result = await service.authenticateRequest(
        'gateway-1',
        { 'x-api-key': 'invalid-key' },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('API_KEY_INVALID');
    });

    it('should return error when API key expired', async () => {
      const expiredKey = { ...mockApiKey, isExpired: jest.fn().mockReturnValue(true) };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([mockGatewayAuth] as any);
      jest.spyOn(apiKeyRepository, 'findOne').mockResolvedValue(expiredKey as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { 'x-api-key': 'expired-key' },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('API_KEY_EXPIRED');
    });

    it('should update lastUsedAt when key valid', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([mockGatewayAuth] as any);
      jest.spyOn(apiKeyRepository, 'findOne').mockResolvedValue(mockApiKey as any);
      jest.spyOn(apiKeyRepository, 'save').mockResolvedValue(mockApiKey as any);

      await service.authenticateRequest(
        'gateway-1',
        { 'x-api-key': 'test-key' },
        {}
      );

      expect(apiKeyRepository.save).toHaveBeenCalled();
    });
  });

  describe('validateBearerToken', () => {
    const bearerAuth = {
      ...mockGatewayAuth,
      type: GatewayAuthType.BEARER_TOKEN,
    };

    it('should validate bearer token successfully', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([bearerAuth] as any);
      jest.spyOn(apiKeyRepository, 'findOne').mockResolvedValue(mockApiKey as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: 'Bearer test-token' },
        {}
      );

      expect(result.isValid).toBe(true);
    });

    it('should return error when bearer token missing', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([bearerAuth] as any);

      const result = await service.authenticateRequest('gateway-1', {}, {});

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('BEARER_TOKEN_MISSING');
    });

    it('should return error when authorization header malformed', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([bearerAuth] as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: 'Basic token' },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('BEARER_TOKEN_MISSING');
    });

    it('should return error when token empty', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([bearerAuth] as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: 'Bearer ' },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('BEARER_TOKEN_INVALID');
    });

    it('should return error when token invalid', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([bearerAuth] as any);
      jest.spyOn(apiKeyRepository, 'findOne').mockResolvedValue(null);

      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: 'Bearer invalid-token' },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('BEARER_TOKEN_INVALID');
    });

    it('should return error when token expired', async () => {
      const expiredKey = { ...mockApiKey, isExpired: jest.fn().mockReturnValue(true) };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([bearerAuth] as any);
      jest.spyOn(apiKeyRepository, 'findOne').mockResolvedValue(expiredKey as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: 'Bearer expired-token' },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('BEARER_TOKEN_EXPIRED');
    });
  });

  describe('validateBasicAuth', () => {
    const basicAuth = {
      ...mockGatewayAuth,
      type: GatewayAuthType.BASIC_AUTH,
    };

    it('should validate basic auth successfully', async () => {
      const bcrypt = require('bcrypt');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([basicAuth] as any);
      jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUser as any);

      const credentials = Buffer.from('test@example.com:password').toString('base64');
      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: `Basic ${credentials}` },
        {}
      );

      expect(result.isValid).toBe(true);
    });

    it('should return error when basic auth missing', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([basicAuth] as any);

      const result = await service.authenticateRequest('gateway-1', {}, {});

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('BASIC_AUTH_MISSING');
    });

    it('should return error when credentials invalid format', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([basicAuth] as any);

      const credentials = Buffer.from('invalidformat').toString('base64');
      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: `Basic ${credentials}` },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('BASIC_AUTH_INVALID');
    });

    it('should return error when user not found', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([basicAuth] as any);
      jest.spyOn(userRepository, 'findOne').mockResolvedValue(null);

      const credentials = Buffer.from('test@example.com:password').toString('base64');
      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: `Basic ${credentials}` },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('BASIC_AUTH_INVALID');
    });

    it('should return error when user inactive', async () => {
      const inactiveUser = { ...mockUser, isActive: false };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([basicAuth] as any);
      jest.spyOn(userRepository, 'findOne').mockResolvedValue(inactiveUser as any);

      const credentials = Buffer.from('test@example.com:password').toString('base64');
      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: `Basic ${credentials}` },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('BASIC_AUTH_INVALID');
    });

    it('should return error when password invalid', async () => {
      const bcrypt = require('bcrypt');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false);
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([basicAuth] as any);
      jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUser as any);

      const credentials = Buffer.from('test@example.com:wrongpassword').toString('base64');
      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: `Basic ${credentials}` },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('BASIC_AUTH_INVALID');
    });

    it('should handle base64 decode errors', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([basicAuth] as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: 'Basic invalid!!!base64' },
        {}
      );

      expect(result.isValid).toBe(false);
      // The actual implementation returns BASIC_AUTH_INVALID for decode errors
      expect(result.errorCode).toBe('BASIC_AUTH_INVALID');
    });
  });

  describe('validateJWT', () => {
    const jwtAuth = {
      ...mockGatewayAuth,
      type: GatewayAuthType.JWT,
      configuration: { secret: 'test-secret' },
    };

    it('should validate JWT successfully', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([jwtAuth] as any);
      jest.spyOn(jwtService, 'verify').mockReturnValue({
        sub: 'user-1',
        scopes: ['read'],
        roles: ['admin'],
        org: 'org-1',
      });
      jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUser as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: 'Bearer jwt-token' },
        {}
      );

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('user-1');
    });

    it('should return error when JWT missing', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([jwtAuth] as any);

      const result = await service.authenticateRequest('gateway-1', {}, {});

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('JWT_MISSING');
    });

    it('should return error when JWT invalid', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([jwtAuth] as any);
      jest.spyOn(jwtService, 'verify').mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: 'Bearer invalid-jwt' },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('JWT_INVALID');
    });

    it('should handle JWT with userId instead of sub', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([jwtAuth] as any);
      jest.spyOn(jwtService, 'verify').mockReturnValue({
        userId: 'user-1',
        scopes: ['read'],
      });
      jest.spyOn(userRepository, 'findOne').mockResolvedValue(mockUser as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: 'Bearer jwt-token' },
        {}
      );

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('user-1');
    });

    it('should handle JWT with space-separated scopes', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([jwtAuth] as any);
      jest.spyOn(jwtService, 'verify').mockReturnValue({
        sub: 'user-1',
        scope: 'read write admin',
      });

      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: 'Bearer jwt-token' },
        {}
      );

      expect(result.isValid).toBe(true);
      expect(result.scopes).toEqual(['read', 'write', 'admin']);
    });
  });

  describe('validateOAuth2', () => {
    const oauth2Auth = {
      ...mockGatewayAuth,
      type: GatewayAuthType.OAUTH2,
    };

    it('should validate OAuth2 token', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([oauth2Auth] as any);
      jest.spyOn(apiKeyRepository, 'findOne').mockResolvedValue(mockApiKey as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { authorization: 'Bearer oauth-token' },
        {}
      );

      expect(result.isValid).toBe(true);
    });
  });

  describe('validateCustomAuth', () => {
    const customAuth = {
      ...mockGatewayAuth,
      type: GatewayAuthType.CUSTOM,
      configuration: {
        headerName: 'X-Custom-Token',
        validTokens: ['valid-token'],
        defaultScopes: ['read'],
      },
    };

    it('should validate custom auth from header', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([customAuth] as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { 'x-custom-token': 'valid-token' },
        {}
      );

      expect(result.isValid).toBe(true);
      expect(result.scopes).toEqual(['read']);
    });

    it('should validate custom auth from query', async () => {
      const customAuthQuery = {
        ...customAuth,
        configuration: {
          ...customAuth.configuration,
          queryName: 'custom_token',
        },
      };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([customAuthQuery] as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        {},
        { custom_token: 'valid-token' }
      );

      expect(result.isValid).toBe(true);
    });

    it('should return error when custom token missing', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([customAuth] as any);

      const result = await service.authenticateRequest('gateway-1', {}, {});

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('CUSTOM_AUTH_MISSING');
    });

    it('should return error when custom token invalid', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([customAuth] as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        { 'x-custom-token': 'invalid-token' },
        {}
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('CUSTOM_AUTH_INVALID');
    });
  });

  describe('NONE auth type', () => {
    const noneAuth = {
      ...mockGatewayAuth,
      type: GatewayAuthType.NONE,
    };

    it('should pass with NONE auth type', async () => {
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([noneAuth] as any);

      const result = await service.authenticateRequest('gateway-1', {}, {});

      expect(result.isValid).toBe(true);
    });
  });

  describe('unsupported auth type', () => {
    it('should return error for unsupported auth type', async () => {
      const unsupportedAuth = {
        ...mockGatewayAuth,
        type: 'UNSUPPORTED' as any,
      };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([unsupportedAuth] as any);

      const result = await service.authenticateRequest('gateway-1', {}, {});

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('UNSUPPORTED_AUTH_TYPE');
    });
  });

  describe('generateApiKey', () => {
    it('should generate API key successfully', async () => {
      const mockCreatedKey = { ...mockApiKey, save: jest.fn() };
      jest.spyOn(apiKeyRepository, 'create').mockReturnValue(mockCreatedKey as any);
      jest.spyOn(apiKeyRepository, 'save').mockResolvedValue(mockCreatedKey as any);

      const result = await service.generateApiKey(
        'Test Key',
        'org-1',
        'user-1',
        ['read', 'write']
      );

      expect(result).toBeDefined();
      expect((result as any).key).toBeDefined();
      expect((result as any).key).toContain('gw_');
    });

    it('should generate API key with expiration', async () => {
      const mockCreatedKey = { ...mockApiKey, save: jest.fn() };
      jest.spyOn(apiKeyRepository, 'create').mockReturnValue(mockCreatedKey as any);
      jest.spyOn(apiKeyRepository, 'save').mockResolvedValue(mockCreatedKey as any);

      const expiresAt = new Date();
      const result = await service.generateApiKey(
        'Test Key',
        'org-1',
        'user-1',
        ['read'],
        expiresAt
      );

      expect(result).toBeDefined();
    });
  });

  describe('IP validation', () => {
    it('should validate IP in CIDR range', async () => {
      const authWithCidr = {
        ...mockGatewayAuth,
        type: GatewayAuthType.NONE,
        validationRules: {
          allowedIpRanges: ['192.168.1.0/24'],
        },
      };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([authWithCidr] as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        {},
        {},
        undefined,
        '192.168.1.100'
      );

      expect(result.isValid).toBe(true);
    });

    it('should reject IP outside CIDR range', async () => {
      const authWithCidr = {
        ...mockGatewayAuth,
        validationRules: {
          allowedIpRanges: ['192.168.1.0/24'],
        },
      };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([authWithCidr] as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        {},
        {},
        undefined,
        '192.168.2.100'
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('IP_RESTRICTED');
    });

    it('should handle CIDR without prefix length', async () => {
      const authWithCidr = {
        ...mockGatewayAuth,
        type: GatewayAuthType.NONE,
        validationRules: {
          allowedIpRanges: ['192.168.1.1'],
        },
      };
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue([authWithCidr] as any);

      const result = await service.authenticateRequest(
        'gateway-1',
        {},
        {},
        undefined,
        '192.168.1.1'
      );

      expect(result.isValid).toBe(true);
    });
  });
});
