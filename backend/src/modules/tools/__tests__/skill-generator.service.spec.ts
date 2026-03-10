import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { SkillGeneratorService } from '../skill-generator.service';
import { Tool, ToolType, ToolStatus } from '../../../entities/tool.entity';
import { Gateway, GatewayType, GatewayStatus } from '../../../entities/gateway.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';

describe('SkillGeneratorService', () => {
  let service: SkillGeneratorService;
  let toolRepository: any;
  let gatewayRepository: any;
  let gatewayToolRepository: any;

  const mockTool: Partial<Tool> = {
    id: 'tool-1',
    name: 'getPetById',
    description: 'Find pet by ID',
    type: ToolType.QUERY,
    status: ToolStatus.ACTIVE,
    parameters: {
      type: 'object',
      properties: {
        petId: { type: 'integer', description: 'ID of pet to return' },
        format: { type: 'string', description: 'Response format' },
      },
      required: ['petId'],
    },
    categories: [{ id: 'cat-1', name: 'Pets' } as any],
    operation: {
      id: 'op-1',
      method: 'GET',
      endpoint: '/pet/{petId}',
    } as any,
  };

  const mockMutationTool: Partial<Tool> = {
    id: 'tool-2',
    name: 'addPet',
    description: 'Add a new pet to the store',
    type: ToolType.MUTATION,
    status: ToolStatus.ACTIVE,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Pet name' },
        status: { type: 'string', description: 'Pet status' },
      },
      required: ['name'],
    },
    categories: [],
    operation: {
      id: 'op-2',
      method: 'POST',
      endpoint: '/pet',
    } as any,
  };

  const mockGateway = {
    id: 'gw-1',
    name: 'Petstore Gateway',
    type: GatewayType.MCP,
    status: GatewayStatus.ACTIVE,
  };

  beforeEach(async () => {
    toolRepository = {
      findOne: jest.fn(),
    };
    gatewayRepository = {
      findOne: jest.fn(),
    };
    gatewayToolRepository = {
      find: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkillGeneratorService,
        { provide: getRepositoryToken(Tool), useValue: toolRepository },
        { provide: getRepositoryToken(Gateway), useValue: gatewayRepository },
        { provide: getRepositoryToken(GatewayTool), useValue: gatewayToolRepository },
      ],
    }).compile();

    service = module.get<SkillGeneratorService>(SkillGeneratorService);
  });

  describe('generateToolSkill', () => {
    it('should generate a skill for a query tool', async () => {
      toolRepository.findOne.mockResolvedValue(mockTool);

      const result = await service.generateToolSkill('tool-1');

      expect(result.name).toBe('getpetbyid');
      expect(result.toolCount).toBe(1);
      expect(result.content).toContain('---');
      expect(result.content).toContain('name: getpetbyid');
      expect(result.content).toContain('description: Find pet by ID');
      expect(result.content).toContain('tools: [getpetbyid]');
      expect(result.content).toContain('type: query');
      expect(result.content).toContain('categories: [Pets]');
      expect(result.content).toContain('method: GET');
      expect(result.content).toContain('endpoint: /pet/{petId}');
      expect(result.content).toContain('# getPetById');
      expect(result.content).toContain('## Description');
      expect(result.content).toContain('## When to use');
      expect(result.content).toContain('retrieve or look up data');
      expect(result.content).toContain('## Parameters');
      expect(result.content).toContain('`petId` (integer, **required**)');
      expect(result.content).toContain('`format` (string, optional)');
      expect(result.content).toContain('## Steps');
      expect(result.content).toContain('## Error handling');
    });

    it('should generate a skill for a mutation tool', async () => {
      toolRepository.findOne.mockResolvedValue(mockMutationTool);

      const result = await service.generateToolSkill('tool-2');

      expect(result.content).toContain('create, update, or modify data');
    });

    it('should generate a skill for an action tool', async () => {
      toolRepository.findOne.mockResolvedValue({
        ...mockTool,
        type: ToolType.ACTION,
      });

      const result = await service.generateToolSkill('tool-1');

      expect(result.content).toContain('perform an action');
    });

    it('should handle tool with no categories', async () => {
      toolRepository.findOne.mockResolvedValue({
        ...mockTool,
        categories: [],
      });

      const result = await service.generateToolSkill('tool-1');

      expect(result.content).not.toContain('categories:');
    });

    it('should handle tool with no operation', async () => {
      toolRepository.findOne.mockResolvedValue({
        ...mockTool,
        operation: null,
      });

      const result = await service.generateToolSkill('tool-1');

      expect(result.content).not.toContain('method:');
      expect(result.content).not.toContain('endpoint:');
    });

    it('should handle tool with no parameters', async () => {
      toolRepository.findOne.mockResolvedValue({
        ...mockTool,
        parameters: {},
      });

      const result = await service.generateToolSkill('tool-1');

      expect(result.content).not.toContain('## Parameters');
    });

    it('should throw NotFoundException for missing tool', async () => {
      toolRepository.findOne.mockResolvedValue(null);

      await expect(service.generateToolSkill('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should escape YAML special characters in description', async () => {
      toolRepository.findOne.mockResolvedValue({
        ...mockTool,
        description: 'Find pet: by "ID"',
      });

      const result = await service.generateToolSkill('tool-1');

      expect(result.content).toContain('description: "Find pet: by \\"ID\\""');
    });

    it('should generate steps with required and optional params', async () => {
      toolRepository.findOne.mockResolvedValue(mockTool);

      const result = await service.generateToolSkill('tool-1');

      expect(result.content).toContain('Collect required parameters: `petId`');
      expect(result.content).toContain('Optionally collect: `format`');
      expect(result.content).toContain('Call `getpetbyid`');
      expect(result.content).toContain('Return the result');
    });
  });

  describe('generateGatewaySkills', () => {
    it('should generate a skill bundle for a gateway with tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
        { tool: mockMutationTool, isActive: true },
      ]);

      const result = await service.generateGatewaySkills('gw-1');

      expect(result.name).toBe('petstore-gateway');
      expect(result.toolCount).toBe(2);
      expect(result.content).toContain('# Petstore Gateway');
      expect(result.content).toContain('This gateway provides 2 tools.');
      expect(result.content).toContain('## Available tools');
      expect(result.content).toContain('**getPetById**');
      expect(result.content).toContain('**addPet**');
      expect(result.content).toContain('### getPetById');
      expect(result.content).toContain('### addPet');
      expect(result.content).toContain('tools: [getpetbyid, addpet]');
      expect(result.content).toContain('gateway: gw-1');
      expect(result.content).toContain('toolCount: 2');
    });

    it('should generate an empty skill for a gateway with no tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([]);

      const result = await service.generateGatewaySkills('gw-1');

      expect(result.toolCount).toBe(0);
      expect(result.content).toContain('No tools are currently assigned');
      expect(result.content).toContain('tools: []');
    });

    it('should throw NotFoundException for missing gateway', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      await expect(service.generateGatewaySkills('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should filter out null tools from gateway tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
        { tool: null, isActive: true },
      ]);

      const result = await service.generateGatewaySkills('gw-1');

      expect(result.toolCount).toBe(1);
    });

    it('should include parameter details in per-tool sections', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
      ]);

      const result = await service.generateGatewaySkills('gw-1');

      expect(result.content).toContain('**Parameters:**');
      expect(result.content).toContain('`petId` (integer, required)');
      expect(result.content).toContain('`format` (string)');
    });
  });
});
