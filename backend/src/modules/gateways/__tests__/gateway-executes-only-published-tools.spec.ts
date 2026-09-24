import axios from 'axios';
import { NotFoundException } from '@nestjs/common';

import { McpToolHandler } from '../../mcp/services/mcp-tool.handler';
import { UtcpService } from '../../mcp/utcp.service';
import { JsonRpcErrorCode } from '../../mcp/types/mcp.types';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { ToolHttpExecutor } from '../../tools/executors/tool-http.executor';
import { Gateway, GatewayType } from '../../../entities/gateway.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { Tool, ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeManager, fakeRepository } from '../../../test/fake-repository';
import { CAST, castFixture, MembershipFixture } from '../../../test/execution-access.fixture';
import { gatewayPrincipal } from '../../../common/authorization/execution-access.service';
import { GatewaySkillsController } from '../gateway-skills.controller';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * A gateway runs what it publishes and nothing else.
 *
 * MCP tools/call and UTCP /execute used to take any tool of the
 * organization by name or id: the gateway's attachments shaped only the
 * listing, so a client holding one gateway's key could run every org-wide
 * tool the gateway never published. A tool that is not servable on the
 * gateway -- not attached, attachment switched off, tool not active, or a
 * scope the gateway cannot carry -- must answer exactly as a tool that does
 * not exist, and never reach the network. Skills /execute already checked
 * the attachment; it now uses the same predicate as its bundle.
 *
 * Real McpToolHandler, UtcpService, GatewaySkillsController and
 * ToolExecutorService over the real ExecutionAccessService; tables are
 * truthful fakes, the network is axios.
 */
describe('a gateway executes only the tools it publishes (MCP, UTCP, Skills)', () => {
  const mockedAxios = axios as unknown as jest.Mock;

  const toolRow = (id: string, visibility: 'org' | 'team' | 'private', extra: Partial<Tool> = {}) =>
    Object.assign(new Tool(), {
      id,
      name: id,
      organizationId: CAST.org,
      status: ToolStatus.ACTIVE,
      type: ToolType.API,
      httpConfig: { method: 'GET', path: 'https://upstream.example.com/things' },
      configuration: {},
      api: null,
      operation: null,
      parameters: { type: 'object', properties: {} },
      visibility,
      teamId: visibility === 'team' ? CAST.team : null,
      createdBy: visibility === 'private' ? CAST.owner : CAST.member,
      ...extra,
    });

  const gatewayRow = (id: string, visibility: 'org' | 'team' | 'private', extra: Partial<Gateway> = {}) =>
    Object.assign(new Gateway(), {
      id,
      name: id,
      organizationId: CAST.org,
      type: GatewayType.MCP,
      visibility,
      teamId: visibility === 'team' ? CAST.team : null,
      ownerUserId: visibility === 'private' ? CAST.owner : CAST.member,
      isSystem: false,
      ...extra,
    });

  const TOOLS = {
    published: toolRow('published', 'org'),
    // Org-wide, callable by anyone in the org -- and attached to no gateway.
    unpublished: toolRow('unpublished', 'org'),
    switchedOff: toolRow('switched_off', 'org'),
    draft: toolRow('draft', 'org', { status: ToolStatus.DRAFT }),
    team: toolRow('team_tool', 'team'),
    private: toolRow('private_tool', 'private'),
  };
  const GATEWAYS = {
    org: gatewayRow('gw-org', 'org'),
    other: gatewayRow('gw-other', 'org'),
    team: gatewayRow('gw-team', 'team'),
    privateOwner: gatewayRow('gw-private-owner', 'private'),
  };

  let m: MembershipFixture;
  let tools: ReturnType<typeof fakeRepository<Tool>>;
  let gateways: ReturnType<typeof fakeRepository<Gateway>>;
  let gatewayTools: ReturnType<typeof fakeRepository<GatewayTool>>;
  let executor: ToolExecutorService;
  let executeSpy: jest.SpyInstance;
  let mcp: McpToolHandler;
  let utcp: UtcpService;

  const attach = (gateway: Gateway, tool: Tool, isActive = true) =>
    gatewayTools.seed({ id: `${gateway.id}:${tool.id}`, gatewayId: gateway.id, toolId: tool.id, isActive, tool, gateway } as any);

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
    m = castFixture();
    tools = fakeRepository<Tool>({ seed: Object.values(TOOLS), make: () => new Tool() });
    gateways = fakeRepository<Gateway>({ seed: Object.values(GATEWAYS), make: () => new Gateway() });
    gatewayTools = fakeRepository<GatewayTool>({ make: () => new GatewayTool() });
    fakeManager([[Gateway, gateways], [GatewayTool, gatewayTools], [Tool, tools]]);

    attach(GATEWAYS.org, TOOLS.published);
    attach(GATEWAYS.org, TOOLS.switchedOff, false);
    attach(GATEWAYS.org, TOOLS.draft);
    // A team tool on an org-wide gateway: refused at attach time today, but
    // a row from before that (or a gateway widened since) must not serve it.
    attach(GATEWAYS.org, TOOLS.team);
    attach(GATEWAYS.other, TOOLS.unpublished);
    attach(GATEWAYS.team, TOOLS.team);
    attach(GATEWAYS.privateOwner, TOOLS.private);

    executor = new ToolExecutorService(
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
    executeSpy = jest.spyOn(executor, 'executeTool');

    const toolsService = {
      findByName: async (name: string, organizationId: string) =>
        tools.rows().find((t) => t.name === name && t.organizationId === organizationId) ?? null,
      getTools: async ({ organizationId }: { organizationId: string }) => {
        const rows = tools.rows().filter((t) => t.organizationId === organizationId);
        return { tools: rows, total: rows.length };
      },
    };
    const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') };
    mcp = new McpToolHandler(tools as any, gatewayTools as any, {} as any, toolsService as any, executor, redis as any);
    utcp = new UtcpService(
      tools as any,
      {} as any,
      {} as any,
      {} as any,
      gatewayTools as any,
      toolsService as any,
      executor,
      redis as any,
    );
  });

  describe('MCP tools/call through a gateway', () => {
    const call = (name: string, gatewayId: string, userId?: string) =>
      mcp.handleToolCall({ name, arguments: {} }, CAST.org, userId, gatewayId);

    const refusal = async (name: string, gatewayId: string, userId?: string) => {
      const error = await call(name, gatewayId, userId).then(
        () => null,
        (e) => e,
      );
      return error && { code: error.code, message: error.message };
    };

    it('runs a tool attached to the gateway', async () => {
      const result = await call('published', GATEWAYS.org.id);
      expect(result.isError).toBe(false);
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an org tool published only on another gateway', 'unpublished'],
      ['an org tool whose attachment is switched off', 'switched_off'],
      ['an attached tool that is not active', 'draft'],
      ['a team tool on an org-wide gateway', 'team_tool'],
      ['another member\'s private tool', 'private_tool'],
    ])('answers %s exactly as a tool that does not exist, off the network', async (_label, name) => {
      const missing = await refusal('no_such_tool', GATEWAYS.org.id);
      expect(missing).toEqual({ code: JsonRpcErrorCode.TOOL_NOT_FOUND, message: 'Tool not found: no_such_tool' });
      expect(await refusal(name, GATEWAYS.org.id)).toEqual({
        code: JsonRpcErrorCode.TOOL_NOT_FOUND,
        message: `Tool not found: ${name}`,
      });
      expect(mockedAxios).not.toHaveBeenCalled();
      // Refused by the surface itself, from the set it lists: the
      // executor's own re-check is the backstop, not the answer.
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('does not serve a tool published on a different gateway of the same org', async () => {
      expect((await call('unpublished', GATEWAYS.other.id)).isError).toBe(false);
      expect(await refusal('unpublished', GATEWAYS.org.id)).toMatchObject({ code: JsonRpcErrorCode.TOOL_NOT_FOUND });
    });

    it('lists and calls from one set: every listed tool runs, every other org tool is not found', async () => {
      const listed = (await mcp.handleToolsList({}, CAST.org, GATEWAYS.org.id)).tools.map((t: any) => t.name);
      expect(listed).toEqual(['published']);
      for (const tool of tools.rows()) {
        const outcome = await call(tool.name, GATEWAYS.org.id).then(
          (r) => (r.isError ? 'error' : 'ran'),
          (e) => (e.code === JsonRpcErrorCode.TOOL_NOT_FOUND ? 'not found' : `threw ${e.message}`),
        );
        expect([tool.name, outcome]).toEqual([tool.name, listed.includes(tool.name) ? 'ran' : 'not found']);
      }
    });

    it('tools/get on a gateway describes only what the gateway serves', async () => {
      await expect((mcp as any).handleToolGet({ name: 'published' }, CAST.org, undefined, GATEWAYS.org.id)).resolves.toMatchObject({
        name: 'published',
      });
      const missing = await (mcp as any).handleToolGet({ name: 'no_such_tool' }, CAST.org, undefined, GATEWAYS.org.id).catch((e) => e);
      const unpublished = await (mcp as any).handleToolGet({ name: 'unpublished' }, CAST.org, undefined, GATEWAYS.org.id).catch((e) => e);
      expect({ code: unpublished.code, message: unpublished.message.replace('unpublished', 'X') }).toEqual({
        code: missing.code,
        message: missing.message.replace('no_such_tool', 'X'),
      });
    });

    it('keeps the team and private rules: a team tool on its team gateway, a private tool on its owner\'s private gateway', async () => {
      expect((await call('team_tool', GATEWAYS.team.id)).isError).toBe(false);
      expect((await call('private_tool', GATEWAYS.privateOwner.id, CAST.owner)).isError).toBe(false);
      // Attached is necessary, not sufficient: the private tool attached to
      // its owner's gateway is still not served to anyone else's call there.
      expect(await refusal('private_tool', GATEWAYS.privateOwner.id, CAST.member)).toMatchObject({
        code: JsonRpcErrorCode.TOOL_NOT_FOUND,
      });
    });
  });

  describe('UTCP /execute through a gateway', () => {
    const execute = (toolId: string, gateway: Gateway, userId: string | null = null) =>
      utcp.executeUtcpTool({ toolId, parameters: {} }, CAST.org, userId, gateway.id, gatewayPrincipal(gateway, userId));

    const shape = (result: any) => ({ success: result.success, error: result.error });

    it('runs a tool attached to the gateway', async () => {
      const result = await execute(TOOLS.published.id, GATEWAYS.org);
      expect(result.success).toBe(true);
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an org tool published only on another gateway', TOOLS.unpublished.id],
      ['an org tool whose attachment is switched off', TOOLS.switchedOff.id],
      ['an attached tool that is not active', TOOLS.draft.id],
      ['a team tool on an org-wide gateway', TOOLS.team.id],
      ['another member\'s private tool', TOOLS.private.id],
    ])('answers %s exactly as a tool id that does not exist, off the network', async (_label, toolId) => {
      const missing = shape(await execute('00000000-0000-4000-8000-00000000dead', GATEWAYS.org));
      expect(missing).toEqual({ success: false, error: { code: 'TOOL_NOT_FOUND', message: 'Tool not found' } });
      expect(shape(await execute(toolId, GATEWAYS.org))).toEqual(missing);
      expect(mockedAxios).not.toHaveBeenCalled();
      // Refused by the surface itself, from the set it lists: the
      // executor's own re-check is the backstop, not the answer.
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('lists and executes from one set: the manual is exactly what /execute runs', async () => {
      const servable = new Set(
        (await gatewayTools.find({ where: { gatewayId: GATEWAYS.org.id } }))
          .filter((row: any) => row.isActive && row.tool.status === ToolStatus.ACTIVE && row.tool.visibility === 'org')
          .map((row: any) => row.toolId),
      );
      expect([...servable]).toEqual([TOOLS.published.id]);
      for (const tool of tools.rows()) {
        const result = await execute(tool.id, GATEWAYS.org);
        expect([tool.id, result.success]).toEqual([tool.id, servable.has(tool.id)]);
      }
    });

    it('keeps the team and private rules', async () => {
      expect((await execute(TOOLS.team.id, GATEWAYS.team)).success).toBe(true);
      expect((await execute(TOOLS.private.id, GATEWAYS.privateOwner, CAST.owner)).success).toBe(true);
    });
  });

  describe('Skills /execute through a gateway', () => {
    let skills: GatewaySkillsController;

    beforeEach(() => {
      // GatewaysService.getGateway(id, org, true): the gateway with its
      // gateway_tools rows and their tools, read from the same tables.
      const gatewaysService = {
        getGateway: async (id: string, organizationId: string) => {
          const gateway = gateways.rows().find((g) => g.id === id && g.organizationId === organizationId);
          if (!gateway) throw new NotFoundException('Gateway not found');
          const rows = await gatewayTools.find({ where: { gatewayId: id } });
          return Object.assign(gateway, { tools: rows.map((row: any) => ({ ...row, gateway: undefined })) });
        },
        incrementRequestCount: jest.fn().mockResolvedValue(undefined),
      };
      skills = new GatewaySkillsController(gatewaysService as any, {} as any, {} as any, executor, {} as any, {} as any);
    });

    const run = (toolId: string, gateway: Gateway, userId: string = CAST.member) =>
      skills
        .executeSkill(gateway.id, toolId, { parameters: {} }, { user: { id: userId, sub: userId, currentOrganizationId: CAST.org } })
        .then(
          (r: any) => ({ ran: r.data.success }),
          (e: any) => ({ status: e.getStatus(), body: e.getResponse() }),
        );

    it('runs a tool attached to the gateway', async () => {
      expect(await run(TOOLS.published.id, GATEWAYS.org)).toEqual({ ran: true });
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an org tool published only on another gateway', TOOLS.unpublished.id],
      ['an org tool whose attachment is switched off', TOOLS.switchedOff.id],
      ['an attached tool that is not active', TOOLS.draft.id],
      ['a team tool on an org-wide gateway', TOOLS.team.id],
    ])('answers %s exactly as a tool id that does not exist, off the network', async (_label, toolId) => {
      const missing = await run('00000000-0000-4000-8000-00000000dead', GATEWAYS.org);
      expect(missing).toMatchObject({ status: 404 });
      expect(await run(toolId, GATEWAYS.org)).toEqual(missing);
      expect(mockedAxios).not.toHaveBeenCalled();
      // Refused by the surface itself, from the set it lists: the
      // executor's own re-check is the backstop, not the answer.
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('keeps the team rule: a member runs the team gateway\'s tool as themselves, another team does not', async () => {
      expect(await run(TOOLS.team.id, GATEWAYS.team, CAST.member)).toEqual({ ran: true });
      const missing = await run('00000000-0000-4000-8000-00000000dead', GATEWAYS.team, CAST.nonMember);
      expect(await run(TOOLS.team.id, GATEWAYS.team, CAST.nonMember)).toEqual(missing);
    });
  });

  describe('the executor re-checks every call that arrives through a gateway', () => {
    it('refuses, as not found, a top-level gateway call for a tool the gateway does not serve', async () => {
      const result = await executor.executeTool(TOOLS.unpublished.id, {}, {
        organizationId: CAST.org,
        userId: null,
        gatewayId: GATEWAYS.org.id,
        principal: gatewayPrincipal(GATEWAYS.org),
      });
      expect(result).toMatchObject({ success: false, notFound: true, error: 'Tool not found' });
      expect(mockedAxios).not.toHaveBeenCalled();
    });

    it('lets a published tool compose: a nested tools.invoke inside it is not a gateway call', async () => {
      const result = await executor.executeTool(TOOLS.unpublished.id, {}, {
        organizationId: CAST.org,
        userId: null,
        gatewayId: GATEWAYS.org.id,
        principal: gatewayPrincipal(GATEWAYS.org),
        invocation: { depth: 1, budget: { claim: () => () => undefined } as any },
      });
      expect(result.success).toBe(true);
    });
  });
});
