import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { GatewayUtcpController } from '../controllers/gateway-utcp.controller';
import { UtcpService } from '../utcp.service';
import { GatewayResolverService } from '../services/gateway-resolver.service';
import { GatewayAuthType } from '../../../entities/gateway-auth.entity';
import { GatewayType, GatewayStatus } from '../../../entities/gateway.entity';

describe('GatewayUtcpController - Auth Behavior', () => {
  let controller: GatewayUtcpController;
  let gatewayResolver: jest.Mocked<GatewayResolverService>;
  let utcpService: jest.Mocked<UtcpService>;

  const mockOrganization = {
    id: 'org-1',
    name: 'Test Org',
    slug: 'test-org',
  };

  const createMockGateway = (authConfigs: any[] = []) => ({
    id: 'gateway-1',
    name: 'Test UTCP Gateway',
    type: GatewayType.UTCP,
    status: GatewayStatus.ACTIVE,
    organizationId: 'org-1',
    endpoint: '/utcp-gw',
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

    const mockUtcpService = {
      getDiscoveryInfo: jest.fn(),
      generateManual: jest.fn(),
      executeUtcpTool: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GatewayUtcpController],
      providers: [
        { provide: UtcpService, useValue: mockUtcpService },
        { provide: GatewayResolverService, useValue: mockGatewayResolver },
      ],
    }).compile();

    controller = module.get<GatewayUtcpController>(GatewayUtcpController);
    gatewayResolver = module.get(GatewayResolverService);
    utcpService = module.get(UtcpService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Discovery endpoints (public)', () => {
    it('should serve UTCP discovery without auth (.well-known/utcp)', async () => {
      const gateway = createMockGateway([]);
      const req = createMockReq('/utcp/test-org/utcp-gw/.well-known/utcp');
      const res = createMockRes();
      const discoveryInfo = {
        protocol: 'utcp',
        version: '1.0.0',
        server: { name: 'apifai' },
      };

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/utcp-gw',
        action: '.well-known/utcp',
      });
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);
      utcpService.getDiscoveryInfo.mockReturnValue(discoveryInfo as any);

      const result = await controller.handleGetRequest('test-org', req, res as any) as any;

      expect(result.protocol).toBe('utcp');
      expect(gatewayResolver.resolveAndAuthenticate).not.toHaveBeenCalled();
    });

    it('should serve UTCP manual without auth (manual endpoint)', async () => {
      const gateway = createMockGateway([]);
      const req = createMockReq('/utcp/test-org/utcp-gw/manual');
      const res = createMockRes();
      const manual = {
        version: '1.0.0',
        info: { title: 'Test Manual' },
        tools: [],
      };

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/utcp-gw',
        action: 'manual',
      });
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);
      utcpService.generateManual.mockResolvedValue(manual as any);

      const result: any = await controller.handleGetRequest('test-org', req, res as any);

      expect(result.version).toBe('1.0.0');
      expect(gatewayResolver.resolveAndAuthenticate).not.toHaveBeenCalled();
    });

    it('should include auth object with auth_type, var_name, location for API_KEY', async () => {
      const gateway = createMockGateway([
        {
          id: 'auth-1',
          type: GatewayAuthType.API_KEY,
          isActive: true,
          configuration: { keyHeader: 'x-api-key' },
        },
      ]);
      const req = createMockReq('/utcp/test-org/utcp-gw/.well-known/utcp');
      const res = createMockRes();
      const discoveryInfo = {
        protocol: 'utcp',
        version: '1.0.0',
      };

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/utcp-gw',
        action: '.well-known/utcp',
      });
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);
      utcpService.getDiscoveryInfo.mockReturnValue(discoveryInfo as any);

      const result: any = await controller.handleGetRequest('test-org', req, res as any);

      expect(result.auth).toEqual({
        auth_type: 'api_key',
        var_name: 'x-api-key',
        location: 'header',
      });
    });

    it('should include auth object for BEARER_TOKEN', async () => {
      const gateway = createMockGateway([
        {
          id: 'auth-2',
          type: GatewayAuthType.BEARER_TOKEN,
          isActive: true,
          configuration: {},
        },
      ]);
      const req = createMockReq('/utcp/test-org/utcp-gw/.well-known/utcp');
      const res = createMockRes();
      const discoveryInfo = {
        protocol: 'utcp',
        version: '1.0.0',
      };

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/utcp-gw',
        action: '.well-known/utcp',
      });
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);
      utcpService.getDiscoveryInfo.mockReturnValue(discoveryInfo as any);

      const result: any = await controller.handleGetRequest('test-org', req, res as any);

      expect(result.auth).toEqual({
        auth_type: 'bearer',
        var_name: 'Authorization',
        location: 'header',
      });
    });

    it('should include auth object for OAUTH2', async () => {
      const gateway = createMockGateway([
        {
          id: 'auth-3',
          type: GatewayAuthType.OAUTH2,
          isActive: true,
          configuration: {},
        },
      ]);
      const req = createMockReq('/utcp/test-org/utcp-gw/.well-known/utcp');
      const res = createMockRes();
      const discoveryInfo = {
        protocol: 'utcp',
        version: '1.0.0',
      };

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/utcp-gw',
        action: '.well-known/utcp',
      });
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);
      utcpService.getDiscoveryInfo.mockReturnValue(discoveryInfo as any);

      const result: any = await controller.handleGetRequest('test-org', req, res as any);

      expect(result.auth).toEqual({
        auth_type: 'oauth2',
        var_name: 'Authorization',
        location: 'header',
      });
    });

    it('should have no auth object when gateway has NONE type', async () => {
      const gateway = createMockGateway([
        {
          id: 'auth-4',
          type: GatewayAuthType.NONE,
          isActive: true,
          configuration: {},
        },
      ]);
      const req = createMockReq('/utcp/test-org/utcp-gw/.well-known/utcp');
      const res = createMockRes();
      const discoveryInfo = {
        protocol: 'utcp',
        version: '1.0.0',
      };

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/utcp-gw',
        action: '.well-known/utcp',
      });
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);
      utcpService.getDiscoveryInfo.mockReturnValue(discoveryInfo as any);

      const result: any = await controller.handleGetRequest('test-org', req, res as any);

      expect(result.auth).toBeUndefined();
    });
  });

  describe('Execute endpoint requires auth', () => {
    it('should return 401 for POST /execute without credentials', async () => {
      const gateway = createMockGateway([
        {
          id: 'auth-1',
          type: GatewayAuthType.API_KEY,
          isActive: true,
          configuration: { keyHeader: 'x-api-key' },
        },
      ]);
      const req = createMockReq('/utcp/test-org/utcp-gw/execute');
      const res = createMockRes();
      const body = { toolId: 'tool-1', parameters: {} };

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/utcp-gw',
        action: 'execute',
      });

      const unauthorizedError = new HttpException(
        { error: 'API key is required', errorCode: 'API_KEY_MISSING' },
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
      const req = createMockReq('/utcp/test-org/utcp-gw/execute');
      const res = createMockRes();
      const body = { toolId: 'tool-1', parameters: {} };

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/utcp-gw',
        action: 'execute',
      });

      const unauthorizedError = new HttpException(
        { error: 'API key is required', errorCode: 'API_KEY_MISSING' },
        HttpStatus.UNAUTHORIZED,
      );

      gatewayResolver.resolveAndAuthenticate.mockRejectedValue(unauthorizedError);
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);

      try {
        await controller.handlePostRequest('test-org', body, req, res as any);
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
      const req = createMockReq('/utcp/test-org/utcp-gw/execute');
      const res = createMockRes();
      const body = { toolId: 'tool-1', parameters: {} };

      gatewayResolver.parsePathSegments.mockReturnValue({
        gatewayEndpoint: '/utcp-gw',
        action: 'execute',
      });

      const unauthorizedError = new HttpException(
        { error: 'Bearer token is required', errorCode: 'BEARER_TOKEN_MISSING' },
        HttpStatus.UNAUTHORIZED,
      );

      gatewayResolver.resolveAndAuthenticate.mockRejectedValue(unauthorizedError);
      gatewayResolver.resolveOrganization.mockResolvedValue(mockOrganization as any);
      gatewayResolver.resolveGateway.mockResolvedValue(gateway as any);

      try {
        await controller.handlePostRequest('test-org', body, req, res as any);
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
