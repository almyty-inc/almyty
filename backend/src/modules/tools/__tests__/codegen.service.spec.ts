import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { CodegenService } from '../codegen.service';
import { Tool, ToolType, ToolStatus } from '../../../entities/tool.entity';
import { Gateway, GatewayType, GatewayStatus } from '../../../entities/gateway.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';

describe('CodegenService', () => {
  let service: CodegenService;
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
        status: { type: 'string', enum: ['available', 'pending', 'sold'], description: 'Pet status' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
      },
      required: ['name'],
    },
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
    toolRepository = { findOne: jest.fn() };
    gatewayRepository = { findOne: jest.fn() };
    gatewayToolRepository = { find: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CodegenService,
        { provide: getRepositoryToken(Tool), useValue: toolRepository },
        { provide: getRepositoryToken(Gateway), useValue: gatewayRepository },
        { provide: getRepositoryToken(GatewayTool), useValue: gatewayToolRepository },
      ],
    }).compile();

    service = module.get<CodegenService>(CodegenService);
  });

  describe('generateToolSdk', () => {
    it('should generate a TypeScript module for a tool', async () => {
      toolRepository.findOne.mockResolvedValue(mockTool);

      const result = await service.generateToolSdk('tool-1', 'org-1');

      expect(result.name).toBe('getpetbyid');
      expect(result.toolCount).toBe(1);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe('getpetbyid.ts');

      const content = result.files[0].content;
      expect(content).toContain("import { AlmytyClient } from './client'");
      expect(content).toContain('interface GetPetByIdParams');
      expect(content).toContain('petId: number');
      expect(content).toContain('format?: string');
      expect(content).toContain('async function getPetById');
      expect(content).toContain("client.callTool('getpetbyid'");
    });

    it('should throw NotFoundException for missing tool', async () => {
      toolRepository.findOne.mockResolvedValue(null);

      await expect(service.generateToolSdk('nonexistent', 'org-1')).rejects.toThrow(NotFoundException);
    });

    it('should handle enum types', async () => {
      toolRepository.findOne.mockResolvedValue(mockMutationTool);

      const result = await service.generateToolSdk('tool-2', 'org-1');
      const content = result.files[0].content;

      expect(content).toContain("'available' | 'pending' | 'sold'");
    });

    it('should handle array types', async () => {
      toolRepository.findOne.mockResolvedValue(mockMutationTool);

      const result = await service.generateToolSdk('tool-2', 'org-1');
      const content = result.files[0].content;

      expect(content).toContain('string[]');
    });
  });

  describe('generateGatewaySdk', () => {
    it('should generate a full SDK package for a gateway', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
        { tool: mockMutationTool, isActive: true },
      ]);

      const result = await service.generateGatewaySdk('gw-1', 'org-1');

      expect(result.name).toBe('petstore-gateway');
      expect(result.toolCount).toBe(2);

      const filePaths = result.files.map(f => f.path);
      expect(filePaths).toContain('package.json');
      expect(filePaths).toContain('tsconfig.json');
      expect(filePaths).toContain('src/index.ts');
      expect(filePaths).toContain('src/client.ts');
      expect(filePaths).toContain('src/types.ts');
      expect(filePaths).toContain('src/getpetbyid.ts');
      expect(filePaths).toContain('src/addpet.ts');
    });

    it('should generate valid package.json', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([{ tool: mockTool, isActive: true }]);

      const result = await service.generateGatewaySdk('gw-1', 'org-1');
      const pkgFile = result.files.find(f => f.path === 'package.json');
      const pkg = JSON.parse(pkgFile!.content);

      expect(pkg.name).toBe('@almyty/petstore-gateway');
      expect(pkg.main).toBe('dist/index.js');
      expect(pkg.types).toBe('dist/index.d.ts');
    });

    it('should generate index with exports for all tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
        { tool: mockMutationTool, isActive: true },
      ]);

      const result = await service.generateGatewaySdk('gw-1', 'org-1');
      const indexFile = result.files.find(f => f.path === 'src/index.ts');

      expect(indexFile!.content).toContain("export { getPetById }");
      expect(indexFile!.content).toContain("export { addPet }");
      expect(indexFile!.content).toContain('createClient');
    });

    it('should generate client with callTool method', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([{ tool: mockTool, isActive: true }]);

      const result = await service.generateGatewaySdk('gw-1', 'org-1');
      const clientFile = result.files.find(f => f.path === 'src/client.ts');

      expect(clientFile!.content).toContain('class AlmytyClient');
      expect(clientFile!.content).toContain('callTool');
      expect(clientFile!.content).toContain('fetch');
      expect(clientFile!.content).toContain('Authorization');
    });

    it('should generate types for all tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([
        { tool: mockTool, isActive: true },
        { tool: mockMutationTool, isActive: true },
      ]);

      const result = await service.generateGatewaySdk('gw-1', 'org-1');
      const typesFile = result.files.find(f => f.path === 'src/types.ts');

      expect(typesFile!.content).toContain('interface GetPetByIdParams');
      expect(typesFile!.content).toContain('interface AddPetParams');
    });

    it('should throw NotFoundException for missing gateway', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      await expect(service.generateGatewaySdk('nonexistent', 'org-1')).rejects.toThrow(NotFoundException);
    });

    it('should handle gateway with no tools', async () => {
      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      gatewayToolRepository.find.mockResolvedValue([]);

      const result = await service.generateGatewaySdk('gw-1', 'org-1');

      expect(result.toolCount).toBe(0);
      // Still generates base files
      expect(result.files.length).toBeGreaterThanOrEqual(4);
    });
  });
});
