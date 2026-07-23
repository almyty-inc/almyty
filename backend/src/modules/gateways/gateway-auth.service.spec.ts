import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';

import { GatewayAuthService } from './gateway-auth.service';
import { GatewayAuthValidators } from './gateway-auth-validators.helper';
import { GatewayAuth, GatewayAuthType } from '../../entities/gateway-auth.entity';
import { Gateway } from '../../entities/gateway.entity';
import { User } from '../../entities/user.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { OAuthAccessToken } from '../../entities/oauth-access-token.entity';

describe('GatewayAuthService - Real Business Logic', () => {
  let service: GatewayAuthService;
  let gatewayAuthRepository: Repository<GatewayAuth>;
  let gatewayRepository: Repository<Gateway>;
  let userRepository: Repository<User>;
  let apiKeyRepository: Repository<ApiKey>;
  let jwtService: JwtService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GatewayAuthValidators,
        GatewayAuthService,
        {
          provide: getRepositoryToken(GatewayAuth),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
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
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(OAuthAccessToken),
          useValue: {
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

    // Default: gatewayRepository.findOne returns a gateway in `org-1`.
    // The validate* paths all resolve the gateway's organizationId for
    // cross-org scoping checks; tests that need a different behaviour
    // override this spy individually.
    jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue({
      id: 'gateway-1',
      organizationId: 'org-1',
      name: 'Test Gateway',
    } as any);
  });

  describe('validateKeyFormat - Real validation logic', () => {
    it('should return true when no validation rules', () => {
      const result = service['validateKeyFormat']('any-key', null);
      expect(result).toBe(true);
    });

    it('should validate minimum key length', () => {
      const rules = { minKeyLength: 10 };

      expect(service['validateKeyFormat']('short', rules)).toBe(false);
      expect(service['validateKeyFormat']('long-enough-key', rules)).toBe(true);
    });

    it('should validate maximum key length', () => {
      const rules = { maxKeyLength: 20 };

      expect(service['validateKeyFormat']('this-is-a-very-long-key-that-exceeds-limit', rules)).toBe(false);
      expect(service['validateKeyFormat']('acceptable-length', rules)).toBe(true);
    });

    it('should validate key format with regex', () => {
      const rules = { keyFormat: '^sk-[a-z0-9]{32}$' };

      expect(service['validateKeyFormat']('sk-abc123def456abc123def456abc123de', rules)).toBe(true);
      expect(service['validateKeyFormat']('invalid-format', rules)).toBe(false);
      expect(service['validateKeyFormat']('sk-SHORT', rules)).toBe(false);
    });

    it('should validate all rules together', () => {
      const rules = {
        minKeyLength: 10,
        maxKeyLength: 50,
        keyFormat: '^gw_[a-zA-Z0-9_-]+$',
      };

      expect(service['validateKeyFormat']('gw_valid-key_123', rules)).toBe(true);
      expect(service['validateKeyFormat']('short', rules)).toBe(false);
      expect(service['validateKeyFormat']('invalid-format-without-prefix', rules)).toBe(false);
    });

    describe('ReDoS defence for admin-supplied keyFormat', () => {
      // Bound the test at 200ms so a regression that re-introduces
      // catastrophic backtracking fails loud rather than hanging the
      // jest worker. The classic `(a+)+$` pattern against 30 'a's
      // with a trailing 'b' takes ~10s on V8 without these guards.
      const assertBounded = (label: string, fn: () => boolean) => {
        const start = Date.now();
        const result = fn();
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(200);
        return result;
      };

      it('refuses the classic nested-quantifier ReDoS pattern (a+)+', () => {
        const rules = { keyFormat: '^(a+)+$' };
        const payload = 'a'.repeat(30) + 'b';
        const result = assertBounded('(a+)+', () =>
          service['validateKeyFormat'](payload, rules),
        );
        expect(result).toBe(false);
      });

      it('refuses (a*)* nested quantifier', () => {
        const rules = { keyFormat: '^(a*)*$' };
        expect(service['validateKeyFormat']('a'.repeat(30) + 'b', rules)).toBe(false);
      });

      it('refuses mixed (a+)* / (a*)+ nested quantifiers', () => {
        expect(
          service['validateKeyFormat']('x'.repeat(30), { keyFormat: '(a+)*' }),
        ).toBe(false);
        expect(
          service['validateKeyFormat']('x'.repeat(30), { keyFormat: '(a*)+' }),
        ).toBe(false);
      });

      it('refuses overlapping alternation like (a|ab)+', () => {
        const rules = { keyFormat: '^(a|ab)+$' };
        expect(service['validateKeyFormat']('abababab', rules)).toBe(false);
      });

      it('refuses bounded-quantifier ReDoS like (a{1,2})+', () => {
        const rules = { keyFormat: '^(a{1,2})+$' };
        expect(service['validateKeyFormat']('aaaaaaaa', rules)).toBe(false);
      });

      it('refuses a pattern that exceeds the source-length cap', () => {
        const rules = { keyFormat: 'a'.repeat(513) };
        expect(service['validateKeyFormat']('anything', rules)).toBe(false);
      });

      it('truncates the probed key to the input-length cap', () => {
        // Safe linear pattern. With a ~10KB input and no cap this
        // would test the full 10KB; with the cap it's bounded at 2KiB.
        // The assertion we care about is just that the call completes
        // fast and doesn't explode — the match still returns true
        // because the truncated prefix is still all 'a'.
        const rules = { keyFormat: '^a+$' };
        const longKey = 'a'.repeat(10_000);
        const result = assertBounded('linear large input', () =>
          service['validateKeyFormat'](longKey, rules),
        );
        expect(result).toBe(true);
      });

      it('still accepts legitimate patterns that look scary but are safe', () => {
        // Anchored character class + fixed quantifier, no nesting.
        const rules = { keyFormat: '^sk-[a-zA-Z0-9]{32}$' };
        expect(
          service['validateKeyFormat']('sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345', rules),
        ).toBe(true);
      });
    });
  });

  describe('isIpInRanges - Real IP checking logic', () => {
    it('should match exact IP', () => {
      expect(service['isIpInRanges']('192.168.1.1', ['192.168.1.1'])).toBe(true);
      expect(service['isIpInRanges']('192.168.1.1', ['192.168.1.2'])).toBe(false);
    });

    it('should match wildcard', () => {
      expect(service['isIpInRanges']('any.ip.address', ['*'])).toBe(true);
      expect(service['isIpInRanges']('192.168.1.1', ['*'])).toBe(true);
    });

    it('should match IP in multiple ranges', () => {
      const ranges = ['10.0.0.1', '192.168.1.0/24', '172.16.0.1'];

      expect(service['isIpInRanges']('10.0.0.1', ranges)).toBe(true);
      expect(service['isIpInRanges']('172.16.0.1', ranges)).toBe(true);
      expect(service['isIpInRanges']('192.168.1.100', ranges)).toBe(true);
      expect(service['isIpInRanges']('8.8.8.8', ranges)).toBe(false);
    });
  });

  describe('isIpInCIDR - Real CIDR calculation', () => {
    it('should match IP in /24 subnet', () => {
      expect(service['isIpInCIDR']('192.168.1.1', '192.168.1.0/24')).toBe(true);
      expect(service['isIpInCIDR']('192.168.1.255', '192.168.1.0/24')).toBe(true);
      expect(service['isIpInCIDR']('192.168.2.1', '192.168.1.0/24')).toBe(false);
    });

    it('should match IP in /16 subnet', () => {
      expect(service['isIpInCIDR']('10.0.0.1', '10.0.0.0/16')).toBe(true);
      expect(service['isIpInCIDR']('10.0.255.255', '10.0.0.0/16')).toBe(true);
      expect(service['isIpInCIDR']('10.1.0.1', '10.0.0.0/16')).toBe(false);
    });

    it('should match IP in /32 (single IP)', () => {
      expect(service['isIpInCIDR']('192.168.1.1', '192.168.1.1/32')).toBe(true);
      expect(service['isIpInCIDR']('192.168.1.2', '192.168.1.1/32')).toBe(false);
    });

    it('should handle CIDR without prefix as exact match', () => {
      expect(service['isIpInCIDR']('192.168.1.1', '192.168.1.1')).toBe(true);
      expect(service['isIpInCIDR']('192.168.1.2', '192.168.1.1')).toBe(false);
    });
  });

  describe('hashKey - Real SHA256 hashing', () => {
    it('should produce consistent hash for same input', () => {
      const key = 'test-api-key-123';
      const hash1 = service['hashKey'](key);
      const hash2 = service['hashKey'](key);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 produces 64 hex characters
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = service['hashKey']('key1');
      const hash2 = service['hashKey']('key2');

      expect(hash1).not.toBe(hash2);
    });

    it('should produce valid hex string', () => {
      const hash = service['hashKey']('any-key');

      expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
    });
  });

  describe('generateSecureKey - Real key generation', () => {
    it('should generate key with gw_ prefix', () => {
      const key = service['generateSecureKey']();

      expect(key.startsWith('gw_')).toBe(true);
    });

    it('should generate unique keys', () => {
      const key1 = service['generateSecureKey']();
      const key2 = service['generateSecureKey']();

      expect(key1).not.toBe(key2);
    });

    it('should generate keys of sufficient length', () => {
      const key = service['generateSecureKey']();

      expect(key.length).toBeGreaterThan(40); // gw_ + 32 random bytes base64url encoded
    });
  });

  describe('validateAuthConfiguration - Real config validation', () => {
    it('should require keyHeader or keyQuery for API_KEY type', () => {
      expect(() => {
        service['validateAuthConfiguration'](GatewayAuthType.API_KEY, {});
      }).toThrow('API key auth requires keyHeader or keyQuery configuration');

      expect(() => {
        service['validateAuthConfiguration'](GatewayAuthType.API_KEY, { keyHeader: 'X-API-Key' });
      }).not.toThrow();

      expect(() => {
        service['validateAuthConfiguration'](GatewayAuthType.API_KEY, { keyQuery: 'api_key' });
      }).not.toThrow();
    });

    it('should require secret for JWT type', () => {
      expect(() => {
        service['validateAuthConfiguration'](GatewayAuthType.JWT, {});
      }).toThrow('JWT auth requires a gateway-specific secret');

      expect(() => {
        service['validateAuthConfiguration'](GatewayAuthType.JWT, { secret: 'my-secret' });
      }).not.toThrow();
    });

    it('should REJECT JWT auth without explicit secret even if JWT_SECRET env is set (cross-org bypass regression)', () => {
      // Regression: validateAuthConfiguration used to allow JWT auth
      // without configuration.secret as long as process.env.JWT_SECRET
      // was set. That matched the pre-fix validateJWT behavior, which
      // accepted the backend's own login JWTs as gateway auth tokens —
      // a silent cross-org bypass. Both paths now require an explicit
      // gateway-specific secret.
      const originalEnv = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'env-secret';

      expect(() => {
        service['validateAuthConfiguration'](GatewayAuthType.JWT, {});
      }).toThrow('JWT auth requires a gateway-specific secret');

      process.env.JWT_SECRET = originalEnv;
    });

    it('should require headerName or queryName for CUSTOM type', () => {
      expect(() => {
        service['validateAuthConfiguration'](GatewayAuthType.CUSTOM, {});
      }).toThrow('Custom auth requires headerName or queryName configuration');

      expect(() => {
        service['validateAuthConfiguration'](GatewayAuthType.CUSTOM, { headerName: 'X-Custom-Token' });
      }).not.toThrow();

      expect(() => {
        service['validateAuthConfiguration'](GatewayAuthType.CUSTOM, { queryName: 'token' });
      }).not.toThrow();
    });

    it('should not throw for NONE type', () => {
      expect(() => {
        service['validateAuthConfiguration'](GatewayAuthType.NONE, {});
      }).not.toThrow();
    });

    it('should not throw for BEARER_TOKEN type', () => {
      expect(() => {
        service['validateAuthConfiguration'](GatewayAuthType.BEARER_TOKEN, {});
      }).not.toThrow();
    });

    it('should not throw for BASIC_AUTH type', () => {
      expect(() => {
        service['validateAuthConfiguration'](GatewayAuthType.BASIC_AUTH, {});
      }).not.toThrow();
    });
  });

  describe('validateApiKey - Real validation with mocked DB', () => {
    it('should return error when API key is missing', async () => {
      const authConfig = {
        type: GatewayAuthType.API_KEY,
        configuration: { keyHeader: 'x-api-key' },
      } as Partial<GatewayAuth> as GatewayAuth;

      const result = await service['validateApiKey'](authConfig, {}, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('API key is required');
      expect(result.errorCode).toBe('API_KEY_MISSING');
    });

    it('should return error for invalid key format', async () => {
      const authConfig = {
        type: GatewayAuthType.API_KEY,
        configuration: { keyHeader: 'x-api-key' },
        validationRules: { keyFormat: '^sk-[a-z0-9]{32}$' },
      } as Partial<GatewayAuth> as GatewayAuth;

      const result = await service['validateApiKey'](authConfig, { 'x-api-key': 'invalid' }, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid API key format');
      expect(result.errorCode).toBe('API_KEY_INVALID_FORMAT');
    });

    it('should return error when key not found in database', async () => {
      jest.spyOn(apiKeyRepository, 'findOne').mockResolvedValue(null);

      const authConfig = {
        type: GatewayAuthType.API_KEY,
        configuration: { keyHeader: 'x-api-key' },
      } as Partial<GatewayAuth> as GatewayAuth;

      const result = await service['validateApiKey'](authConfig, { 'x-api-key': 'test-key' }, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid API key');
      expect(result.errorCode).toBe('API_KEY_INVALID');
    });

    it('should return error when key is expired', async () => {
      const expiredKey = {
        id: 'key-1',
        userId: 'user-1',
        isExpired: jest.fn().mockReturnValue(true),
      } as any;

      jest.spyOn(apiKeyRepository, 'findOne').mockResolvedValue(expiredKey);

      const authConfig = {
        type: GatewayAuthType.API_KEY,
        configuration: { keyHeader: 'x-api-key' },
      } as Partial<GatewayAuth> as GatewayAuth;

      const result = await service['validateApiKey'](authConfig, { 'x-api-key': 'test-key' }, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('API key expired');
      expect(result.errorCode).toBe('API_KEY_EXPIRED');
    });

    it('should successfully validate and update lastUsedAt', async () => {
      const validKey = {
        id: 'key-1',
        userId: 'user-1',
        scopes: ['read', 'write'],
        organizationId: 'org-1',
        name: 'Test Key',
        isExpired: jest.fn().mockReturnValue(false),
        user: {
          organizationMemberships: [{ role: 'admin' }],
        },
      } as any;

      jest.spyOn(apiKeyRepository, 'findOne').mockResolvedValue(validKey);
      jest.spyOn(apiKeyRepository, 'save').mockResolvedValue(validKey);

      const authConfig = {
        type: GatewayAuthType.API_KEY,
        configuration: { keyHeader: 'x-api-key' },
      } as Partial<GatewayAuth> as GatewayAuth;

      const result = await service['validateApiKey'](authConfig, { 'x-api-key': 'test-key' }, {});

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('user-1');
      expect(result.scopes).toEqual(['read', 'write']);
      expect(result.organizationId).toBe('org-1');
      expect(result.metadata.keyId).toBe('key-1');
      expect(validKey.lastUsedAt).toBeInstanceOf(Date);
      expect(apiKeyRepository.save).toHaveBeenCalledWith(validKey);
    });

    it('should accept API key from query parameter', async () => {
      const validKey = {
        id: 'key-1',
        userId: 'user-1',
        isExpired: jest.fn().mockReturnValue(false),
        user: {},
      } as any;

      jest.spyOn(apiKeyRepository, 'findOne').mockResolvedValue(validKey);
      jest.spyOn(apiKeyRepository, 'save').mockResolvedValue(validKey);

      const authConfig = {
        type: GatewayAuthType.API_KEY,
        configuration: { keyQuery: 'api_key' },
      } as Partial<GatewayAuth> as GatewayAuth;

      const result = await service['validateApiKey'](authConfig, {}, { api_key: 'test-key' });

      expect(result.isValid).toBe(true);
      expect(apiKeyRepository.findOne).toHaveBeenCalled();
    });
  });

  describe('validateBasicAuth - Real Base64 decoding and password check', () => {
    it('should return error when authorization header missing', async () => {
      const authConfig = { configuration: {} } as Partial<GatewayAuth> as GatewayAuth;

      const result = await service['validateBasicAuth'](authConfig, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Basic authentication is required');
      expect(result.errorCode).toBe('BASIC_AUTH_MISSING');
    });

    it('should return error when not Basic auth', async () => {
      const authConfig = { configuration: {} } as Partial<GatewayAuth> as GatewayAuth;

      const result = await service['validateBasicAuth'](authConfig, { authorization: 'Bearer token' });

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Basic authentication is required');
    });

    it('should decode Base64 credentials correctly', async () => {
      const credentials = Buffer.from('user@example.com:password123').toString('base64');

      jest.spyOn(userRepository, 'findOne').mockResolvedValue(null);

      const authConfig = { configuration: {} } as Partial<GatewayAuth> as GatewayAuth;
      const result = await service['validateBasicAuth'](authConfig, { authorization: `Basic ${credentials}` });

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { email: 'user@example.com' },
        relations: { organizationMemberships: true },
      });
    });

    it('should return error for invalid credentials format', async () => {
      const invalidCredentials = Buffer.from('no-colon-separator').toString('base64');

      const authConfig = { configuration: {} } as Partial<GatewayAuth> as GatewayAuth;
      const result = await service['validateBasicAuth'](authConfig, { authorization: `Basic ${invalidCredentials}` });

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid basic auth credentials');
    });

    it('should return error for invalid Base64', async () => {
      const authConfig = { configuration: {} } as Partial<GatewayAuth> as GatewayAuth;
      const result = await service['validateBasicAuth'](authConfig, { authorization: 'Basic invalid!!!base64' });

      expect(result.isValid).toBe(false);
      // Base64 decodes but results in invalid credentials (no colon separator)
      expect(result.errorCode).toBe('BASIC_AUTH_INVALID');
    });

    it('should verify password with bcrypt', async () => {
      const password = 'password123';
      const passwordHash = await bcrypt.hash(password, 10);

      const user = {
        id: 'user-1',
        email: 'user@example.com',
        passwordHash,
        isActive: true,
        organizationMemberships: [{ organizationId: 'org-1', role: 'member' }],
      } as any;

      jest.spyOn(userRepository, 'findOne').mockResolvedValue(user);

      const credentials = Buffer.from(`user@example.com:${password}`).toString('base64');
      const authConfig = { configuration: { defaultScopes: ['read'] } } as Partial<GatewayAuth> as GatewayAuth;

      const result = await service['validateBasicAuth'](authConfig, { authorization: `Basic ${credentials}` });

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('user-1');
      expect(result.scopes).toEqual(['read']);
      expect(result.organizationId).toBe('org-1');
    });

    it('should return error for wrong password', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 10);

      const user = {
        id: 'user-1',
        email: 'user@example.com',
        passwordHash,
        isActive: true,
      } as any;

      jest.spyOn(userRepository, 'findOne').mockResolvedValue(user);

      const credentials = Buffer.from('user@example.com:wrong-password').toString('base64');
      const authConfig = { configuration: {} } as Partial<GatewayAuth> as GatewayAuth;

      const result = await service['validateBasicAuth'](authConfig, { authorization: `Basic ${credentials}` });

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid credentials');
    });
  });

  describe('createGatewayAuth - Real orchestration logic', () => {
    it('should throw NotFoundException when gateway does not exist', async () => {
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(null);

      const dto = {
        type: GatewayAuthType.API_KEY,
        isRequired: true,
        isActive: true,
        configuration: { keyHeader: 'X-API-Key' },
      };

      await expect(
        service.createGatewayAuth('gateway-1', dto, 'org-1')
      ).rejects.toThrow('Gateway not found');
    });

    it('should throw when gateway belongs to different organization', async () => {
      const gateway = { id: 'gateway-1', organizationId: 'org-2' } as Gateway;
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(gateway);

      const dto = {
        type: GatewayAuthType.API_KEY,
        isRequired: true,
        isActive: true,
        configuration: { keyHeader: 'X-API-Key' },
      };

      // findOne with specific org check returns null
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.createGatewayAuth('gateway-1', dto, 'org-1')
      ).rejects.toThrow('Gateway not found');
    });

    it('should validate configuration before creating', async () => {
      const gateway = { id: 'gateway-1', organizationId: 'org-1' } as Gateway;
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(gateway);

      const dto = {
        type: GatewayAuthType.API_KEY,
        isRequired: true,
        isActive: true,
        configuration: {}, // Missing keyHeader/keyQuery
      };

      await expect(
        service.createGatewayAuth('gateway-1', dto, 'org-1')
      ).rejects.toThrow('API key auth requires keyHeader or keyQuery configuration');
    });

    it('should create and save gateway auth with valid data', async () => {
      const gateway = { id: 'gateway-1', organizationId: 'org-1' } as Gateway;
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(gateway);
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(null);

      const dto = {
        type: GatewayAuthType.API_KEY,
        isRequired: true,
        isActive: true,
        configuration: { keyHeader: 'X-API-Key' },
      };

      const createdAuth = { id: 'auth-1', ...dto, gatewayId: 'gateway-1' } as Partial<GatewayAuth> as GatewayAuth;
      jest.spyOn(gatewayAuthRepository, 'create').mockReturnValue(createdAuth);
      jest.spyOn(gatewayAuthRepository, 'save').mockResolvedValue(createdAuth);

      const result = await service.createGatewayAuth('gateway-1', dto, 'org-1');

      expect(result).toBe(createdAuth);
      expect(gatewayAuthRepository.create).toHaveBeenCalledWith({
        gatewayId: 'gateway-1',
        ...dto,
      });
      expect(gatewayAuthRepository.save).toHaveBeenCalledWith(createdAuth);
    });

    it('rejects a duplicate active config of the same type (auto-created + manually-added would otherwise produce two identical rows)', async () => {
      const gateway = { id: 'gateway-1', organizationId: 'org-1' } as Gateway;
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(gateway);

      const existingAuth = {
        id: 'auth-existing',
        gatewayId: 'gateway-1',
        type: GatewayAuthType.API_KEY,
        isActive: true,
        configuration: { keyHeader: 'x-api-key' },
      } as Partial<GatewayAuth> as GatewayAuth;
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(existingAuth);

      const dto = {
        type: GatewayAuthType.API_KEY,
        isRequired: true,
        isActive: true,
        configuration: { keyHeader: 'X-API-Key' },
      };

      await expect(service.createGatewayAuth('gateway-1', dto, 'org-1')).rejects.toThrow(
        /already has an active api_key auth config.*auth-existing/,
      );
    });
  });

  describe('updateGatewayAuth - Real authorization and update logic', () => {
    it('should throw when auth not found', async () => {
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.updateGatewayAuth('auth-1', { isActive: false }, 'org-1')
      ).rejects.toThrow('Gateway auth not found');
    });

    it('should throw when gateway belongs to different organization', async () => {
      const auth = {
        id: 'auth-1',
        gateway: { organizationId: 'org-2' },
      } as Partial<GatewayAuth> as GatewayAuth;
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(auth);

      await expect(
        service.updateGatewayAuth('auth-1', { isActive: false }, 'org-1')
      ).rejects.toThrow('Gateway auth not found');
    });

    it('should validate configuration when updated', async () => {
      const auth = {
        id: 'auth-1',
        type: GatewayAuthType.JWT,
        gateway: { organizationId: 'org-1' },
      } as Partial<GatewayAuth> as GatewayAuth;
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(auth);

      const originalEnv = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;

      await expect(
        service.updateGatewayAuth('auth-1', { configuration: {} }, 'org-1')
      ).rejects.toThrow('JWT auth requires a gateway-specific secret');

      process.env.JWT_SECRET = originalEnv;
    });

    it('should update and save auth with valid data', async () => {
      const auth = {
        id: 'auth-1',
        type: GatewayAuthType.API_KEY,
        isActive: true,
        gateway: { organizationId: 'org-1' },
      } as Partial<GatewayAuth> as GatewayAuth;
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(auth);

      const updatedAuth = { ...auth, isActive: false } as Partial<GatewayAuth> as GatewayAuth;
      jest.spyOn(gatewayAuthRepository, 'save').mockResolvedValue(updatedAuth);

      const result = await service.updateGatewayAuth('auth-1', { isActive: false }, 'org-1');

      expect(result.isActive).toBe(false);
      expect(gatewayAuthRepository.save).toHaveBeenCalledWith(auth);
    });
  });

  describe('getGatewayAuths - Real authorization check', () => {
    it('should throw when gateway not found', async () => {
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.getGatewayAuths('gateway-1', 'org-1')
      ).rejects.toThrow('Gateway not found');
    });

    it('should return auth configs when gateway exists', async () => {
      const gateway = { id: 'gateway-1', organizationId: 'org-1' } as Gateway;
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(gateway);

      const auths = [
        { id: 'auth-1', type: GatewayAuthType.API_KEY },
        { id: 'auth-2', type: GatewayAuthType.JWT },
      ] as GatewayAuth[];
      jest.spyOn(gatewayAuthRepository, 'find').mockResolvedValue(auths);

      const result = await service.getGatewayAuths('gateway-1', 'org-1');

      expect(result).toBe(auths);
      expect(gatewayAuthRepository.find).toHaveBeenCalledWith({
        where: { gatewayId: 'gateway-1' },
        order: { createdAt: 'ASC' },
      });
    });
  });

  describe('deleteGatewayAuth - Real authorization check', () => {
    it('should throw when auth not found', async () => {
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.deleteGatewayAuth('auth-1', 'org-1')
      ).rejects.toThrow('Gateway auth not found');
    });

    it('should throw when gateway belongs to different organization', async () => {
      const auth = {
        id: 'auth-1',
        gateway: { organizationId: 'org-2' },
      } as Partial<GatewayAuth> as GatewayAuth;
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(auth);

      await expect(
        service.deleteGatewayAuth('auth-1', 'org-1')
      ).rejects.toThrow('Gateway auth not found');
    });

    it('should delete auth when authorized', async () => {
      const auth = {
        id: 'auth-1',
        gateway: { organizationId: 'org-1' },
      } as Partial<GatewayAuth> as GatewayAuth;
      jest.spyOn(gatewayAuthRepository, 'findOne').mockResolvedValue(auth);
      jest.spyOn(gatewayAuthRepository, 'remove').mockResolvedValue(auth);

      await service.deleteGatewayAuth('auth-1', 'org-1');

      expect(gatewayAuthRepository.remove).toHaveBeenCalledWith(auth);
    });
  });

  describe('generateApiKey - Real key generation and hashing', () => {
    it('should generate secure key with correct format', async () => {
      const mockKey = { id: 'key-1', keyHash: 'hash', keyPrefix: 'gw_12345' } as any;
      jest.spyOn(apiKeyRepository, 'create').mockReturnValue(mockKey);
      jest.spyOn(apiKeyRepository, 'save').mockResolvedValue(mockKey);

      const result = await service.generateApiKey('Test Key', 'org-1', 'user-1', ['read'], new Date());

      expect(result.keyPrefix.startsWith('gw_')).toBe(true);
      expect((result as any).key).toBeDefined();
      expect((result as any).key.startsWith('gw_')).toBe(true);
      expect(apiKeyRepository.create).toHaveBeenCalledWith({
        name: 'Test Key',
        keyHash: expect.any(String),
        keyPrefix: expect.stringContaining('gw_'),
        organizationId: 'org-1',
        userId: 'user-1',
        scopes: ['read'],
        expiresAt: expect.any(Date),
        gatewayId: null,
        isActive: true,
      });
    });

    it('should hash the generated key', async () => {
      const mockKey = { id: 'key-1' } as any;
      jest.spyOn(apiKeyRepository, 'create').mockReturnValue(mockKey);
      jest.spyOn(apiKeyRepository, 'save').mockResolvedValue(mockKey);

      await service.generateApiKey('Test Key', 'org-1', 'user-1');

      const createCall = (apiKeyRepository.create as jest.Mock).mock.calls[0][0];
      expect(createCall.keyHash).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex
    });
  });

  describe('validateJWT - Real JWT verification', () => {
    it('should return error when JWT header missing', async () => {
      const authConfig = { configuration: {} } as Partial<GatewayAuth> as GatewayAuth;

      const result = await service['validateJWT'](authConfig, {});

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('JWT token is required');
    });

    it('should verify JWT and extract payload', async () => {
      const payload = {
        sub: 'user-123',
        scopes: ['read', 'write'],
        roles: ['admin'],
        org: 'org-1',
      };

      jest.spyOn(jwtService, 'verify').mockReturnValue(payload);

      const authConfig = { configuration: { secret: 'test-secret' } } as Partial<GatewayAuth> as GatewayAuth;
      const result = await service['validateJWT'](authConfig, { authorization: 'Bearer valid.jwt.token' });

      expect(result.isValid).toBe(true);
      expect(result.userId).toBe('user-123');
      expect(result.scopes).toEqual(['read', 'write']);
      expect(result.roles).toEqual(['admin']);
      expect(result.organizationId).toBe('org-1');
      expect(result.metadata.jwtPayload).toEqual(payload);
    });

    it('should parse scope string into array', async () => {
      const payload = {
        sub: 'user-123',
        scope: 'read write admin',
      };

      jest.spyOn(jwtService, 'verify').mockReturnValue(payload);

      const authConfig = { configuration: { secret: 'test-secret' } } as Partial<GatewayAuth> as GatewayAuth;
      const result = await service['validateJWT'](authConfig, { authorization: 'Bearer token' });

      expect(result.scopes).toEqual(['read', 'write', 'admin']);
    });

    it('should return error for invalid JWT', async () => {
      jest.spyOn(jwtService, 'verify').mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const authConfig = { configuration: { secret: 'test-secret' } } as Partial<GatewayAuth> as GatewayAuth;
      const result = await service['validateJWT'](authConfig, { authorization: 'Bearer invalid' });

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid JWT token');
      expect(result.errorCode).toBe('JWT_INVALID');
    });
  });
});
