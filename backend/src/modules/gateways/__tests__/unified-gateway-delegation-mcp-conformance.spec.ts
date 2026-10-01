import { UnifiedGatewayDelegation } from '../unified-gateway-delegation.helper';
import { AlmytyMcpService } from '../../mcp/almyty-mcp.service';
import { Gateway, GatewayType } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';
import { refusingQueryBuilder } from './recording-query-builder';

/**
 * MCP wire conformance of the unified endpoint's MCP delegation.
 *
 * Two things the official SDKs care about and this path used to get wrong:
 *
 *  - JSON-RPC 2.0 §4.1: a notification (no `id`) MUST NOT be answered. The
 *    control-plane (system gateway) server answered `notifications/initialized`
 *    with `{jsonrpc, result}` and no id — not a valid JSON-RPC message of any
 *    kind. Every client sends that notification immediately after initialize.
 *
 *  - The status for a notification-only POST is 202 Accepted, not 204. The
 *    TypeScript SDK's StreamableHTTPClientTransport branches on
 *    `status === 202` to decide whether to open the server->client SSE stream.
 */
describe('UnifiedGatewayDelegation — MCP wire conformance', () => {
  let delegation: UnifiedGatewayDelegation;
  let mcpService: { handleJsonRpc: jest.Mock; handleJsonRpcMessage: jest.Mock };
  let almytyMcp: AlmytyMcpService;

  const organization = { id: 'org-1', slug: 'acme' } as Organization;

  const gw = (isSystem: boolean) =>
    ({
      id: isSystem ? 'gw-sys-1' : 'gw-mcp-1',
      type: GatewayType.MCP,
      organizationId: 'org-1',
      isSystem,
      configuration: {},
    } as unknown as Gateway);

  const makeReq = (body: any) =>
    ({
      method: 'POST',
      path: '/acme/mcp',
      headers: {},
      rawBody: Buffer.from(JSON.stringify(body)),
    } as any);

  const makeRes = () => {
    const res: any = { statusCode: 200, setHeader: jest.fn(), end: jest.fn() };
    res.status = jest.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    // Real control-plane server: the notification behaviour under test is its
    // own, and a stub would assert nothing.
    almytyMcp = new AlmytyMcpService({ get: jest.fn() } as any);
    mcpService = {
      handleJsonRpc: jest.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} }),
      handleJsonRpcMessage: jest.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} }),
    };

    delegation = new UnifiedGatewayDelegation(
      { findOne: jest.fn() } as any, // agent repo
      {
        // MCP bumps its counters inside McpService; the delegation writes
        // nothing to the gateways table on this path.
        createQueryBuilder: refusingQueryBuilder('MCP counters belong to McpService'),
      } as any, // gateway repo
      mcpService as any,
      almytyMcp as any,
      { validateAccessToken: jest.fn() } as any, // mcp oauth
      {} as any, // utcp
      { resolveAndAuthenticate: jest.fn().mockResolvedValue({ auth: { userId: 'u-1' } }) } as any,
      {} as any, // a2a server
      {} as any, // a2a agent card
      { get: jest.fn().mockReturnValue(null) } as any, // config
      { check: jest.fn().mockResolvedValue({ limited: false }) } as any, // rate limit
      { getAdapter: jest.fn(), handleInboundMessage: jest.fn() } as any, // channels
    );
  });

  const handle = (gateway: Gateway, body: any) => {
    const res = makeRes();
    return delegation
      .handleGatewayRequest(organization, gateway, 'acme', 'mcp', makeReq(body), res, body)
      .then(() => res);
  };

  it('never answers notifications/initialized on the control-plane gateway', async () => {
    const res = await handle(gw(true), { jsonrpc: '2.0', method: 'notifications/initialized' });

    expect(res.json).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.end).toHaveBeenCalled();
  });

  it('answers a real control-plane request normally', async () => {
    const res = await handle(gw(true), { jsonrpc: '2.0', id: 7, method: 'ping' });

    expect(res.json).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('returns 202, not 204, for a notification-only POST on the control plane', async () => {
    const res = await handle(gw(true), { jsonrpc: '2.0', method: 'notifications/cancelled' });

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.status).not.toHaveBeenCalledWith(204);
  });

  it('returns 202, not 204, for a notification-only POST on a tenant gateway', async () => {
    mcpService.handleJsonRpcMessage.mockResolvedValue(null);

    const res = await handle(gw(false), { jsonrpc: '2.0', method: 'notifications/initialized' });

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.status).not.toHaveBeenCalledWith(204);
    expect(res.json).not.toHaveBeenCalled();
  });

  // No server stream and no stored session: GET and DELETE are 405, which
  // the official clients and the conformance suite read as "not supported".
  it.each(['GET', 'DELETE'])('answers %s on a tenant gateway with 405 and Allow: POST', async (method) => {
    const res = makeRes();
    const req = { ...makeReq({}), method, headers: { 'mcp-session-id': 'abc' } };
    await delegation.handleGatewayRequest(organization, gw(false), 'acme', 'mcp', req, res, undefined);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', 'POST');
    expect(mcpService.handleJsonRpcMessage).not.toHaveBeenCalled();
  });

  it('refuses a foreign Origin with 403 before authenticating', async () => {
    const res = makeRes();
    const req = { ...makeReq({ jsonrpc: '2.0', id: 1, method: 'ping' }), headers: { origin: 'https://evil.example.com' } };
    const resolver = (delegation as any).gatewayResolver.resolveAndAuthenticate as jest.Mock;
    resolver.mockClear();
    await delegation.handleGatewayRequest(organization, gw(false), 'acme', 'mcp', req, res, { jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(resolver).not.toHaveBeenCalled();
    expect(mcpService.handleJsonRpcMessage).not.toHaveBeenCalled();
  });

  it('refuses a batch from a 2025-06-18 client with 400 on both gateway kinds', async () => {
    for (const system of [true, false]) {
      const res = makeRes();
      const batch = [{ jsonrpc: '2.0', id: 1, method: 'ping' }];
      const req = { ...makeReq(batch), headers: { 'mcp-protocol-version': '2025-06-18' } };
      await delegation.handleGatewayRequest(organization, gw(system), 'acme', 'mcp', req, res, batch);
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  describe('MCP 2026-07-28 requests', () => {
    const V = '2026-07-28';
    const modernBody = (method: string, params: Record<string, unknown> = {}) => ({
      jsonrpc: '2.0',
      id: 9,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': V,
          'io.modelcontextprotocol/clientCapabilities': {},
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      },
    });
    const send = async (body: any, headers: Record<string, string>) => {
      const res = makeRes();
      const req = { ...makeReq(body), headers };
      await delegation.handleGatewayRequest(organization, gw(false), 'acme', 'mcp', req, res, body);
      return res;
    };

    it('serves a request statelessly: what _meta declared reaches the service, no session id is minted or echoed', async () => {
      const res = await send(modernBody('tools/list'), { 'mcp-protocol-version': V, 'mcp-method': 'tools/list', 'mcp-session-id': 'old' });
      expect(mcpService.handleJsonRpcMessage).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'tools/list' }),
        'org-1',
        'u-1',
        'gw-mcp-1',
        expect.objectContaining({
          version: V,
          era: 'modern',
          trace: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
        }),
      );
      expect(res.setHeader).not.toHaveBeenCalledWith('Mcp-Session-Id', expect.anything());
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('refuses a header mismatch with 400 before authenticating', async () => {
      const resolver = (delegation as any).gatewayResolver.resolveAndAuthenticate as jest.Mock;
      resolver.mockClear();
      const res = await send(modernBody('tools/list'), { 'mcp-protocol-version': V, 'mcp-method': 'tools/call' });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 9, error: expect.objectContaining({ code: -32020 }) }));
      expect(resolver).not.toHaveBeenCalled();
      expect(mcpService.handleJsonRpcMessage).not.toHaveBeenCalled();
    });

    it('sends a method the modern era does not have as 404', async () => {
      mcpService.handleJsonRpcMessage.mockResolvedValue({ jsonrpc: '2.0', id: 9, error: { code: -32601, message: 'Method not found: ping' } });
      const res = await send(modernBody('ping'), { 'mcp-protocol-version': V, 'mcp-method': 'ping' });
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('still mints a session id for a legacy initialize', async () => {
      const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } } };
      const res = await send(body, {});
      expect(res.setHeader).toHaveBeenCalledWith('Mcp-Session-Id', expect.any(String));
    });
  });
});
