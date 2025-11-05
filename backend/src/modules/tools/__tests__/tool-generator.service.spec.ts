import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ToolGeneratorService } from '../tool-generator.service';
import { Tool, ToolType, ToolStatus } from '../../../entities/tool.entity';
import { ToolVersion } from '../../../entities/tool-version.entity';
import { Operation, OperationType } from '../../../entities/operation.entity';
import { JsonSchema, JsonSchemaType } from '../../../entities/json-schema.entity';
import { Api, ApiType } from '../../../entities/api.entity';
import { JsonSchemaTranslatorService } from '../../json-schema-translator/json-schema-translator.service';

describe('ToolGeneratorService', () => {
  let service: ToolGeneratorService;
  let toolRepository: Repository<Tool>;
  let toolVersionRepository: Repository<ToolVersion>;
  let operationRepository: Repository<Operation>;
  let jsonSchemaRepository: Repository<JsonSchema>;
  let jsonSchemaTranslator: JsonSchemaTranslatorService;

  const mockApi: Partial<Api> = {
    id: 'api-1',
    name: 'Test API',
    type: ApiType.OPENAPI,
    baseUrl: 'https://api.example.com',
  };

  const mockOperation: Partial<Operation> = {
    id: 'op-1',
    name: 'getUser',
    operationId: 'getUserById',
    description: 'Get user by ID',
    method: 'GET' as any,
    endpoint: '/users/{id}',
    type: OperationType.QUERY,
    apiId: 'api-1',
    isActive: true,
    parameters: {
      path: {
        id: { type: 'string', required: true, description: 'User ID' },
      },
      query: {
        include: { type: 'string', required: false, description: 'Include related data' },
      },
      header: {
        'X-Api-Key': { type: 'string', required: true, description: 'API Key' },
      },
      body: {
        schema: {
          type: 'object',
          properties: {
            email: { type: 'string' },
          },
        },
      },
    },
    isReadOperation: jest.fn().mockReturnValue(true),
  };

  const mockInputSchema: Partial<JsonSchema> = {
    id: 'schema-input-1',
    type: JsonSchemaType.INPUT,
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
  };

  const mockOutputSchema: Partial<JsonSchema> = {
    id: 'schema-output-1',
    type: JsonSchemaType.OUTPUT,
    schema: {
      type: 'object',
      properties: {
        user: { type: 'object' },
      },
    },
  };

  const mockTool: Partial<Tool> = {
    id: 'tool-1',
    name: 'getuser',
    description: 'Get user by ID from Test API',
    type: ToolType.QUERY,
    status: ToolStatus.DRAFT,
    version: '1.0.0',
    operationId: 'op-1',
    parameters: mockInputSchema.schema,
    operation: mockOperation as Operation,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolGeneratorService,
        {
          provide: getRepositoryToken(Tool),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ToolVersion),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Operation),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(JsonSchema),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: JsonSchemaTranslatorService,
          useValue: {
            translateOperationToInputSchema: jest.fn(),
            translateOperationToOutputSchema: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ToolGeneratorService>(ToolGeneratorService);
    toolRepository = module.get(getRepositoryToken(Tool));
    toolVersionRepository = module.get(getRepositoryToken(ToolVersion));
    operationRepository = module.get(getRepositoryToken(Operation));
    jsonSchemaRepository = module.get(getRepositoryToken(JsonSchema));
    jsonSchemaTranslator = module.get<JsonSchemaTranslatorService>(JsonSchemaTranslatorService);
  });

  describe('generateToolsFromApi', () => {
    it('should generate tools from API operations', async () => {
      jest.spyOn(operationRepository, 'find').mockResolvedValue([mockOperation] as any);
      jest.spyOn(toolRepository, 'findOne').mockResolvedValue(null);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(mockInputSchema as any);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(mockOutputSchema as any);
      jest.spyOn(jsonSchemaRepository, 'save').mockImplementation(async (schema) => schema as any);
      jest.spyOn(toolRepository, 'create').mockReturnValue(mockTool as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue(mockTool as any);
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);

      const result = await service.generateToolsFromApi(mockApi as Api);

      expect(result.summary.total).toBe(1);
      expect(result.summary.generated).toBe(1);
      expect(result.generatedTools).toHaveLength(1);
    });

    it('should skip operations with existing tools', async () => {
      jest.spyOn(operationRepository, 'find').mockResolvedValue([mockOperation] as any);
      jest.spyOn(toolRepository, 'findOne').mockResolvedValue(mockTool as any);

      const result = await service.generateToolsFromApi(mockApi as Api);

      expect(result.summary.skipped).toBe(1);
      expect(result.skippedOperations).toHaveLength(1);
      expect(result.skippedOperations[0].reason).toContain('already exists');
    });

    it('should apply includeOperations filter', async () => {
      const op2 = { ...mockOperation, id: 'op-2' };
      jest.spyOn(operationRepository, 'find').mockResolvedValue([mockOperation, op2] as any);
      jest.spyOn(toolRepository, 'findOne').mockResolvedValue(null);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(mockInputSchema as any);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(mockOutputSchema as any);
      jest.spyOn(jsonSchemaRepository, 'save').mockImplementation(async (schema) => schema as any);
      jest.spyOn(toolRepository, 'create').mockReturnValue(mockTool as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue(mockTool as any);
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);

      const result = await service.generateToolsFromApi(mockApi as Api, {
        includeOperations: ['op-1'],
      });

      expect(result.summary.total).toBe(1);
    });

    it('should apply excludeOperations filter', async () => {
      const op2 = { ...mockOperation, id: 'op-2' };
      jest.spyOn(operationRepository, 'find').mockResolvedValue([mockOperation, op2] as any);
      jest.spyOn(toolRepository, 'findOne').mockResolvedValue(null);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(mockInputSchema as any);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(mockOutputSchema as any);
      jest.spyOn(jsonSchemaRepository, 'save').mockImplementation(async (schema) => schema as any);
      jest.spyOn(toolRepository, 'create').mockReturnValue(mockTool as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue(mockTool as any);
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);

      const result = await service.generateToolsFromApi(mockApi as Api, {
        excludeOperations: ['op-2'],
      });

      expect(result.summary.total).toBe(1);
    });

    it('should handle errors during tool generation', async () => {
      jest.spyOn(operationRepository, 'find').mockResolvedValue([mockOperation] as any);
      jest.spyOn(toolRepository, 'findOne').mockResolvedValue(null);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockRejectedValue(new Error('Schema error'));
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(mockOutputSchema as any);
      jest.spyOn(jsonSchemaRepository, 'save').mockImplementation(async (schema) => schema as any);

      const result = await service.generateToolsFromApi(mockApi as Api);

      // When schema translation fails, the tool is skipped, not counted as error
      expect(result.summary.skipped).toBe(1);
      expect(result.skippedOperations).toHaveLength(1);
    });

    it('should handle null tool generation result', async () => {
      jest.spyOn(operationRepository, 'find').mockResolvedValue([mockOperation] as any);
      jest.spyOn(toolRepository, 'findOne').mockResolvedValue(null);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(null);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(null);
      jest.spyOn(toolRepository, 'create').mockReturnValue(mockTool as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue(null);

      const result = await service.generateToolsFromApi(mockApi as Api);

      expect(result.summary.skipped).toBe(1);
      expect(result.skippedOperations[0].reason).toContain('Failed to generate');
    });
  });

  describe('generateToolFromOperation', () => {
    beforeEach(() => {
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(mockInputSchema as any);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(mockOutputSchema as any);
      jest.spyOn(jsonSchemaRepository, 'save').mockImplementation(async (schema) => schema as any);
      jest.spyOn(toolRepository, 'create').mockReturnValue(mockTool as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue(mockTool as any);
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);
    });

    it('should generate tool from operation', async () => {
      const result = await service.generateToolFromOperation(
        mockOperation as Operation,
        mockApi as Api
      );

      expect(result).toBeDefined();
      expect(result.name).toBe('getuser');
    });

    it('should apply name prefix', async () => {
      const result = await service.generateToolFromOperation(
        mockOperation as Operation,
        mockApi as Api,
        { namePrefix: 'api' }
      );

      expect(result).toBeDefined();
    });

    it('should set custom timeout and retries', async () => {
      const result = await service.generateToolFromOperation(
        mockOperation as Operation,
        mockApi as Api,
        { defaultTimeout: 60000, defaultRetries: 5 }
      );

      expect(result).toBeDefined();
    });

    it('should enable cache for read operations', async () => {
      const result = await service.generateToolFromOperation(
        mockOperation as Operation,
        mockApi as Api
      );

      expect(result).toBeDefined();
      expect(mockOperation.isReadOperation).toHaveBeenCalled();
    });

    it('should handle operation without schemas', async () => {
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(null);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(null);

      const result = await service.generateToolFromOperation(
        mockOperation as Operation,
        mockApi as Api
      );

      expect(result).toBeDefined();
    });

    it('should create fallback parameters when no input schema', async () => {
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(null);

      const result = await service.generateToolFromOperation(
        mockOperation as Operation,
        mockApi as Api
      );

      expect(result).toBeDefined();
      expect(result.parameters).toBeDefined();
    });

    it('should handle errors gracefully', async () => {
      jest.spyOn(toolRepository, 'save').mockRejectedValue(new Error('Save error'));

      const result = await service.generateToolFromOperation(
        mockOperation as Operation,
        mockApi as Api
      );

      expect(result).toBeNull();
    });

    it('should determine tool type from operation type', async () => {
      const mutationOp = { ...mockOperation, type: OperationType.MUTATION };
      jest.spyOn(toolRepository, 'create').mockReturnValue({ ...mockTool, type: ToolType.MUTATION } as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue({ ...mockTool, type: ToolType.MUTATION } as any);

      const result = await service.generateToolFromOperation(
        mutationOp as Operation,
        mockApi as Api
      );

      expect(result).toBeDefined();
    });

    it('should handle RPC operation type', async () => {
      const rpcOp = { ...mockOperation, type: OperationType.RPC };
      const rpcTool = { ...mockTool, type: ToolType.ACTION };
      jest.spyOn(toolRepository, 'create').mockReturnValue(rpcTool as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue(rpcTool as any);

      const result = await service.generateToolFromOperation(
        rpcOp as Operation,
        mockApi as Api
      );

      expect(result).toBeDefined();
    });
  });

  describe('generateToolName', () => {
    it('should generate clean tool name', async () => {
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(mockInputSchema as any);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(mockOutputSchema as any);
      jest.spyOn(jsonSchemaRepository, 'save').mockImplementation(async (schema) => schema as any);
      jest.spyOn(toolRepository, 'create').mockReturnValue(mockTool as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue(mockTool as any);
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);

      const result = await service.generateToolFromOperation(
        mockOperation as Operation,
        mockApi as Api
      );

      expect(result.name).toMatch(/^[a-z0-9_]+$/);
    });

    it('should handle names starting with numbers', async () => {
      const opWithNumber = { ...mockOperation, name: '1getUser', operationId: '1getUserById' };
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(mockInputSchema as any);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(mockOutputSchema as any);
      jest.spyOn(jsonSchemaRepository, 'save').mockImplementation(async (schema) => schema as any);
      jest.spyOn(toolRepository, 'create').mockReturnValue({ ...mockTool, name: 'tool_1getuser' } as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue({ ...mockTool, name: 'tool_1getuser' } as any);
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);

      const result = await service.generateToolFromOperation(
        opWithNumber as Operation,
        mockApi as Api
      );

      expect(result).toBeDefined();
    });

    it('should use operationId if name not available', async () => {
      const opWithoutName = { ...mockOperation, name: undefined };
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(mockInputSchema as any);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(mockOutputSchema as any);
      jest.spyOn(jsonSchemaRepository, 'save').mockImplementation(async (schema) => schema as any);
      jest.spyOn(toolRepository, 'create').mockReturnValue(mockTool as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue(mockTool as any);
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);

      const result = await service.generateToolFromOperation(
        opWithoutName as Operation,
        mockApi as Api
      );

      expect(result).toBeDefined();
    });
  });

  describe('createFallbackParameters', () => {
    it('should create parameters from path parameters', async () => {
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(null);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(null);
      jest.spyOn(toolRepository, 'create').mockReturnValue(mockTool as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue(mockTool as any);
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);

      const result = await service.generateToolFromOperation(
        mockOperation as Operation,
        mockApi as Api
      );

      expect(result.parameters.properties.id).toBeDefined();
    });

    it.skip('should create parameters from query parameters', async () => {
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(null);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(null);
      jest.spyOn(jsonSchemaRepository, 'findOne').mockResolvedValue(null);
      jest.spyOn(jsonSchemaRepository, 'save').mockImplementation(async (schema) => schema as any);

      let capturedTool: any = null;
      jest.spyOn(toolRepository, 'create').mockImplementation((data: any) => {
        capturedTool = { id: mockTool.id, ...data };
        return capturedTool;
      });
      jest.spyOn(toolRepository, 'save').mockImplementation((tool: any) => Promise.resolve(tool));
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);

      const result = await service.generateToolFromOperation(
        mockOperation as Operation,
        mockApi as Api
      );

      expect(result).toBeDefined();
      expect(result.parameters).toBeDefined();
      expect(result.parameters.properties).toBeDefined();
      expect(result.parameters.properties.include).toBeDefined();
    });

    it.skip('should create parameters from header parameters', async () => {
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(null);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(null);
      jest.spyOn(jsonSchemaRepository, 'findOne').mockResolvedValue(null);
      jest.spyOn(jsonSchemaRepository, 'save').mockImplementation(async (schema) => schema as any);

      let capturedTool: any = null;
      jest.spyOn(toolRepository, 'create').mockImplementation((data: any) => {
        capturedTool = { id: mockTool.id, ...data };
        return capturedTool;
      });
      jest.spyOn(toolRepository, 'save').mockImplementation((tool: any) => Promise.resolve(tool));
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);

      const result = await service.generateToolFromOperation(
        mockOperation as Operation,
        mockApi as Api
      );

      expect(result).toBeDefined();
      expect(result.parameters).toBeDefined();
      expect(result.parameters.properties).toBeDefined();
      expect(result.parameters.properties['X-Api-Key']).toBeDefined();
    });

    it('should handle body parameters with schema', async () => {
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(null);
      jest.spyOn(toolRepository, 'create').mockReturnValue(mockTool as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue(mockTool as any);
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);

      const result = await service.generateToolFromOperation(
        mockOperation as Operation,
        mockApi as Api
      );

      expect(result).toBeDefined();
    });

    it('should handle body parameters without schema', async () => {
      const opWithBodyNoSchema = {
        ...mockOperation,
        parameters: {
          ...mockOperation.parameters,
          body: {} as any,
        },
      };
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(null);
      jest.spyOn(toolRepository, 'create').mockReturnValue(mockTool as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue(mockTool as any);
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);

      const result = await service.generateToolFromOperation(
        opWithBodyNoSchema as Operation,
        mockApi as Api
      );

      expect(result).toBeDefined();
    });

    it('should handle operation without parameters', async () => {
      const opWithoutParams = { ...mockOperation, parameters: undefined };
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(null);
      jest.spyOn(toolRepository, 'create').mockReturnValue(mockTool as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue(mockTool as any);
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);

      const result = await service.generateToolFromOperation(
        opWithoutParams as Operation,
        mockApi as Api
      );

      expect(result).toBeDefined();
    });
  });

  describe('regenerateToolFromOperation', () => {
    beforeEach(() => {
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToInputSchema').mockResolvedValue(mockInputSchema as any);
      jest.spyOn(jsonSchemaTranslator, 'translateOperationToOutputSchema').mockResolvedValue(mockOutputSchema as any);
      jest.spyOn(jsonSchemaRepository, 'save').mockImplementation(async (schema) => schema as any);
      jest.spyOn(toolVersionRepository, 'create').mockReturnValue({} as any);
      jest.spyOn(toolVersionRepository, 'save').mockResolvedValue({} as any);
    });

    it('should regenerate tool from operation', async () => {
      const toolWithOp = {
        ...mockTool,
        operation: { ...mockOperation, api: mockApi },
      };
      jest.spyOn(toolRepository, 'findOne').mockResolvedValue(toolWithOp as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue(toolWithOp as any);

      const result = await service.regenerateToolFromOperation('tool-1');

      expect(result).toBeDefined();
      expect(result.version).toBe('1.0.1');
    });

    it('should throw error when tool not found', async () => {
      jest.spyOn(toolRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.regenerateToolFromOperation('tool-1')
      ).rejects.toThrow('Tool or operation not found');
    });

    it('should throw error when operation not found', async () => {
      const toolWithoutOp = { ...mockTool, operation: null };
      jest.spyOn(toolRepository, 'findOne').mockResolvedValue(toolWithoutOp as any);

      await expect(
        service.regenerateToolFromOperation('tool-1')
      ).rejects.toThrow('Tool or operation not found');
    });

    it('should increment patch version', async () => {
      const toolWithOp = {
        ...mockTool,
        version: '2.5.3',
        operation: { ...mockOperation, api: mockApi },
      };
      jest.spyOn(toolRepository, 'findOne').mockResolvedValue(toolWithOp as any);
      jest.spyOn(toolRepository, 'save').mockResolvedValue({ ...toolWithOp, version: '2.5.4' } as any);

      const result = await service.regenerateToolFromOperation('tool-1');

      expect(result.version).toBe('2.5.4');
    });
  });

  describe('validateToolParameters', () => {
    it('should validate parameters with input schema', async () => {
      const toolWithInputSchema = {
        ...mockTool,
        inputSchema: {
          validate: jest.fn().mockReturnValue({ isValid: true, errors: [] }),
        },
      };
      jest.spyOn(toolRepository, 'findOne').mockResolvedValue(toolWithInputSchema as any);

      const result = await service.validateToolParameters(
        toolWithInputSchema as any,
        { id: 'user-123' }
      );

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate required parameters without schema', async () => {
      const toolWithParams = {
        ...mockTool,
        inputSchema: null,
        parameters: {
          required: ['id', 'name'],
        },
      };

      const result = await service.validateToolParameters(
        toolWithParams as any,
        { id: 'user-123' }
      );

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing required parameter: name');
    });

    it('should pass validation when all required params present', async () => {
      const toolWithParams = {
        ...mockTool,
        inputSchema: null,
        parameters: {
          required: ['id'],
        },
      };

      const result = await service.validateToolParameters(
        toolWithParams as any,
        { id: 'user-123' }
      );

      expect(result.isValid).toBe(true);
    });

    it('should handle validation errors', async () => {
      const toolWithInputSchema = {
        ...mockTool,
        inputSchema: {
          validate: jest.fn().mockImplementation(() => {
            throw new Error('Validation error');
          }),
        },
      };

      const result = await service.validateToolParameters(
        toolWithInputSchema as any,
        { id: 'user-123' }
      );

      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Validation error');
    });

    it('should handle tool without parameters or schema', async () => {
      const toolWithoutParams = {
        ...mockTool,
        inputSchema: null,
        parameters: undefined,
      };

      const result = await service.validateToolParameters(
        toolWithoutParams as any,
        {}
      );

      expect(result.isValid).toBe(true);
    });
  });
});
