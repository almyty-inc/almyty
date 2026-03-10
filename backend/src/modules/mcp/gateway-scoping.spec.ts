import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { McpService } from './mcp.service';
import { Tool } from '../../entities/tool.entity';
import { Resource } from '../../entities/resource.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolsService } from '../tools/tools.service';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { SkillGeneratorService } from '../tools/skill-generator.service';

describe('MCP Gateway Tool Scoping', () => {
  let mcpService: McpService;
  let gatewayToolRepository: Repository<GatewayTool>;
  let module: TestingModule;

  const mockGatewayTools = [
    {
      id: 'gt-1',
      gatewayId: 'gateway-1',
      toolId: 'tool-1',
      isActive: true,
      tool: {
        id: 'tool-1',
        name: 'Petstore_Place an order',
        description: 'Place order tool',
        parameters: { type: 'object', properties: {} },
        status: 'active'
      }
    }
  ];

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        McpService,
        {
          provide: getRepositoryToken(Tool),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(Resource),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(Organization),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(Gateway),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(GatewayTool),
          useValue: {
            find: jest.fn().mockResolvedValue(mockGatewayTools),
          },
        },
        {
          provide: getRepositoryToken(ToolCategory),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
          },
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
    gatewayToolRepository = module.get(getRepositoryToken(GatewayTool));
  });

  it('should return only gateway-assigned tools when gatewayId provided', async () => {
    const result = await mcpService['handleToolsList']({}, 'org-1', 'gateway-1');

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('Petstore_Place_an_order');
    expect(gatewayToolRepository.find).toHaveBeenCalledWith({
      where: { gatewayId: 'gateway-1', isActive: true },
      relations: ['tool'],
    });
  });

  it('should return all organization tools when no gatewayId', async () => {
    const toolsService = module.get(ToolsService);
    (toolsService.getTools as jest.Mock).mockResolvedValue({
      tools: [
        { id: 'tool-1', name: 'Tool 1' },
        { id: 'tool-2', name: 'Tool 2' },
      ]
    });

    const result = await mcpService['handleToolsList']({}, 'org-1');

    expect(result.tools).toHaveLength(2);
    expect(gatewayToolRepository.find).not.toHaveBeenCalled();
  });
});
