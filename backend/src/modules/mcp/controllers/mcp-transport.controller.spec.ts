import { Test, TestingModule } from '@nestjs/testing';
import { McpTransportController } from './mcp-transport.controller';
import { McpService } from '../mcp.service';
import { SseTransport } from '../transports/sse.transport';
import { StreamableHttpTransport } from '../transports/streamable-http.transport';

describe('McpTransportController', () => {
  let controller: McpTransportController;
  let mcpService: any;
  let sseTransport: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpTransportController],
      providers: [
        {
          provide: McpService,
          useValue: {
            getWellKnown: jest.fn(),
            healthCheck: jest.fn(),
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
          provide: StreamableHttpTransport,
          useValue: { handlePost: jest.fn(), handleStream: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<McpTransportController>(McpTransportController);
    mcpService = module.get(McpService);
    sseTransport = module.get(SseTransport);
  });

  describe('getTransportStats', () => {
    // Any member may call this, so it answers for the caller's organization
    // only. It used to return `connections: <platform total>` for each
    // transport beside the org's own count -- every other tenant's load, to
    // anyone with a login.
    it('counts only the caller organization, never the platform total', async () => {
      mcpService.getActiveSessions = jest.fn().mockResolvedValue([{ id: 's1' }]);
      sseTransport.getConnectionStats.mockReturnValue({
        total: 57,
        averageAge: 300,
        byOrganization: { 'org-1': 2, 'org-2': 55 },
      });

      const result = await controller.getTransportStats({ user: { currentOrganizationId: 'org-1' } });

      expect(mcpService.getActiveSessions).toHaveBeenCalledWith('org-1');
      expect(result.totalSessions).toBe(1);
      expect(result.transports).toEqual({ sse: { organizationConnections: 2 } });
      expect(JSON.stringify(result)).not.toMatch(/\b57\b|\b55\b|averageAge/);
    });

    it('refuses without an organization context instead of reading undefined', async () => {
      await expect(controller.getTransportStats({ user: {} })).rejects.toThrow('Organization context required');
    });
  });

  describe('getTransportHealth', () => {
    it('returns only a minimal {status, transports} shape — no uptime or connection counts leaked', async () => {
      // This endpoint used to dump process.uptime() + global
      // connection counts to anyone. Regression: pin the
      // stripped-down shape so nothing global slips back in.
      const result = await controller.getTransportHealth();

      expect(result).toEqual({
        status: 'healthy',
        transports: {
          sse: { status: 'active' },
        },
      });
      expect(Object.keys(result)).toEqual(['status', 'transports']);
      // No 'uptime', 'capabilities', 'connections', 'averageAge', etc.
      expect(JSON.stringify(result)).not.toMatch(/uptime|connections|averageAge/);
    });
  });

  describe('broadcast', () => {
    it('broadcasts to the organization over SSE', async () => {
      sseTransport.broadcast = jest.fn().mockResolvedValue(3);

      const result = await controller.broadcast(
        { user: { id: 'user-1', currentOrganizationId: 'org-1' } },
        { message: 'Test broadcast' },
      );

      expect(sseTransport.broadcast).toHaveBeenCalledWith('org-1', 'Test broadcast');
      expect(result).toEqual({ message: 'Broadcast sent', recipients: { sse: 3, total: 3 } });
    });

    it('should throw error when organization context is missing', async () => {
      await expect(
        controller.broadcast({ user: { id: 'user-1' } }, { message: 'Test broadcast' }),
      ).rejects.toThrow('Organization context required');
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
      // The caller's org travels with the message: the connection is
      // not proof of who is posting to it, and without this a POST to
      // somebody else's connection id ran tools in their organization
      // and returned the result to the poster.
      expect(sseTransport.handleSseMessage).toHaveBeenCalledWith(
        connectionId,
        mockMessage,
        'org-1',
        'user-1',
      );
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