import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';

import { McpOAuthService } from '../services/mcp-oauth.service';
import { OAuthClient } from '../../../entities/oauth-client.entity';
import { OAuthAuthorizationCode } from '../../../entities/oauth-authorization-code.entity';
import { OAuthAccessToken } from '../../../entities/oauth-access-token.entity';
import { Gateway } from '../../../entities/gateway.entity';

describe('McpOAuthService', () => {
  let service: McpOAuthService;
  let oauthClientRepository: Repository<OAuthClient>;
  let oauthCodeRepository: Repository<OAuthAuthorizationCode>;
  let oauthTokenRepository: Repository<OAuthAccessToken>;
  let gatewayRepository: Repository<Gateway>;

  const mockGateway = {
    id: 'gateway-1',
    organizationId: 'org-1',
    name: 'Test Gateway',
    configuration: {
      oauth: {
        scopes: ['tools:read', 'tools:execute'],
      },
    },
  };

  const mockClient: Partial<OAuthClient> = {
    id: 'uuid-1',
    clientId: 'mcp_client_abc123',
    clientSecretHash: null,
    clientName: 'Test Client',
    redirectUris: ['https://example.com/callback', 'http://localhost:3000/callback'],
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    tokenEndpointAuthMethod: 'none',
    scope: 'tools:read tools:execute',
    gatewayId: 'gateway-1',
    organizationId: 'org-1',
    isActive: true,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpOAuthService,
        {
          provide: getRepositoryToken(OAuthClient),
          useValue: {
            create: jest.fn().mockImplementation((data) => ({ ...data })),
            save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
            findOne: jest.fn(),
            // count is used by registerClient to enforce the
            // per-gateway quota. Default to 0 so existing tests
            // don't hit the cap; tests that exercise the cap
            // explicitly override this mock.
            count: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: getRepositoryToken(OAuthAuthorizationCode),
          useValue: {
            create: jest.fn().mockImplementation((data) => ({ ...data })),
            save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
            findOne: jest.fn(),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
          },
        },
        {
          provide: getRepositoryToken(OAuthAccessToken),
          useValue: {
            create: jest.fn().mockImplementation((data) => ({ ...data })),
            save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
            findOne: jest.fn(),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
          },
        },
        {
          provide: getRepositoryToken(Gateway),
          useValue: {
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<McpOAuthService>(McpOAuthService);
    oauthClientRepository = module.get(getRepositoryToken(OAuthClient));
    oauthCodeRepository = module.get(getRepositoryToken(OAuthAuthorizationCode));
    oauthTokenRepository = module.get(getRepositoryToken(OAuthAccessToken));
    gatewayRepository = module.get(getRepositoryToken(Gateway));

    // Default: the client lookup now runs at the top of exchangeCode /
    // refreshToken / revokeToken so every test flow hits it. Return the
    // public mockClient by default; individual tests override when they
    // need a confidential client or a "not found" branch.
    jest.spyOn(oauthClientRepository, 'findOne').mockResolvedValue(mockClient as OAuthClient);
  });

  // ---------------------------------------------------------------------------
  // Helper: compute SHA-256 hash the same way the service does
  // ---------------------------------------------------------------------------
  function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  // ---------------------------------------------------------------------------
  // getAuthorizationServerMetadata
  // ---------------------------------------------------------------------------

  describe('getAuthorizationServerMetadata', () => {
    it('should return correct metadata structure', () => {
      const baseUrl = 'https://api.almyty.com';
      const result = service.getAuthorizationServerMetadata(
        mockGateway as any,
        baseUrl,
      );

      expect(result.issuer).toBe(baseUrl);
      expect(result.authorization_endpoint).toContain('/oauth/authorize');
      expect(result.token_endpoint).toContain('/oauth/token');
      expect(result.registration_endpoint).toContain('/oauth/register');
      expect(result.revocation_endpoint).toContain('/oauth/revoke');
      expect(result.code_challenge_methods_supported).toEqual(['S256']);
      expect(result.grant_types_supported).toContain('authorization_code');
      expect(result.grant_types_supported).toContain('refresh_token');
      expect(result.token_endpoint_auth_methods_supported).toEqual(['none', 'client_secret_post']);
    });

    it('should use default scopes when gateway has no oauth config', () => {
      const gatewayNoOauth = { ...mockGateway, configuration: {} };
      const result = service.getAuthorizationServerMetadata(
        gatewayNoOauth as any,
        'https://api.almyty.com',
      );

      expect(result.scopes_supported).toEqual(['tools:read', 'tools:execute']);
    });
  });

  // ---------------------------------------------------------------------------
  // getProtectedResourceMetadata
  // ---------------------------------------------------------------------------

  describe('getProtectedResourceMetadata', () => {
    it('should return correct resource metadata', () => {
      const baseUrl = 'https://api.almyty.com';
      const result = service.getProtectedResourceMetadata(
        mockGateway as any,
        baseUrl,
      );

      expect(result.resource).toContain('/mcp');
      expect(result.authorization_servers).toHaveLength(1);
      expect(result.authorization_servers[0]).toContain('.well-known/oauth-authorization-server');
    });
  });

  // ---------------------------------------------------------------------------
  // registerClient
  // ---------------------------------------------------------------------------

  describe('registerClient', () => {
    const validDto = {
      client_name: 'My MCP Client',
      redirect_uris: ['https://example.com/callback'],
    };

    it('should create client with generated client_id starting with mcp_client_', async () => {
      const result = await service.registerClient('gateway-1', 'org-1', validDto);

      expect(result.client_id).toMatch(/^mcp_client_/);
      expect(result.client_name).toBe('My MCP Client');
      expect(result.redirect_uris).toEqual(['https://example.com/callback']);
      expect(oauthClientRepository.create).toHaveBeenCalled();
      expect(oauthClientRepository.save).toHaveBeenCalled();
    });

    it('should store hashed secret for client_secret_post auth method', async () => {
      const dto = {
        ...validDto,
        token_endpoint_auth_method: 'client_secret_post',
      };

      const result = await service.registerClient('gateway-1', 'org-1', dto);

      expect(result.client_secret).toBeDefined();
      expect(result.client_secret).toBeTruthy();
      expect(result.token_endpoint_auth_method).toBe('client_secret_post');

      // The create call should have received a hashed secret
      const createCall = (oauthClientRepository.create as jest.Mock).mock.calls[0][0];
      expect(createCall.clientSecretHash).toBeDefined();
      expect(createCall.clientSecretHash).not.toBe(result.client_secret);
      // Verify it's a SHA-256 hex hash (64 chars)
      expect(createCall.clientSecretHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should return no secret for public clients (auth method = none)', async () => {
      const dto = {
        ...validDto,
        token_endpoint_auth_method: 'none',
      };

      const result = await service.registerClient('gateway-1', 'org-1', dto);

      expect(result.client_secret).toBeUndefined();
      expect(result.token_endpoint_auth_method).toBe('none');
    });

    it('should default to auth method none when not specified', async () => {
      const result = await service.registerClient('gateway-1', 'org-1', validDto);

      expect(result.client_secret).toBeUndefined();
      expect(result.token_endpoint_auth_method).toBe('none');
    });

    it('should reject invalid redirect URIs (non-HTTPS, non-localhost)', async () => {
      const dto = {
        ...validDto,
        redirect_uris: ['http://example.com/callback'],
      };

      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow localhost redirect URIs with HTTP', async () => {
      const dto = {
        ...validDto,
        redirect_uris: ['http://localhost:3000/callback'],
      };

      const result = await service.registerClient('gateway-1', 'org-1', dto);
      expect(result.redirect_uris).toEqual(['http://localhost:3000/callback']);
    });

    it('should allow 127.0.0.1 redirect URIs with HTTP', async () => {
      const dto = {
        ...validDto,
        redirect_uris: ['http://127.0.0.1:8080/callback'],
      };

      const result = await service.registerClient('gateway-1', 'org-1', dto);
      expect(result.redirect_uris).toEqual(['http://127.0.0.1:8080/callback']);
    });

    it('should reject redirect URIs with fragment identifiers', async () => {
      const dto = {
        ...validDto,
        redirect_uris: ['https://example.com/callback#fragment'],
      };

      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject invalid URL format in redirect URIs', async () => {
      const dto = {
        ...validDto,
        redirect_uris: ['not-a-valid-url'],
      };

      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject unsupported grant_types', async () => {
      const dto = {
        ...validDto,
        grant_types: ['implicit'],
      };

      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow('Unsupported grant_type: implicit');
    });

    it('should reject unsupported response_types', async () => {
      const dto = {
        ...validDto,
        response_types: ['token'],
      };

      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow('Unsupported response_type: token');
    });

    it('should reject unsupported token_endpoint_auth_method', async () => {
      const dto = {
        ...validDto,
        token_endpoint_auth_method: 'client_secret_basic',
      };

      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow('Unsupported token_endpoint_auth_method');
    });

    it('should reject empty redirect_uris', async () => {
      const dto = {
        ...validDto,
        redirect_uris: [],
      };

      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow('At least one redirect_uri is required');
    });

    it('should reject missing redirect_uris', async () => {
      const dto = {
        client_name: 'Test',
        redirect_uris: undefined as any,
      };

      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should default grant_types to authorization_code', async () => {
      const result = await service.registerClient('gateway-1', 'org-1', validDto);

      expect(result.grant_types).toEqual(['authorization_code']);
    });

    it('should default response_types to code', async () => {
      const result = await service.registerClient('gateway-1', 'org-1', validDto);

      expect(result.response_types).toEqual(['code']);
    });

    it('should default scope to tools:read tools:execute', async () => {
      const result = await service.registerClient('gateway-1', 'org-1', validDto);

      expect(result.scope).toBe('tools:read tools:execute');
    });

    it('should set client_id_issued_at to current unix timestamp', async () => {
      const before = Math.floor(Date.now() / 1000);
      const result = await service.registerClient('gateway-1', 'org-1', validDto);
      const after = Math.floor(Date.now() / 1000);

      expect(result.client_id_issued_at).toBeGreaterThanOrEqual(before);
      expect(result.client_id_issued_at).toBeLessThanOrEqual(after);
    });

    it('should accept multiple valid redirect URIs', async () => {
      const dto = {
        ...validDto,
        redirect_uris: [
          'https://example.com/callback',
          'http://localhost:3000/callback',
          'https://app.example.com/auth',
        ],
      };

      const result = await service.registerClient('gateway-1', 'org-1', dto);
      expect(result.redirect_uris).toHaveLength(3);
    });

    it('should reject if any redirect URI is invalid', async () => {
      const dto = {
        ...validDto,
        redirect_uris: [
          'https://example.com/callback',
          'gateway-1',
          'http://example.com/bad', // non-HTTPS, non-localhost
        ],
      };

      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(BadRequestException);
    });

    // ── Input caps (DoS defence for RFC 7591 public endpoint) ──

    it('rejects client_name longer than 255 characters', async () => {
      const dto = {
        ...validDto,
        client_name: 'x'.repeat(256),
      };
      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(/client_name exceeds/);
    });

    it('rejects empty client_name', async () => {
      const dto = { ...validDto, client_name: '' };
      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(/client_name is required/);
    });

    it('rejects more than 20 redirect_uris', async () => {
      const dto = {
        ...validDto,
        redirect_uris: Array.from({ length: 21 }, (_, i) => `https://a${i}.example.com/cb`),
      };
      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(/Too many redirect_uris/);
    });

    it('rejects a redirect_uri longer than 2048 characters', async () => {
      const dto = {
        ...validDto,
        redirect_uris: [`https://example.com/${'x'.repeat(2100)}`],
      };
      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(/redirect_uri exceeds/);
    });

    it('rejects registration when the gateway has reached the per-gateway client cap', async () => {
      // Simulate the cap being full by returning the limit from
      // the `count` stub.
      jest.spyOn(oauthClientRepository, 'count').mockResolvedValueOnce(500);

      await expect(
        service.registerClient('gateway-1', 'org-1', validDto),
      ).rejects.toThrow(/maximum of 500 registered OAuth clients/);
    });

    it('accepts a registration when one slot below the cap', async () => {
      jest.spyOn(oauthClientRepository, 'count').mockResolvedValueOnce(499);

      const result = await service.registerClient('gateway-1', 'org-1', validDto);
      expect(result.client_id).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // createAuthorizationCode
  // ---------------------------------------------------------------------------

  describe('createAuthorizationCode', () => {
    const validParams = {
      redirectUri: 'https://example.com/callback',
      codeChallenge: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      codeChallengeMethod: 'S256',
    };

    it('should create code and return raw code value', async () => {
      jest.spyOn(oauthClientRepository, 'findOne').mockResolvedValue(mockClient as any);

      const rawCode = await service.createAuthorizationCode(
        'mcp_client_abc123',
        'user-1',
        'gateway-1',
        'org-1',
        validParams,
      );

      expect(rawCode).toBeDefined();
      expect(typeof rawCode).toBe('string');
      expect(rawCode.length).toBeGreaterThan(0);
      expect(oauthCodeRepository.create).toHaveBeenCalled();
      expect(oauthCodeRepository.save).toHaveBeenCalled();
    });

    it('should store SHA-256 hash of the code, not the raw code', async () => {
      jest.spyOn(oauthClientRepository, 'findOne').mockResolvedValue(mockClient as any);

      const rawCode = await service.createAuthorizationCode(
        'mcp_client_abc123',
        'user-1',
        'gateway-1',
        'org-1',
        validParams,
      );

      const createCall = (oauthCodeRepository.create as jest.Mock).mock.calls[0][0];
      expect(createCall.codeHash).toBe(sha256(rawCode));
      expect(createCall.codeHash).not.toBe(rawCode);
    });

    it('should validate client exists and is active', async () => {
      jest.spyOn(oauthClientRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.createAuthorizationCode(
          'nonexistent-client',
          'user-1',
          'gateway-1',
          'org-1',
          validParams,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createAuthorizationCode(
          'nonexistent-client',
          'user-1',
          'gateway-1',
          'org-1',
          validParams,
        ),
      ).rejects.toThrow('Invalid or inactive client');
    });

    it('should reject if redirect_uri does not match registered URIs', async () => {
      jest.spyOn(oauthClientRepository, 'findOne').mockResolvedValue(mockClient as any);

      const params = {
        ...validParams,
        redirectUri: 'https://evil.com/callback',
      };

      await expect(
        service.createAuthorizationCode(
          'mcp_client_abc123',
          'user-1',
          'gateway-1',
          'org-1',
          params,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createAuthorizationCode(
          'mcp_client_abc123',
          'user-1',
          'gateway-1',
          'org-1',
          params,
        ),
      ).rejects.toThrow('redirect_uri does not match');
    });

    it('should only accept S256 code_challenge_method', async () => {
      jest.spyOn(oauthClientRepository, 'findOne').mockResolvedValue(mockClient as any);

      const params = {
        ...validParams,
        codeChallengeMethod: 'plain',
      };

      await expect(
        service.createAuthorizationCode(
          'mcp_client_abc123',
          'user-1',
          'gateway-1',
          'org-1',
          params,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createAuthorizationCode(
          'mcp_client_abc123',
          'user-1',
          'gateway-1',
          'org-1',
          params,
        ),
      ).rejects.toThrow('Only S256 code_challenge_method is supported');
    });

    it('should set 10-minute expiry', async () => {
      jest.spyOn(oauthClientRepository, 'findOne').mockResolvedValue(mockClient as any);

      const before = Date.now();
      await service.createAuthorizationCode(
        'mcp_client_abc123',
        'user-1',
        'gateway-1',
        'org-1',
        validParams,
      );
      const after = Date.now();

      const createCall = (oauthCodeRepository.create as jest.Mock).mock.calls[0][0];
      const expiresAt = createCall.expiresAt as Date;
      const tenMinutesMs = 10 * 60 * 1000;

      // expiresAt should be ~10 minutes from now
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + tenMinutesMs - 1000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(after + tenMinutesMs + 1000);
    });

    it('should store the PKCE code_challenge in the authorization code', async () => {
      jest.spyOn(oauthClientRepository, 'findOne').mockResolvedValue(mockClient as any);

      await service.createAuthorizationCode(
        'mcp_client_abc123',
        'user-1',
        'gateway-1',
        'org-1',
        validParams,
      );

      const createCall = (oauthCodeRepository.create as jest.Mock).mock.calls[0][0];
      expect(createCall.codeChallenge).toBe(validParams.codeChallenge);
      expect(createCall.codeChallengeMethod).toBe('S256');
    });

    it('should use client scope when no scope is provided', async () => {
      jest.spyOn(oauthClientRepository, 'findOne').mockResolvedValue(mockClient as any);

      await service.createAuthorizationCode(
        'mcp_client_abc123',
        'user-1',
        'gateway-1',
        'org-1',
        validParams,
      );

      const createCall = (oauthCodeRepository.create as jest.Mock).mock.calls[0][0];
      expect(createCall.scope).toBe('tools:read tools:execute');
    });

    it('should use provided scope when specified', async () => {
      jest.spyOn(oauthClientRepository, 'findOne').mockResolvedValue(mockClient as any);

      const params = {
        ...validParams,
        scope: 'tools:read',
      };

      await service.createAuthorizationCode(
        'mcp_client_abc123',
        'user-1',
        'gateway-1',
        'org-1',
        params,
      );

      const createCall = (oauthCodeRepository.create as jest.Mock).mock.calls[0][0];
      expect(createCall.scope).toBe('tools:read');
    });

    it('should set isUsed to false on new code', async () => {
      jest.spyOn(oauthClientRepository, 'findOne').mockResolvedValue(mockClient as any);

      await service.createAuthorizationCode(
        'mcp_client_abc123',
        'user-1',
        'gateway-1',
        'org-1',
        validParams,
      );

      const createCall = (oauthCodeRepository.create as jest.Mock).mock.calls[0][0];
      expect(createCall.isUsed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // exchangeCode
  // ---------------------------------------------------------------------------

  describe('exchangeCode', () => {
    // Generate a real PKCE pair for testing
    const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    const rawCode = 'test-authorization-code';
    const codeHash = sha256(rawCode);

    const mockAuthCode: Partial<OAuthAuthorizationCode> = {
      id: 'code-uuid-1',
      codeHash,
      clientId: 'mcp_client_abc123',
      userId: 'user-1',
      gatewayId: 'gateway-1',
      organizationId: 'org-1',
      redirectUri: 'https://example.com/callback',
      scope: 'tools:read tools:execute',
      codeChallenge,
      codeChallengeMethod: 'S256',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min from now
      isUsed: false,
    };

    it('should verify PKCE and return tokens', async () => {
      jest.spyOn(oauthCodeRepository, 'findOne').mockResolvedValue({ ...mockAuthCode } as any);

      const result = await service.exchangeCode(
        rawCode,
        'mcp_client_abc123',
        codeVerifier,
        'https://example.com/callback',
          'gateway-1',
      );

      expect(result.access_token).toBeDefined();
      expect(result.access_token).toMatch(/^almyty_at_/);
      expect(result.refresh_token).toBeDefined();
      expect(result.refresh_token).toMatch(/^almyty_rt_/);
      expect(result.token_type).toBe('bearer');
      expect(result.expires_in).toBe(3600);
      expect(result.scope).toBe('tools:read tools:execute');
    });

    it('should atomically mark code as used after exchange', async () => {
      const authCode = { ...mockAuthCode };
      jest.spyOn(oauthCodeRepository, 'findOne').mockResolvedValue(authCode as any);

      await service.exchangeCode(
        rawCode,
        'mcp_client_abc123',
        codeVerifier,
        'https://example.com/callback',
        'gateway-1',
      );

      // The claim is done via a conditional UPDATE with `isUsed: false`
      // in the where clause so only one concurrent caller can consume
      // a given code — a race the previous `save(authCode)` shape lost.
      expect(oauthCodeRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: authCode.id, isUsed: false }),
        expect.objectContaining({ isUsed: true }),
      );
    });

    it('rejects a second concurrent exchange that lost the race', async () => {
      jest.spyOn(oauthCodeRepository, 'findOne').mockResolvedValue({ ...mockAuthCode } as any);
      // Simulate the other racer having already consumed the code:
      // the conditional UPDATE affects zero rows.
      (oauthCodeRepository.update as jest.Mock).mockResolvedValueOnce({ affected: 0 });

      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          codeVerifier,
          'https://example.com/callback',
          'gateway-1',
        ),
      ).rejects.toThrow('already been used');
    });

    it('should reject already-used codes (replay detection)', async () => {
      const usedCode = { ...mockAuthCode, isUsed: true };
      jest.spyOn(oauthCodeRepository, 'findOne').mockResolvedValue(usedCode as any);

      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          codeVerifier,
          'https://example.com/callback',
          'gateway-1',
        ),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          codeVerifier,
          'https://example.com/callback',
          'gateway-1',
        ),
      ).rejects.toThrow('Authorization code has already been used');
    });

    it('should reject expired codes', async () => {
      const expiredCode = {
        ...mockAuthCode,
        expiresAt: new Date(Date.now() - 1000), // expired 1 second ago
      };
      jest.spyOn(oauthCodeRepository, 'findOne').mockResolvedValue(expiredCode as any);

      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          codeVerifier,
          'https://example.com/callback',
          'gateway-1',
        ),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          codeVerifier,
          'https://example.com/callback',
          'gateway-1',
        ),
      ).rejects.toThrow('Authorization code has expired');
    });

    it('should reject mismatched redirect_uri', async () => {
      jest.spyOn(oauthCodeRepository, 'findOne').mockResolvedValue({ ...mockAuthCode } as any);

      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          codeVerifier,
          'https://wrong.com/callback',
          'gateway-1',
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          codeVerifier,
          'https://wrong.com/callback',
          'gateway-1',
        ),
      ).rejects.toThrow('redirect_uri mismatch');
    });

    it('should reject invalid PKCE code_verifier', async () => {
      jest.spyOn(oauthCodeRepository, 'findOne').mockResolvedValue({ ...mockAuthCode } as any);

      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          'wrong-verifier',
          'https://example.com/callback',
          'gateway-1',
        ),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          'wrong-verifier',
          'https://example.com/callback',
          'gateway-1',
        ),
      ).rejects.toThrow('PKCE verification failed');
    });

    it('should reject non-existent authorization code', async () => {
      jest.spyOn(oauthCodeRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.exchangeCode(
          'nonexistent-code',
          'mcp_client_abc123',
          codeVerifier,
          'https://example.com/callback',
          'gateway-1',
        ),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.exchangeCode(
          'nonexistent-code',
          'mcp_client_abc123',
          codeVerifier,
          'https://example.com/callback',
          'gateway-1',
        ),
      ).rejects.toThrow('Invalid authorization code');
    });

    it('should create both access and refresh token entities', async () => {
      jest.spyOn(oauthCodeRepository, 'findOne').mockResolvedValue({ ...mockAuthCode } as any);

      await service.exchangeCode(
        rawCode,
        'mcp_client_abc123',
        codeVerifier,
        'https://example.com/callback',
          'gateway-1',
      );

      // create should be called twice: once for access token, once for refresh token
      expect(oauthTokenRepository.create).toHaveBeenCalledTimes(2);

      const calls = (oauthTokenRepository.create as jest.Mock).mock.calls;
      const tokenTypes = calls.map((c: any[]) => c[0].tokenType);
      expect(tokenTypes).toContain('access');
      expect(tokenTypes).toContain('refresh');
    });

    it('should look up code by its SHA-256 hash, scoped to the gateway', async () => {
      jest.spyOn(oauthCodeRepository, 'findOne').mockResolvedValue({ ...mockAuthCode } as any);

      await service.exchangeCode(
        rawCode,
        'mcp_client_abc123',
        codeVerifier,
        'https://example.com/callback',
        'gateway-1',
      );

      // gatewayId MUST be part of the where clause — without it a code
      // issued at /mcp/orgA/gwA could be redeemed at /mcp/orgB/gwB.
      expect(oauthCodeRepository.findOne).toHaveBeenCalledWith({
        where: { codeHash, clientId: 'mcp_client_abc123', gatewayId: 'gateway-1' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // refreshToken
  // ---------------------------------------------------------------------------

  describe('refreshToken', () => {
    const rawRefreshToken = 'almyty_rt_testrefreshtoken123';
    const tokenHash = sha256(rawRefreshToken);

    const mockRefreshToken: Partial<OAuthAccessToken> = {
      id: 'token-uuid-1',
      tokenHash,
      tokenType: 'refresh',
      clientId: 'mcp_client_abc123',
      userId: 'user-1',
      gatewayId: 'gateway-1',
      organizationId: 'org-1',
      scope: 'tools:read tools:execute',
      resource: 'https://example.com/callback',
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000), // 30 days from now
      isRevoked: false,
    };

    it('should atomically rotate the old refresh token and generate a new token pair', async () => {
      const existingToken = { ...mockRefreshToken };
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(existingToken as any);

      const result = await service.refreshToken(rawRefreshToken, 'mcp_client_abc123', 'gateway-1');

      // Rotation is now a conditional UPDATE rather than a read-modify-
      // save, so we can't race ourselves into two valid rotations from
      // a single stolen refresh token.
      expect(oauthTokenRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: existingToken.id, isRevoked: false }),
        expect.objectContaining({ isRevoked: true }),
      );

      // New tokens should be generated
      expect(result.access_token).toBeDefined();
      expect(result.access_token).toMatch(/^almyty_at_/);
      expect(result.refresh_token).toBeDefined();
      expect(result.refresh_token).toMatch(/^almyty_rt_/);
      expect(result.token_type).toBe('bearer');
      expect(result.expires_in).toBe(3600);
    });

    it('should reject revoked refresh tokens', async () => {
      const revokedToken = { ...mockRefreshToken, isRevoked: true };
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(revokedToken as any);

      await expect(
        service.refreshToken(rawRefreshToken, 'mcp_client_abc123', 'gateway-1'),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.refreshToken(rawRefreshToken, 'mcp_client_abc123', 'gateway-1'),
      ).rejects.toThrow('Refresh token has been revoked');
    });

    it('should reject expired refresh tokens', async () => {
      const expiredToken = {
        ...mockRefreshToken,
        expiresAt: new Date(Date.now() - 1000),
      };
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(expiredToken as any);

      await expect(
        service.refreshToken(rawRefreshToken, 'mcp_client_abc123', 'gateway-1'),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.refreshToken(rawRefreshToken, 'mcp_client_abc123', 'gateway-1'),
      ).rejects.toThrow('Refresh token has expired');
    });

    it('should reject non-existent refresh tokens', async () => {
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.refreshToken('nonexistent-token', 'mcp_client_abc123', 'gateway-1'),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.refreshToken('nonexistent-token', 'mcp_client_abc123', 'gateway-1'),
      ).rejects.toThrow('Invalid refresh token');
    });

    it('should look up refresh token by hash, clientId, gatewayId, and type', async () => {
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue({ ...mockRefreshToken } as any);

      await service.refreshToken(rawRefreshToken, 'mcp_client_abc123', 'gateway-1');

      expect(oauthTokenRepository.findOne).toHaveBeenCalledWith({
        where: {
          tokenHash,
          clientId: 'mcp_client_abc123',
          gatewayId: 'gateway-1',
          tokenType: 'refresh',
        },
      });
    });

    it('should preserve scope and resource from old token in new pair', async () => {
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue({ ...mockRefreshToken } as any);

      const result = await service.refreshToken(rawRefreshToken, 'mcp_client_abc123', 'gateway-1');

      expect(result.scope).toBe('tools:read tools:execute');
    });
  });

  // ---------------------------------------------------------------------------
  // validateAccessToken
  // ---------------------------------------------------------------------------

  describe('validateAccessToken', () => {
    const rawAccessToken = 'almyty_at_testaccesstoken123';
    const tokenHash = sha256(rawAccessToken);

    const mockAccessToken: Partial<OAuthAccessToken> = {
      id: 'token-uuid-2',
      tokenHash,
      tokenType: 'access',
      clientId: 'mcp_client_abc123',
      userId: 'user-1',
      gatewayId: 'gateway-1',
      organizationId: 'org-1',
      scope: 'tools:read tools:execute',
      expiresAt: new Date(Date.now() + 3600 * 1000), // 1 hour from now
      isRevoked: false,
    };

    it('should return valid=true for valid token', async () => {
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(mockAccessToken as any);

      const result = await service.validateAccessToken(rawAccessToken);

      expect(result.valid).toBe(true);
      expect(result.clientId).toBe('mcp_client_abc123');
      expect(result.userId).toBe('user-1');
      expect(result.gatewayId).toBe('gateway-1');
      expect(result.organizationId).toBe('org-1');
      expect(result.scope).toBe('tools:read tools:execute');
    });

    it('should return valid=false for expired token', async () => {
      const expiredToken = {
        ...mockAccessToken,
        expiresAt: new Date(Date.now() - 1000),
      };
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(expiredToken as any);

      const result = await service.validateAccessToken(rawAccessToken);

      expect(result.valid).toBe(false);
      expect(result.clientId).toBeUndefined();
      expect(result.userId).toBeUndefined();
    });

    it('should return valid=false for revoked token', async () => {
      const revokedToken = { ...mockAccessToken, isRevoked: true };
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(revokedToken as any);

      const result = await service.validateAccessToken(rawAccessToken);

      expect(result.valid).toBe(false);
    });

    it('should return valid=false for non-existent token', async () => {
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(null);

      const result = await service.validateAccessToken('nonexistent-token');

      expect(result.valid).toBe(false);
    });

    it('should look up token by SHA-256 hash with tokenType access', async () => {
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(mockAccessToken as any);

      await service.validateAccessToken(rawAccessToken);

      expect(oauthTokenRepository.findOne).toHaveBeenCalledWith({
        where: { tokenHash, tokenType: 'access' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // revokeToken
  // ---------------------------------------------------------------------------

  describe('revokeToken', () => {
    const rawToken = 'almyty_at_sometokenvalue';
    const tokenHash = sha256(rawToken);

    const mockAccessTokenForRevoke: Partial<OAuthAccessToken> = {
      id: 'token-uuid-3',
      tokenHash,
      tokenType: 'access',
      clientId: 'mcp_client_abc123',
      userId: 'user-1',
      gatewayId: 'gateway-1',
      organizationId: 'org-1',
      isRevoked: false,
    };

    it('should revoke access tokens', async () => {
      const token = { ...mockAccessTokenForRevoke };
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(token as any);

      await service.revokeToken(rawToken, 'mcp_client_abc123', 'gateway-1');

      expect(token.isRevoked).toBe(true);
      expect(oauthTokenRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ isRevoked: true }),
      );
    });

    it('should cascade revoke: revoking refresh token also revokes associated access tokens', async () => {
      const refreshToken = {
        ...mockAccessTokenForRevoke,
        tokenType: 'refresh' as const,
      };
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(refreshToken as any);

      await service.revokeToken(rawToken, 'mcp_client_abc123', 'gateway-1');

      // The refresh token itself should be revoked
      expect(refreshToken.isRevoked).toBe(true);
      expect(oauthTokenRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ isRevoked: true, tokenType: 'refresh' }),
      );

      // Associated access tokens should also be revoked via bulk update
      expect(oauthTokenRepository.update).toHaveBeenCalledWith(
        {
          clientId: 'mcp_client_abc123',
          userId: 'user-1',
          gatewayId: 'gateway-1',
          tokenType: 'access',
          isRevoked: false,
        },
        { isRevoked: true },
      );
    });

    it('should not cascade when revoking an access token', async () => {
      const accessToken = { ...mockAccessTokenForRevoke, tokenType: 'access' as const };
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(accessToken as any);

      await service.revokeToken(rawToken, 'mcp_client_abc123', 'gateway-1');

      expect(oauthTokenRepository.update).not.toHaveBeenCalled();
    });

    it('should return silently for non-existent tokens (RFC 7009)', async () => {
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(null);

      // Should not throw
      await expect(
        service.revokeToken('nonexistent-token', 'mcp_client_abc123', 'gateway-1'),
      ).resolves.toBeUndefined();

      // save should not be called
      expect(oauthTokenRepository.save).not.toHaveBeenCalled();
    });

    it("silently ignores tokens that don't belong to the presented client (via findOne where clause)", async () => {
      // The old shape did `findOne({ where: { tokenHash } })` and then
      // threw BadRequest when the loaded token's clientId didn't match.
      // That leaked a cross-client existence oracle: a caller could tell
      // whether a random token hash belonged to client X by checking
      // whether they got 400 ("wrong client") vs 200 (no-op). Now the
      // clientId is part of the where clause, so a token belonging to a
      // different client simply isn't found and the handler returns 200
      // per RFC 7009.
      const token = { ...mockAccessTokenForRevoke, clientId: 'mcp_client_other' };
      // Since the where clause now scopes to clientId+gatewayId, the
      // service.findOne call wouldn't actually match this token in real
      // DB. Simulate that by returning null.
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.revokeToken(rawToken, 'mcp_client_abc123', 'gateway-1'),
      ).resolves.toBeUndefined();
      expect(oauthTokenRepository.save).not.toHaveBeenCalled();
    });

    it('scopes the token lookup by hash + clientId + gatewayId', async () => {
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(null);

      await service.revokeToken(rawToken, 'mcp_client_abc123', 'gateway-1');

      expect(oauthTokenRepository.findOne).toHaveBeenCalledWith({
        where: {
          tokenHash,
          clientId: 'mcp_client_abc123',
          gatewayId: 'gateway-1',
        },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // generateTokenPair (internal helper, tested via public methods but also directly)
  // ---------------------------------------------------------------------------

  describe('generateTokenPair', () => {
    it('should generate access and refresh tokens with correct prefixes', async () => {
      const result = await service.generateTokenPair(
        'mcp_client_abc123',
        'gateway-1',
        'org-1',
        'user-1',
        'tools:read',
      );

      expect(result.access_token).toMatch(/^almyty_at_/);
      expect(result.refresh_token).toMatch(/^almyty_rt_/);
      expect(result.token_type).toBe('bearer');
      expect(result.expires_in).toBe(3600);
      expect(result.scope).toBe('tools:read');
    });

    it('should store hashed tokens, not raw tokens', async () => {
      const result = await service.generateTokenPair(
        'mcp_client_abc123',
        'gateway-1',
        'org-1',
        'user-1',
        'tools:read',
      );

      const createCalls = (oauthTokenRepository.create as jest.Mock).mock.calls;
      for (const call of createCalls) {
        const entity = call[0];
        // Token hash should not equal the raw token
        expect(entity.tokenHash).not.toBe(result.access_token);
        expect(entity.tokenHash).not.toBe(result.refresh_token);
        // Should be a valid SHA-256 hex hash
        expect(entity.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      }
    });

    it('should set correct expiry for access token (1 hour)', async () => {
      const before = Date.now();
      await service.generateTokenPair(
        'mcp_client_abc123',
        'gateway-1',
        'org-1',
        'user-1',
        'tools:read',
      );
      const after = Date.now();

      const createCalls = (oauthTokenRepository.create as jest.Mock).mock.calls;
      const accessCall = createCalls.find((c: any[]) => c[0].tokenType === 'access');
      const expiresAt = accessCall[0].expiresAt as Date;

      const oneHourMs = 3600 * 1000;
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + oneHourMs - 1000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(after + oneHourMs + 1000);
    });

    it('should set correct expiry for refresh token (30 days)', async () => {
      const before = Date.now();
      await service.generateTokenPair(
        'mcp_client_abc123',
        'gateway-1',
        'org-1',
        'user-1',
        'tools:read',
      );
      const after = Date.now();

      const createCalls = (oauthTokenRepository.create as jest.Mock).mock.calls;
      const refreshCall = createCalls.find((c: any[]) => c[0].tokenType === 'refresh');
      const expiresAt = refreshCall[0].expiresAt as Date;

      const thirtyDaysMs = 30 * 24 * 3600 * 1000;
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + thirtyDaysMs - 1000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
    });

    it('should save both tokens in a single save call', async () => {
      await service.generateTokenPair(
        'mcp_client_abc123',
        'gateway-1',
        'org-1',
        'user-1',
        'tools:read',
      );

      // The service saves both tokens as an array in one call
      const saveCalls = (oauthTokenRepository.save as jest.Mock).mock.calls;
      const arrayCall = saveCalls.find((c: any[]) => Array.isArray(c[0]));
      expect(arrayCall).toBeDefined();
      expect(arrayCall[0]).toHaveLength(2);
    });

    it('should set isRevoked to false on new tokens', async () => {
      await service.generateTokenPair(
        'mcp_client_abc123',
        'gateway-1',
        'org-1',
        'user-1',
        'tools:read',
      );

      const createCalls = (oauthTokenRepository.create as jest.Mock).mock.calls;
      for (const call of createCalls) {
        expect(call[0].isRevoked).toBe(false);
      }
    });

    it('should handle null resource gracefully', async () => {
      await service.generateTokenPair(
        'mcp_client_abc123',
        'gateway-1',
        'org-1',
        'user-1',
        'tools:read',
        undefined,
      );

      const createCalls = (oauthTokenRepository.create as jest.Mock).mock.calls;
      for (const call of createCalls) {
        expect(call[0].resource).toBeNull();
      }
    });
  });

  // ─── Regression: confidential client secret enforcement ───────────
  describe('confidential client secret enforcement (regression)', () => {
    // Helper: a confidential client with a known secret + its hash.
    const knownSecret = 'super-secret-value';
    const secretHash = crypto.createHash('sha256').update(knownSecret).digest('hex');
    const confidentialClient: Partial<OAuthClient> = {
      ...mockClient,
      tokenEndpointAuthMethod: 'client_secret_post',
      clientSecretHash: secretHash,
    };

    const rawCode = 'auth-code-confidential';
    const codeVerifier = 'verifier-for-confidential';
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const mockAuthCode: Partial<OAuthAuthorizationCode> = {
      id: 'code-uuid-confidential',
      codeHash: sha256(rawCode),
      clientId: 'mcp_client_abc123',
      userId: 'user-1',
      gatewayId: 'gateway-1',
      organizationId: 'org-1',
      redirectUri: 'https://example.com/callback',
      scope: 'tools:read',
      codeChallenge,
      codeChallengeMethod: 'S256',
      expiresAt: new Date(Date.now() + 600_000),
      isUsed: false,
    };

    beforeEach(() => {
      // Override the default public client for this describe block.
      (oauthClientRepository.findOne as jest.Mock).mockResolvedValue(
        confidentialClient as any,
      );
      (oauthCodeRepository.findOne as jest.Mock).mockResolvedValue({ ...mockAuthCode } as any);
    });

    it('rejects exchangeCode when no client_secret is presented', async () => {
      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          codeVerifier,
          'https://example.com/callback',
          'gateway-1',
          /* clientSecret */ undefined,
        ),
      ).rejects.toThrow('client_secret is required');
    });

    it('rejects exchangeCode when the presented secret is wrong', async () => {
      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          codeVerifier,
          'https://example.com/callback',
          'gateway-1',
          'wrong-secret',
        ),
      ).rejects.toThrow('Invalid client_secret');
    });

    it('accepts exchangeCode when the presented secret matches', async () => {
      const result = await service.exchangeCode(
        rawCode,
        'mcp_client_abc123',
        codeVerifier,
        'https://example.com/callback',
        'gateway-1',
        knownSecret,
      );
      expect(result.access_token).toMatch(/^almyty_at_/);
    });

    it('rejects a public-client call that includes a client_secret', async () => {
      // Flip back to the public client for this test.
      (oauthClientRepository.findOne as jest.Mock).mockResolvedValueOnce(
        mockClient as any,
      );

      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          codeVerifier,
          'https://example.com/callback',
          'gateway-1',
          'some-secret',
        ),
      ).rejects.toThrow('must not be presented');
    });
  });

  // ─── Regression: cross-gateway replay ─────────────────────────────
  describe('cross-gateway scoping (regression)', () => {
    it('refuses to load a code with a findOne call that omits gatewayId', async () => {
      // Set findOne to return a code bound to gateway-1 regardless of
      // query. The service is responsible for passing gatewayId in the
      // where clause — if it does, we can assert on the call.
      const rawCode = 'cross-gateway-code';
      (oauthCodeRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'code-cg',
        codeHash: sha256(rawCode),
        clientId: 'mcp_client_abc123',
        userId: 'user-1',
        gatewayId: 'gateway-1',
        organizationId: 'org-1',
        redirectUri: 'https://example.com/callback',
        scope: 'tools:read',
        codeChallenge: crypto.createHash('sha256').update('verifier').digest('base64url'),
        codeChallengeMethod: 'S256',
        expiresAt: new Date(Date.now() + 600_000),
        isUsed: false,
      });

      await service.exchangeCode(
        rawCode,
        'mcp_client_abc123',
        'verifier',
        'https://example.com/callback',
        'gateway-1',
      );

      expect(oauthCodeRepository.findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({ gatewayId: 'gateway-1' }),
      });
    });
  });

  // ─── Regression: refresh token lineage revocation ────────────────
  describe('refresh token lineage (regression)', () => {
    it('revokes the entire token lineage when a rotated refresh token is reused', async () => {
      const rawRt = 'almyty_rt_rotated';
      const revokedExisting = {
        id: 'token-rotated',
        tokenHash: sha256(rawRt),
        tokenType: 'refresh',
        clientId: 'mcp_client_abc123',
        userId: 'user-1',
        gatewayId: 'gateway-1',
        organizationId: 'org-1',
        scope: 'tools:read',
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        isRevoked: true,
      };
      (oauthTokenRepository.findOne as jest.Mock).mockResolvedValue(revokedExisting);

      await expect(
        service.refreshToken(rawRt, 'mcp_client_abc123', 'gateway-1'),
      ).rejects.toThrow('has been revoked');

      // The critical bit: the whole chain for this (client, user, gateway)
      // must be revoked, not just the one presented token.
      expect(oauthTokenRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'mcp_client_abc123',
          userId: 'user-1',
          gatewayId: 'gateway-1',
          isRevoked: false,
        }),
        { isRevoked: true },
      );
    });

    it('links the new refresh token to the old one via parentTokenId', async () => {
      const rawRt = 'almyty_rt_current';
      const existing = {
        id: 'token-current',
        tokenHash: sha256(rawRt),
        tokenType: 'refresh',
        clientId: 'mcp_client_abc123',
        userId: 'user-1',
        gatewayId: 'gateway-1',
        organizationId: 'org-1',
        scope: 'tools:read',
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        isRevoked: false,
      };
      (oauthTokenRepository.findOne as jest.Mock).mockResolvedValue(existing);

      await service.refreshToken(rawRt, 'mcp_client_abc123', 'gateway-1');

      const createCalls = (oauthTokenRepository.create as jest.Mock).mock.calls;
      // Both the new access + refresh should carry the old token's id.
      for (const call of createCalls) {
        expect(call[0].parentTokenId).toBe('token-current');
      }
    });
  });
});
