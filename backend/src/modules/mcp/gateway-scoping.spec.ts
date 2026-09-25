import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { McpService } from './mcp.service';
import { McpToolHandler } from './services/mcp-tool.handler';
import { McpContentHandler } from './services/mcp-content.handler';
import { McpServerRequestService } from './services/mcp-server-request.service';
import { Tool } from '../../entities/tool.entity';
import { Resource } from '../../entities/resource.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolsService } from '../tools/tools.service';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { SkillGeneratorService } from '../tools/skill-generator.service';
import { PromotedSkillsService } from '../promoted-skills/promoted-skills.service';
import { fakeRepository } from '../../test/fake-repository';

describe('MCP Gateway Scoping', () => {
  let mcpService: McpService;
  let toolHandler: McpToolHandler;
  let contentHandler: McpContentHandler;
  let gatewayToolRepository: any;
  let module: TestingModule;

  const mockGatewayTools = [
    {
      id: 'gt-1',
      gatewayId: 'gateway-1',
      toolId: 'tool-1',
      isActive: true,
      gateway: { id: 'gateway-1', organizationId: 'org-1', visibility: 'org' },
      tool: {
        id: 'tool-1',
        name: 'open_meteo_forecast',
        description: 'Weather forecast',
        parameters: { type: 'object', properties: { latitude: { type: 'number' } }, required: ['latitude'] },
        status: 'active',
        apiId: 'api-weather',
      },
    },
  ];

  const mockAllOrgTools = [
    { id: 'tool-1', name: 'open_meteo_forecast', description: 'Weather', parameters: { type: 'object', properties: {} }, status: 'active', apiId: 'api-weather' },
    { id: 'tool-2', name: 'petstore_get_pet', description: 'Get pet', parameters: { type: 'object', properties: {} }, status: 'active', apiId: 'api-petstore' },
    { id: 'tool-3', name: 'httpbin_get', description: 'Httpbin', parameters: { type: 'object', properties: {} }, status: 'active', apiId: 'api-httpbin' },
  ];

  const mockAllResources = [
    { id: '00000000-0000-4000-8000-000000000001', name: 'HourlyResponse', description: 'Weather hourly', apiId: 'api-weather', api: { id: 'api-weather', organizationId: 'org-1' } },
    { id: '00000000-0000-4000-8000-000000000002', name: 'Pet', description: null, apiId: 'api-petstore', api: { id: 'api-petstore', organizationId: 'org-1' } },
    { id: '00000000-0000-4000-8000-000000000003', name: 'Order', description: null, apiId: 'api-petstore', api: { id: 'api-petstore', organizationId: 'org-1' } },
    { id: '00000000-0000-4000-8000-000000000004', name: 'HttpbinResponse', description: 'Httpbin resp', apiId: 'api-httpbin', api: { id: 'api-httpbin', organizationId: 'org-1' } },
  ];

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        McpToolHandler,
        McpContentHandler,
        { provide: PromotedSkillsService, useValue: { listForServing: jest.fn().mockResolvedValue([]), get: jest.fn() } },
        McpServerRequestService,
        McpService,
        {
          provide: getRepositoryToken(Tool),
          useValue: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() },
        },
        {
          // A table that evaluates the where clause, so the gateway's API
          // scope is what the query itself asks for, not a post-filter.
          provide: getRepositoryToken(Resource),
          useValue: fakeRepository(mockAllResources),
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: getRepositoryToken(Gateway),
          useValue: { findOne: jest.fn(), createQueryBuilder: jest.fn().mockReturnValue({ update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), execute: jest.fn().mockResolvedValue({}) }) },
        },
        {
          provide: getRepositoryToken(GatewayTool),
          useValue: {
            find: jest.fn().mockResolvedValue(mockGatewayTools),
          },
        },
        {
          // Weather holds the gateway's one tool; Pets holds only tools the
          // gateway does not publish.
          provide: getRepositoryToken(ToolCategory),
          useValue: fakeRepository([
            { id: 'cat-weather', name: 'Weather', slug: 'weather', organizationId: 'org-1', isActive: true, sortOrder: 0, tools: [mockAllOrgTools[0]] },
            { id: 'cat-pets', name: 'Pets', slug: 'pets', organizationId: 'org-1', isActive: true, sortOrder: 1, tools: [mockAllOrgTools[1], mockAllOrgTools[2]] },
          ] as any[]),
        },
        {
          provide: ToolsService,
          useValue: {
            getTools: jest.fn().mockResolvedValue({ tools: [] }),
          },
        },
        {
          provide: ToolExecutorService,
          useValue: {},
        },
        {
          provide: SkillGeneratorService,
          useValue: {
            generateToolSkill: jest.fn(),
            generateGatewaySkills: jest.fn(),
          },
        },
        {
          provide: 'default_IORedisModuleConnectionToken',
          useValue: { get: jest.fn().mockResolvedValue(null), setex: jest.fn() },
        },
      ],
    }).compile();

    mcpService = module.get<McpService>(McpService);
    toolHandler = module.get<McpToolHandler>(McpToolHandler);
    contentHandler = module.get<McpContentHandler>(McpContentHandler);
    gatewayToolRepository = module.get(getRepositoryToken(GatewayTool));
  });

  describe('tools/list scoping', () => {
    it('should return only gateway-assigned tools when gatewayId provided', async () => {
      const result = await toolHandler.handleToolsList({}, 'org-1', 'gateway-1');

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('open_meteo_forecast');
    });

    it('should return all organization tools the caller can see when no gatewayId', async () => {
      const toolsService = module.get(ToolsService);
      (toolsService.getTools as jest.Mock).mockResolvedValue({ tools: mockAllOrgTools });

      // The gateway-less path is team-scoped to the caller now, so it needs
      // one; with neither a gateway nor a caller the listing is refused.
      const result = await toolHandler.handleToolsList({}, 'org-1', undefined, { id: 'u-1' });

      expect(result.tools).toHaveLength(3);
    });
  });

  describe('resources/list scoping', () => {

    it('should return only resources from gateway tool APIs when gatewayId provided', async () => {
      const result = await contentHandler.handleResourcesList({}, 'org-1', 'gateway-1');

      expect(result.resources).toHaveLength(1);
      expect(result.resources[0].name).toBe('HourlyResponse');
    });

    it('should not leak resources from other APIs', async () => {
      const result = await contentHandler.handleResourcesList({}, 'org-1', 'gateway-1');

      const names = result.resources.map((r: any) => r.name);
      expect(names).not.toContain('Pet');
      expect(names).not.toContain('Order');
      expect(names).not.toContain('HttpbinResponse');
    });

    it('should return all org resources when no gatewayId', async () => {
      const result = await contentHandler.handleResourcesList({}, 'org-1');

      expect(result.resources).toHaveLength(4);
    });

    it('should return empty resources when gateway has no tools', async () => {
      gatewayToolRepository.find.mockResolvedValueOnce([]);

      const result = await contentHandler.handleResourcesList({}, 'org-1', 'gateway-empty');

      expect(result.resources).toHaveLength(0);
    });
  });

  describe('prompts/list scoping', () => {
    it('should return only prompts for gateway tools when gatewayId provided', async () => {
      // getToolsForScope uses gatewayToolRepository.find which returns mockGatewayTools
      const result = await contentHandler.handlePromptsList({}, 'org-1', 'gateway-1');

      // 1 tool prompt + 1 discovery prompt
      expect(result.prompts).toHaveLength(2);
      expect(result.prompts[0].name).toBe('use-open_meteo_forecast');
      expect(result.prompts[1].name).toBe('list-available-tools');
    });

    it('should not leak prompts from other tools', async () => {
      const result = await contentHandler.handlePromptsList({}, 'org-1', 'gateway-1');

      const names = result.prompts.map((p: any) => p.name);
      expect(names).not.toContain('use-petstore_get_pet');
      expect(names).not.toContain('use-httpbin_get');
    });

    it('should return all org prompts the caller can see when no gatewayId', async () => {
      const toolsService = module.get(ToolsService);
      (toolsService.getTools as jest.Mock).mockResolvedValue({ tools: mockAllOrgTools });

      const result = await contentHandler.handlePromptsList({}, 'org-1', undefined, { id: 'u-1' });

      // 3 tool prompts + 1 discovery prompt
      expect(result.prompts).toHaveLength(4);
    });

    it('should extract prompt arguments from gateway tool schema', async () => {
      const result = await contentHandler.handlePromptsList({}, 'org-1', 'gateway-1');

      const forecastPrompt = result.prompts[0];
      expect(forecastPrompt.arguments).toHaveLength(1);
      expect(forecastPrompt.arguments[0].name).toBe('latitude');
      expect(forecastPrompt.arguments[0].required).toBe(true);
    });
  });

  describe('resources/read scoping', () => {
    const read = (uri: string, gatewayId?: string) =>
      mcpService.handleJsonRpc({ jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri } }, 'org-1', 'u-1', gatewayId) as Promise<any>;
    const shape = (res: any) => (res.error ? { code: res.error.code, message: res.error.message } : { result: res.result });

    it('reads the resource of an API the gateway serves', async () => {
      const res = await read(`almyty://resources/${mockAllResources[0].id}`, 'gateway-1');
      expect(res.result.contents[0].uri).toBe(`almyty://resources/${mockAllResources[0].id}`);
    });

    it('answers a resource the gateway does not publish exactly like a nonexistent one', async () => {
      const missing = shape(await read('almyty://resources/00000000-0000-4000-8000-0000000000ff', 'gateway-1'));
      expect(missing).toEqual({ code: -32001, message: 'Resource not found' });
      for (const resource of mockAllResources.slice(1)) {
        expect(shape(await read(`almyty://resources/${resource.id}`, 'gateway-1'))).toEqual(missing);
      }
    });

    it('still reads any org resource off-gateway', async () => {
      const res = await read(`almyty://resources/${mockAllResources[1].id}`);
      expect(res.result.contents).toHaveLength(1);
    });
  });

  describe('tools/discover and tools/search scoping', () => {
    it('counts on a gateway only the tools the gateway serves', async () => {
      const result = await toolHandler.handleToolsDiscover({}, 'org-1', 'gateway-1', { id: 'u-1' });
      expect(result.totalTools).toBe(1);
      expect(result.categories.map((c: any) => [c.slug, c.toolCount])).toEqual([['weather', 1]]);
    });

    it('keeps org-wide category counts off-gateway', async () => {
      const toolsService = module.get(ToolsService);
      (toolsService.getTools as jest.Mock).mockResolvedValue({ tools: mockAllOrgTools, total: 3 });
      const result = await toolHandler.handleToolsDiscover({}, 'org-1', undefined, { id: 'u-1' });
      expect(result.categories.map((c: any) => [c.slug, c.toolCount])).toEqual([['weather', 1], ['pets', 2]]);
    });

    it('searches and counts on a gateway only the tools the gateway serves', async () => {
      const toolsService = module.get(ToolsService);
      (toolsService.getTools as jest.Mock).mockResolvedValue({ tools: mockAllOrgTools, total: 3 });
      const result = await toolHandler.handleToolsSearch({ query: 'e' }, 'org-1', 'gateway-1', { id: 'u-1' });
      expect(result.tools.map((t: any) => t.name)).toEqual(['open_meteo_forecast']);
      expect(result).toMatchObject({ total: 1, hasMore: false });
    });
  });

  describe('end-to-end via handleJsonRpc', () => {
    it('should scope tools, resources, and prompts when gatewayId passed', async () => {
      const gatewayRepository = module.get(getRepositoryToken(Gateway));
      (gatewayRepository as any).findOne = jest.fn().mockResolvedValue({ id: 'gateway-1', name: 'Open-Meteo', organizationId: 'org-1' });

      // tools/list
      const toolsResult = await mcpService.handleJsonRpc(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        'org-1', null, 'gateway-1',
      );
      expect(toolsResult.result.tools).toHaveLength(1);

      // resources/list
      const resourcesResult = await mcpService.handleJsonRpc(
        { jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} },
        'org-1', null, 'gateway-1',
      );
      expect(resourcesResult.result.resources).toHaveLength(1);

      // prompts/list
      const promptsResult = await mcpService.handleJsonRpc(
        { jsonrpc: '2.0', id: 3, method: 'prompts/list', params: {} },
        'org-1', null, 'gateway-1',
      );
      expect(promptsResult.result.prompts).toHaveLength(2);
    });
  });
});
