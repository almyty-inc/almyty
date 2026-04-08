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
    version: '1.0.0',
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
      api: { baseUrl: 'https://petstore.swagger.io/v2' },
    } as any,
  };

  const mockMutationTool: Partial<Tool> = {
    id: 'tool-2',
    name: 'addPet',
    description: 'Add a new pet to the store',
    type: ToolType.MUTATION,
    status: ToolStatus.ACTIVE,
    version: '1.0.0',
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
      api: { baseUrl: 'https://petstore.swagger.io/v2' },
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
    it('should generate a SKILL.md with Agent Skills standard format', async () => {
      toolRepository.findOne.mockResolvedValue(mockTool);

      const result = await service.generateToolSkill('tool-1', 'org-1');

      expect(result.name).toBe('getpetbyid');
      expect(result.toolCount).toBe(1);
      // YAML frontmatter — Agent Skills standard
      expect(result.content).toContain('---');
      expect(result.content).toContain('name: getpetbyid');
      expect(result.content).toContain('description:');
      expect(result.content).toContain('Find pet by ID');
      // Metadata
      expect(result.content).toContain('metadata:');
      expect(result.content).toContain('author: almyty');
      expect(result.content).toContain('generated: "true"');
      // Content sections
      expect(result.content).toContain('# getPetById');
      expect(result.content).toContain('## When to use');
      expect(result.content).toContain('retrieve or look up data');
      // HTTP endpoint (real curl, not fictional almyty_execute)
      expect(result.content).toContain('## HTTP endpoint');
      expect(result.content).toContain('GET https://petstore.swagger.io/v2/pet/{petId}');
      // Parameters
      expect(result.content).toContain('## Parameters');
      expect(result.content).toContain('`petId` (integer, **required**)');
      expect(result.content).toContain('`format` (string)');
      // Curl example
      expect(result.content).toContain('## Example');
      expect(result.content).toContain('curl');
      expect(result.content).toContain('petstore.swagger.io');
      // Error handling
      expect(result.content).toContain('## Error handling');
    });

    it('should generate a skill for a mutation tool with POST curl', async () => {
      toolRepository.findOne.mockResolvedValue(mockMutationTool);

      const result = await service.generateToolSkill('tool-2', 'org-1');

      expect(result.content).toContain('create, update, or modify data');
      expect(result.content).toContain('curl -X POST');
      expect(result.content).toContain('Content-Type: application/json');
    });

    it('should generate a skill for an action tool', async () => {
      toolRepository.findOne.mockResolvedValue({
        ...mockTool,
        type: ToolType.ACTION,
      });

      const result = await service.generateToolSkill('tool-1', 'org-1');

      expect(result.content).toContain('perform an action');
    });

    it('should handle tool with no parameters', async () => {
      toolRepository.findOne.mockResolvedValue({
        ...mockTool,
        parameters: {},
      });

      const result = await service.generateToolSkill('tool-1', 'org-1');

      // Should not have parameters section
      expect(result.content).not.toContain('## Parameters');
    });

    it('should throw NotFoundException for missing tool', async () => {
      toolRepository.findOne.mockResolvedValue(null);

      await expect(service.generateToolSkill('nonexistent', 'org-1')).rejects.toThrow(NotFoundException);
    });

    it('should escape YAML special characters in description', async () => {
      toolRepository.findOne.mockResolvedValue({
        ...mockTool,
        description: 'Find pet: by "ID"',
      });

      const result = await service.generateToolSkill('tool-1', 'org-1');

      // Description should be YAML-escaped (quoted)
      expect(result.content).toMatch(/description: ".*Find pet.*"/);
    });

    it('should include trigger phrase in description', async () => {
      toolRepository.findOne.mockResolvedValue(mockTool);

      const result = await service.generateToolSkill('tool-1', 'org-1');

      // Description should include "Use when" trigger phrase
      expect(result.content).toContain('Use when you need to retrieve this data.');
    });

    it('should handle tool with no operation (custom tool)', async () => {
      toolRepository.findOne.mockResolvedValue({
        ...mockTool,
        operation: null,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name to greet' },
          },
          required: ['name'],
        },
      });

      const result = await service.generateToolSkill('tool-1', 'org-1');

      // No HTTP endpoint section
      expect(result.content).not.toContain('## HTTP endpoint');
      // No error handling (only for API tools)
      expect(result.content).not.toContain('## Error handling');
      // JSON example instead of curl
      expect(result.content).toContain('```json');
    });
  });

  describe('generateGatewaySkills', () => {
    it('should generate a skill bundle for a gateway with tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
        { tool: mockMutationTool, isActive: true },
      ]);

      const result = await service.generateGatewaySkills('gw-1', 'org-1');

      expect(result.name).toBe('petstore-gateway');
      expect(result.toolCount).toBe(2);
      expect(result.content).toContain('# Petstore Gateway');
      expect(result.content).toContain('This gateway provides 2 API tools.');
      expect(result.content).toContain('## Available tools');
      expect(result.content).toContain('**getPetById**');
      expect(result.content).toContain('**addPet**');
      expect(result.content).toContain('### getPetById');
      expect(result.content).toContain('### addPet');
      // Should have HTTP endpoints, not almyty_execute
      expect(result.content).toContain('GET https://petstore.swagger.io/v2/pet/{petId}');
      expect(result.content).toContain('curl');
      // Metadata
      expect(result.content).toContain('metadata:');
      expect(result.content).toContain('author: almyty');
    });

    it('should generate an empty skill for a gateway with no tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([]);

      const result = await service.generateGatewaySkills('gw-1', 'org-1');

      expect(result.toolCount).toBe(0);
      expect(result.content).toContain('No tools are currently assigned');
      expect(result.content).toContain('metadata:');
    });

    it('should throw NotFoundException for missing gateway', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      await expect(service.generateGatewaySkills('nonexistent', 'org-1')).rejects.toThrow(NotFoundException);
    });

    it('should filter out null tools from gateway tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
        { tool: null, isActive: true },
      ]);

      const result = await service.generateGatewaySkills('gw-1', 'org-1');

      expect(result.toolCount).toBe(1);
    });

    it('should include parameter details in per-tool sections', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
      ]);

      const result = await service.generateGatewaySkills('gw-1', 'org-1');

      expect(result.content).toContain('**Parameters:**');
      expect(result.content).toContain('`petId` (integer, required)');
      expect(result.content).toContain('`format` (string)');
    });
  });

  describe('generateIndividualSkills', () => {
    it('should generate individual SKILL.md files with name matching directory', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
        { tool: mockMutationTool, isActive: true },
      ]);

      const result = await service.generateIndividualSkills('gw-1', 'org-1');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('getpetbyid');
      expect(result[0].fileName).toBe('almyty-getpetbyid');
      // Frontmatter name MUST match directory name (Agent Skills spec compliance)
      expect(result[0].content).toContain('name: almyty-getpetbyid');
      expect(result[0].content).toContain('curl');
      expect(result[1].name).toBe('addpet');
      expect(result[1].fileName).toBe('almyty-addpet');
      expect(result[1].content).toContain('name: almyty-addpet');
    });

    it('should throw NotFoundException for missing gateway', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      await expect(service.generateIndividualSkills('nonexistent', 'org-1')).rejects.toThrow(NotFoundException);
    });

    it('should return empty array for gateway with no tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([]);

      const result = await service.generateIndividualSkills('gw-1', 'org-1');

      expect(result).toHaveLength(0);
    });
  });
});
