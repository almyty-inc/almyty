import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { McpService } from '../mcp.service';
import { McpToolHandler } from '../services/mcp-tool.handler';
import { McpContentHandler } from '../services/mcp-content.handler';
import { McpServerRequestService } from '../services/mcp-server-request.service';
import { Tool, ToolStatus } from '../../../entities/tool.entity';
import { Resource } from '../../../entities/resource.entity';
import { Organization } from '../../../entities/organization.entity';
import { Gateway } from '../../../entities/gateway.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { ToolCategory } from '../../../entities/tool-category.entity';
import { ToolsService } from '../../tools/tools.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { SkillGeneratorService } from '../../tools/skill-generator.service';
import { SkillRendererHelper } from '../../tools/skill-renderer.helper';
import { PromotedSkillsService } from '../../promoted-skills/promoted-skills.service';
import { AccessPolicyService } from '../../../common/authorization/access-policy.service';
import { fakeManager, fakeRepository } from '../../../test/fake-repository';
import { CAST, castFixture } from '../../../test/execution-access.fixture';

/**
 * Skills and resources answer from the set the surface publishes.
 *
 * Through a gateway that is the gateway's servable tools
 * (gateway-servable.ts): skills/list, skills/get by toolId and skills/get
 * by gatewayId all resolve against it, so a gateway never hands out the
 * skill of a tool it does not serve, nor another gateway's bundle. Off a
 * gateway, resources/list and resources/read are scoped to the caller the
 * way tools/list is: org-wide APIs, their own teams' APIs, their own
 * private APIs.
 *
 * Driven through McpService with the real handlers, the real skill
 * generator and the real access policy over in-memory tables.
 */
describe('MCP skills and resources answer from the published set', () => {
  const org = CAST.org;
  const id = (n: number) => `0d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  const gwA = { id: id(1), organizationId: org, name: 'Gateway A', visibility: 'org', teamId: null, ownerUserId: null, isActive: true };
  const gwB = { id: id(2), organizationId: org, name: 'Gateway B', visibility: 'org', teamId: null, ownerUserId: null, isActive: true };

  const tool = (n: number, name: string, extra: Record<string, any> = {}) => ({
    id: id(100 + n),
    organizationId: org,
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    status: ToolStatus.ACTIVE,
    visibility: 'org',
    teamId: null,
    ownerUserId: null,
    createdBy: null,
    ...extra,
  });
  const onA = tool(1, 'ServedOnA');
  const onBOnly = tool(2, 'ServedOnBOnly');
  const retiredOnA = tool(3, 'RetiredOnA', { status: ToolStatus.INACTIVE });
  const teamTool = tool(4, 'TeamOnly', { visibility: 'team', teamId: CAST.team });
  const gwTeam = { id: id(3), organizationId: org, name: 'Team Gateway', visibility: 'team', teamId: CAST.team, ownerUserId: null, isActive: true };

  const teamApi = { id: id(200), organizationId: org, name: 'team api', visibility: 'team', teamId: CAST.team, ownerUserId: null };
  const orgApi = { id: id(201), organizationId: org, name: 'org api', visibility: 'org', teamId: null, ownerUserId: null };
  const teamResource = { id: id(300), apiId: teamApi.id, name: 'TeamShape', description: null, schema: { team: true }, api: teamApi };
  const orgResource = { id: id(301), apiId: orgApi.id, name: 'OrgShape', description: null, schema: { org: true }, api: orgApi };

  let mcp: McpService;

  const rpc = (method: string, params: any, userId?: string, gatewayId?: string) =>
    mcp.handleJsonRpc({ jsonrpc: '2.0', id: 1, method, params }, org, userId, gatewayId) as Promise<any>;

  beforeEach(async () => {
    const fixture = castFixture();
    const tools = fakeRepository<any>([onA, onBOnly, retiredOnA, teamTool]);
    const gateways = fakeRepository<any>([gwA, gwB, gwTeam]);
    const gatewayTools = fakeRepository<any>([
      { id: id(401), gatewayId: gwA.id, toolId: onA.id, isActive: true, tool: onA, gateway: gwA },
      { id: id(402), gatewayId: gwB.id, toolId: onBOnly.id, isActive: true, tool: onBOnly, gateway: gwB },
      { id: id(403), gatewayId: gwA.id, toolId: retiredOnA.id, isActive: true, tool: retiredOnA, gateway: gwA },
    ]);
    fakeManager([[Gateway, gateways], [GatewayTool, gatewayTools]]);
    const resources = fakeRepository<any>([teamResource, orgResource]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpToolHandler,
        McpContentHandler,
        McpServerRequestService,
        McpService,
        SkillGeneratorService,
        SkillRendererHelper,
        { provide: AccessPolicyService, useValue: fixture.accessPolicy },
        { provide: PromotedSkillsService, useValue: { listForServing: jest.fn().mockResolvedValue([]), get: jest.fn() } },
        { provide: getRepositoryToken(Tool), useValue: tools },
        { provide: getRepositoryToken(Resource), useValue: resources },
        { provide: getRepositoryToken(Organization), useValue: fakeRepository<any>([]) },
        { provide: getRepositoryToken(Gateway), useValue: gateways },
        { provide: getRepositoryToken(GatewayTool), useValue: gatewayTools },
        { provide: getRepositoryToken(ToolCategory), useValue: fakeRepository<any>([]) },
        { provide: ToolsService, useValue: {} },
        { provide: ToolExecutorService, useValue: {} },
        { provide: 'default_IORedisModuleConnectionToken', useValue: { get: jest.fn().mockResolvedValue(null), setex: jest.fn() } },
      ],
    }).compile();
    mcp = module.get(McpService);
  });

  describe('skills/get by toolId through a gateway', () => {
    it('serves the skill of a tool the gateway serves', async () => {
      const res = await rpc('skills/get', { toolId: onA.id }, CAST.member, gwA.id);
      expect(res.error).toBeUndefined();
      expect(res.result.content).toContain('ServedOnA');
    });

    it("reads another gateway's tool as not found", async () => {
      const res = await rpc('skills/get', { toolId: onBOnly.id }, CAST.member, gwA.id);
      expect(res.result).toBeUndefined();
      expect(res.error.message).toMatch(/not found/i);
    });

    it('reads a retired tool still attached to the gateway as not found', async () => {
      const res = await rpc('skills/get', { toolId: retiredOnA.id }, CAST.member, gwA.id);
      expect(res.result).toBeUndefined();
      expect(res.error.message).toMatch(/not found/i);
    });
  });

  describe('skills/get by gatewayId through a gateway', () => {
    it('serves the bundle of the gateway being served', async () => {
      const res = await rpc('skills/get', { gatewayId: gwA.id }, CAST.member, gwA.id);
      expect(res.error).toBeUndefined();
      expect(res.result.content).toContain('ServedOnA');
    });

    it("reads another gateway's bundle as not found", async () => {
      const res = await rpc('skills/get', { gatewayId: gwB.id }, CAST.member, gwA.id);
      expect(res.result).toBeUndefined();
      expect(res.error.message).toMatch(/not found/i);
      expect(JSON.stringify(res)).not.toContain('ServedOnBOnly');
    });
  });

  describe('skills/list through a gateway', () => {
    it('bundles only the tools the gateway serves', async () => {
      const res = await rpc('skills/list', {}, CAST.member, gwA.id);
      const [bundle] = res.result.skills;
      expect(bundle.toolCount).toBe(1);
      expect(bundle.content).toContain('ServedOnA');
      expect(bundle.content).not.toContain('RetiredOnA');
      expect(bundle.content).not.toContain('ServedOnBOnly');
    });
  });


  describe('skills/get off a gateway', () => {
    it("serves a team tool's skill to the team and reads it as not found outside", async () => {
      const mine = await rpc('skills/get', { toolId: teamTool.id }, CAST.member);
      expect(mine.error).toBeUndefined();
      expect(mine.result.content).toContain('TeamOnly');
      for (const who of [CAST.nonMember, undefined]) {
        const res = await rpc('skills/get', { toolId: teamTool.id }, who);
        expect(res.result).toBeUndefined();
        expect(res.error.message).toMatch(/not found/i);
      }
    });

    it('reads a retired tool as not found, as tools/list leaves it out', async () => {
      const res = await rpc('skills/get', { toolId: retiredOnA.id }, CAST.admin);
      expect(res.result).toBeUndefined();
      expect(res.error.message).toMatch(/not found/i);
    });

    it("serves a team gateway's bundle to the team and reads it as not found outside", async () => {
      const mine = await rpc('skills/get', { gatewayId: gwTeam.id }, CAST.member);
      expect(mine.error).toBeUndefined();
      for (const who of [CAST.nonMember, undefined]) {
        const res = await rpc('skills/get', { gatewayId: gwTeam.id }, who);
        expect(res.result).toBeUndefined();
        expect(res.error.message).toMatch(/not found/i);
      }
    });
  });
  describe('resources off a gateway', () => {
    const names = (res: any) => res.result.resources.map((r: any) => r.name).sort();

    it("leaves out a team API's resources for a member outside the team", async () => {
      expect(names(await rpc('resources/list', {}, CAST.nonMember))).toEqual(['OrgShape']);
    });

    it("lists them for the team's member and for an org admin", async () => {
      expect(names(await rpc('resources/list', {}, CAST.member))).toEqual(['OrgShape', 'TeamShape']);
      expect(names(await rpc('resources/list', {}, CAST.admin))).toEqual(['OrgShape', 'TeamShape']);
    });

    it('with no known caller lists only org-wide resources', async () => {
      expect(names(await rpc('resources/list', {}))).toEqual(['OrgShape']);
    });

    it('reads a team API resource as not found outside the team', async () => {
      const res = await rpc('resources/read', { uri: `almyty://resources/${teamResource.id}` }, CAST.nonMember);
      expect(res.result).toBeUndefined();
      expect(res.error.message).toContain('Resource not found');
      const anon = await rpc('resources/read', { uri: `almyty://resources/${teamResource.id}` });
      expect(anon.error.message).toContain('Resource not found');
    });

    it("reads it for the team's member", async () => {
      const res = await rpc('resources/read', { uri: `almyty://resources/${teamResource.id}` }, CAST.member);
      expect(res.result.contents[0].text).toContain('team');
    });
  });
});
