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
          },
        },
        {
          provide: getRepositoryToken(OAuthAuthorizationCode),
          useValue: {
            create: jest.fn().mockImplementation((data) => ({ ...data })),
            save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
            findOne: jest.fn(),
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
          'http://example.com/bad', // non-HTTPS, non-localhost
        ],
      };

      await expect(
        service.registerClient('gateway-1', 'org-1', dto),
      ).rejects.toThrow(BadRequestException);
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
      );

      expect(result.access_token).toBeDefined();
      expect(result.access_token).toMatch(/^almyty_at_/);
      expect(result.refresh_token).toBeDefined();
      expect(result.refresh_token).toMatch(/^almyty_rt_/);
      expect(result.token_type).toBe('bearer');
      expect(result.expires_in).toBe(3600);
      expect(result.scope).toBe('tools:read tools:execute');
    });

    it('should mark code as used after exchange', async () => {
      const authCode = { ...mockAuthCode };
      jest.spyOn(oauthCodeRepository, 'findOne').mockResolvedValue(authCode as any);

      await service.exchangeCode(
        rawCode,
        'mcp_client_abc123',
        codeVerifier,
        'https://example.com/callback',
      );

      expect(authCode.isUsed).toBe(true);
      expect(oauthCodeRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ isUsed: true }),
      );
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
        ),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          codeVerifier,
          'https://example.com/callback',
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
        ),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          codeVerifier,
          'https://example.com/callback',
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
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          codeVerifier,
          'https://wrong.com/callback',
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
        ),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.exchangeCode(
          rawCode,
          'mcp_client_abc123',
          'wrong-verifier',
          'https://example.com/callback',
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
        ),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.exchangeCode(
          'nonexistent-code',
          'mcp_client_abc123',
          codeVerifier,
          'https://example.com/callback',
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
      );

      // create should be called twice: once for access token, once for refresh token
      expect(oauthTokenRepository.create).toHaveBeenCalledTimes(2);

      const calls = (oauthTokenRepository.create as jest.Mock).mock.calls;
      const tokenTypes = calls.map((c: any[]) => c[0].tokenType);
      expect(tokenTypes).toContain('access');
      expect(tokenTypes).toContain('refresh');
    });

    it('should look up code by its SHA-256 hash', async () => {
      jest.spyOn(oauthCodeRepository, 'findOne').mockResolvedValue({ ...mockAuthCode } as any);

      await service.exchangeCode(
        rawCode,
        'mcp_client_abc123',
        codeVerifier,
        'https://example.com/callback',
      );

      expect(oauthCodeRepository.findOne).toHaveBeenCalledWith({
        where: { codeHash, clientId: 'mcp_client_abc123' },
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

    it('should revoke old refresh token (rotation) and generate new token pair', async () => {
      const existingToken = { ...mockRefreshToken };
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(existingToken as any);

      const result = await service.refreshToken(rawRefreshToken, 'mcp_client_abc123');

      // Old token should be revoked
      expect(existingToken.isRevoked).toBe(true);
      expect(oauthTokenRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ isRevoked: true, tokenType: 'refresh' }),
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
        service.refreshToken(rawRefreshToken, 'mcp_client_abc123'),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.refreshToken(rawRefreshToken, 'mcp_client_abc123'),
      ).rejects.toThrow('Refresh token has been revoked');
    });

    it('should reject expired refresh tokens', async () => {
      const expiredToken = {
        ...mockRefreshToken,
        expiresAt: new Date(Date.now() - 1000),
      };
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(expiredToken as any);

      await expect(
        service.refreshToken(rawRefreshToken, 'mcp_client_abc123'),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.refreshToken(rawRefreshToken, 'mcp_client_abc123'),
      ).rejects.toThrow('Refresh token has expired');
    });

    it('should reject non-existent refresh tokens', async () => {
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.refreshToken('nonexistent-token', 'mcp_client_abc123'),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.refreshToken('nonexistent-token', 'mcp_client_abc123'),
      ).rejects.toThrow('Invalid refresh token');
    });

    it('should look up refresh token by hash and clientId', async () => {
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue({ ...mockRefreshToken } as any);

      await service.refreshToken(rawRefreshToken, 'mcp_client_abc123');

      expect(oauthTokenRepository.findOne).toHaveBeenCalledWith({
        where: {
          tokenHash,
          clientId: 'mcp_client_abc123',
          tokenType: 'refresh',
        },
      });
    });

    it('should preserve scope and resource from old token in new pair', async () => {
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue({ ...mockRefreshToken } as any);

      const result = await service.refreshToken(rawRefreshToken, 'mcp_client_abc123');

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

      await service.revokeToken(rawToken, 'mcp_client_abc123');

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

      await service.revokeToken(rawToken, 'mcp_client_abc123');

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

      await service.revokeToken(rawToken, 'mcp_client_abc123');

      expect(oauthTokenRepository.update).not.toHaveBeenCalled();
    });

    it('should return silently for non-existent tokens (RFC 7009)', async () => {
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(null);

      // Should not throw
      await expect(
        service.revokeToken('nonexistent-token', 'mcp_client_abc123'),
      ).resolves.toBeUndefined();

      // save should not be called
      expect(oauthTokenRepository.save).not.toHaveBeenCalled();
    });

    it('should reject token belonging to different client', async () => {
      const token = { ...mockAccessTokenForRevoke, clientId: 'mcp_client_other' };
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(token as any);

      await expect(
        service.revokeToken(rawToken, 'mcp_client_abc123'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.revokeToken(rawToken, 'mcp_client_abc123'),
      ).rejects.toThrow('Token does not belong to this client');
    });

    it('should look up token by hash without filtering by clientId', async () => {
      jest.spyOn(oauthTokenRepository, 'findOne').mockResolvedValue(null);

      await service.revokeToken(rawToken, 'mcp_client_abc123');

      expect(oauthTokenRepository.findOne).toHaveBeenCalledWith({
        where: { tokenHash },
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
});
