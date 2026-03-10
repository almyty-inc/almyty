import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { CliGeneratorService } from '../cli-generator.service';
import { Tool, ToolType, ToolStatus, ToolExecutionMethod } from '../../../entities/tool.entity';
import { Gateway, GatewayType, GatewayStatus } from '../../../entities/gateway.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';

describe('CliGeneratorService', () => {
  let service: CliGeneratorService;
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
    operation: {
      id: 'op-1',
      method: 'GET',
      endpoint: '/pet/{petId}',
    } as any,
  };

  const mockGateway = {
    id: 'gw-1',
    name: 'Petstore Gateway',
    type: GatewayType.MCP,
    status: GatewayStatus.ACTIVE,
  };

  beforeEach(async () => {
    toolRepository = { findOne: jest.fn() };
    gatewayRepository = { findOne: jest.fn() };
    gatewayToolRepository = { find: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CliGeneratorService,
        { provide: getRepositoryToken(Tool), useValue: toolRepository },
        { provide: getRepositoryToken(Gateway), useValue: gatewayRepository },
        { provide: getRepositoryToken(GatewayTool), useValue: gatewayToolRepository },
      ],
    }).compile();

    service = module.get<CliGeneratorService>(CliGeneratorService);
  });

  describe('generateToolCli - bash', () => {
    it('should generate a bash script for a tool', async () => {
      toolRepository.findOne.mockResolvedValue(mockTool);

      const result = await service.generateToolCli('tool-1', 'bash');

      expect(result.name).toBe('getpetbyid');
      expect(result.format).toBe('bash');
      expect(result.toolCount).toBe(1);
      expect(result.content).toContain('#!/usr/bin/env bash');
      expect(result.content).toContain('getPetById');
      expect(result.content).toContain('APIFAI_BASE_URL');
      expect(result.content).toContain('APIFAI_TOKEN');
      expect(result.content).toContain('--pet-id');
      expect(result.content).toContain('(required)');
      expect(result.content).toContain('curl');
    });

    it('should throw NotFoundException for missing tool', async () => {
      toolRepository.findOne.mockResolvedValue(null);

      await expect(service.generateToolCli('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('generateToolCli - node', () => {
    it('should generate a node script for a tool', async () => {
      toolRepository.findOne.mockResolvedValue(mockTool);

      const result = await service.generateToolCli('tool-1', 'node');

      expect(result.format).toBe('node');
      expect(result.content).toContain('#!/usr/bin/env node');
      expect(result.content).toContain('fetch');
      expect(result.content).toContain('APIFAI_BASE_URL');
      expect(result.content).toContain('--pet-id');
      expect(result.content).toContain('is required');
    });
  });

  describe('generateGatewayCliBunde', () => {
    it('should generate a bash bundle for gateway tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
      ]);

      const result = await service.generateGatewayCliBunde('gw-1', 'bash');

      expect(result.name).toBe('petstore-gateway');
      expect(result.format).toBe('bash');
      expect(result.toolCount).toBe(1);
      expect(result.content).toContain('#!/usr/bin/env bash');
      expect(result.content).toContain('Petstore Gateway');
      expect(result.content).toContain('getpetbyid');
    });

    it('should generate a node bundle for gateway tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
      ]);

      const result = await service.generateGatewayCliBunde('gw-1', 'node');

      expect(result.format).toBe('node');
      expect(result.content).toContain('#!/usr/bin/env node');
      expect(result.content).toContain('Petstore Gateway');
    });

    it('should throw NotFoundException for missing gateway', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      await expect(service.generateGatewayCliBunde('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should handle gateway with no tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([]);

      const result = await service.generateGatewayCliBunde('gw-1', 'bash');

      expect(result.toolCount).toBe(0);
    });
  });
});
