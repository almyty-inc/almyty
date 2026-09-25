import { NotFoundException } from '@nestjs/common';
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
import { ToolsService } from '../../tools/tools.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { SkillGeneratorService } from '../../tools/skill-generator.service';
import { PromotedSkillsService } from '../../promoted-skills/promoted-skills.service';

/**
 * MCP surfaces that serve content derived from a private resource:
 * promoted skills (skills/list, skills/get) and API resources
 * (resources/list, resources/read). Driven through McpService.handleJsonRpc
 * so the caller the transport resolved is what reaches the handlers.
 *
 * 'owner' holds a private API; 'admin' is anybody else (an org admin
 * included -- the private tier makes no role exception).
 */
describe('MCP content derived from private resources', () => {
  let mcp: McpService;
  let promoted: { listForServing: jest.Mock; get: jest.Mock };
  let resourceRepository: { find: jest.Mock; findOne: jest.Mock };

  const privateApi = { id: 'api-private', organizationId: 'org-1', visibility: 'private', ownerUserId: 'owner' };
  const orgApi = { id: 'api-org', organizationId: 'org-1', visibility: 'org', ownerUserId: 'owner' };
  const resources = [
    { id: '0b6f2c1e-5a4d-4e3f-9c2b-1a0d9e8f7c6b', name: 'SecretShape', description: null, schema: { secret: true }, api: privateApi },
    { id: '7d1e3a5c-2b4f-4a6e-8c0d-9e1f2a3b4c5d', name: 'PublicShape', description: null, schema: { open: true }, api: orgApi },
  ];

  const rpc = (method: string, params: any, userId?: string) =>
    mcp.handleJsonRpc({ jsonrpc: '2.0', id: 1, method, params }, 'org-1', userId) as Promise<any>;

  beforeEach(async () => {
    promoted = { listForServing: jest.fn().mockResolvedValue([]), get: jest.fn() };
    resourceRepository = {
      find: jest.fn().mockResolvedValue(resources),
      findOne: jest.fn(({ where }: any) => Promise.resolve(resources.find((r) => r.id === where.id) ?? null)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpToolHandler,
        McpContentHandler,
        McpServerRequestService,
        McpService,
        { provide: PromotedSkillsService, useValue: promoted },
        { provide: getRepositoryToken(Tool), useValue: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() } },
        { provide: getRepositoryToken(Resource), useValue: resourceRepository },
        { provide: getRepositoryToken(Organization), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Gateway), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(GatewayTool), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(ToolCategory), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: ToolsService, useValue: { getTools: jest.fn().mockResolvedValue({ tools: [] }) } },
        { provide: ToolExecutorService, useValue: {} },
        { provide: SkillGeneratorService, useValue: { generateToolSkill: jest.fn(), generateGatewaySkills: jest.fn() } },
        { provide: 'default_IORedisModuleConnectionToken', useValue: { get: jest.fn().mockResolvedValue(null), setex: jest.fn() } },
      ],
    }).compile();
    mcp = module.get(McpService);
  });

  describe('skills/list', () => {
    it('asks for the promoted skills the caller may see', async () => {
      await rpc('skills/list', {}, 'admin');
      expect(promoted.listForServing).toHaveBeenCalledWith('org-1', 'admin');
    });

    it('with no known caller serves no private-derived skill', async () => {
      promoted.listForServing.mockImplementation((_org: string, viewer: string | null) =>
        Promise.resolve(viewer ? [{ name: 'from-private-agent', content: 'x' }] : []),
      );
      const res = await rpc('skills/list', {});
      // The gateway-less listing refuses an unknown caller outright; if it
      // ever reaches the promoted skills it must ask with no viewer.
      expect(res.result?.skills ?? []).toEqual([]);
      for (const call of promoted.listForServing.mock.calls) expect(call[1]).toBeNull();
    });
  });

  describe('skills/get by promotedSkillId', () => {
    it("resolves as the caller; another member's private-derived skill is not found", async () => {
      promoted.get.mockRejectedValue(new NotFoundException('Promoted skill not found'));
      const res = await rpc('skills/get', { promotedSkillId: 'ps-1' }, 'admin');
      expect(promoted.get).toHaveBeenCalledWith('ps-1', 'org-1', 'admin');
      expect(res.error).toBeDefined();
      expect(res.result).toBeUndefined();
    });

    it('with no known caller resolves with null', async () => {
      promoted.get.mockRejectedValue(new NotFoundException('Promoted skill not found'));
      await rpc('skills/get', { promotedSkillId: 'ps-1' });
      expect(promoted.get).toHaveBeenCalledWith('ps-1', 'org-1', null);
    });
  });

  describe('resources/list', () => {
    const names = (res: any) => res.result.resources.map((r: any) => r.name).sort();

    it("leaves out another member's private API's resources", async () => {
      expect(names(await rpc('resources/list', {}, 'admin'))).toEqual(['PublicShape']);
    });

    it("keeps the owner's own", async () => {
      expect(names(await rpc('resources/list', {}, 'owner'))).toEqual(['PublicShape', 'SecretShape']);
    });

    it('with no known caller lists no private API resource', async () => {
      expect(names(await rpc('resources/list', {}))).toEqual(['PublicShape']);
    });
  });

  describe('resources/read', () => {
    it("reads another member's private API resource as not found", async () => {
      const res = await rpc('resources/read', { uri: 'almyty://resources/0b6f2c1e-5a4d-4e3f-9c2b-1a0d9e8f7c6b' }, 'admin');
      expect(res.result).toBeUndefined();
      expect(res.error.message).toContain('Resource not found');
    });

    it('reads it for the owner', async () => {
      const res = await rpc('resources/read', { uri: 'almyty://resources/0b6f2c1e-5a4d-4e3f-9c2b-1a0d9e8f7c6b' }, 'owner');
      expect(res.result.contents[0].text).toContain('secret');
    });

    it('with no known caller it is not found', async () => {
      const res = await rpc('resources/read', { uri: 'almyty://resources/0b6f2c1e-5a4d-4e3f-9c2b-1a0d9e8f7c6b' });
      expect(res.error.message).toContain('Resource not found');
    });
  });
});
