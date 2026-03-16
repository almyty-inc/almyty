import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpException, HttpStatus } from '@nestjs/common';

import { McpOAuthController } from '../controllers/mcp-oauth.controller';
import { McpOAuthService } from '../services/mcp-oauth.service';
import { Gateway, GatewayStatus } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';

describe('McpOAuthController', () => {
  let controller: McpOAuthController;
  let gatewayRepository: Repository<Gateway>;
  let organizationRepository: Repository<Organization>;
  let mcpOAuthService: McpOAuthService;

  const mockOrganization = {
    id: 'org-uuid-1234',
    name: 'Test Org',
    slug: 'test-org',
  } as Organization;

  const mockGateway = {
    id: 'gateway-uuid-1234',
    name: 'Test Gateway',
    endpoint: '/test-gateway',
    organizationId: 'org-uuid-1234',
    status: GatewayStatus.ACTIVE,
    organization: mockOrganization,
    configuration: {},
  } as unknown as Gateway;

  const orgSlug = 'test-org';
  const gatewaySlug = 'test-gateway';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpOAuthController],
      providers: [
        {
          provide: getRepositoryToken(Gateway),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
          },
        },
        {
          provide: McpOAuthService,
          useValue: {
            createAuthorizationCode: jest.fn(),
            exchangeCode: jest.fn(),
            refreshToken: jest.fn(),
            registerClient: jest.fn(),
            revokeToken: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<McpOAuthController>(McpOAuthController);
    gatewayRepository = module.get(getRepositoryToken(Gateway));
    organizationRepository = module.get(getRepositoryToken(Organization));
    mcpOAuthService = module.get<McpOAuthService>(McpOAuthService);

    // Default: resolveOrg and resolveGateway succeed
    jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(mockOrganization);
    jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(mockGateway as any);

    // Set a known BASE_URL for deterministic assertions
    process.env.BASE_URL = 'http://localhost:4000';
    process.env.FRONTEND_URL = 'http://localhost:3002';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Helpers — resolveOrg / resolveGateway
  // ---------------------------------------------------------------------------

  describe('org/gateway resolution', () => {
    it('should throw 404 when organization not found by slug', async () => {
      jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(null);
      jest.spyOn(organizationRepository, 'find').mockResolvedValue([]);

      await expect(
        controller.getAuthorizationServerMetadata('nonexistent', gatewaySlug),
      ).rejects.toThrow(
        new HttpException('Organization not found: nonexistent', HttpStatus.NOT_FOUND),
      );
    });

    it('should resolve organization by UUID', async () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(mockOrganization);

      const result = await controller.getAuthorizationServerMetadata(uuid, gatewaySlug);

      expect(organizationRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: uuid } }),
      );
      expect(result).toBeDefined();
    });

    it('should fall back to name-derived slug when exact slug not found', async () => {
      jest
        .spyOn(organizationRepository, 'findOne')
        .mockResolvedValueOnce(null) // slug lookup returns null
        .mockResolvedValue(mockGateway as any); // gateway lookup still works
      jest
        .spyOn(organizationRepository, 'find')
        .mockResolvedValue([mockOrganization]);

      const result = await controller.getAuthorizationServerMetadata(orgSlug, gatewaySlug);

      expect(result).toBeDefined();
    });

    it('should throw 404 when gateway not found', async () => {
      jest.spyOn(gatewayRepository, 'findOne').mockResolvedValue(null);

      await expect(
        controller.getAuthorizationServerMetadata(orgSlug, gatewaySlug),
      ).rejects.toThrow(
        new HttpException(`Gateway not found: ${gatewaySlug}`, HttpStatus.NOT_FOUND),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 1. Authorization Server Metadata (RFC 8414)
  // ---------------------------------------------------------------------------

  describe('getAuthorizationServerMetadata', () => {
    it('should return correct metadata structure', async () => {
      const result = await controller.getAuthorizationServerMetadata(orgSlug, gatewaySlug);

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    it('should contain required fields', async () => {
      const result = await controller.getAuthorizationServerMetadata(orgSlug, gatewaySlug);

      expect(result).toHaveProperty('issuer');
      expect(result).toHaveProperty('authorization_endpoint');
      expect(result).toHaveProperty('token_endpoint');
      expect(result).toHaveProperty('registration_endpoint');
      expect(result).toHaveProperty('revocation_endpoint');
      expect(result).toHaveProperty('response_types_supported');
      expect(result).toHaveProperty('grant_types_supported');
      expect(result).toHaveProperty('code_challenge_methods_supported');
      expect(result).toHaveProperty('token_endpoint_auth_methods_supported');
      expect(result).toHaveProperty('scopes_supported');
      expect(result).toHaveProperty('service_documentation');
    });

    it('should have correct issuer based on base URL and path segments', async () => {
      const result = await controller.getAuthorizationServerMetadata(orgSlug, gatewaySlug);

      expect(result.issuer).toBe(`http://localhost:4000/mcp/${orgSlug}/${gatewaySlug}`);
    });

    it('should have correct endpoint URLs', async () => {
      const result = await controller.getAuthorizationServerMetadata(orgSlug, gatewaySlug);
      const prefix = `http://localhost:4000/mcp/${orgSlug}/${gatewaySlug}`;

      expect(result.authorization_endpoint).toBe(`${prefix}/authorize`);
      expect(result.token_endpoint).toBe(`${prefix}/token`);
      expect(result.registration_endpoint).toBe(`${prefix}/register`);
      expect(result.revocation_endpoint).toBe(`${prefix}/revoke`);
    });

    it('should include only S256 in code_challenge_methods_supported', async () => {
      const result = await controller.getAuthorizationServerMetadata(orgSlug, gatewaySlug);

      expect(result.code_challenge_methods_supported).toEqual(['S256']);
    });

    it('should include only "code" in response_types_supported', async () => {
      const result = await controller.getAuthorizationServerMetadata(orgSlug, gatewaySlug);

      expect(result.response_types_supported).toEqual(['code']);
    });

    it('should support authorization_code and refresh_token grant types', async () => {
      const result = await controller.getAuthorizationServerMetadata(orgSlug, gatewaySlug);

      expect(result.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    });

    it('should support "none" and "client_secret_post" auth methods', async () => {
      const result = await controller.getAuthorizationServerMetadata(orgSlug, gatewaySlug);

      expect(result.token_endpoint_auth_methods_supported).toEqual([
        'none',
        'client_secret_post',
      ]);
    });

    it('should include MCP scopes', async () => {
      const result = await controller.getAuthorizationServerMetadata(orgSlug, gatewaySlug);

      expect(result.scopes_supported).toContain('mcp:tools');
      expect(result.scopes_supported).toContain('mcp:resources');
      expect(result.scopes_supported).toContain('mcp:prompts');
      expect(result.scopes_supported).toContain('mcp:*');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Protected Resource Metadata (RFC 9728)
  // ---------------------------------------------------------------------------

  describe('getProtectedResourceMetadata', () => {
    it('should return correct metadata structure', async () => {
      const result = await controller.getProtectedResourceMetadata(orgSlug, gatewaySlug);

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    it('should contain resource URL', async () => {
      const result = await controller.getProtectedResourceMetadata(orgSlug, gatewaySlug);

      expect(result).toHaveProperty('resource');
      expect(result.resource).toBe(`http://localhost:4000/mcp/${orgSlug}/${gatewaySlug}`);
    });

    it('should contain authorization_servers array', async () => {
      const result = await controller.getProtectedResourceMetadata(orgSlug, gatewaySlug);

      expect(result).toHaveProperty('authorization_servers');
      expect(Array.isArray(result.authorization_servers)).toBe(true);
      expect(result.authorization_servers.length).toBeGreaterThan(0);
    });

    it('should have authorization_servers referencing the same gateway prefix', async () => {
      const result = await controller.getProtectedResourceMetadata(orgSlug, gatewaySlug);
      const prefix = `http://localhost:4000/mcp/${orgSlug}/${gatewaySlug}`;

      expect(result.authorization_servers).toContain(prefix);
    });

    it('should contain scopes_supported', async () => {
      const result = await controller.getProtectedResourceMetadata(orgSlug, gatewaySlug);

      expect(result).toHaveProperty('scopes_supported');
      expect(Array.isArray(result.scopes_supported)).toBe(true);
    });

    it('should contain bearer_methods_supported with header', async () => {
      const result = await controller.getProtectedResourceMetadata(orgSlug, gatewaySlug);

      expect(result).toHaveProperty('bearer_methods_supported');
      expect(result.bearer_methods_supported).toContain('header');
    });

    it('should contain resource_name matching gateway name', async () => {
      const result = await controller.getProtectedResourceMetadata(orgSlug, gatewaySlug);

      expect(result).toHaveProperty('resource_name');
      expect(result.resource_name).toBe(mockGateway.name);
    });

    it('should contain resource_documentation', async () => {
      const result = await controller.getProtectedResourceMetadata(orgSlug, gatewaySlug);

      expect(result).toHaveProperty('resource_documentation');
      expect(result.resource_documentation).toBe('http://localhost:4000/docs');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Dynamic Client Registration (RFC 7591)
  // ---------------------------------------------------------------------------

  describe('register', () => {
    const mockRes = () => {
      const res: any = {};
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);
      return res;
    };

    it('should successfully register a public client', async () => {
      const res = mockRes();
      const registrationResponse = {
        client_id: 'mcp_client_abc123',
        client_name: 'Test Client',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'tools:read tools:execute',
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };

      jest.spyOn(mcpOAuthService, 'registerClient').mockResolvedValue(registrationResponse);

      await controller.register(
        orgSlug,
        gatewaySlug,
        {
          client_name: 'Test Client',
          redirect_uris: ['https://example.com/callback'],
        },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(HttpStatus.CREATED);
      expect(res.json).toHaveBeenCalledWith(registrationResponse);
    });

    it('should return client_id and client_id_issued_at in response', async () => {
      const res = mockRes();
      const registrationResponse = {
        client_id: 'mcp_client_abc123',
        client_name: 'Test Client',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'tools:read tools:execute',
        client_id_issued_at: 1710000000,
      };

      jest.spyOn(mcpOAuthService, 'registerClient').mockResolvedValue(registrationResponse);

      await controller.register(
        orgSlug,
        gatewaySlug,
        {
          client_name: 'Test Client',
          redirect_uris: ['https://example.com/callback'],
        },
        res,
      );

      const jsonArg = res.json.mock.calls[0][0];
      expect(jsonArg).toHaveProperty('client_id');
      expect(jsonArg).toHaveProperty('client_id_issued_at');
      expect(typeof jsonArg.client_id_issued_at).toBe('number');
    });

    it('should reject missing client_name', async () => {
      const res = mockRes();

      await expect(
        controller.register(
          orgSlug,
          gatewaySlug,
          {
            client_name: '',
            redirect_uris: ['https://example.com/callback'],
          },
          res,
        ),
      ).rejects.toThrow(HttpException);

      try {
        await controller.register(
          orgSlug,
          gatewaySlug,
          {
            client_name: '',
            redirect_uris: ['https://example.com/callback'],
          },
          res,
        );
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
        const response = (e as HttpException).getResponse() as any;
        expect(response.error).toBe('invalid_client_metadata');
      }
    });

    it('should reject missing redirect_uris', async () => {
      const res = mockRes();

      await expect(
        controller.register(
          orgSlug,
          gatewaySlug,
          {
            client_name: 'Test Client',
            redirect_uris: [],
          },
          res,
        ),
      ).rejects.toThrow(HttpException);

      try {
        await controller.register(
          orgSlug,
          gatewaySlug,
          {
            client_name: 'Test Client',
            redirect_uris: [],
          },
          res,
        );
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      }
    });

    it('should reject non-HTTPS redirect_uris (except localhost)', async () => {
      const res = mockRes();

      await expect(
        controller.register(
          orgSlug,
          gatewaySlug,
          {
            client_name: 'Test Client',
            redirect_uris: ['http://example.com/callback'],
          },
          res,
        ),
      ).rejects.toThrow(HttpException);

      try {
        await controller.register(
          orgSlug,
          gatewaySlug,
          {
            client_name: 'Test Client',
            redirect_uris: ['http://example.com/callback'],
          },
          res,
        );
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
        const response = (e as HttpException).getResponse() as any;
        expect(response.error).toBe('invalid_client_metadata');
        expect(response.error_description).toContain('HTTPS');
      }
    });

    it('should allow http://localhost redirect_uris', async () => {
      const res = mockRes();
      const registrationResponse = {
        client_id: 'mcp_client_abc123',
        client_name: 'Dev Client',
        redirect_uris: ['http://localhost:3000/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'tools:read tools:execute',
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };

      jest.spyOn(mcpOAuthService, 'registerClient').mockResolvedValue(registrationResponse);

      await controller.register(
        orgSlug,
        gatewaySlug,
        {
          client_name: 'Dev Client',
          redirect_uris: ['http://localhost:3000/callback'],
        },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(HttpStatus.CREATED);
    });

    it('should allow http://127.0.0.1 redirect_uris', async () => {
      const res = mockRes();
      const registrationResponse = {
        client_id: 'mcp_client_abc123',
        client_name: 'Dev Client',
        redirect_uris: ['http://127.0.0.1:8080/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'tools:read tools:execute',
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };

      jest.spyOn(mcpOAuthService, 'registerClient').mockResolvedValue(registrationResponse);

      await controller.register(
        orgSlug,
        gatewaySlug,
        {
          client_name: 'Dev Client',
          redirect_uris: ['http://127.0.0.1:8080/callback'],
        },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(HttpStatus.CREATED);
    });

    it('should allow http://[::1] redirect_uris', async () => {
      const res = mockRes();
      const registrationResponse = {
        client_id: 'mcp_client_abc123',
        client_name: 'Dev Client',
        redirect_uris: ['http://[::1]:8080/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'tools:read tools:execute',
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };

      jest.spyOn(mcpOAuthService, 'registerClient').mockResolvedValue(registrationResponse);

      await controller.register(
        orgSlug,
        gatewaySlug,
        {
          client_name: 'Dev Client',
          redirect_uris: ['http://[::1]:8080/callback'],
        },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(HttpStatus.CREATED);
    });

    it('should reject invalid redirect_uri format', async () => {
      const res = mockRes();

      await expect(
        controller.register(
          orgSlug,
          gatewaySlug,
          {
            client_name: 'Test Client',
            redirect_uris: ['not-a-url'],
          },
          res,
        ),
      ).rejects.toThrow(HttpException);

      try {
        await controller.register(
          orgSlug,
          gatewaySlug,
          {
            client_name: 'Test Client',
            redirect_uris: ['not-a-url'],
          },
          res,
        );
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
        const response = (e as HttpException).getResponse() as any;
        expect(response.error).toBe('invalid_client_metadata');
      }
    });

    it('should pass grant_types and response_types to service', async () => {
      const res = mockRes();
      jest.spyOn(mcpOAuthService, 'registerClient').mockResolvedValue({
        client_id: 'mcp_client_abc123',
        client_name: 'Test Client',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'tools:read tools:execute',
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });

      await controller.register(
        orgSlug,
        gatewaySlug,
        {
          client_name: 'Test Client',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
        res,
      );

      expect(mcpOAuthService.registerClient).toHaveBeenCalledWith(
        mockGateway.id,
        mockOrganization.id,
        expect.objectContaining({
          client_name: 'Test Client',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      );
    });

    it('should use default grant_types when not provided', async () => {
      const res = mockRes();
      jest.spyOn(mcpOAuthService, 'registerClient').mockResolvedValue({
        client_id: 'mcp_client_abc123',
        client_name: 'Test Client',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'tools:read tools:execute',
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });

      await controller.register(
        orgSlug,
        gatewaySlug,
        {
          client_name: 'Test Client',
          redirect_uris: ['https://example.com/callback'],
        },
        res,
      );

      expect(mcpOAuthService.registerClient).toHaveBeenCalledWith(
        mockGateway.id,
        mockOrganization.id,
        expect.objectContaining({
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Authorization Endpoint
  // ---------------------------------------------------------------------------

  describe('authorize', () => {
    const validQuery = {
      responseType: 'code',
      clientId: 'mcp_client_abc123',
      redirectUri: 'https://example.com/callback',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      scope: 'mcp:tools',
      state: 'random-state-value',
      resource: undefined as string | undefined,
    };

    const mockReq = (user?: any) => ({ user });
    const mockRes = () => {
      const res: any = {};
      res.redirect = jest.fn().mockReturnValue(res);
      return res;
    };

    it('should reject missing required params (no response_type)', async () => {
      const res = mockRes();

      await expect(
        controller.authorize(
          orgSlug,
          gatewaySlug,
          undefined as any,
          validQuery.clientId,
          validQuery.redirectUri,
          validQuery.codeChallenge,
          validQuery.codeChallengeMethod,
          validQuery.scope,
          validQuery.state,
          validQuery.resource,
          mockReq(),
          res,
        ),
      ).rejects.toThrow(HttpException);

      try {
        await controller.authorize(
          orgSlug,
          gatewaySlug,
          undefined as any,
          validQuery.clientId,
          validQuery.redirectUri,
          validQuery.codeChallenge,
          validQuery.codeChallengeMethod,
          validQuery.scope,
          validQuery.state,
          validQuery.resource,
          mockReq(),
          res,
        );
      } catch (e) {
        const response = (e as HttpException).getResponse() as any;
        expect(response.error).toBe('invalid_request');
      }
    });

    it('should reject missing client_id', async () => {
      const res = mockRes();

      await expect(
        controller.authorize(
          orgSlug,
          gatewaySlug,
          validQuery.responseType,
          undefined as any,
          validQuery.redirectUri,
          validQuery.codeChallenge,
          validQuery.codeChallengeMethod,
          validQuery.scope,
          validQuery.state,
          validQuery.resource,
          mockReq(),
          res,
        ),
      ).rejects.toThrow(HttpException);
    });

    it('should reject missing redirect_uri', async () => {
      const res = mockRes();

      await expect(
        controller.authorize(
          orgSlug,
          gatewaySlug,
          validQuery.responseType,
          validQuery.clientId,
          undefined as any,
          validQuery.codeChallenge,
          validQuery.codeChallengeMethod,
          validQuery.scope,
          validQuery.state,
          validQuery.resource,
          mockReq(),
          res,
        ),
      ).rejects.toThrow(HttpException);
    });

    it('should reject missing code_challenge', async () => {
      const res = mockRes();

      await expect(
        controller.authorize(
          orgSlug,
          gatewaySlug,
          validQuery.responseType,
          validQuery.clientId,
          validQuery.redirectUri,
          undefined as any,
          validQuery.codeChallengeMethod,
          validQuery.scope,
          validQuery.state,
          validQuery.resource,
          mockReq(),
          res,
        ),
      ).rejects.toThrow(HttpException);
    });

    it('should reject missing code_challenge_method', async () => {
      const res = mockRes();

      await expect(
        controller.authorize(
          orgSlug,
          gatewaySlug,
          validQuery.responseType,
          validQuery.clientId,
          validQuery.redirectUri,
          validQuery.codeChallenge,
          undefined as any,
          validQuery.scope,
          validQuery.state,
          validQuery.resource,
          mockReq(),
          res,
        ),
      ).rejects.toThrow(HttpException);
    });

    it('should reject response_type != code', async () => {
      const res = mockRes();

      await expect(
        controller.authorize(
          orgSlug,
          gatewaySlug,
          'token',
          validQuery.clientId,
          validQuery.redirectUri,
          validQuery.codeChallenge,
          validQuery.codeChallengeMethod,
          validQuery.scope,
          validQuery.state,
          validQuery.resource,
          mockReq(),
          res,
        ),
      ).rejects.toThrow(HttpException);

      try {
        await controller.authorize(
          orgSlug,
          gatewaySlug,
          'token',
          validQuery.clientId,
          validQuery.redirectUri,
          validQuery.codeChallenge,
          validQuery.codeChallengeMethod,
          validQuery.scope,
          validQuery.state,
          validQuery.resource,
          mockReq(),
          res,
        );
      } catch (e) {
        const response = (e as HttpException).getResponse() as any;
        expect(response.error).toBe('unsupported_response_type');
        expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      }
    });

    it('should reject code_challenge_method != S256', async () => {
      const res = mockRes();

      await expect(
        controller.authorize(
          orgSlug,
          gatewaySlug,
          validQuery.responseType,
          validQuery.clientId,
          validQuery.redirectUri,
          validQuery.codeChallenge,
          'plain',
          validQuery.scope,
          validQuery.state,
          validQuery.resource,
          mockReq(),
          res,
        ),
      ).rejects.toThrow(HttpException);

      try {
        await controller.authorize(
          orgSlug,
          gatewaySlug,
          validQuery.responseType,
          validQuery.clientId,
          validQuery.redirectUri,
          validQuery.codeChallenge,
          'plain',
          validQuery.scope,
          validQuery.state,
          validQuery.resource,
          mockReq(),
          res,
        );
      } catch (e) {
        const response = (e as HttpException).getResponse() as any;
        expect(response.error).toBe('invalid_request');
        expect(response.error_description).toContain('S256');
        expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      }
    });

    it('should redirect to login when no user session', async () => {
      const res = mockRes();

      await controller.authorize(
        orgSlug,
        gatewaySlug,
        validQuery.responseType,
        validQuery.clientId,
        validQuery.redirectUri,
        validQuery.codeChallenge,
        validQuery.codeChallengeMethod,
        validQuery.scope,
        validQuery.state,
        validQuery.resource,
        mockReq(undefined),
        res,
      );

      expect(res.redirect).toHaveBeenCalledWith(302, expect.stringContaining('http://localhost:3002/login'));
      expect(res.redirect).toHaveBeenCalledWith(302, expect.stringContaining('returnTo='));
    });

    it('should redirect to login with returnTo containing all original params', async () => {
      const res = mockRes();

      await controller.authorize(
        orgSlug,
        gatewaySlug,
        validQuery.responseType,
        validQuery.clientId,
        validQuery.redirectUri,
        validQuery.codeChallenge,
        validQuery.codeChallengeMethod,
        validQuery.scope,
        validQuery.state,
        validQuery.resource,
        mockReq(undefined),
        res,
      );

      const redirectUrl = res.redirect.mock.calls[0][1];
      const returnTo = decodeURIComponent(redirectUrl.split('returnTo=')[1]);
      expect(returnTo).toContain('response_type=code');
      expect(returnTo).toContain(`client_id=${validQuery.clientId}`);
      expect(returnTo).toContain('code_challenge_method=S256');
    });

    it('should redirect to client with authorization code when user is authenticated', async () => {
      const res = mockRes();
      const mockAuthCode = 'auth-code-abc123';

      jest.spyOn(mcpOAuthService, 'createAuthorizationCode').mockResolvedValue(mockAuthCode);

      await controller.authorize(
        orgSlug,
        gatewaySlug,
        validQuery.responseType,
        validQuery.clientId,
        validQuery.redirectUri,
        validQuery.codeChallenge,
        validQuery.codeChallengeMethod,
        validQuery.scope,
        validQuery.state,
        validQuery.resource,
        mockReq({ id: 'user-1' }),
        res,
      );

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        expect.stringContaining(`code=${mockAuthCode}`),
      );
    });

    it('should include state in redirect when user is authenticated', async () => {
      const res = mockRes();
      const mockAuthCode = 'auth-code-abc123';

      jest.spyOn(mcpOAuthService, 'createAuthorizationCode').mockResolvedValue(mockAuthCode);

      await controller.authorize(
        orgSlug,
        gatewaySlug,
        validQuery.responseType,
        validQuery.clientId,
        validQuery.redirectUri,
        validQuery.codeChallenge,
        validQuery.codeChallengeMethod,
        validQuery.scope,
        'my-state-value',
        validQuery.resource,
        mockReq({ id: 'user-1' }),
        res,
      );

      const redirectUrl = res.redirect.mock.calls[0][1];
      expect(redirectUrl).toContain('state=my-state-value');
    });

    it('should not include state in redirect when state is not provided', async () => {
      const res = mockRes();
      const mockAuthCode = 'auth-code-abc123';

      jest.spyOn(mcpOAuthService, 'createAuthorizationCode').mockResolvedValue(mockAuthCode);

      await controller.authorize(
        orgSlug,
        gatewaySlug,
        validQuery.responseType,
        validQuery.clientId,
        validQuery.redirectUri,
        validQuery.codeChallenge,
        validQuery.codeChallengeMethod,
        validQuery.scope,
        undefined as any,
        validQuery.resource,
        mockReq({ id: 'user-1' }),
        res,
      );

      const redirectUrl = res.redirect.mock.calls[0][1];
      expect(redirectUrl).not.toContain('state=');
    });

    it('should use mcp:* as default scope when scope is not provided', async () => {
      const res = mockRes();

      jest.spyOn(mcpOAuthService, 'createAuthorizationCode').mockResolvedValue('auth-code');

      await controller.authorize(
        orgSlug,
        gatewaySlug,
        validQuery.responseType,
        validQuery.clientId,
        validQuery.redirectUri,
        validQuery.codeChallenge,
        validQuery.codeChallengeMethod,
        undefined as any,
        validQuery.state,
        validQuery.resource,
        mockReq({ id: 'user-1' }),
        res,
      );

      expect(mcpOAuthService.createAuthorizationCode).toHaveBeenCalledWith(
        validQuery.clientId,
        'user-1',
        mockGateway.id,
        mockOrganization.id,
        expect.objectContaining({ scope: 'mcp:*' }),
      );
    });

    it('should call createAuthorizationCode with correct parameters', async () => {
      const res = mockRes();

      jest.spyOn(mcpOAuthService, 'createAuthorizationCode').mockResolvedValue('auth-code');

      await controller.authorize(
        orgSlug,
        gatewaySlug,
        validQuery.responseType,
        validQuery.clientId,
        validQuery.redirectUri,
        validQuery.codeChallenge,
        validQuery.codeChallengeMethod,
        validQuery.scope,
        validQuery.state,
        validQuery.resource,
        mockReq({ id: 'user-1' }),
        res,
      );

      expect(mcpOAuthService.createAuthorizationCode).toHaveBeenCalledWith(
        validQuery.clientId,
        'user-1',
        mockGateway.id,
        mockOrganization.id,
        {
          redirectUri: validQuery.redirectUri,
          codeChallenge: validQuery.codeChallenge,
          codeChallengeMethod: validQuery.codeChallengeMethod,
          scope: validQuery.scope,
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Token Endpoint
  // ---------------------------------------------------------------------------

  describe('token', () => {
    it('should reject missing grant_type', async () => {
      await expect(
        controller.token(orgSlug, gatewaySlug, {}),
      ).rejects.toThrow(HttpException);

      try {
        await controller.token(orgSlug, gatewaySlug, {});
      } catch (e) {
        const response = (e as HttpException).getResponse() as any;
        expect(response.error).toBe('invalid_request');
        expect(response.error_description).toContain('grant_type');
        expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      }
    });

    it('should reject unsupported grant_type', async () => {
      await expect(
        controller.token(orgSlug, gatewaySlug, {
          grant_type: 'client_credentials',
        }),
      ).rejects.toThrow(HttpException);

      try {
        await controller.token(orgSlug, gatewaySlug, {
          grant_type: 'client_credentials',
        });
      } catch (e) {
        const response = (e as HttpException).getResponse() as any;
        expect(response.error).toBe('unsupported_grant_type');
        expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      }
    });

    it('should reject unsupported grant_type "implicit"', async () => {
      await expect(
        controller.token(orgSlug, gatewaySlug, {
          grant_type: 'implicit',
        }),
      ).rejects.toThrow(HttpException);
    });

    describe('authorization_code grant', () => {
      it('should reject missing code', async () => {
        await expect(
          controller.token(orgSlug, gatewaySlug, {
            grant_type: 'authorization_code',
            client_id: 'mcp_client_abc',
            redirect_uri: 'https://example.com/callback',
            code_verifier: 'verifier',
          }),
        ).rejects.toThrow(HttpException);

        try {
          await controller.token(orgSlug, gatewaySlug, {
            grant_type: 'authorization_code',
            client_id: 'mcp_client_abc',
            redirect_uri: 'https://example.com/callback',
            code_verifier: 'verifier',
          });
        } catch (e) {
          const response = (e as HttpException).getResponse() as any;
          expect(response.error).toBe('invalid_request');
          expect(response.error_description).toContain('code');
        }
      });

      it('should reject missing redirect_uri', async () => {
        await expect(
          controller.token(orgSlug, gatewaySlug, {
            grant_type: 'authorization_code',
            code: 'auth-code',
            client_id: 'mcp_client_abc',
            code_verifier: 'verifier',
          }),
        ).rejects.toThrow(HttpException);
      });

      it('should reject missing code_verifier', async () => {
        await expect(
          controller.token(orgSlug, gatewaySlug, {
            grant_type: 'authorization_code',
            code: 'auth-code',
            client_id: 'mcp_client_abc',
            redirect_uri: 'https://example.com/callback',
          }),
        ).rejects.toThrow(HttpException);
      });

      it('should reject missing client_id', async () => {
        await expect(
          controller.token(orgSlug, gatewaySlug, {
            grant_type: 'authorization_code',
            code: 'auth-code',
            redirect_uri: 'https://example.com/callback',
            code_verifier: 'verifier',
          }),
        ).rejects.toThrow(HttpException);
      });

      it('should call exchangeCode with correct parameters on valid request', async () => {
        const tokenResponse = {
          access_token: 'apifai_at_abc123',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'apifai_rt_abc123',
          scope: 'mcp:tools',
        };

        jest.spyOn(mcpOAuthService, 'exchangeCode').mockResolvedValue(tokenResponse);

        const result = await controller.token(orgSlug, gatewaySlug, {
          grant_type: 'authorization_code',
          code: 'auth-code',
          client_id: 'mcp_client_abc',
          redirect_uri: 'https://example.com/callback',
          code_verifier: 'verifier',
        });

        expect(mcpOAuthService.exchangeCode).toHaveBeenCalledWith(
          'auth-code',
          'mcp_client_abc',
          'verifier',
          'https://example.com/callback',
        );
        expect(result).toEqual(tokenResponse);
      });

      it('should return token response with correct shape', async () => {
        const tokenResponse = {
          access_token: 'apifai_at_abc123',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'apifai_rt_abc123',
          scope: 'mcp:tools',
        };

        jest.spyOn(mcpOAuthService, 'exchangeCode').mockResolvedValue(tokenResponse);

        const result = await controller.token(orgSlug, gatewaySlug, {
          grant_type: 'authorization_code',
          code: 'auth-code',
          client_id: 'mcp_client_abc',
          redirect_uri: 'https://example.com/callback',
          code_verifier: 'verifier',
        });

        expect(result).toHaveProperty('access_token');
        expect(result).toHaveProperty('token_type', 'bearer');
        expect(result).toHaveProperty('expires_in');
        expect(result).toHaveProperty('refresh_token');
        expect(result).toHaveProperty('scope');
      });
    });

    describe('refresh_token grant', () => {
      it('should reject missing refresh_token', async () => {
        await expect(
          controller.token(orgSlug, gatewaySlug, {
            grant_type: 'refresh_token',
            client_id: 'mcp_client_abc',
          }),
        ).rejects.toThrow(HttpException);

        try {
          await controller.token(orgSlug, gatewaySlug, {
            grant_type: 'refresh_token',
            client_id: 'mcp_client_abc',
          });
        } catch (e) {
          const response = (e as HttpException).getResponse() as any;
          expect(response.error).toBe('invalid_request');
          expect(response.error_description).toContain('refresh_token');
        }
      });

      it('should reject missing client_id for refresh_token grant', async () => {
        await expect(
          controller.token(orgSlug, gatewaySlug, {
            grant_type: 'refresh_token',
            refresh_token: 'apifai_rt_abc123',
          }),
        ).rejects.toThrow(HttpException);
      });

      it('should call refreshToken with correct parameters on valid request', async () => {
        const tokenResponse = {
          access_token: 'apifai_at_new',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'apifai_rt_new',
          scope: 'mcp:tools',
        };

        jest.spyOn(mcpOAuthService, 'refreshToken').mockResolvedValue(tokenResponse);

        const result = await controller.token(orgSlug, gatewaySlug, {
          grant_type: 'refresh_token',
          refresh_token: 'apifai_rt_abc123',
          client_id: 'mcp_client_abc',
        });

        expect(mcpOAuthService.refreshToken).toHaveBeenCalledWith(
          'apifai_rt_abc123',
          'mcp_client_abc',
        );
        expect(result).toEqual(tokenResponse);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Token Revocation (RFC 7009)
  // ---------------------------------------------------------------------------

  describe('revoke', () => {
    const mockRes = () => {
      const res: any = {};
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);
      return res;
    };

    it('should always return 200 per RFC 7009 for a valid revocation', async () => {
      const res = mockRes();

      jest.spyOn(mcpOAuthService, 'revokeToken').mockResolvedValue(undefined);

      await controller.revoke(
        orgSlug,
        gatewaySlug,
        {
          token: 'apifai_at_abc123',
          client_id: 'mcp_client_abc',
        },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith({});
    });

    it('should return 200 even for invalid tokens (RFC 7009 compliance)', async () => {
      const res = mockRes();

      jest.spyOn(mcpOAuthService, 'revokeToken').mockRejectedValue(new Error('Token not found'));

      await controller.revoke(
        orgSlug,
        gatewaySlug,
        {
          token: 'invalid-token',
          client_id: 'mcp_client_abc',
        },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith({});
    });

    it('should return 200 even when token or client_id is missing', async () => {
      const res = mockRes();

      await controller.revoke(
        orgSlug,
        gatewaySlug,
        {
          token: '',
          client_id: 'mcp_client_abc',
        },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith({});
      // revokeToken should not be called when token is empty
      expect(mcpOAuthService.revokeToken).not.toHaveBeenCalled();
    });

    it('should return 200 when client_id is missing', async () => {
      const res = mockRes();

      await controller.revoke(
        orgSlug,
        gatewaySlug,
        {
          token: 'apifai_at_abc123',
          client_id: '',
        },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith({});
      expect(mcpOAuthService.revokeToken).not.toHaveBeenCalled();
    });

    it('should pass token_type_hint when provided', async () => {
      const res = mockRes();

      jest.spyOn(mcpOAuthService, 'revokeToken').mockResolvedValue(undefined);

      await controller.revoke(
        orgSlug,
        gatewaySlug,
        {
          token: 'apifai_at_abc123',
          token_type_hint: 'access_token',
          client_id: 'mcp_client_abc',
        },
        res,
      );

      expect(mcpOAuthService.revokeToken).toHaveBeenCalledWith(
        'apifai_at_abc123',
        'mcp_client_abc',
      );
      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    });

    it('should handle revokeToken throwing BadRequestException and still return 200', async () => {
      const res = mockRes();

      jest
        .spyOn(mcpOAuthService, 'revokeToken')
        .mockRejectedValue(new HttpException('Token does not belong to client', HttpStatus.BAD_REQUEST));

      await controller.revoke(
        orgSlug,
        gatewaySlug,
        {
          token: 'apifai_at_abc123',
          client_id: 'wrong_client',
        },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith({});
    });
  });
});
