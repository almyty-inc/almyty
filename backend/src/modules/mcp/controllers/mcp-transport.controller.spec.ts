import { Test, TestingModule } from '@nestjs/testing';
import { McpTransportController } from './mcp-transport.controller';
import { McpService } from '../mcp.service';
import { SseTransport } from '../transports/sse.transport';
import { snapshotEnv } from '../../../test/env';

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
      const mockResponse = { setHeader: jest.fn() };
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

      const result = await controller.sendSseMessage(connectionId, mockMessage, mockRequest, { setHeader: jest.fn() });

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

      await expect(controller.sendSseMessage('conn-123', mockMessage, mockRequest, { setHeader: jest.fn() })).rejects.toThrow('Organization context required');
    });
  });

  describe('handleServerSse', () => {
    it('should establish server-specific SSE connection successfully', async () => {
      const mockRequest = {
        user: { id: 'user-1', currentOrganizationId: 'org-1' }
      };
      const mockResponse = { setHeader: jest.fn() };
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

  // The legacy HTTP+SSE transport is deprecated in MCP 2026-07-28
  // (SEP-2596): still served, and every response says so (RFC 9745).
  describe('legacy SSE deprecation headers', () => {
    const restore = snapshotEnv('MCP_LEGACY_SSE_DEPRECATION_HEADERS', 'MCP_LEGACY_SSE_DEPRECATED_AT', 'MCP_LEGACY_SSE_DOCS_URL');
    afterEach(restore);
    const req = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
    const headersOf = (res: { setHeader: jest.Mock }) => Object.fromEntries(res.setHeader.mock.calls);

    beforeEach(() => {
      sseTransport.handleSseConnection = jest.fn().mockResolvedValue(undefined);
      sseTransport.handleSseMessage = jest.fn().mockResolvedValue({ ok: true });
    });

    it('marks all three routes deprecated, with a link to the docs', async () => {
      const expected = {
        Deprecation: '@1785196800',
        Link: '<https://docs.almyty.com/gateways/mcp#legacy-sse-transport>; rel="deprecation"; type="text/html"',
      };
      const open = { setHeader: jest.fn() };
      await controller.handleSse(req, open);
      expect(headersOf(open)).toEqual(expected);

      const message = { setHeader: jest.fn() };
      await controller.sendSseMessage('conn-1', { jsonrpc: '2.0', id: '1', method: 'tools/list' }, req, message);
      expect(headersOf(message)).toEqual(expected);

      const server = { setHeader: jest.fn() };
      await controller.handleServerSse('server-1', req, server);
      expect(headersOf(server)).toEqual(expected);
    });

    it('takes the date and the link from configuration, and can be turned off', async () => {
      process.env.MCP_LEGACY_SSE_DEPRECATED_AT = '2026-08-01T00:00:00Z';
      process.env.MCP_LEGACY_SSE_DOCS_URL = 'https://docs.example.com/sse';
      const res = { setHeader: jest.fn() };
      await controller.handleSse(req, res);
      expect(headersOf(res)).toEqual({
        Deprecation: `@${Date.UTC(2026, 7, 1) / 1000}`,
        Link: '<https://docs.example.com/sse>; rel="deprecation"; type="text/html"',
      });

      // A value that is not a URL never reaches a header.
      process.env.MCP_LEGACY_SSE_DOCS_URL = 'javascript:alert(1)';
      const fallback = { setHeader: jest.fn() };
      await controller.handleSse(req, fallback);
      expect(headersOf(fallback).Link).toContain('https://docs.almyty.com/');

      process.env.MCP_LEGACY_SSE_DEPRECATION_HEADERS = 'false';
      const off = { setHeader: jest.fn() };
      await controller.handleSse(req, off);
      expect(off.setHeader).not.toHaveBeenCalled();
    });

    it('lists sse as a deprecated transport', async () => {
      (mcpService as any).getActiveSessions = jest.fn().mockResolvedValue([]);
      sseTransport.getConnectionStats = jest.fn().mockReturnValue({ byOrganization: {} });
      const stats = await controller.getTransportStats(req);
      expect(stats.serverInfo.deprecatedTransports).toEqual(['sse']);
    });
  });

});