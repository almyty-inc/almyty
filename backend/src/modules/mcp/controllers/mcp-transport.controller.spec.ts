import { Test, TestingModule } from '@nestjs/testing';
import { McpTransportController } from './mcp-transport.controller';
import { McpService } from '../mcp.service';
import { SseTransport } from '../transports/sse.transport';
import { WebSocketTransport } from '../transports/websocket.transport';

describe('McpTransportController', () => {
  let controller: McpTransportController;
  let mcpService: any;
  let sseTransport: any;
  let wsTransport: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpTransportController],
      providers: [
        {
          provide: McpService,
          useValue: {
            getWellKnown: jest.fn(),
            healthCheck: jest.fn(),
            getToolsAsMcp: jest.fn(),
            handleJsonRpc: jest.fn(),
          },
        },
        {
          provide: SseTransport,
          useValue: {
            getActiveConnections: jest.fn(),
            broadcastToAll: jest.fn(),
            getConnectionStats: jest.fn(),
          },
        },
        {
          provide: WebSocketTransport,
          useValue: {
            getActiveConnections: jest.fn(),
            broadcastToAll: jest.fn(),
            getConnectionStats: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<McpTransportController>(McpTransportController);
    mcpService = module.get(McpService);
    sseTransport = module.get(SseTransport);
    wsTransport = module.get(WebSocketTransport);
  });

  describe('getWebSocketInfo', () => {
    it('should return WebSocket information', async () => {
      const result = await controller.getWebSocketInfo();

      expect(result).toEqual({
        protocol: 'mcp-websocket',
        version: '1.0.0',
        endpoint: expect.any(String),
        features: expect.any(Object),
      });
    });
  });

  describe('getTransportStats', () => {
    it('should return transport statistics', async () => {
      const mockRequest = {
        user: { currentOrganizationId: 'org-1' }
      };

      mcpService.getActiveSessions = jest.fn().mockResolvedValue([]);
      sseTransport.getConnectionStats.mockReturnValue({
        total: 5,
        totalMessages: 100,
        averageAge: 300,
        byOrganization: { 'org-1': 2 }
      });
      wsTransport.getConnectionStats.mockReturnValue({
        total: 3,
        totalMessages: 50,
        averageAge: 200,
        byOrganization: { 'org-1': 1 }
      });

      const result = await controller.getTransportStats(mockRequest);

      expect(result).toEqual({
        totalSessions: 0,
        transports: expect.any(Object),
        serverInfo: expect.any(Object),
      });
    });
  });

  describe('getTransportHealth', () => {
    it('returns only a minimal {status, transports} shape — no uptime or connection counts leaked', async () => {
      // This endpoint used to dump process.uptime() + global
      // SSE/WS connection counts to anyone. Regression: pin the
      // stripped-down shape so nothing global slips back in.
      const result = await controller.getTransportHealth();

      expect(result).toEqual({
        status: 'healthy',
        transports: {
          sse: { status: 'active' },
          websocket: { status: 'active' },
        },
      });
      expect(Object.keys(result)).toEqual(['status', 'transports']);
      // No 'uptime', 'capabilities', 'connections', 'averageAge', etc.
      expect(JSON.stringify(result)).not.toMatch(/uptime|connections|averageAge/);
    });
  });

  describe('broadcast', () => {
    it('should broadcast message successfully', async () => {
      const mockRequest = {
        user: { id: 'user-1', currentOrganizationId: 'org-1' }
      };

      const broadcastDto = {
        message: 'Test broadcast',
        recipients: ['all'],
      };

      sseTransport.broadcast = jest.fn().mockResolvedValue(3);
      wsTransport.broadcastToOrganization = jest.fn().mockResolvedValue(2);

      const result = await controller.broadcast(mockRequest, broadcastDto);

      expect(result).toEqual({
        message: 'Broadcast sent',
        recipients: expect.any(Object),
      });
    });

    it('should throw error when organization context is missing', async () => {
      const mockRequest = {
        user: { id: 'user-1' }
      };

      const broadcastDto = {
        message: 'Test broadcast',
      };

      await expect(controller.broadcast(mockRequest, broadcastDto)).rejects.toThrow('Organization context required');
    });

    it('should broadcast only to SSE when transport is sse', async () => {
      const mockRequest = {
        user: { id: 'user-1', currentOrganizationId: 'org-1' }
      };

      const broadcastDto = {
        message: 'Test broadcast',
        transport: 'sse' as const,
      };

      sseTransport.broadcast = jest.fn().mockResolvedValue(3);
      wsTransport.broadcastToOrganization = jest.fn().mockResolvedValue(0);

      const result = await controller.broadcast(mockRequest, broadcastDto);

      expect(result.recipients.sse).toBe(3);
      expect(sseTransport.broadcast).toHaveBeenCalledWith('org-1', 'Test broadcast');
    });

    it('should broadcast only to WebSocket when transport is websocket', async () => {
      const mockRequest = {
        user: { id: 'user-1', currentOrganizationId: 'org-1' }
      };

      const broadcastDto = {
        message: 'Test broadcast',
        transport: 'websocket' as const,
      };

      sseTransport.broadcast = jest.fn().mockResolvedValue(0);
      wsTransport.broadcastToOrganization = jest.fn().mockResolvedValue(2);

      const result = await controller.broadcast(mockRequest, broadcastDto);

      expect(result.recipients.websocket).toBe(2);
      expect(wsTransport.broadcastToOrganization).toHaveBeenCalledWith('org-1', 'Test broadcast');
    });
  });

  describe('handleSse', () => {
    it('should establish SSE connection successfully', async () => {
      const mockRequest = {
        user: { id: 'user-1', currentOrganizationId: 'org-1' }
      };
      const mockResponse = {};
      const mockServerId = 'server-1';

      sseTransport.handleSseConnection = jest.fn().mockResolvedValue(undefined);

      await controller.handleSse(mockRequest, mockResponse, mockServerId);

      expect(sseTransport.handleSseConnection).toHaveBeenCalledWith(
        mockResponse,
        'org-1',
        'user-1',
        'server-1'
      );
    });

    it('should throw error when organization context is missing', async () => {
      const mockRequest = {
        user: { id: 'user-1' }
      };
      const mockResponse = {};

      await expect(controller.handleSse(mockRequest, mockResponse)).rejects.toThrow('Organization context required');
    });
  });

  describe('sendSseMessage', () => {
    it('should send SSE message successfully', async () => {
      const mockRequest = {
        user: { id: 'user-1', currentOrganizationId: 'org-1' }
      };
      const mockMessage = {
        jsonrpc: '2.0' as const,
        id: '1',
        method: 'tools/list',
      };
      const connectionId = 'conn-123';

      sseTransport.handleSseMessage = jest.fn().mockResolvedValue({ success: true });

      const result = await controller.sendSseMessage(connectionId, mockMessage, mockRequest);

      expect(result).toEqual({ success: true });
      expect(sseTransport.handleSseMessage).toHaveBeenCalledWith(connectionId, mockMessage);
    });

    it('should throw error when organization context is missing', async () => {
      const mockRequest = {
        user: { id: 'user-1' }
      };
      const mockMessage = {
        jsonrpc: '2.0' as const,
        id: '1',
        method: 'tools/list',
      };

      await expect(controller.sendSseMessage('conn-123', mockMessage, mockRequest)).rejects.toThrow('Organization context required');
    });
  });

  describe('handleServerSse', () => {
    it('should establish server-specific SSE connection successfully', async () => {
      const mockRequest = {
        user: { id: 'user-1', currentOrganizationId: 'org-1' }
      };
      const mockResponse = {};
      const serverId = 'server-123';

      sseTransport.handleSseConnection = jest.fn().mockResolvedValue(undefined);

      await controller.handleServerSse(serverId, mockRequest, mockResponse);

      expect(sseTransport.handleSseConnection).toHaveBeenCalledWith(
        mockResponse,
        'org-1',
        'user-1',
        'server-123'
      );
    });

    it('should throw error when organization context is missing', async () => {
      const mockRequest = {
        user: { id: 'user-1' }
      };
      const mockResponse = {};

      await expect(controller.handleServerSse('server-123', mockRequest, mockResponse)).rejects.toThrow('Organization context required');
    });
  });

});