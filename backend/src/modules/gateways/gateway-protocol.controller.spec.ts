import { Test, TestingModule } from '@nestjs/testing';
import { GatewayProtocolController, GatewayWebSocketGateway } from './gateway-protocol.controller';
import { GatewayProtocolService } from './gateway-protocol.service';
import { GatewayAuthService } from './gateway-auth.service';
import { GatewaysService } from './gateways.service';
import { Gateway, GatewayType, GatewayStatus } from '../../entities/gateway.entity';
import { Request, Response } from 'express';
import * as WebSocket from 'ws';

describe('GatewayProtocolController', () => {
  let controller: GatewayProtocolController;
  let gatewayProtocolService: jest.Mocked<GatewayProtocolService>;
  let gatewayAuthService: jest.Mocked<GatewayAuthService>;
  let gatewaysService: jest.Mocked<GatewaysService>;

  const mockGateway = {
    id: 'gateway-1',
    name: 'Test Gateway',
    type: GatewayType.MCP,
    status: GatewayStatus.ACTIVE,
    endpoint: '/test-endpoint',
    organizationId: 'org-1',
    isHealthy: true,
    totalRequests: 10,
    successfulRequests: 8,
    tools: [],
    authConfigs: [],
    corsConfig: {
      origins: ['*'],
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type'],
      credentials: false,
    },
    customHeaders: { 'X-Custom': 'value' },
    canAcceptRequests: jest.fn().mockReturnValue(true),
    incrementRequest: jest.fn(),
    getActiveTools: jest.fn().mockReturnValue([]),
    getConfigForType: jest.fn().mockReturnValue({}),
    supportsProtocol: jest.fn().mockReturnValue(true),
  } as unknown as Gateway;

  const mockRequest = {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    connection: { remoteAddress: '127.0.0.1' },
    on: jest.fn(),
  } as unknown as Request;

  const mockResponse = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    write: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
  } as unknown as Response;

  const mockGatewayRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GatewayProtocolController],
      providers: [
        {
          provide: GatewayProtocolService,
          useValue: {
            handleProtocolRequest: jest.fn(),
            handleWebSocketConnection: jest.fn(),
          },
        },
        {
          provide: GatewayAuthService,
          useValue: {
            authenticateRequest: jest.fn(),
          },
        },
        {
          provide: GatewaysService,
          useValue: {
            performHealthCheck: jest.fn(),
            gatewayRepository: mockGatewayRepository,
          },
        },
      ],
    }).compile();

    controller = module.get<GatewayProtocolController>(GatewayProtocolController);
    gatewayProtocolService = module.get(GatewayProtocolService);
    gatewayAuthService = module.get(GatewayAuthService);
    gatewaysService = module.get(GatewaysService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('basic functionality', () => {
    it('should be defined', () => {
      expect(controller).toBeDefined();
    });

    it('should have handleWebSocket method', () => {
      expect(controller.handleWebSocket).toBeDefined();
    });

    it('should call handleWebSocket', () => {
      const result = controller.handleWebSocket();
      expect(result).toBeUndefined();
    });
  });

  describe('handleGatewayRequest', () => {
    beforeEach(() => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
    });

    it('should return 404 if gateway not found', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(null);

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        mockResponse,
        {},
        {},
        {}
      );

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: 'GATEWAY_NOT_FOUND',
          message: 'Gateway endpoint not found',
        },
      });
    });

    it('should return 503 if gateway cannot accept requests', async () => {
      const unavailableGateway = { ...mockGateway, canAcceptRequests: jest.fn().mockReturnValue(false) };
      mockGatewayRepository.findOne.mockResolvedValue(unavailableGateway);

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        mockResponse,
        {},
        {},
        {}
      );

      expect(mockResponse.status).toHaveBeenCalledWith(503);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: 'GATEWAY_UNAVAILABLE',
          message: 'Gateway is currently unavailable',
        },
      });
    });

    it('should handle CORS preflight OPTIONS request', async () => {
      const optionsRequest = { ...mockRequest, method: 'OPTIONS' } as unknown as Request;
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);

      await controller.handleGatewayRequest(
        'test-endpoint',
        optionsRequest,
        mockResponse,
        {},
        {},
        {}
      );

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.end).toHaveBeenCalled();
    });

    it('should apply custom headers', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayAuthService.authenticateRequest.mockResolvedValue({ isValid: true, userId: 'user-1' });
      gatewayProtocolService.handleProtocolRequest.mockResolvedValue({ success: true, data: {} });

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        mockResponse,
        {},
        {},
        {}
      );

      expect(mockResponse.setHeader).toHaveBeenCalledWith('X-Custom', 'value');
    });

    it('should return 401 if authentication fails', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayAuthService.authenticateRequest.mockResolvedValue({
        isValid: false,
        error: 'Invalid credentials',
        errorCode: 'UNAUTHORIZED',
      });

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        mockResponse,
        {},
        {},
        {}
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid credentials',
          details: undefined,
        },
      });
    });

    it('should handle successful protocol request', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayAuthService.authenticateRequest.mockResolvedValue({
        isValid: true,
        userId: 'user-1',
        roles: ['admin'],
        organizationId: 'org-1',
        scopes: ['read', 'write'],
      });
      gatewayProtocolService.handleProtocolRequest.mockResolvedValue({
        success: true,
        data: { result: 'success' },
      });

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        mockResponse,
        {},
        {},
        {}
      );

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({ result: 'success' });
      expect(mockGateway.incrementRequest).toHaveBeenCalledWith(true);
    });

    it('should handle failed protocol request', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayAuthService.authenticateRequest.mockResolvedValue({ isValid: true, userId: 'user-1' });
      gatewayProtocolService.handleProtocolRequest.mockResolvedValue({
        success: false,
        error: { code: 'TOOL_NOT_FOUND', message: 'Tool not found' },
      });

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        mockResponse,
        {},
        {},
        {}
      );

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: { code: 'TOOL_NOT_FOUND', message: 'Tool not found' },
      });
      expect(mockGateway.incrementRequest).toHaveBeenCalledWith(false);
    });

    it('should handle exceptions and return 500', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayAuthService.authenticateRequest.mockRejectedValue(new Error('Database error'));

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        mockResponse,
        {},
        {},
        {}
      );

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
        },
      });
    });

    it('should apply CORS headers with specific origin', async () => {
      const gatewayWithOrigin = {
        ...mockGateway,
        corsConfig: {
          origins: ['https://example.com'],
          methods: ['GET', 'POST'],
          allowedHeaders: ['Content-Type'],
          credentials: true,
        },
      };
      mockGatewayRepository.findOne.mockResolvedValue(gatewayWithOrigin);
      const requestWithOrigin = { ...mockRequest, headers: { origin: 'https://example.com' } } as unknown as Request;

      gatewayAuthService.authenticateRequest.mockResolvedValue({ isValid: true, userId: 'user-1' });
      gatewayProtocolService.handleProtocolRequest.mockResolvedValue({ success: true, data: {} });

      await controller.handleGatewayRequest(
        'test-endpoint',
        requestWithOrigin,
        mockResponse,
        { origin: 'https://example.com' },
        {},
        {}
      );

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://example.com');
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Credentials', 'true');
    });
  });

  describe('healthCheck', () => {
    it('should return 404 if gateway not found', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(null);

      await controller.healthCheck('test-endpoint', mockResponse);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Gateway not found' });
    });

    it('should return 200 for healthy gateway', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewaysService.performHealthCheck.mockResolvedValue({
        isHealthy: true,
        responseTime: 100,
        details: { message: 'All systems operational' },
      });

      await controller.healthCheck('test-endpoint', mockResponse);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          healthy: true,
          responseTime: 100,
          details: { message: 'All systems operational' },
        })
      );
    });

    it('should return 503 for unhealthy gateway', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewaysService.performHealthCheck.mockResolvedValue({
        isHealthy: false,
        responseTime: 5000,
        error: 'Timeout',
      });

      await controller.healthCheck('test-endpoint', mockResponse);

      expect(mockResponse.status).toHaveBeenCalledWith(503);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          healthy: false,
          error: 'Timeout',
        })
      );
    });

    it('should handle health check errors', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewaysService.performHealthCheck.mockRejectedValue(new Error('Service error'));

      await controller.healthCheck('test-endpoint', mockResponse);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        healthy: false,
        error: 'Health check failed',
      });
    });
  });

  describe('getGatewayInfo', () => {
    it('should return 404 if gateway not found', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(null);

      await controller.getGatewayInfo('test-endpoint', mockResponse);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Gateway not found' });
    });

    it('should return gateway information', async () => {
      const gatewayWithAuth = {
        ...mockGateway,
        authConfigs: [{ type: 'bearer', isRequired: true }],
        rateLimitConfig: { enabled: true, requestsPerMinute: 60 },
        lastHealthCheckAt: new Date(),
      };
      mockGatewayRepository.findOne.mockResolvedValue(gatewayWithAuth);

      await controller.getGatewayInfo('test-endpoint', mockResponse);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test Gateway',
          type: GatewayType.MCP,
          status: GatewayStatus.ACTIVE,
          activeTools: 0,
        })
      );
    });

    it('should handle info retrieval errors', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
      mockGateway.getConfigForType = jest.fn().mockImplementation(() => {
        throw new Error('Config error');
      });

      await controller.getGatewayInfo('test-endpoint', mockResponse);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Failed to get gateway info' });
    });
  });

  describe('handleSSE', () => {
    it('should return 404 if gateway not found', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(null);

      await controller.handleSSE('test-endpoint', mockRequest, mockResponse);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Gateway not found' });
    });

    it('should return 400 if gateway does not support SSE', async () => {
      const gatewayNoSSE = { ...mockGateway, supportsProtocol: jest.fn().mockReturnValue(false) };
      mockGatewayRepository.findOne.mockResolvedValue(gatewayNoSSE);

      await controller.handleSSE('test-endpoint', mockRequest, mockResponse);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Gateway does not support Server-Sent Events',
      });
    });

    it('should establish SSE connection', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);

      await controller.handleSSE('test-endpoint', mockRequest, mockResponse);

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
      expect(mockResponse.write).toHaveBeenCalled();
    });

    it('should handle SSE connection errors', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
      mockResponse.setHeader = jest.fn().mockImplementation(() => {
        throw new Error('Header error');
      });

      await controller.handleSSE('test-endpoint', mockRequest, mockResponse);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'SSE connection failed' });
    });
  });

  describe('handleGatewayRequest - additional branch coverage', () => {
    let freshMockResponse: any;

    beforeEach(() => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
      mockGatewayRepository.save.mockResolvedValue(mockGateway);
      freshMockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn().mockReturnThis(),
        write: jest.fn().mockReturnThis(),
        end: jest.fn().mockReturnThis(),
      };
    });

    it('should handle gateway without CORS config', async () => {
      const gatewayNoCORS = { ...mockGateway, corsConfig: null };
      mockGatewayRepository.findOne.mockResolvedValue(gatewayNoCORS);
      gatewayAuthService.authenticateRequest.mockResolvedValue({ isValid: true, userId: 'user-1' });
      gatewayProtocolService.handleProtocolRequest.mockResolvedValue({ success: true, data: {} });

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        freshMockResponse,
        {},
        {},
        {}
      );

      expect(freshMockResponse.status).toHaveBeenCalledWith(200);
    });

    it('should handle gateway without custom headers', async () => {
      const gatewayNoHeaders = { ...mockGateway, customHeaders: null };
      mockGatewayRepository.findOne.mockResolvedValue(gatewayNoHeaders);
      gatewayAuthService.authenticateRequest.mockResolvedValue({ isValid: true, userId: 'user-1' });
      gatewayProtocolService.handleProtocolRequest.mockResolvedValue({ success: true, data: {} });

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        freshMockResponse,
        {},
        {},
        {}
      );

      expect(freshMockResponse.status).toHaveBeenCalledWith(200);
    });

    it('should handle auth error without authConfigs', async () => {
      const gatewayNoAuth = { ...mockGateway, authConfigs: null };
      mockGatewayRepository.findOne.mockResolvedValue(gatewayNoAuth);
      gatewayAuthService.authenticateRequest.mockResolvedValue({
        isValid: false,
        error: 'Unauthorized',
        errorCode: 'UNAUTHORIZED',
      });

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        freshMockResponse,
        {},
        {},
        {}
      );

      expect(freshMockResponse.status).toHaveBeenCalledWith(401);
    });

    it('should handle protocol response without data', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayAuthService.authenticateRequest.mockResolvedValue({ isValid: true, userId: 'user-1' });
      gatewayProtocolService.handleProtocolRequest.mockResolvedValue({ success: true });

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        freshMockResponse,
        {},
        {},
        {}
      );

      expect(freshMockResponse.status).toHaveBeenCalledWith(200);
      expect(freshMockResponse.json).toHaveBeenCalledWith({ success: true });
    });

    it('should handle error response without recognized error code', async () => {
      mockGatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayAuthService.authenticateRequest.mockResolvedValue({ isValid: true, userId: 'user-1' });
      gatewayProtocolService.handleProtocolRequest.mockResolvedValue({
        success: false,
        error: { code: 'UNKNOWN_ERROR', message: 'Unknown error' },
      });

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        freshMockResponse,
        {},
        {},
        {}
      );

      // When error code is not in the errorCodeMap, it returns 500
      expect(freshMockResponse.status).toHaveBeenCalledWith(500);
    });

  });

  describe('handleSSE - heartbeat and disconnect', () => {
    it.skip('should send heartbeat on SSE connection', async () => {
      jest.useFakeTimers();
      const sseGateway = {
        ...mockGateway,
        type: GatewayType.MCP,
        supportsProtocol: jest.fn().mockReturnValue(true),
      };
      mockGatewayRepository.findOne.mockResolvedValue(sseGateway);

      const sseRequest = {
        ...mockRequest,
        on: jest.fn(),
      } as unknown as Request;

      const sseResponse = {
        setHeader: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
        write: jest.fn(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response;

      // Start SSE connection (returns void, runs in background)
      controller.handleSSE('test-endpoint', sseRequest, sseResponse);

      // Wait for all pending promises to resolve
      await jest.runAllTimersAsync();

      // Verify initial SSE setup and heartbeat
      expect(sseResponse.write).toHaveBeenCalled();
      const writeCalls = (sseResponse.write as jest.Mock).mock.calls;

      // Check for either initial connection or heartbeat
      expect(writeCalls.length).toBeGreaterThan(0);
      const hasHeartbeatOrConnection = writeCalls.some(call =>
        typeof call[0] === 'string' && (call[0].includes('heartbeat') || call[0].includes('connected'))
      );
      expect(hasHeartbeatOrConnection).toBe(true);

      jest.useRealTimers();
    }, 10000);

    it('should handle client disconnect on SSE', async () => {
      const sseGateway = {
        ...mockGateway,
        type: GatewayType.MCP,
        supportsProtocol: jest.fn().mockReturnValue(true),
      };
      mockGatewayRepository.findOne.mockResolvedValue(sseGateway);

      let closeCallback: (() => void) | undefined;
      const sseRequest = {
        ...mockRequest,
        on: jest.fn((event, callback) => {
          if (event === 'close') {
            closeCallback = callback;
          }
        }),
      } as unknown as Request;

      const sseResponse = {
        setHeader: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
        write: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await controller.handleSSE('test-endpoint', sseRequest, sseResponse);

      // Simulate client disconnect
      expect(closeCallback).toBeDefined();
      closeCallback!();

      // Verify disconnect was handled (no error thrown)
      expect(sseRequest.on).toHaveBeenCalledWith('close', expect.any(Function));
    });
  });

  describe('private method coverage via reflection', () => {
    it('should handle error in findGatewayByEndpoint', async () => {
      mockGatewayRepository.findOne.mockRejectedValue(new Error('Database error'));

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        mockResponse,
        {},
        {},
        {}
      );

      expect(mockResponse.status).toHaveBeenCalledWith(404);
    });

    it('should return correct content type for A2A gateway', async () => {
      const freshMockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn().mockReturnThis(),
        write: jest.fn().mockReturnThis(),
        end: jest.fn().mockReturnThis(),
      } as unknown as Response;

      const a2aGateway = {
        ...mockGateway,
        type: GatewayType.A2A,
        corsConfig: null, // No CORS to avoid extra headers
        customHeaders: null,
      };
      mockGatewayRepository.findOne.mockResolvedValue(a2aGateway);
      gatewayAuthService.authenticateRequest.mockResolvedValue({ isValid: true, userId: 'user-1' });
      gatewayProtocolService.handleProtocolRequest.mockResolvedValue({
        success: true,
        data: { message: 'test' },
      });

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        freshMockResponse,
        {},
        {},
        {}
      );

      expect(freshMockResponse.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    });

    it('should return correct content type for UTCP gateway', async () => {
      const freshMockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn().mockReturnThis(),
        write: jest.fn().mockReturnThis(),
        end: jest.fn().mockReturnThis(),
      } as unknown as Response;

      const utcpGateway = {
        ...mockGateway,
        type: GatewayType.UTCP,
        corsConfig: null, // No CORS to avoid extra headers
        customHeaders: null,
      };
      mockGatewayRepository.findOne.mockResolvedValue(utcpGateway);
      gatewayAuthService.authenticateRequest.mockResolvedValue({ isValid: true, userId: 'user-1' });
      gatewayProtocolService.handleProtocolRequest.mockResolvedValue({
        success: true,
        data: { message: 'test' },
      });

      await controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        freshMockResponse,
        {},
        {},
        {}
      );

      expect(freshMockResponse.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    });

    it('should handle saveGatewayStats error gracefully', async () => {
      const freshMockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn().mockReturnThis(),
        write: jest.fn().mockReturnThis(),
        end: jest.fn().mockReturnThis(),
      } as unknown as Response;

      const testGateway = {
        ...mockGateway,
        corsConfig: null,
        customHeaders: null,
      };

      mockGatewayRepository.findOne.mockResolvedValue(testGateway);
      gatewayAuthService.authenticateRequest.mockResolvedValue({ isValid: true, userId: 'user-1' });
      gatewayProtocolService.handleProtocolRequest.mockResolvedValue({
        success: true,
        data: { message: 'test' },
      });

      // Mock save to throw an error
      mockGatewayRepository.save.mockRejectedValue(new Error('Database error'));

      // Should not throw, error should be logged
      await expect(controller.handleGatewayRequest(
        'test-endpoint',
        mockRequest,
        freshMockResponse,
        {},
        {},
        {}
      )).resolves.not.toThrow();

      expect(freshMockResponse.status).toHaveBeenCalledWith(200);
    });
  });

  describe('getSupportedProtocols coverage', () => {
    it('should return protocols for A2A gateway in info endpoint', async () => {
      const a2aGateway = {
        ...mockGateway,
        type: GatewayType.A2A,
        getConfigForType: jest.fn().mockReturnValue({}),
        getActiveTools: jest.fn().mockReturnValue([]),
        authConfigs: [],
        description: 'Test gateway',
        status: GatewayStatus.ACTIVE,
        rateLimitConfig: null,
        lastHealthCheckAt: new Date(),
        isHealthy: true,
      };
      mockGatewayRepository.findOne.mockResolvedValue(a2aGateway);

      await controller.getGatewayInfo('test-endpoint', mockResponse);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          supportedProtocols: expect.arrayContaining(['http', 'grpc', 'websocket']),
        })
      );
    });

    it('should return protocols for UTCP gateway in info endpoint', async () => {
      const utcpGateway = {
        ...mockGateway,
        type: GatewayType.UTCP,
        getConfigForType: jest.fn().mockReturnValue({}),
        getActiveTools: jest.fn().mockReturnValue([]),
        authConfigs: [],
        description: 'Test gateway',
        status: GatewayStatus.ACTIVE,
        rateLimitConfig: null,
        lastHealthCheckAt: new Date(),
        isHealthy: true,
      };
      mockGatewayRepository.findOne.mockResolvedValue(utcpGateway);

      await controller.getGatewayInfo('test-endpoint', mockResponse);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          supportedProtocols: expect.arrayContaining(['http', 'tcp']),
        })
      );
    });
  });
});

describe('GatewayWebSocketGateway', () => {
  let websocketGateway: GatewayWebSocketGateway;
  let gatewayProtocolService: jest.Mocked<GatewayProtocolService>;
  let gatewayAuthService: jest.Mocked<GatewayAuthService>;

  const mockClient = {
    close: jest.fn(),
  } as unknown as WebSocket;

  const mockGateway = {
    id: 'gateway-1',
    name: 'Test Gateway',
    type: GatewayType.MCP,
  } as Gateway;

  beforeEach(() => {
    gatewayProtocolService = {
      handleWebSocketConnection: jest.fn(),
    } as unknown as jest.Mocked<GatewayProtocolService>;

    gatewayAuthService = {} as jest.Mocked<GatewayAuthService>;

    websocketGateway = new GatewayWebSocketGateway(
      gatewayProtocolService,
      gatewayAuthService
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleConnection', () => {
    it('should handle WebSocket connection successfully', async () => {
      const mockRequest = {
        url: '/test-endpoint?param=value',
        headers: { host: 'localhost:4000' },
      } as unknown as Request;

      // Mock findGatewayByEndpoint to return a gateway
      jest.spyOn(websocketGateway as any, 'findGatewayByEndpoint').mockResolvedValue(mockGateway);
      gatewayProtocolService.handleWebSocketConnection.mockResolvedValue(undefined);

      await websocketGateway.handleConnection(mockClient, mockRequest);

      expect(gatewayProtocolService.handleWebSocketConnection).toHaveBeenCalledWith(
        'gateway-1',
        mockClient,
        { param: 'value' }
      );
      expect(mockClient.close).not.toHaveBeenCalled();
    });

    it('should close connection if gateway not found', async () => {
      const mockRequest = {
        url: '/test-endpoint',
        headers: { host: 'localhost:4000' },
      } as unknown as Request;

      // Mock findGatewayByEndpoint to return null
      jest.spyOn(websocketGateway as any, 'findGatewayByEndpoint').mockResolvedValue(null);

      await websocketGateway.handleConnection(mockClient, mockRequest);

      expect(mockClient.close).toHaveBeenCalledWith(1003, 'Gateway not found');
      expect(gatewayProtocolService.handleWebSocketConnection).not.toHaveBeenCalled();
    });

    it('should close connection on error', async () => {
      const mockRequest = {
        url: '/test-endpoint',
        headers: { host: 'localhost:4000' },
      } as unknown as Request;

      // Mock findGatewayByEndpoint to throw an error
      jest.spyOn(websocketGateway as any, 'findGatewayByEndpoint').mockRejectedValue(
        new Error('Database error')
      );

      await websocketGateway.handleConnection(mockClient, mockRequest);

      expect(mockClient.close).toHaveBeenCalledWith(1011, 'Internal server error');
    });

    it('should handle WebSocket connection error', async () => {
      const mockRequest = {
        url: '/test-endpoint',
        headers: { host: 'localhost:4000' },
      } as unknown as Request;

      jest.spyOn(websocketGateway as any, 'findGatewayByEndpoint').mockResolvedValue(mockGateway);
      gatewayProtocolService.handleWebSocketConnection.mockRejectedValue(
        new Error('Connection error')
      );

      await websocketGateway.handleConnection(mockClient, mockRequest);

      expect(mockClient.close).toHaveBeenCalledWith(1011, 'Internal server error');
    });
  });

  describe('findGatewayByEndpoint', () => {
    it('should return null as placeholder', async () => {
      const result = await (websocketGateway as any).findGatewayByEndpoint('/test');
      expect(result).toBeNull();
    });
  });
});
