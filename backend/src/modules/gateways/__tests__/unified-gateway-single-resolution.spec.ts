import { UnifiedEndpointController } from '../unified-endpoint.controller';
import { UnifiedGatewayDelegation } from '../unified-gateway-delegation.helper';
import { GatewayAuthService } from '../gateway-auth.service';
import { GatewayResolverService } from '../../mcp/services/gateway-resolver.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { GatewayAuth, GatewayAuthType } from '../../../entities/gateway-auth.entity';
import { Organization } from '../../../entities/organization.entity';

/**
 * One gateway request, one lookup of each thing it needs.
 *
 * The unified controller resolves the organization and loads the gateway
 * (with its `authConfigs` relation) before it delegates. The resolver used
 * to redo both, and GatewayAuthService then re-queried the same auth
 * configs a third time — three redundant round trips on the hottest route
 * in the product. These tests count repository calls across a full
 * delegated request; they fail if any layer goes back to the database for
 * something the layer above already holds.
 */
describe('unified gateway request — single resolution', () => {
  let controller: UnifiedEndpointController;

  let organizationRepository: { findOne: jest.Mock };
  let gatewayRepository: any;
  let gatewayAuthRepository: { find: jest.Mock };
  let validators: { validateAuthConfig: jest.Mock };
  let mcpService: { handleJsonRpcMessage: jest.Mock };
  let resolver: GatewayResolverService;

  const organization = { id: 'org-1', slug: 'acme', name: 'Acme' } as Organization;

  const authConfigRow = (over: Partial<GatewayAuth> = {}): GatewayAuth =>
    ({
      id: 'auth-1',
      gatewayId: 'gw-1',
      type: GatewayAuthType.API_KEY,
      isActive: true,
      isRequired: true,
      configuration: { keyHeader: 'x-api-key' },
      createdAt: new Date('2024-01-01T00:00:00Z'),
      ...over,
    } as unknown as GatewayAuth);

  const gatewayRow = (authConfigs: GatewayAuth[]): Gateway =>
    ({
      id: 'gw-1',
      name: 'Acme MCP',
      endpoint: '/acme-mcp',
      type: GatewayType.MCP,
      status: GatewayStatus.ACTIVE,
      organizationId: 'org-1',
      isSystem: false,
      configuration: {},
      authConfigs,
    } as unknown as Gateway);

  const makeReq = () =>
    ({
      method: 'POST',
      path: '/acme/acme-mcp',
      headers: { 'x-api-key': 'k-1' },
      query: {},
      ip: '127.0.0.1',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    } as any);

  const makeRes = () => {
    const res: any = { statusCode: 200, setHeader: jest.fn(), end: jest.fn() };
    res.status = jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  const build = (authConfigs: GatewayAuth[]) => {
    organizationRepository = {
      findOne: jest.fn().mockResolvedValue(organization),
    };
    gatewayRepository = {
      findOne: jest.fn().mockResolvedValue(gatewayRow(authConfigs)),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
        getOne: jest.fn().mockResolvedValue(organization),
      }),
    };
    gatewayAuthRepository = {
      find: jest.fn().mockResolvedValue(authConfigs),
    };
    validators = {
      validateAuthConfig: jest.fn().mockResolvedValue({ isValid: true, userId: 'u-1' }),
    };
    mcpService = {
      handleJsonRpcMessage: jest.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} }),
    };

    const authService = new GatewayAuthService(
      gatewayAuthRepository as any,
      gatewayRepository as any,
      { findOne: jest.fn() } as any, // api key repo
      validators as any,
    );

    resolver = new GatewayResolverService(
      gatewayRepository as any,
      organizationRepository as any,
      authService,
    );

    const delegation = new UnifiedGatewayDelegation(
      { findOne: jest.fn() } as any, // agent repo
      gatewayRepository,
      mcpService as any,
      { handleJsonRpc: jest.fn() } as any, // almyty mcp
      { validateAccessToken: jest.fn() } as any, // mcp oauth
      {} as any, // utcp
      resolver,
      {} as any, // a2a server
      {} as any, // a2a agent card
      {} as any, // acp server
      {} as any, // acp discovery
      { get: jest.fn().mockReturnValue(null) } as any, // config
      { check: jest.fn().mockResolvedValue({ limited: false }) } as any, // rate limit
      { getAdapter: jest.fn(), handleInboundMessage: jest.fn() } as any, // channels
    );

    controller = new UnifiedEndpointController(
      organizationRepository as any,
      gatewayRepository,
      { findOne: jest.fn() } as any, // agent repo
      { findOne: jest.fn() } as any, // api key repo
      resolver,
      {} as any, // a2a server
      {} as any, // a2a agent card
      { get: jest.fn().mockReturnValue(null) } as any, // config
      { handleAgentRequest: jest.fn() } as any, // agent helper
      delegation,
    );
  };

  it('resolves the organization, the gateway and the auth configs exactly once each', async () => {
    build([authConfigRow()]);
    const req = makeReq();
    const res = makeRes();

    await controller.handleRequest('acme', 'acme-mcp', req, res, req.body);

    // The request actually went through: auth ran and MCP was delegated to.
    expect(validators.validateAuthConfig).toHaveBeenCalledTimes(1);
    expect(mcpService.handleJsonRpcMessage).toHaveBeenCalledTimes(1);

    // ...and nothing was looked up twice.
    expect(organizationRepository.findOne).toHaveBeenCalledTimes(1);
    expect(gatewayRepository.findOne).toHaveBeenCalledTimes(1);
    expect(gatewayAuthRepository.find).toHaveBeenCalledTimes(0);
  });

  it('hands the pre-resolved gateway straight through — the resolver queries nothing', async () => {
    build([authConfigRow()]);
    const req = makeReq();
    const gateway = gatewayRow([authConfigRow()]);

    const result = await resolver.resolveAndAuthenticate('acme', '/acme-mcp', req, {
      organization,
      gateway,
    });

    expect(result.organization).toBe(organization);
    expect(result.gateway).toBe(gateway);
    expect(result.auth.isValid).toBe(true);
    expect(organizationRepository.findOne).toHaveBeenCalledTimes(0);
    expect(gatewayRepository.findOne).toHaveBeenCalledTimes(0);
    expect(gatewayAuthRepository.find).toHaveBeenCalledTimes(0);
  });

  it('still resolves both itself when no pre-resolved pair is supplied', async () => {
    build([authConfigRow()]);
    const req = makeReq();

    const result = await resolver.resolveAndAuthenticate('acme', '/acme-mcp', req);

    expect(result.organization).toEqual(organization);
    expect(result.gateway.id).toBe('gw-1');
    expect(result.auth.isValid).toBe(true);
    expect(organizationRepository.findOne).toHaveBeenCalledTimes(1);
    expect(gatewayRepository.findOne).toHaveBeenCalledTimes(1);
  });

  it('carries the owning gateway on each pre-loaded auth config so OAuth2 org binding still has something to compare', async () => {
    build([authConfigRow({ type: GatewayAuthType.OAUTH2 } as Partial<GatewayAuth>)]);
    const req = makeReq();
    const gateway = gatewayRow([
      authConfigRow({ type: GatewayAuthType.OAUTH2 } as Partial<GatewayAuth>),
    ]);

    await resolver.resolveAndAuthenticate('acme', '/acme-mcp', req, { organization, gateway });

    expect(validators.validateAuthConfig).toHaveBeenCalledTimes(1);
    const [passedConfig] = validators.validateAuthConfig.mock.calls[0];
    expect(passedConfig.gateway).toBeDefined();
    expect(passedConfig.gateway.organizationId).toBe('org-1');
  });

  it('drops inactive auth configs from the pre-loaded set, as the query it replaces did', async () => {
    build([]);
    const req = makeReq();
    const gateway = gatewayRow([
      authConfigRow({ id: 'auth-off', isActive: false } as Partial<GatewayAuth>),
      authConfigRow({ id: 'auth-on', isActive: true } as Partial<GatewayAuth>),
    ]);

    await resolver.resolveAndAuthenticate('acme', '/acme-mcp', req, { organization, gateway });

    expect(validators.validateAuthConfig).toHaveBeenCalledTimes(1);
    expect(validators.validateAuthConfig.mock.calls[0][0].id).toBe('auth-on');
    expect(gatewayAuthRepository.find).toHaveBeenCalledTimes(0);
  });

  it('falls back to the auth-config query when the relation was never loaded', async () => {
    build([authConfigRow()]);
    const req = makeReq();
    const gateway = { ...gatewayRow([]), authConfigs: undefined } as unknown as Gateway;

    await resolver.resolveAndAuthenticate('acme', '/acme-mcp', req, { organization, gateway });

    expect(gatewayAuthRepository.find).toHaveBeenCalledTimes(1);
  });
});
