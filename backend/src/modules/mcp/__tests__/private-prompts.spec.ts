import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { McpService } from '../mcp.service';
import { McpToolHandler } from '../services/mcp-tool.handler';
import { McpContentHandler } from '../services/mcp-content.handler';
import { McpServerRequestService } from '../services/mcp-server-request.service';
import { Tool } from '../../../entities/tool.entity';
import { Resource } from '../../../entities/resource.entity';
import { Organization } from '../../../entities/organization.entity';
import { Gateway } from '../../../entities/gateway.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { ToolCategory } from '../../../entities/tool-category.entity';
import { withoutOthersPrivate } from '../../../common/authorization/private-visibility';
import { ToolsService } from '../../tools/tools.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { SkillGeneratorService } from '../../tools/skill-generator.service';
import { PromotedSkillsService } from '../../promoted-skills/promoted-skills.service';

/**
 * MCP prompts/get answers from the tool set prompts/list offered: the
 * caller's visible tools (their own private tools, nobody else's, and
 * only their teams' tools), or a gateway's servable tools. Driven through
 * McpService.handleJsonRpc so the caller the transport resolved reaches
 * the handler.
 *
 * The tool table below holds every row; ToolsService.getTools stands in
 * for the access-policy filter (it keeps what the caller may see), so a
 * handler that reads the table directly shows up as a leak.
 */
describe('MCP prompts/get and private tools', () => {
  let mcp: McpService;
  let getTools: jest.Mock;
  let gatewayTools: { find: jest.Mock };

  const ownerTool = { id: 't-private', name: 'secret-lookup', description: 'owner only', status: 'active', organizationId: 'org-1', visibility: 'private', createdBy: 'owner', parameters: { properties: { q: {} } } };
  const teamTool = { id: 't-team', name: 'team-report', description: 'team only', status: 'active', organizationId: 'org-1', visibility: 'team', teamId: 'team-a', createdBy: 'lead', parameters: {} };
  const orgTool = { id: 't-org', name: 'weather', description: 'everyone', status: 'active', organizationId: 'org-1', visibility: 'org', createdBy: 'lead', parameters: {} };
  const table = [ownerTool, teamTool, orgTool];

  const rpc = (params: any, userId?: string, gatewayId?: string) =>
    mcp.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params }, 'org-1', userId, gatewayId) as Promise<any>;

  beforeEach(async () => {
    // The caller's visible set: their own private tools, org tools, and
    // team tools only for 'lead' (the one member of team-a here).
    getTools = jest.fn(async ({ caller }: any) => ({
      tools: withoutOthersPrivate(table as any[], caller?.id ?? null).filter((t: any) => t.visibility !== 'team' || caller?.id === 'lead'),
    }));
    gatewayTools = { find: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpToolHandler,
        McpContentHandler,
        McpServerRequestService,
        McpService,
        { provide: PromotedSkillsService, useValue: { listForServing: jest.fn().mockResolvedValue([]), get: jest.fn() } },
        {
          provide: getRepositoryToken(Tool),
          useValue: {
            find: jest.fn().mockResolvedValue(table),
            findOne: jest.fn(({ where }: any) => Promise.resolve(table.find((t) => t.name === where?.name) ?? null)),
          },
        },
        { provide: getRepositoryToken(Resource), useValue: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() } },
        { provide: getRepositoryToken(Organization), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Gateway), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(GatewayTool), useValue: gatewayTools },
        { provide: getRepositoryToken(ToolCategory), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: ToolsService, useValue: { getTools } },
        { provide: ToolExecutorService, useValue: {} },
        { provide: SkillGeneratorService, useValue: { generateToolSkill: jest.fn(), generateGatewaySkills: jest.fn() } },
        { provide: 'default_IORedisModuleConnectionToken', useValue: { get: jest.fn().mockResolvedValue(null), setex: jest.fn() } },
      ],
    }).compile();
    mcp = module.get(McpService);
  });

  it('the owner gets the prompt for their own private tool', async () => {
    const res = await rpc({ name: 'use-secret-lookup' }, 'owner');
    expect(res.error).toBeUndefined();
    expect(res.result.messages[0].content.text).toContain('secret-lookup');
  });

  it('anyone else -- an admin included -- gets the same not-found as a missing tool', async () => {
    const privateOne = await rpc({ name: 'use-secret-lookup' }, 'admin');
    const missing = await rpc({ name: 'use-no-such-tool' }, 'admin');
    expect(privateOne.error).toBeDefined();
    expect(privateOne.error.code).toBe(missing.error.code);
    expect(privateOne.error.message).toBe("Tool 'secret-lookup' not found");
    expect(JSON.stringify(privateOne)).not.toContain('owner only');
  });

  it('a team tool is only offered to its team', async () => {
    expect((await rpc({ name: 'use-team-report' }, 'owner')).error).toBeDefined();
    expect((await rpc({ name: 'use-team-report' }, 'lead')).error).toBeUndefined();
  });

  it('list-available-tools lists what the caller may see, nothing else', async () => {
    const forOwner = (await rpc({ name: 'list-available-tools' }, 'owner')).result.messages[0].content.text;
    expect(forOwner).toContain('secret-lookup');
    expect(forOwner).toContain('weather');
    expect(forOwner).not.toContain('team-report');

    const forAdmin = (await rpc({ name: 'list-available-tools' }, 'admin')).result.messages[0].content.text;
    expect(forAdmin).not.toContain('secret-lookup');
    expect(forAdmin).not.toContain('team-report');
    expect(forAdmin).toContain('weather');
  });

  it('with neither a caller nor a gateway there is no tool set (fail closed)', async () => {
    expect((await rpc({ name: 'list-available-tools' })).error).toBeDefined();
    expect((await rpc({ name: 'use-weather' })).error).toBeDefined();
  });

  it('on a gateway, only that gateway\'s servable tools answer; a private tool needs the owner\'s private gateway', async () => {
    const orgGateway = { id: 'gw-1', visibility: 'org', ownerUserId: 'owner' };
    gatewayTools.find.mockResolvedValue([
      { gatewayId: 'gw-1', isActive: true, tool: orgTool, gateway: orgGateway },
      { gatewayId: 'gw-1', isActive: true, tool: ownerTool, gateway: orgGateway },
    ]);
    expect((await rpc({ name: 'use-weather' }, undefined, 'gw-1')).error).toBeUndefined();
    expect((await rpc({ name: 'use-secret-lookup' }, 'owner', 'gw-1')).error).toBeDefined();
    expect((await rpc({ name: 'use-team-report' }, 'lead', 'gw-1')).error).toBeDefined();
  });
});
