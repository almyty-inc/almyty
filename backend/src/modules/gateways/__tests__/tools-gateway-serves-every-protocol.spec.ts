import axios from 'axios';
import * as crypto from 'crypto';
import { HttpException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

import { UnifiedEndpointController } from '../unified-endpoint.controller';
import { UnifiedGatewayDelegation, toolsGatewayProtocol } from '../unified-gateway-delegation.helper';
import { GatewayAuthService } from '../gateway-auth.service';
import { GatewayAuthValidators } from '../gateway-auth-validators.helper';
import { GatewayResolverService } from '../../mcp/services/gateway-resolver.service';
import { McpService } from '../../mcp/mcp.service';
import { McpToolHandler } from '../../mcp/services/mcp-tool.handler';
import { UtcpService } from '../../mcp/utcp.service';
import { JsonRpcErrorCode } from '../../mcp/types/mcp.types';
import { SkillGeneratorService } from '../../tools/skill-generator.service';
import { SkillRendererHelper } from '../../tools/skill-renderer.helper';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { ToolHttpExecutor } from '../../tools/executors/tool-http.executor';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { GatewayAuth, GatewayAuthType } from '../../../entities/gateway-auth.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { ApiKey } from '../../../entities/api-key.entity';
import { Tool, ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeManager, fakeRepository } from '../../../test/fake-repository';
import { CAST, castFixture } from '../../../test/execution-access.fixture';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * One address, three protocols, one set of tools.
 *
 * A shared-tools gateway (type `tools`) is what the Share tools page makes:
 * the person picks tools and gets one address, never a protocol. A JSON-RPC
 * POST to it is MCP, /manual and /execute are UTCP, /skills lists the Agent
 * Skills. These specs drive the real unified endpoint, the real gateway
 * auth (API keys hashed and looked up in a table), and the real MCP, UTCP
 * and Skills services over truthful tables; only the upstream HTTP call is
 * a double.
 *
 * What must hold:
 *  - every protocol lists exactly the gateway's servable set
 *    (`servableToolsOnGateway`: attached, attachment on, tool active, scope
 *    fits), and calls resolve against that same set;
 *  - every protocol refuses a request without this gateway's key;
 *  - the single-protocol MCP and UTCP gateways answer as they always did,
 *    and do not pick up the other protocols.
 */
describe('a shared-tools gateway serves MCP, UTCP and Skills from one address', () => {
  const mockedAxios = axios as unknown as jest.Mock;
  const organization = { id: CAST.org, slug: 'acme', name: 'Acme' };

  let seq = 0;
  const toolRow = (name: string, extra: Partial<Tool> = {}) =>
    Object.assign(new Tool(), {
      id: `0d000000-0000-4000-8000-00000000000${++seq}`,
      name,
      description: `The ${name} tool`,
      organizationId: CAST.org,
      status: ToolStatus.ACTIVE,
      type: ToolType.API,
      httpConfig: { method: 'GET', path: 'https://upstream.example.com/things' },
      configuration: {},
      api: null,
      operation: null,
      operationId: `op-${name}`,
      parameters: { type: 'object', properties: {} },
      visibility: 'org',
      teamId: null,
      createdBy: CAST.member,
      ...extra,
    });

  const TOOLS = {
    weather: toolRow('get_weather'),
    cities: toolRow('list_cities'),
    unpublished: toolRow('delete_everything'),
    switchedOff: toolRow('switched_off'),
    draft: toolRow('draft_tool', { status: ToolStatus.DRAFT }),
    team: toolRow('team_tool', { visibility: 'team', teamId: CAST.team }),
  };
  const SERVABLE = [TOOLS.weather.name, TOOLS.cities.name].sort();
  const NOT_SERVABLE = [TOOLS.unpublished, TOOLS.switchedOff, TOOLS.draft, TOOLS.team];

  const apiKeyAuth = (gatewayId: string) =>
    Object.assign(new GatewayAuth(), {
      id: `auth-${gatewayId}`,
      gatewayId,
      type: GatewayAuthType.API_KEY,
      isActive: true,
      isRequired: true,
      configuration: { keyHeader: 'x-api-key', keyQuery: 'api_key' },
      validationRules: undefined,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

  const gatewayRow = (id: string, type: GatewayType, endpoint: string, extra: Partial<Gateway> = {}) =>
    Object.assign(new Gateway(), {
      id,
      name: id,
      type,
      kind: GatewayKind.TOOL,
      endpoint,
      organizationId: CAST.org,
      status: GatewayStatus.ACTIVE,
      visibility: 'org',
      teamId: null,
      ownerUserId: CAST.member,
      isSystem: false,
      configuration: {},
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      authConfigs: [apiKeyAuth(id)],
      ...extra,
    });

  const GATEWAYS = {
    shared: gatewayRow('gw-shared', GatewayType.TOOLS, '/shared'),
    soloMcp: gatewayRow('gw-solo-mcp', GatewayType.MCP, '/solo-mcp'),
    soloUtcp: gatewayRow('gw-solo-utcp', GatewayType.UTCP, '/solo-utcp'),
  };

  const KEYS = {
    shared: 'shared_key_0123456789abcdefghijklmnop',
    soloMcp: 'solo_mcp_key_0123456789abcdefghijklm',
    soloUtcp: 'solo_utcp_key_0123456789abcdefghijkl',
  };

  const keyRow = (raw: string, gatewayId: string) =>
    Object.assign(new ApiKey(), {
      id: `key-${gatewayId}`,
      name: `${gatewayId} key`,
      keyHash: crypto.createHash('sha256').update(raw).digest('hex'),
      isActive: true,
      gatewayId,
      organizationId: CAST.org,
      userId: CAST.member,
      scopes: ['gateway:use'],
      expiresAt: null,
      user: {
        id: CAST.member,
        isActive: true,
        organizationMemberships: [{ organizationId: CAST.org, userId: CAST.member, role: 'member', isActive: true, inviteAccepted: true }],
      },
    });

  let controller: UnifiedEndpointController;
  let gatewayTools: ReturnType<typeof fakeRepository<GatewayTool>>;
  let counterBumps: string[];

  const attach = (gateway: Gateway, tool: Tool, isActive = true) =>
    gatewayTools.seed({ id: `${gateway.id}:${tool.id}`, gatewayId: gateway.id, toolId: tool.id, isActive, tool, gateway } as any);

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
    counterBumps = [];

    const m = castFixture();
    const organizations = fakeRepository<any>([organization, { id: CAST.otherOrg, slug: 'globex', name: 'Globex' }]);
    const tools = fakeRepository<Tool>({ seed: Object.values(TOOLS), make: () => new Tool() });
    const gatewayTable = fakeRepository<Gateway>({ seed: Object.values(GATEWAYS), make: () => new Gateway() });
    gatewayTools = fakeRepository<GatewayTool>({ make: () => new GatewayTool() });
    const apiKeys = fakeRepository<ApiKey>({
      seed: [keyRow(KEYS.shared, GATEWAYS.shared.id), keyRow(KEYS.soloMcp, GATEWAYS.soloMcp.id), keyRow(KEYS.soloUtcp, GATEWAYS.soloUtcp.id)],
      make: () => new ApiKey(),
    });
    const operations = fakeRepository<any>(
      Object.values(TOOLS).map((t) => ({
        id: t.operationId,
        method: 'GET',
        endpoint: `/${t.name}`,
        parameters: {},
        api: { id: 'api-1', baseUrl: 'https://upstream.example.com', headers: {}, authentication: { type: 'none' } },
      })),
    );
    fakeManager([[Gateway, gatewayTable], [GatewayTool, gatewayTools], [Tool, tools]]);

    // The request counters are one UPDATE per request; recorded, not run.
    const gateways: any = Object.assign(Object.create(gatewayTable), gatewayTable, {
      createQueryBuilder: () => {
        let id: string | undefined;
        const qb: any = {
          update: () => qb,
          set: () => qb,
          where: (_sql: string, params: Record<string, string>) => {
            id = params.id ?? params.gatewayId;
            return qb;
          },
          andWhere: () => qb,
          execute: async () => {
            counterBumps.push(id!);
            return { affected: 1 };
          },
        };
        return qb;
      },
    });

    // Servable on the shared gateway: two tools. Attached but not servable:
    // a switched-off attachment, a draft, a team tool on an org-wide gateway.
    attach(GATEWAYS.shared, TOOLS.weather);
    attach(GATEWAYS.shared, TOOLS.cities);
    attach(GATEWAYS.shared, TOOLS.switchedOff, false);
    attach(GATEWAYS.shared, TOOLS.draft);
    attach(GATEWAYS.shared, TOOLS.team);
    attach(GATEWAYS.soloMcp, TOOLS.unpublished);
    attach(GATEWAYS.soloUtcp, TOOLS.unpublished);

    const executor = new ToolExecutorService(
      tools as any,
      {} as any,
      { findOne: jest.fn().mockResolvedValue({ hasPermissionInOrganization: () => true, organizationMemberships: [] }) } as any,
      {} as any,
      new ToolHttpExecutor({ applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any),
      {} as any,
      {} as any,
      {} as any,
      {
        checkRateLimit: jest.fn().mockResolvedValue({ limited: false }),
        getCachedResult: jest.fn().mockResolvedValue(null),
        cacheResult: jest.fn().mockResolvedValue(undefined),
      } as any,
      { validateParameters: jest.fn().mockResolvedValue({ isValid: true, errors: [] }), recordExecution: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      gatewayTools as any,
      undefined,
      m.executionAccess,
    );
    const toolsService = {
      findByName: async (name: string, organizationId: string) =>
        tools.rows().find((t) => t.name === name && t.organizationId === organizationId) ?? null,
      getTools: async ({ organizationId }: { organizationId: string }) => {
        const rows = tools.rows().filter((t) => t.organizationId === organizationId);
        return { tools: rows, total: rows.length };
      },
    };
    const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') };

    const toolHandler = new McpToolHandler(tools as any, gatewayTools as any, {} as any, toolsService as any, executor, redis as any);
    const mcp = new McpService(gateways, organizations as any, toolsService as any, toolHandler, {} as any, {} as any);
    const utcp = new UtcpService(
      tools as any,
      {} as any,
      operations as any,
      organizations as any,
      gatewayTools as any,
      toolsService as any,
      executor,
      redis as any,
    );
    const skills = new SkillGeneratorService(tools as any, gateways, gatewayTools as any, new SkillRendererHelper());

    const validators = new GatewayAuthValidators(gateways, {} as any, apiKeys as any, {} as any, {} as any);
    const authService = new GatewayAuthService(fakeRepository<GatewayAuth>([]) as any, gateways, apiKeys as any, validators);
    const resolver = new GatewayResolverService(gateways, organizations as any, authService);

    const delegation = new UnifiedGatewayDelegation(
      { findOne: jest.fn() } as any, // agents: no agent is reached here
      gateways,
      mcp,
      {} as any, // almyty platform MCP: system gateways only
      { validateAccessToken: jest.fn() } as any,
      utcp,
      resolver,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { get: jest.fn().mockReturnValue(null) } as any,
      { check: jest.fn().mockResolvedValue({ limited: false }) } as any,
      { getAdapter: jest.fn(), handleInboundMessage: jest.fn() } as any,
      undefined,
      undefined,
      undefined,
      skills,
    );
    controller = new UnifiedEndpointController(
      organizations as any,
      gateways,
      { findOne: jest.fn().mockResolvedValue(null) } as any,
      apiKeys as any,
      resolver,
      {} as any,
      {} as any,
      { get: jest.fn().mockReturnValue(null) } as any,
      { handleAgentRequest: jest.fn() } as any,
      delegation,
    );
  });

  const makeRes = () => {
    const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
    res.setHeader = (k: string, v: string) => {
      res.headers[k.toLowerCase()] = v;
    };
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    res.json = (payload: any) => {
      res.body = payload;
      return res;
    };
    res.end = () => res;
    res.send = (payload: any) => {
      res.body = payload;
      return res;
    };
    return res;
  };

  /** One request through the unified endpoint, the way Express hands it over. */
  const send = async (
    slug: string,
    opts: { method?: string; action?: string; key?: string | null; body?: any } = {},
  ): Promise<{ status: number; body: any }> => {
    const method = opts.method ?? 'POST';
    const action = opts.action ?? '';
    const req: any = {
      method,
      path: `/acme/${slug}${action ? `/${action}` : ''}`,
      headers: opts.key ? { 'x-api-key': opts.key } : {},
      query: {},
      ip: '127.0.0.1',
      body: opts.body,
      get: () => 'api.test',
      protocol: 'https',
    };
    const res = makeRes();
    try {
      if (action) await controller.handleSubPathRequest('acme', slug, req, res, opts.body);
      else await controller.handleRequest('acme', slug, req, res, opts.body);
      return { status: res.statusCode, body: res.body };
    } catch (e) {
      if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
      throw e;
    }
  };

  const rpc = (method: string, params: any = {}) => ({ jsonrpc: '2.0', id: 1, method, params });

  const mcpList = async (slug: string, key: string) =>
    (await send(slug, { key, body: rpc('tools/list') })).body.result.tools.map((t: any) => t.name).sort();
  const utcpManual = async (slug: string, key: string) =>
    (await send(slug, { key, method: 'GET', action: 'manual' })).body.tools.map((t: any) => t.name).sort();
  const skillsList = async (slug: string, key: string) => (await send(slug, { key, method: 'GET', action: 'skills' })).body.data.skills;

  describe('one servable set on every protocol', () => {
    it('lists exactly the servable tools on MCP tools/list, the UTCP manual and the Skills list', async () => {
      expect(await mcpList('shared', KEYS.shared)).toEqual(SERVABLE);
      expect(await utcpManual('shared', KEYS.shared)).toEqual(SERVABLE);

      const skills = await skillsList('shared', KEYS.shared);
      expect(skills).toHaveLength(SERVABLE.length);
      const text = skills.map((s: any) => s.content).join('\n');
      for (const name of SERVABLE) expect(text).toContain(name);
      for (const tool of NOT_SERVABLE) expect(text).not.toContain(tool.name);
    });

    it('runs a listed tool through MCP tools/call and UTCP /execute', async () => {
      const viaMcp = await send('shared', { key: KEYS.shared, body: rpc('tools/call', { name: TOOLS.weather.name, arguments: {} }) });
      expect(viaMcp.body.result.isError).toBe(false);

      const viaUtcp = await send('shared', {
        key: KEYS.shared,
        action: 'execute',
        body: { toolId: TOOLS.cities.id, parameters: {} },
      });
      expect(viaUtcp.body.success).toBe(true);
      expect(mockedAxios).toHaveBeenCalledTimes(2);
    });

    it.each(NOT_SERVABLE.map((t) => [t.name, t] as const))(
      'answers %s as not found on MCP and UTCP, off the network',
      async (_name, tool) => {
        const viaMcp = await send('shared', { key: KEYS.shared, body: rpc('tools/call', { name: tool.name, arguments: {} }) });
        expect(viaMcp.body.error).toMatchObject({ code: JsonRpcErrorCode.TOOL_NOT_FOUND });

        const viaUtcp = await send('shared', { key: KEYS.shared, action: 'execute', body: { toolId: tool.id, parameters: {} } });
        expect(viaUtcp.body).toMatchObject({ success: false, error: { code: 'TOOL_NOT_FOUND' } });
        expect(mockedAxios).not.toHaveBeenCalled();
      },
    );

    it('counts each request against the gateway', async () => {
      await send('shared', { key: KEYS.shared, method: 'GET', action: 'manual' });
      await send('shared', { key: KEYS.shared, method: 'GET', action: 'skills' });
      expect(counterBumps).toEqual([GATEWAYS.shared.id, GATEWAYS.shared.id]);
    });
  });

  describe('auth on every protocol', () => {
    const requests = [
      ['MCP tools/list', { body: rpc('tools/list') }],
      ['MCP tools/call', { body: rpc('tools/call', { name: 'get_weather', arguments: {} }) }],
      ['UTCP manual', { method: 'GET', action: 'manual' }],
      ['UTCP execute', { action: 'execute', body: { toolId: TOOLS.weather.id, parameters: {} } }],
      ['Skills list', { method: 'GET', action: 'skills' }],
    ] as const;

    it.each(requests)('refuses %s without a key', async (_label, request) => {
      const out = await send('shared', { ...request, key: null });
      expect(out.status).toBe(401);
      expect(mockedAxios).not.toHaveBeenCalled();
    });

    it.each(requests)('refuses %s with another gateway\'s key', async (_label, request) => {
      const out = await send('shared', { ...request, key: KEYS.soloMcp });
      expect(out.status).toBe(403);
      expect(mockedAxios).not.toHaveBeenCalled();
    });

    it.each(requests)('refuses %s with a made-up key', async (_label, request) => {
      const out = await send('shared', { ...request, key: 'not_a_real_key_0123456789abcdefghijk' });
      expect(out.status).toBe(403);
    });
  });

  describe('single-protocol gateways are unchanged', () => {
    it('an MCP gateway still answers MCP with its own tools and nothing else', async () => {
      expect(await mcpList('solo-mcp', KEYS.soloMcp)).toEqual([TOOLS.unpublished.name]);
      const manual = await send('solo-mcp', { key: KEYS.soloMcp, method: 'GET', action: 'manual' });
      // An MCP gateway speaks MCP whatever the path: a GET for "manual"
      // is an MCP request with no JSON-RPC body, not a UTCP manual.
      expect(manual.body?.tools).toBeUndefined();
      const skills = await send('solo-mcp', { key: KEYS.soloMcp, method: 'GET', action: 'skills' });
      expect(skills.body?.data?.skills).toBeUndefined();
    });

    it('a UTCP gateway still serves its manual and refuses a JSON-RPC POST and a skills request', async () => {
      expect(await utcpManual('solo-utcp', KEYS.soloUtcp)).toEqual([TOOLS.unpublished.name]);
      expect((await send('solo-utcp', { key: KEYS.soloUtcp, body: rpc('tools/list') })).status).toBe(404);
      expect((await send('solo-utcp', { key: KEYS.soloUtcp, method: 'GET', action: 'skills' })).status).toBe(404);
    });
  });

  describe('which protocol a path speaks', () => {
    it.each([
      ['', 'mcp'],
      ['.well-known/oauth-protected-resource', 'mcp'],
      ['.well-known/utcp', 'utcp'],
      ['manual', 'utcp'],
      ['execute', 'utcp'],
      ['skills', 'skills'],
      ['skills/../manual', null],
      ['admin', null],
    ])('%j -> %s', (action, protocol) => {
      expect(toolsGatewayProtocol(action)).toBe(protocol);
    });

    it('answers an unknown path on a shared gateway with not found, after auth', async () => {
      expect((await send('shared', { key: null, method: 'GET', action: 'admin' })).status).toBe(401);
      expect((await send('shared', { key: KEYS.shared, method: 'GET', action: 'admin' })).status).toBe(404);
    });
  });

  // The Skills service is @Optional on the delegation (positional specs
  // build it by hand), so a missing provider would boot fine and answer
  // every /skills with not found. The module has to bring it in.
  it('is wired: the unified endpoint module imports the module that exports SkillGeneratorService', () => {
    const unified = readFileSync(join(__dirname, '../unified-endpoint.module.ts'), 'utf8');
    expect(unified).toMatch(/imports:\s*\[[\s\S]*forwardRef\(\(\) => ToolsModule\)[\s\S]*\]/);
    const tools = readFileSync(join(__dirname, '../../tools/tools.module.ts'), 'utf8');
    expect(tools.slice(tools.indexOf('exports:'))).toMatch(/SkillGeneratorService/);
  });
});
