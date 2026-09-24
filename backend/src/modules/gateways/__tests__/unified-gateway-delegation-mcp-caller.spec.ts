import { UnifiedGatewayDelegation } from '../unified-gateway-delegation.helper';
import { Gateway, GatewayType } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';

/**
 * A tenant MCP gateway reached through the unified endpoint hands the MCP
 * server the caller its own auth identified, as UTCP does.
 *
 * It used to pass null. tools/call and tools/get then ran as nobody, so a
 * private gateway -- which only its owner can reach -- could not run its
 * owner's private tools, and every call went unattributed. With no user
 * identified the caller stays nobody, and private tools stay refused.
 */
describe('UnifiedGatewayDelegation — MCP caller on tenant gateways', () => {
  const organization = { id: 'org-1', slug: 'acme' } as Organization;
  const gateway = (visibility: 'org' | 'private') =>
    ({
      id: 'gw-mcp-1',
      type: GatewayType.MCP,
      organizationId: 'org-1',
      isSystem: false,
      visibility,
      ownerUserId: visibility === 'private' ? 'u-owner' : null,
      configuration: {},
    } as unknown as Gateway);

  const makeRes = () => {
    const res: any = { statusCode: 200, setHeader: jest.fn(), end: jest.fn() };
    res.status = jest.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  const build = (auth: Record<string, unknown> | null) => {
    const mcpService = {
      handleJsonRpc: jest.fn(),
      handleJsonRpcMessage: jest.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} }),
    };
    const delegation = new UnifiedGatewayDelegation(
      { findOne: jest.fn() } as any,
      {
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue(undefined),
        }),
      } as any,
      mcpService as any,
      {} as any,
      { validateAccessToken: jest.fn() } as any,
      {} as any,
      { resolveAndAuthenticate: jest.fn().mockResolvedValue({ auth }) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { get: jest.fn().mockReturnValue(null) } as any,
      { check: jest.fn().mockResolvedValue({ limited: false }) } as any,
      { getAdapter: jest.fn(), handleInboundMessage: jest.fn() } as any,
    );
    return { delegation, mcpService };
  };

  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: {} } };
  const req = { method: 'POST', path: '/acme/mcp', headers: {} } as any;

  it('passes the user the gateway key or token belongs to', async () => {
    const { delegation, mcpService } = build({ isValid: true, userId: 'u-owner' });

    await delegation.handleGatewayRequest(organization, gateway('private'), 'acme', 'mcp', req, makeRes(), body);

    expect(mcpService.handleJsonRpcMessage).toHaveBeenCalledWith(body, 'org-1', 'u-owner', 'gw-mcp-1');
  });

  it('passes the identified user on an org gateway too', async () => {
    const { delegation, mcpService } = build({ isValid: true, userId: 'u-member' });

    await delegation.handleGatewayRequest(organization, gateway('org'), 'acme', 'mcp', req, makeRes(), body);

    expect(mcpService.handleJsonRpcMessage).toHaveBeenCalledWith(body, 'org-1', 'u-member', 'gw-mcp-1');
  });

  it('passes no user when the credential names none (fails closed on private tools)', async () => {
    const { delegation, mcpService } = build({ isValid: true });

    await delegation.handleGatewayRequest(organization, gateway('org'), 'acme', 'mcp', req, makeRes(), body);

    expect(mcpService.handleJsonRpcMessage).toHaveBeenCalledWith(body, 'org-1', undefined, 'gw-mcp-1');
  });
});
