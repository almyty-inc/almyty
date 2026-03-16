import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { GatewayA2AController } from '../controllers/gateway-a2a.controller';
import { A2AService } from '../a2a.service';
import { GatewayResolverService } from '../services/gateway-resolver.service';
import { GatewayAuthType } from '../../../entities/gateway-auth.entity';
import { GatewayType, GatewayStatus } from '../../../entities/gateway.entity';

describe('GatewayA2AController - Auth Behavior', () => {
  let controller: GatewayA2AController;
  let gatewayResolver: jest.Mocked<GatewayResolverService>;
  let a2aService: jest.Mocked<A2AService>;

  const mockOrganization = {
    id: 'org-1',
    name: 'Test Org',
    slug: 'test-org',
  };

  const createMockGateway = (authConfigs: any[] = []) => ({
    id: 'gateway-1',
    name: 'Test A2A Gateway',
    type: GatewayType.A2A,
    status: GatewayStatus.ACTIVE,
    organizationId: 'org-1',
    endpoint: '/a2a-gw',
    configuration: {},
    authConfigs,
  });

  const createMockReq = (path: string, headers: Record<string, string> = {}) => ({
    path,
    headers,
    query: {},
    ip: '127.0.0.1',
  });

  const createMockRes = () => {
    const headers: Record<string, string> = {};
    return {
      setHeader: jest.fn((name: string, value: string) => {
        headers[name] = value;
      }),
      getHeader: (name: string) => headers[name],
      _headers: headers,
    };
  };

  beforeEach(async () => {
    const mockGatewayResolver = {
      resolveOrganization: jest.fn(),
      resolveGateway: jest.fn(),
      resolveAndAuthenticate: jest.fn(),
      parsePathSegments: jest.fn(),
    };

    const mockA2AService = {
      listAgents: jest.fn(),
      registerAgent: jest.fn(),
      sendMessage: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GatewayA2AController],
      providers: [
        { provide: A2AService, useValue: mockA2AService },
        { provide: GatewayResolverService, useValue: mockGatewayResolver },
      ],
    }).compile();

    controller = module.get<GatewayA2AController>(GatewayA2AController);
    gatewayResolver = module.get(GatewayResolverService);
    a2aService = module.get(A2AService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Agent Card Discovery (public endpoint)', () => {
    it('should serve Agent Card without auth (.well-known/agent.json)', async () => {
      const gateway = createMockGateway([]);
      const req = createMockReq('/a2a/test-org/a2a-gw/.well-known/agent.json');
      const res = createMockRes();

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/a2a-gw',
        action: '.well-known/agent.json',
      });
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);

      const result: any = await controller.handleGetRequest('test-org', req, res as any);

      expect(result.protocol).toBe('a2a');
      expect(result.version).toBe('1.0.0');
      expect(result.gateway.id).toBe('gateway-1');
      // resolveAndAuthenticate should NOT be called for discovery
      expect(gatewayResolver.resolveAndAuthenticate).not.toHaveBeenCalled();
    });

    it('should include securitySchemes when gateway has API_KEY auth', async () => {
      const gateway = createMockGateway([
        {
          id: 'auth-1',
          type: GatewayAuthType.API_KEY,
          isActive: true,
          configuration: { keyHeader: 'x-api-key' },
        },
      ]);
      const req = createMockReq('/a2a/test-org/a2a-gw/.well-known/agent.json');
      const res = createMockRes();

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/a2a-gw',
        action: '.well-known/agent.json',
      });
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);

      const result: any = await controller.handleGetRequest('test-org', req, res as any);

      expect(result.securitySchemes).toBeDefined();
      expect(result.securitySchemes.apiKey).toEqual({
        type: 'apiKey',
        name: 'x-api-key',
        location: 'header',
        description: 'API key for gateway access',
      });
      expect(result.security).toEqual([{ apiKey: [] }]);
    });

    it('should include securitySchemes when gateway has BEARER_TOKEN auth', async () => {
      const gateway = createMockGateway([
        {
          id: 'auth-2',
          type: GatewayAuthType.BEARER_TOKEN,
          isActive: true,
          configuration: {},
        },
      ]);
      const req = createMockReq('/a2a/test-org/a2a-gw/.well-known/agent.json');
      const res = createMockRes();

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/a2a-gw',
        action: '.well-known/agent.json',
      });
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);

      const result: any = await controller.handleGetRequest('test-org', req, res as any);

      expect(result.securitySchemes).toBeDefined();
      expect(result.securitySchemes.bearer).toEqual({
        type: 'http',
        scheme: 'Bearer',
        description: 'Bearer token authentication',
      });
      expect(result.security).toEqual([{ bearer: [] }]);
    });

    it('should include securitySchemes when gateway has OAUTH2 auth', async () => {
      const oauthFlows = {
        authorizationCode: {
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
        },
      };
      const gateway = createMockGateway([
        {
          id: 'auth-3',
          type: GatewayAuthType.OAUTH2,
          isActive: true,
          configuration: { flows: oauthFlows },
        },
      ]);
      const req = createMockReq('/a2a/test-org/a2a-gw/.well-known/agent.json');
      const res = createMockRes();

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/a2a-gw',
        action: '.well-known/agent.json',
      });
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);

      const result: any = await controller.handleGetRequest('test-org', req, res as any);

      expect(result.securitySchemes).toBeDefined();
      expect(result.securitySchemes.oauth2).toEqual({
        type: 'oauth2',
        description: 'OAuth 2.0 authentication',
        flows: oauthFlows,
      });
      expect(result.security).toEqual([{ oauth2: [] }]);
    });

    it('should have no securitySchemes when gateway has NONE auth type', async () => {
      const gateway = createMockGateway([
        {
          id: 'auth-4',
          type: GatewayAuthType.NONE,
          isActive: true,
          configuration: {},
        },
      ]);
      const req = createMockReq('/a2a/test-org/a2a-gw/.well-known/agent.json');
      const res = createMockRes();

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/a2a-gw',
        action: '.well-known/agent.json',
      });
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);

      const result: any = await controller.handleGetRequest('test-org', req, res as any);

      expect(result.securitySchemes).toBeUndefined();
      expect(result.security).toBeUndefined();
    });

    it('should include security array matching securitySchemes', async () => {
      const gateway = createMockGateway([
        {
          id: 'auth-a',
          type: GatewayAuthType.API_KEY,
          isActive: true,
          configuration: { keyHeader: 'x-api-key' },
        },
        {
          id: 'auth-b',
          type: GatewayAuthType.BEARER_TOKEN,
          isActive: true,
          configuration: {},
        },
      ]);
      const req = createMockReq('/a2a/test-org/a2a-gw/.well-known/agent.json');
      const res = createMockRes();

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/a2a-gw',
        action: '.well-known/agent.json',
      });
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);

      const result: any = await controller.handleGetRequest('test-org', req, res as any);

      expect(result.securitySchemes).toHaveProperty('apiKey');
      expect(result.securitySchemes).toHaveProperty('bearer');
      expect(result.security).toEqual([{ apiKey: [] }, { bearer: [] }]);
    });
  });

  describe('Non-discovery endpoints require auth', () => {
    it('should return 401 for /agents without credentials', async () => {
      const gateway = createMockGateway([
        {
          id: 'auth-1',
          type: GatewayAuthType.API_KEY,
          isActive: true,
          configuration: { keyHeader: 'x-api-key' },
        },
      ]);
      const req = createMockReq('/a2a/test-org/a2a-gw/agents');
      const res = createMockRes();

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/a2a-gw',
        action: 'agents',
      });

      const unauthorizedError = new HttpException(
        { error: 'API key is required', errorCode: 'API_KEY_MISSING' },
        HttpStatus.UNAUTHORIZED,
      );

      gatewayResolver.resolveAndAuthenticate.mockRejectedValue(unauthorizedError);
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);

      await expect(
        controller.handleGetRequest('test-org', req, res as any),
      ).rejects.toThrow(HttpException);

      try {
        await controller.handleGetRequest('test-org', req, res as any);
      } catch (e) {
        expect(e.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      }
    });

    it('should return 401 for POST /messages without credentials', async () => {
      const gateway = createMockGateway([
        {
          id: 'auth-1',
          type: GatewayAuthType.BEARER_TOKEN,
          isActive: true,
          configuration: {},
        },
      ]);
      const req = createMockReq('/a2a/test-org/a2a-gw/messages');
      const res = createMockRes();
      const body = { fromAgentId: 'a1', toAgentId: 'a2', content: 'hello' };

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/a2a-gw',
        action: 'messages',
      });

      const unauthorizedError = new HttpException(
        { error: 'Bearer token is required', errorCode: 'BEARER_TOKEN_MISSING' },
        HttpStatus.UNAUTHORIZED,
      );

      gatewayResolver.resolveAndAuthenticate.mockRejectedValue(unauthorizedError);
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);

      await expect(
        controller.handlePostRequest('test-org', body, req, res as any),
      ).rejects.toThrow(HttpException);

      try {
        await controller.handlePostRequest('test-org', body, req, res as any);
      } catch (e) {
        expect(e.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      }
    });

    it('should include WWW-Authenticate header in 401 responses for API_KEY auth', async () => {
      const gateway = createMockGateway([
        {
          id: 'auth-1',
          type: GatewayAuthType.API_KEY,
          isActive: true,
          configuration: { keyHeader: 'x-api-key' },
        },
      ]);
      const req = createMockReq('/a2a/test-org/a2a-gw/agents');
      const res = createMockRes();

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/a2a-gw',
        action: 'agents',
      });

      const unauthorizedError = new HttpException(
        { error: 'API key is required', errorCode: 'API_KEY_MISSING' },
        HttpStatus.UNAUTHORIZED,
      );

      gatewayResolver.resolveAndAuthenticate.mockRejectedValue(unauthorizedError);
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);

      try {
        await controller.handleGetRequest('test-org', req, res as any);
      } catch {
        // expected
      }

      expect(res.setHeader).toHaveBeenCalledWith(
        'WWW-Authenticate',
        expect.stringContaining('ApiKey'),
      );
    });

    it('should include WWW-Authenticate header in 401 responses for BEARER_TOKEN auth', async () => {
      const gateway = createMockGateway([
        {
          id: 'auth-1',
          type: GatewayAuthType.BEARER_TOKEN,
          isActive: true,
          configuration: {},
        },
      ]);
      const req = createMockReq('/a2a/test-org/a2a-gw/agents');
      const res = createMockRes();

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/a2a-gw',
        action: 'agents',
      });

      const unauthorizedError = new HttpException(
        { error: 'Bearer token is required', errorCode: 'BEARER_TOKEN_MISSING' },
        HttpStatus.UNAUTHORIZED,
      );

      gatewayResolver.resolveAndAuthenticate.mockRejectedValue(unauthorizedError);
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);

      try {
        await controller.handleGetRequest('test-org', req, res as any);
      } catch {
        // expected
      }

      expect(res.setHeader).toHaveBeenCalledWith(
        'WWW-Authenticate',
        expect.stringContaining('Bearer'),
      );
    });
  });
});
