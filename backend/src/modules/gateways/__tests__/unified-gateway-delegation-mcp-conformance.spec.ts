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
      {} as any, // acp server
      {} as any, // acp discovery
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
});
