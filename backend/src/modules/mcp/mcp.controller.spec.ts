import { Test, TestingModule } from '@nestjs/testing';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { getProtocolContext } from '../../common/interceptors/protocol-context';

describe('McpController', () => {
  let controller: McpController;
  let mcpService: { handleJsonRpcMessage: jest.Mock; healthCheck: jest.Mock };

  const makeRes = () => {
    const res: any = { statusCode: 200 };
    res.status = jest.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json = jest.fn().mockReturnValue(res);
    res.end = jest.fn().mockReturnValue(res);
    return res;
  };

  const request = (headers: Record<string, string> = {}, user: any = { id: 'user-1', currentOrganizationId: 'org-1' }) =>
    ({ user, headers }) as any;

  beforeEach(async () => {
    mcpService = {
      handleJsonRpcMessage: jest.fn(),
      healthCheck: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpController],
      providers: [{ provide: McpService, useValue: mcpService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = module.get<McpController>(McpController);
  });

  describe('handleMcp', () => {
    it('answers through the core at the version the header names', async () => {
      const body = { jsonrpc: '2.0', id: '1', method: 'tools/list' };
      const answer = { jsonrpc: '2.0', id: '1', result: { tools: [] } };
      mcpService.handleJsonRpcMessage.mockResolvedValue(answer);
      const res = makeRes();

      await controller.handleMcp(request({ 'mcp-protocol-version': '2025-11-25' }), body, res);

      expect(res.json).toHaveBeenCalledWith(answer);
      expect(mcpService.handleJsonRpcMessage).toHaveBeenCalledWith(body, 'org-1', 'user-1', undefined, {
        version: '2025-11-25',
        era: 'legacy',
      });
    });

    it('treats a request without the header as 2025-03-26, which still allows a batch', async () => {
      const batch = [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ];
      mcpService.handleJsonRpcMessage.mockResolvedValue([]);

      await controller.handleMcp(request(), batch, makeRes());

      expect(mcpService.handleJsonRpcMessage).toHaveBeenCalledWith(batch, 'org-1', 'user-1', undefined, {
        version: '2025-03-26',
        era: 'assumed',
      });
    });

    it('refuses a batch with 400 from 2025-06-18 on, before anything runs', async () => {
      const res = makeRes();
      await controller.handleMcp(
        request({ 'mcp-protocol-version': '2025-06-18' }),
        [{ jsonrpc: '2.0', id: 1, method: 'ping' }],
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].error.code).toBe(-32600);
      expect(mcpService.handleJsonRpcMessage).not.toHaveBeenCalled();
    });

    it('refuses an unsupported MCP-Protocol-Version with 400', async () => {
      const res = makeRes();
      await controller.handleMcp(
        request({ 'mcp-protocol-version': '1999-01-01' }),
        { jsonrpc: '2.0', id: 4, method: 'tools/list' },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0]).toMatchObject({ id: 4, error: { code: -32600 } });
      expect(mcpService.handleJsonRpcMessage).not.toHaveBeenCalled();
    });

    it('refuses a foreign Origin with 403', async () => {
      const res = makeRes();
      await controller.handleMcp(
        request({ origin: 'https://evil.example.com' }),
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json.mock.calls[0][0]).toMatchObject({ id: null, error: { code: -32600 } });
      expect(mcpService.handleJsonRpcMessage).not.toHaveBeenCalled();
    });

    it('answers a notification-only POST with 202 and no body', async () => {
      mcpService.handleJsonRpcMessage.mockResolvedValue(null);
      const res = makeRes();

      await controller.handleMcp(request(), { jsonrpc: '2.0', method: 'notifications/initialized' }, res);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).not.toHaveBeenCalled();
    });

    it('records the protocol version and client of an initialize on the request log', async () => {
      mcpService.handleJsonRpcMessage.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} });
      const req = request();

      await controller.handleMcp(
        req,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } },
        },
        makeRes(),
      );

      expect(getProtocolContext(req)?.mcp).toEqual({
        protocolVersion: '2025-06-18',
        era: 'legacy',
        method: 'initialize',
        clientName: 'claude-code',
        clientVersion: '2.1.0',
        outcome: 'ok',
      });
    });

    it('throws when the organization context is missing', async () => {
      await expect(
        controller.handleMcp(request({}, { id: 'user-1' }), { jsonrpc: '2.0', id: '1', method: 'tools/list' }, makeRes()),
      ).rejects.toThrow('Organization context required');
    });
  });

  describe('health', () => {
    it('should return health status', async () => {
      const mockHealth = { status: 'healthy', activeSessions: 5, serverInfo: { version: '1.0.0' } };
      mcpService.healthCheck.mockResolvedValue(mockHealth);

      await expect(controller.health()).resolves.toBe(mockHealth);
    });
  });

  describe('wellKnown', () => {
    it('names the newest version answered and every version answered', async () => {
      const result = await controller.wellKnown();

      expect(result.protocol).toBe('mcp');
      expect(result.version).toBe('2025-11-25');
      expect(result.supportedVersions).toEqual(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
      expect(result.server.name).toBe('almyty');
      expect(result.transports.http).toContain('/mcp');
    });

    // `/api` is a same-origin prefix a tenant host uses, and the ingress
    // (rewrite-target /$2) and the vite dev proxy both strip it before this
    // server sees a request. BASE_URL already names the API origin, whose
    // ingress routes `/` straight through, so `${BASE_URL}/api/mcp` named a
    // path with no route behind it.
    it('advertises transport URLs without the stripped /api prefix', async () => {
      const result = await controller.wellKnown();

      expect(result.transports.http).not.toContain('/api/');
      expect(result.transports.sse).not.toContain('/api/');
      expect(result.transports.websocket).not.toContain('/api/');
      expect(result.transports.sse).toMatch(/\/mcp\/sse$/);
    });

    // The handshake advertises listChanged: false for all three, and
    // broadcastNotification sends nothing, so a `true` here was doubly
    // false. This document is read by humans, which is exactly why it
    // has to match.
    it('advertises listChanged exactly as the handshake does', async () => {
      const result = await controller.wellKnown();

      expect(result.capabilities.tools.listChanged).toBe(false);
      expect(result.capabilities.resources.listChanged).toBe(false);
      expect(result.capabilities.prompts.listChanged).toBe(false);
    });
  });
});
