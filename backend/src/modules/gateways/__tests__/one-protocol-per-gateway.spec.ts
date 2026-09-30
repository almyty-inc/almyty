import axios from 'axios';
import * as crypto from 'crypto';
import { HttpException } from '@nestjs/common';

import { UnifiedEndpointController } from '../unified-endpoint.controller';
import { UnifiedGatewayDelegation } from '../unified-gateway-delegation.helper';
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
import { Tool, ToolExecutionMethod, ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeManager, fakeRepository } from '../../../test/fake-repository';
import { CAST, castFixture } from '../../../test/execution-access.fixture';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * One gateway, one protocol. Sharing a set of tools over MCP, UTCP and
 * Agent Skills means three gateways, each attached to the same tools: the
 * MCP one answers JSON-RPC at its address, the UTCP one serves /manual and
 * /execute at its own, and the Skills one is what `npx @almyty/skills`
 * installs from. These specs drive the real unified endpoint, the real
 * gateway auth (API keys hashed and looked up in a table), and the real MCP,
 * UTCP and Skills services over truthful tables; only the upstream HTTP call
 * is a double.
 *
 * What must hold:
 *  - each protocol lists exactly its gateway's servable set
 *    (`servableToolsOnGateway`: attached, attachment on, tool active, scope
 *    fits), and calls resolve against that same set;
 *  - each gateway refuses a request without its own key;
 *  - each gateway speaks its protocol and nothing else.
 */
describe('each gateway serves one protocol', () => {
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

  // One tool of each type, shared on one gateway per protocol: generated from an API
  // operation, and the four made by hand (HTTP, JavaScript, GraphQL, LLM).
  const handMade = { operationId: null, httpConfig: null, executionMethod: null } as Partial<Tool>;
  const EACH_TYPE = {
    api: toolRow('api_forecast'),
    http: toolRow('http_lookup', {
      ...handMade,
      type: ToolType.FUNCTION,
      executionMethod: ToolExecutionMethod.HTTP,
      httpConfig: { method: 'GET', path: 'https://hooks.example.com/lookup' },
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' }, days: { type: 'integer' }, exact: { type: 'boolean' } },
      },
    }),
    javascript: toolRow('js_reverse', {
      ...handMade,
      type: ToolType.FUNCTION,
      executionMethod: ToolExecutionMethod.CUSTOM,
      code: 'return input.text.split("").reverse().join("")',
    }),
    graphql: toolRow('gql_viewer', {
      ...handMade,
      type: ToolType.QUERY,
      executionMethod: ToolExecutionMethod.GRAPHQL,
      graphqlConfig: { endpoint: 'https://graph.example.com/graphql', query: '{ viewer { id } }' },
    }),
    llm: toolRow('llm_summarize', {
      ...handMade,
      type: ToolType.FUNCTION,
      executionMethod: ToolExecutionMethod.LLM,
      llmConfig: { providerId: 'provider-1', promptTemplate: 'Summarize {{text}}', outputMode: 'text' },
    }),
  };
  const EACH_TYPE_NAMES = Object.values(EACH_TYPE).map((t) => t.name).sort();

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
    mcp: gatewayRow('gw-mcp', GatewayType.MCP, '/weather'),
    utcp: gatewayRow('gw-utcp', GatewayType.UTCP, '/weather-utcp'),
    skills: gatewayRow('gw-skills', GatewayType.SKILLS, '/weather-skills'),
    eachMcp: gatewayRow('gw-each-mcp', GatewayType.MCP, '/each-type'),
    eachUtcp: gatewayRow('gw-each-utcp', GatewayType.UTCP, '/each-type-utcp'),
    eachSkills: gatewayRow('gw-each-skills', GatewayType.SKILLS, '/each-type-skills'),
  };

  const KEYS = {
    mcp: 'mcp_key_0123456789abcdefghijklmnopqrs',
    utcp: 'utcp_key_0123456789abcdefghijklmnopqr',
    skills: 'skills_key_0123456789abcdefghijklmnop',
    eachMcp: 'each_mcp_key_0123456789abcdefghijklm',
    eachUtcp: 'each_utcp_key_0123456789abcdefghijkl',
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
  let skills: SkillGeneratorService;
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
    const tools = fakeRepository<Tool>({ seed: [...Object.values(TOOLS), ...Object.values(EACH_TYPE)], make: () => new Tool() });
    const gatewayTable = fakeRepository<Gateway>({ seed: Object.values(GATEWAYS), make: () => new Gateway() });
    gatewayTools = fakeRepository<GatewayTool>({ make: () => new GatewayTool() });
    const apiKeys = fakeRepository<ApiKey>({
      seed: [
        keyRow(KEYS.mcp, GATEWAYS.mcp.id),
        keyRow(KEYS.utcp, GATEWAYS.utcp.id),
        keyRow(KEYS.skills, GATEWAYS.skills.id),
        keyRow(KEYS.eachMcp, GATEWAYS.eachMcp.id),
        keyRow(KEYS.eachUtcp, GATEWAYS.eachUtcp.id),
      ],
      make: () => new ApiKey(),
    });
    const operations = fakeRepository<any>(
      [...Object.values(TOOLS), EACH_TYPE.api].map((t) => ({
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

    // The same tools on the MCP, UTCP and Skills gateway. Servable: two.
    // Attached but not servable: a switched-off attachment, a draft, a team
    // tool on an org-wide gateway. `unpublished` is on no gateway here.
    for (const gateway of [GATEWAYS.mcp, GATEWAYS.utcp, GATEWAYS.skills]) {
      attach(gateway, TOOLS.weather);
      attach(gateway, TOOLS.cities);
      attach(gateway, TOOLS.switchedOff, false);
      attach(gateway, TOOLS.draft);
      attach(gateway, TOOLS.team);
    }
    for (const gateway of [GATEWAYS.eachMcp, GATEWAYS.eachUtcp, GATEWAYS.eachSkills]) {
      for (const tool of Object.values(EACH_TYPE)) attach(gateway, tool);
    }

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
    skills = new SkillGeneratorService(tools as any, gateways, gatewayTools as any, new SkillRendererHelper());

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
    opts: { method?: string; action?: string; key?: string | null; body?: any; query?: Record<string, any> } = {},
  ): Promise<{ status: number; body: any }> => {
    const method = opts.method ?? 'POST';
    const action = opts.action ?? '';
    const req: any = {
      method,
      path: `/acme/${slug}${action ? `/${action}` : ''}`,
      headers: opts.key ? { 'x-api-key': opts.key } : {},
      query: opts.query ?? {},
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
  /** What `npx @almyty/skills` installs from a Skills gateway (GET /gateways/:id/skills/individual). */
  const skillsList = (gateway: Gateway) =>
    skills.generateIndividualSkills(gateway.id, CAST.org, { orgSlug: 'acme', gatewaySlug: gateway.endpoint.replace(/^\/+/, '') });

  describe('the same tools on each protocol, one gateway each', () => {
    it('lists exactly the servable tools on MCP tools/list, the UTCP manual and the Skills list', async () => {
      expect(await mcpList('weather', KEYS.mcp)).toEqual(SERVABLE);
      expect(await utcpManual('weather-utcp', KEYS.utcp)).toEqual(SERVABLE);

      const list = await skillsList(GATEWAYS.skills);
      expect(list).toHaveLength(SERVABLE.length);
      const text = list.map((s: any) => s.content).join('\n');
      for (const name of SERVABLE) expect(text).toContain(name);
      for (const tool of NOT_SERVABLE) expect(text).not.toContain(tool.name);
    });

    it('runs a listed tool through MCP tools/call and UTCP /execute', async () => {
      const viaMcp = await send('weather', { key: KEYS.mcp, body: rpc('tools/call', { name: TOOLS.weather.name, arguments: {} }) });
      expect(viaMcp.body.result.isError).toBe(false);

      const viaUtcp = await send('weather-utcp', {
        key: KEYS.utcp,
        action: 'execute',
        body: { toolId: TOOLS.cities.id, parameters: {} },
      });
      expect(viaUtcp.body.success).toBe(true);
      expect(mockedAxios).toHaveBeenCalledTimes(2);
    });

    it.each(NOT_SERVABLE.map((t) => [t.name, t] as const))(
      'answers %s as not found on MCP and UTCP, off the network',
      async (_name, tool) => {
        const viaMcp = await send('weather', { key: KEYS.mcp, body: rpc('tools/call', { name: tool.name, arguments: {} }) });
        expect(viaMcp.body.error).toMatchObject({ code: JsonRpcErrorCode.TOOL_NOT_FOUND });

        const viaUtcp = await send('weather-utcp', { key: KEYS.utcp, action: 'execute', body: { toolId: tool.id, parameters: {} } });
        expect(viaUtcp.body).toMatchObject({ success: false, error: { code: 'TOOL_NOT_FOUND' } });
        expect(mockedAxios).not.toHaveBeenCalled();
      },
    );

    it('counts each request against the gateway it reached', async () => {
      await send('weather-utcp', { key: KEYS.utcp, method: 'GET', action: 'manual' });
      await send('weather-utcp', { key: KEYS.utcp, action: 'execute', body: { toolId: TOOLS.cities.id, parameters: {} } });
      expect(counterBumps).toEqual([GATEWAYS.utcp.id, GATEWAYS.utcp.id]);
    });
  });

  describe('every tool type, on each protocol', () => {
    /** The tool each skill is for, by the toolId its frontmatter carries. */
    const skillToolNames = (list: Array<{ content: string }>) =>
      list
        .map((s) => /toolId: "([^"]+)"/.exec(s.content)?.[1])
        .map((id) => Object.values(EACH_TYPE).find((t) => t.id === id)?.name)
        .sort();

    it('lists the same tools on MCP tools/list, the UTCP manual and the Skills list', async () => {
      expect(await mcpList('each-type', KEYS.eachMcp)).toEqual(EACH_TYPE_NAMES);
      expect(await utcpManual('each-type-utcp', KEYS.eachUtcp)).toEqual(EACH_TYPE_NAMES);
      expect(skillToolNames(await skillsList(GATEWAYS.eachSkills))).toEqual(EACH_TYPE_NAMES);
    });

    it('gives each tool a call template: the API for a generated tool, this gateway for the rest', async () => {
      const manual = (await send('each-type-utcp', { key: KEYS.eachUtcp, method: 'GET', action: 'manual' })).body;
      const template = (name: string) => manual.tools.find((t: any) => t.name === name).tool_call_template;

      expect(template(EACH_TYPE.api.name)).toMatchObject({
        call_template_type: 'http',
        http_method: 'GET',
        url: `https://upstream.example.com/${EACH_TYPE.api.name}`,
      });
      for (const tool of [EACH_TYPE.http, EACH_TYPE.javascript, EACH_TYPE.graphql, EACH_TYPE.llm]) {
        expect(template(tool.name)).toEqual({
          call_template_type: 'http',
          url: `https://api.test/acme/each-type-utcp/execute/${tool.id}`,
          http_method: 'POST',
          content_type: 'application/json',
          // The gateway's own key, as a placeholder: never the key itself.
          auth: {
            auth_type: 'api_key',
            api_key: `{{GATEWAY_${GATEWAYS.eachUtcp.id.toUpperCase()}_API_KEY}}`,
            var_name: 'x-api-key',
            location: 'header',
          },
        });
      }
    });

    it('runs a hand-made tool through the address its template names, arguments typed by its schema', async () => {
      const out = await send('each-type-utcp', {
        key: KEYS.eachUtcp,
        action: `execute/${EACH_TYPE.http.id}`,
        // What a UTCP client sends for arguments that are not a body.
        query: { city: 'Paris', days: '3', exact: 'true' },
      });

      expect(out.body.success).toBe(true);
      expect(mockedAxios).toHaveBeenCalledTimes(1);
      const request = mockedAxios.mock.calls[0][0];
      expect(request.url).toBe('https://hooks.example.com/lookup');
      expect(request.params).toEqual({ city: 'Paris', days: 3, exact: true });
    });

    it('answers a tool this gateway does not serve as not found on its execute address, off the network', async () => {
      for (const tool of [TOOLS.weather, TOOLS.unpublished]) {
        const out = await send('each-type-utcp', { key: KEYS.eachUtcp, action: `execute/${tool.id}`, body: {} });
        expect(out.body).toMatchObject({ success: false, error: { code: 'TOOL_NOT_FOUND' } });
      }
      expect(mockedAxios).not.toHaveBeenCalled();
    });

    it('refuses the execute address without this gateway\'s key', async () => {
      const action = `execute/${EACH_TYPE.http.id}`;
      expect((await send('each-type-utcp', { key: null, action })).status).toBe(401);
      expect((await send('each-type-utcp', { key: KEYS.utcp, action })).status).toBe(401);
      expect(mockedAxios).not.toHaveBeenCalled();
    });
  });

  describe('auth on each gateway', () => {
    const requests = [
      ['MCP tools/list', 'weather', { body: rpc('tools/list') }],
      ['MCP tools/call', 'weather', { body: rpc('tools/call', { name: 'get_weather', arguments: {} }) }],
      ['UTCP manual', 'weather-utcp', { method: 'GET', action: 'manual' }],
      ['UTCP execute', 'weather-utcp', { action: 'execute', body: { toolId: TOOLS.weather.id, parameters: {} } }],
    ] as const;

    it.each(requests)('refuses %s without a key', async (_label, slug, request) => {
      const out = await send(slug, { ...request, key: null });
      expect(out.status).toBe(401);
      expect(mockedAxios).not.toHaveBeenCalled();
    });

    // A key this gateway does not accept is a bad credential for it -- 401,
    // so a client knows to present a different one -- the same answer as
    // no key at all.
    it.each(requests)('refuses %s with another gateway\'s key', async (_label, slug, request) => {
      const out = await send(slug, { ...request, key: KEYS.eachMcp });
      expect(out.status).toBe(401);
      expect(mockedAxios).not.toHaveBeenCalled();
    });

    it.each(requests)('refuses %s with a made-up key', async (_label, slug, request) => {
      const out = await send(slug, { ...request, key: 'not_a_real_key_0123456789abcdefghijk' });
      expect(out.status).toBe(401);
    });
  });

  describe('each gateway speaks only its protocol', () => {
    it('an MCP gateway answers MCP whatever the path, never a UTCP manual or a skills list', async () => {
      const manual = await send('weather', { key: KEYS.mcp, method: 'GET', action: 'manual' });
      // A GET for "manual" is an MCP request with no JSON-RPC body.
      expect(manual.body?.tools).toBeUndefined();
      const list = await send('weather', { key: KEYS.mcp, method: 'GET', action: 'skills' });
      expect(list.body?.data?.skills).toBeUndefined();
    });

    it('a UTCP gateway refuses a JSON-RPC POST and a skills request', async () => {
      expect((await send('weather-utcp', { key: KEYS.utcp, body: rpc('tools/list') })).status).toBe(404);
      expect((await send('weather-utcp', { key: KEYS.utcp, method: 'GET', action: 'skills' })).status).toBe(404);
    });

    it('a Skills gateway is installed from, not called: its address answers neither MCP nor UTCP', async () => {
      expect((await send('weather-skills', { key: KEYS.skills, body: rpc('tools/list') })).status).toBe(400);
      expect((await send('weather-skills', { key: KEYS.skills, method: 'GET', action: 'manual' })).status).toBe(400);
      expect(mockedAxios).not.toHaveBeenCalled();
    });
  });
});
