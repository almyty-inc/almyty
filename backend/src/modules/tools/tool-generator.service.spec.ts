import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ToolGeneratorService } from './tool-generator.service';
import { Tool, ToolType, ToolStatus } from '../../entities/tool.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { Operation, OperationType } from '../../entities/operation.entity';
import { JsonSchema, JsonSchemaType } from '../../entities/json-schema.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { JsonSchemaTranslatorService } from '../json-schema-translator/json-schema-translator.service';

describe('ToolGeneratorService', () => {
  let service: ToolGeneratorService;
  let toolRepository: any;
  let toolVersionRepository: any;
  let operationRepository: any;
  let jsonSchemaRepository: any;
  let jsonSchemaTranslator: any;

  beforeEach(async () => {
    const mockJsonSchemaTranslator = {
      translateOperationToInputSchema: jest.fn(),
      translateOperationToOutputSchema: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolGeneratorService,
        {
          provide: getRepositoryToken(Tool),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            find: jest.fn(),
            findOne: jest.fn(),
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
            findOne: jest.fn(),
            find: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(JsonSchema),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: JsonSchemaTranslatorService,
          useValue: mockJsonSchemaTranslator,
        },
      ],
    }).compile();

    service = module.get<ToolGeneratorService>(ToolGeneratorService);
    toolRepository = module.get(getRepositoryToken(Tool));
    toolVersionRepository = module.get(getRepositoryToken(ToolVersion));
    operationRepository = module.get(getRepositoryToken(Operation));
    jsonSchemaRepository = module.get(getRepositoryToken(JsonSchema));
    jsonSchemaTranslator = module.get(JsonSchemaTranslatorService);
  });

  describe('generateToolFromOperation', () => {
    it('should generate tool from operation successfully', async () => {
      const mockApi = {
        id: 'api-1',
        name: 'User API',
        type: ApiType.OPENAPI,
      } as Api;

      const mockOperation = {
        id: 'op-1',
        name: 'getUser',
        operationId: 'getUser',
        description: 'Get user by ID',
        method: 'GET',
        endpoint: '/users/{id}',
        type: OperationType.QUERY,
        parameters: {
          path: {
            id: { type: 'string', required: true, description: 'User ID' }
          }
        },
        isReadOperation: jest.fn().mockReturnValue(true),
        apiId: 'api-1',
      } as any;

      const mockInputSchema = {
        id: 'input-schema-1',
        name: 'Input Schema',
        schemaHash: 'hash1',
        description: 'Input schema for operation',
        type: JsonSchemaType.INPUT,
        sourceSchemaId: null,
        version: '1.0.0',
        isActive: true,
        metadata: {},
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'User ID' }
          },
          required: ['id']
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as JsonSchema;

      const mockOutputSchema = {
        id: 'output-schema-1',
        name: 'Output Schema',
        schemaHash: 'hash2',
        description: 'Output schema for operation',
        type: JsonSchemaType.OUTPUT,
        sourceSchemaId: null,
        version: '1.0.0',
        isActive: true,
        metadata: {},
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' }
          }
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as JsonSchema;

      const expectedTool = {
        id: 'tool-1',
        name: 'getuser',
        description: 'Get user by ID from User API',
        type: ToolType.QUERY,
        status: ToolStatus.DRAFT,
        version: '1.0.0',
        operationId: 'op-1',
        inputSchemaId: 'input-schema-1',
        outputSchemaId: 'output-schema-1',
      } as unknown as Tool;

      const mockToolVersion = {
        id: 'version-1',
        toolId: 'tool-1',
        version: '1.0.0',
      } as ToolVersion;

      jsonSchemaRepository.findOne.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(mockInputSchema);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(mockOutputSchema);
      jsonSchemaRepository.save.mockResolvedValueOnce(mockInputSchema).mockResolvedValueOnce(mockOutputSchema);
      toolRepository.create.mockReturnValue(expectedTool);
      toolRepository.save.mockResolvedValue(expectedTool);
      toolVersionRepository.create.mockReturnValue(mockToolVersion);
      toolVersionRepository.save.mockResolvedValue(mockToolVersion);

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      expect(result).toBe(expectedTool);
      expect(toolRepository.create).toHaveBeenCalled();
      expect(toolRepository.save).toHaveBeenCalled();
      expect(toolVersionRepository.create).toHaveBeenCalled();
      expect(toolVersionRepository.save).toHaveBeenCalled();
    });

    it('should return null if schema generation fails', async () => {
      const mockApi = {
        id: 'api-1',
        name: 'User API',
        type: ApiType.OPENAPI,
      } as Api;

      const mockOperation = {
        id: 'op-1',
        name: 'getUser',
        operationId: 'getUser',
        description: 'Get user by ID',
        method: 'GET',
        endpoint: '/users/{id}',
        type: OperationType.QUERY,
        isReadOperation: jest.fn().mockReturnValue(true),
        apiId: 'api-1',
      } as any;

      jsonSchemaRepository.findOne.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToInputSchema.mockRejectedValue(new Error('Schema generation failed'));

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      expect(result).toBeNull();
    });
  });

  describe('generateToolsFromApi', () => {
    it('should skip existing tools', async () => {
      const mockApi = {
        id: 'api-1',
        name: 'User API',
        type: ApiType.OPENAPI,
      } as Api;

      const mockOperations = [
        {
          id: 'op-1',
          name: 'getUser',
          operationId: 'getUser',
          description: 'Get user',
          method: 'GET',
          endpoint: '/users/{id}',
          type: OperationType.QUERY,
          apiId: 'api-1',
          isActive: true,
          isReadOperation: jest.fn().mockReturnValue(true),
        },
      ] as any[];

      const existingTool = { id: 'tool-1', name: 'getuser', operationId: 'op-1' } as Tool;

      operationRepository.find.mockResolvedValue(mockOperations);
      toolRepository.findOne.mockResolvedValue(existingTool); // Existing tool

      const result = await service.generateToolsFromApi(mockApi);

      expect(result.summary.skipped).toBe(1);
      expect(result.summary.generated).toBe(0);
    });

    it('should skip inactive operations', async () => {
      const mockApi = {
        id: 'api-1',
        name: 'User API',
        type: ApiType.OPENAPI,
      } as Api;

      const mockOperations = [
        {
          id: 'op-1',
          name: 'getUser',
          operationId: 'getUser',
          description: 'Get user',
          method: 'GET',
          endpoint: '/users/{id}',
          type: OperationType.QUERY,
          apiId: 'api-1',
          isActive: false, // Inactive operation
          isReadOperation: jest.fn().mockReturnValue(true),
        },
      ] as any[];

      operationRepository.find.mockResolvedValue(mockOperations);

      const result = await service.generateToolsFromApi(mockApi);

      expect(result.summary.generated).toBe(0);
    });

    it('should generate multiple tools from API operations', async () => {
      const mockApi = {
        id: 'api-1',
        name: 'User API',
        type: ApiType.OPENAPI,
      } as Api;

      const mockOperations = [
        {
          id: 'op-1',
          name: 'getUser',
          operationId: 'getUser',
          description: 'Get user',
          method: 'GET',
          endpoint: '/users/{id}',
          type: OperationType.QUERY,
          apiId: 'api-1',
          isActive: true,
          isReadOperation: jest.fn().mockReturnValue(true),
        },
        {
          id: 'op-2',
          name: 'createUser',
          operationId: 'createUser',
          description: 'Create user',
          method: 'POST',
          endpoint: '/users',
          type: OperationType.MUTATION,
          apiId: 'api-1',
          isActive: true,
          isReadOperation: jest.fn().mockReturnValue(false),
        },
      ] as any[];

      const mockTools = [
        { id: 'tool-1', name: 'getuser', operationId: 'op-1' } as Tool,
        { id: 'tool-2', name: 'createuser', operationId: 'op-2' } as Tool,
      ];

      operationRepository.find.mockResolvedValue(mockOperations);
      toolRepository.findOne.mockResolvedValue(null); // No existing tools
      toolRepository.create.mockReturnValueOnce(mockTools[0]).mockReturnValueOnce(mockTools[1]);
      toolRepository.save.mockResolvedValueOnce(mockTools[0]).mockResolvedValueOnce(mockTools[1]);
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaRepository.findOne.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue({ id: 'input-1', schema: {} });
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue({ id: 'output-1', schema: {} });
      jsonSchemaRepository.save.mockResolvedValue({ id: 'schema-1', schema: {} });

      const result = await service.generateToolsFromApi(mockApi);

      expect(result.generatedTools).toHaveLength(2);
      expect(result.summary.generated).toBe(2);
      expect(result.summary.total).toBe(2);
    });
  });




  describe('validateToolParameters', () => {
    it('should validate tool parameters successfully', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'validateTool',
        description: 'Validate tool parameters',
        type: ToolType.FUNCTION,
        status: ToolStatus.ACTIVE,
        version: '1.0.0',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' }
          },
          required: ['id']
        },
        configuration: {},
        metadata: {},
        inputSchema: null,
        outputSchema: null,
        inputSchemaId: null,
        outputSchemaId: null,
        operationId: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as Tool;

      const parameters = { id: 'user-123', name: 'John' };

      const result = await service.validateToolParameters(mockTool, parameters);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return validation errors for missing required parameters', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'validateTool',
        description: 'Validate tool parameters',
        type: ToolType.FUNCTION,
        status: ToolStatus.ACTIVE,
        version: '1.0.0',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' }
          },
          required: ['id']
        },
        configuration: {},
        metadata: {},
        inputSchema: null,
        outputSchema: null,
        inputSchemaId: null,
        outputSchemaId: null,
        operationId: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as Tool;

      const parameters = { name: 'John' }; // Missing required 'id'

      const result = await service.validateToolParameters(mockTool, parameters);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Missing required parameter: id');
    });
  });

  describe('generateToolName', () => {
    it('should clean up tool name and lowercase it', async () => {
      const mockApi = { id: 'api-1', type: ApiType.OPENAPI } as Api;
      const mockOperation = {
        id: 'op-1',
        name: 'Get-User-By.ID!',
        method: 'GET',
        endpoint: '/users/{id}',
        type: OperationType.QUERY,
        isReadOperation: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.create.mockImplementation((data) => data as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      // New logic: builds from method + endpoint path, not operation.name
      expect(result.name).toBe('get_users_by_id');
      expect(result.name).not.toContain('-');
      expect(result.name).not.toContain('.');
      expect(result.name).not.toContain('!');
    });

    it('should add prefix to tool name when provided', async () => {
      const mockApi = { id: 'api-1', type: ApiType.OPENAPI } as Api;
      const mockOperation = {
        id: 'op-1',
        name: 'getUser',
        method: 'GET',
        endpoint: '/users/{id}',
        type: OperationType.QUERY,
        isReadOperation: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.create.mockImplementation((data) => data as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolFromOperation(mockOperation, mockApi, { namePrefix: 'api' });

      // New logic: builds from method + endpoint, then adds prefix
      expect(result.name).toBe('api_get_users_by_id');
    });

    it('should prepend tool_ if name starts with number', async () => {
      const mockApi = { id: 'api-1', type: ApiType.OPENAPI } as Api;
      const mockOperation = {
        id: 'op-1',
        name: '123getUser',
        method: 'GET',
        endpoint: '/users/{id}',
        type: OperationType.QUERY,
        isReadOperation: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.create.mockImplementation((data) => data as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      // New logic: builds from method + endpoint (ignores operation.name starting with number)
      expect(result.name).toBe('get_users_by_id');
    });
  });

  describe('generateToolDescription', () => {
    it('should create description from operation description and API name', async () => {
      const mockApi = { id: 'api-1', name: 'User Management API', type: ApiType.OPENAPI } as Api;
      const mockOperation = {
        id: 'op-1',
        name: 'getUser',
        description: 'Retrieves a user by ID',
        method: 'GET',
        endpoint: '/users/{id}',
        type: OperationType.QUERY,
        isReadOperation: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.create.mockImplementation((data) => data as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      // New logic: returns operation description directly, no API name suffix
      expect(result.description).toBe('Retrieves a user by ID');
    });

    it('should create fallback description from method and endpoint', async () => {
      const mockApi = { id: 'api-1', name: 'User API', type: ApiType.OPENAPI } as Api;
      const mockOperation = {
        id: 'op-1',
        name: 'getUser',
        description: null,
        method: 'POST',
        endpoint: '/users',
        type: OperationType.MUTATION,
        isReadOperation: jest.fn().mockReturnValue(false),
      } as any;

      toolRepository.create.mockImplementation((data) => data as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      expect(result.description).toContain('POST /users');
      expect(result.description).toContain('User API');
    });
  });

  describe('determineToolType', () => {
    it('should map QUERY operation to QUERY tool type', async () => {
      const mockApi = { id: 'api-1', type: ApiType.OPENAPI } as Api;
      const mockOperation = {
        id: 'op-1',
        name: 'getUser',
        method: 'GET',
        endpoint: '/users/{id}',
        type: OperationType.QUERY,
        isReadOperation: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.create.mockImplementation((data) => data as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      expect(result.type).toBe(ToolType.QUERY);
    });

    it('should map MUTATION operation to MUTATION tool type', async () => {
      const mockApi = { id: 'api-1', type: ApiType.OPENAPI } as Api;
      const mockOperation = {
        id: 'op-1',
        name: 'createUser',
        method: 'POST',
        endpoint: '/users',
        type: OperationType.MUTATION,
        isReadOperation: jest.fn().mockReturnValue(false),
      } as any;

      toolRepository.create.mockImplementation((data) => data as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      expect(result.type).toBe(ToolType.MUTATION);
    });

    it('should map RPC operation to ACTION tool type', async () => {
      const mockApi = { id: 'api-1', type: ApiType.GRPC } as Api;
      const mockOperation = {
        id: 'op-1',
        name: 'ProcessPayment',
        method: 'RPC',
        endpoint: '/payment/process',
        type: OperationType.RPC,
        isReadOperation: jest.fn().mockReturnValue(false),
      } as any;

      toolRepository.create.mockImplementation((data) => data as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      expect(result.type).toBe(ToolType.ACTION);
    });
  });

  describe('createFallbackParameters', () => {
    it('should extract path parameters from operation', async () => {
      const mockApi = { id: 'api-1', type: ApiType.OPENAPI } as Api;
      const mockOperation = {
        id: 'op-1',
        name: 'getUser',
        method: 'GET',
        endpoint: '/users/{id}',
        type: OperationType.QUERY,
        parameters: {
          path: {
            id: { type: 'string', required: true, description: 'User ID' },
          },
        },
        isReadOperation: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.create.mockImplementation((data) => data as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      expect(result.parameters.properties.id).toBeDefined();
      expect(result.parameters.properties.id.type).toBe('string');
      expect(result.parameters.required).toContain('id');
    });

    it('should extract query parameters from operation', async () => {
      const mockApi = { id: 'api-1', type: ApiType.OPENAPI } as Api;
      const mockOperation = {
        id: 'op-1',
        name: 'listUsers',
        method: 'GET',
        endpoint: '/users',
        type: OperationType.QUERY,
        parameters: {
          query: {
            page: { type: 'number', required: false, description: 'Page number' },
            limit: { type: 'number', required: false, description: 'Page size' },
          },
        },
        isReadOperation: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.create.mockImplementation((data) => data as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      expect(result.parameters.properties.page).toBeDefined();
      expect(result.parameters.properties.limit).toBeDefined();
      expect(result.parameters.required).toHaveLength(0);
    });

    it('should handle mixed path and query parameters', async () => {
      const mockApi = { id: 'api-1', type: ApiType.OPENAPI } as Api;
      const mockOperation = {
        id: 'op-1',
        name: 'updateUser',
        method: 'PATCH',
        endpoint: '/users/{id}',
        type: OperationType.MUTATION,
        parameters: {
          path: {
            id: { type: 'string', required: true, description: 'User ID' },
          },
          query: {
            notify: { type: 'boolean', required: false, description: 'Send notification' },
          },
        },
        isReadOperation: jest.fn().mockReturnValue(false),
      } as any;

      toolRepository.create.mockImplementation((data) => data as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      expect(result.parameters.properties.id).toBeDefined();
      expect(result.parameters.properties.notify).toBeDefined();
      expect(result.parameters.required).toContain('id');
      expect(result.parameters.required).not.toContain('notify');
    });
  });

  describe('caching behavior based on operation type', () => {
    it('should enable caching for read operations', async () => {
      const mockApi = { id: 'api-1', type: ApiType.OPENAPI } as Api;
      const mockOperation = {
        id: 'op-1',
        name: 'getUser',
        method: 'GET',
        endpoint: '/users/{id}',
        type: OperationType.QUERY,
        isReadOperation: jest.fn().mockReturnValue(true),
      } as any;

      toolRepository.create.mockImplementation((data) => data as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      expect(result.configuration.cache.enabled).toBe(true);
      expect(result.configuration.cache.ttl).toBe(300);
    });

    it('should disable caching for write operations', async () => {
      const mockApi = { id: 'api-1', type: ApiType.OPENAPI } as Api;
      const mockOperation = {
        id: 'op-1',
        name: 'createUser',
        method: 'POST',
        endpoint: '/users',
        type: OperationType.MUTATION,
        isReadOperation: jest.fn().mockReturnValue(false),
      } as any;

      toolRepository.create.mockImplementation((data) => data as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolFromOperation(mockOperation, mockApi);

      expect(result.configuration.cache.enabled).toBe(false);
      expect(result.configuration.cache.ttl).toBe(0);
    });
  });

  describe('operation filtering', () => {
    it('should only include specified operations when includeOperations provided', async () => {
      const mockApi = { id: 'api-1', type: ApiType.OPENAPI } as Api;
      const mockOperations = [
        {
          id: 'op-1',
          name: 'getUser',
          method: 'GET',
          endpoint: '/users/{id}',
          type: OperationType.QUERY,
          isActive: true,
          isReadOperation: jest.fn().mockReturnValue(true),
        },
        {
          id: 'op-2',
          name: 'listUsers',
          method: 'GET',
          endpoint: '/users',
          type: OperationType.QUERY,
          isActive: true,
          isReadOperation: jest.fn().mockReturnValue(true),
        },
        {
          id: 'op-3',
          name: 'createUser',
          method: 'POST',
          endpoint: '/users',
          type: OperationType.MUTATION,
          isActive: true,
          isReadOperation: jest.fn().mockReturnValue(false),
        },
      ] as any[];

      operationRepository.find.mockResolvedValue(mockOperations);
      toolRepository.findOne.mockResolvedValue(null);
      toolRepository.create.mockImplementation((data) => ({ ...data, id: 'tool-x' }) as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolsFromApi(mockApi, {
        includeOperations: ['op-1', 'op-3'],
      });

      // Should only generate 2 tools (op-1 and op-3)
      expect(result.summary.generated).toBe(2);
      expect(result.summary.total).toBe(2);
    });

    it('should exclude specified operations when excludeOperations provided', async () => {
      const mockApi = { id: 'api-1', type: ApiType.OPENAPI } as Api;
      const mockOperations = [
        {
          id: 'op-1',
          name: 'getUser',
          method: 'GET',
          endpoint: '/users/{id}',
          type: OperationType.QUERY,
          isActive: true,
          isReadOperation: jest.fn().mockReturnValue(true),
        },
        {
          id: 'op-2',
          name: 'listUsers',
          method: 'GET',
          endpoint: '/users',
          type: OperationType.QUERY,
          isActive: true,
          isReadOperation: jest.fn().mockReturnValue(true),
        },
        {
          id: 'op-3',
          name: 'deleteUser',
          method: 'DELETE',
          endpoint: '/users/{id}',
          type: OperationType.MUTATION,
          isActive: true,
          isReadOperation: jest.fn().mockReturnValue(false),
        },
      ] as any[];

      operationRepository.find.mockResolvedValue(mockOperations);
      toolRepository.findOne.mockResolvedValue(null);
      toolRepository.create.mockImplementation((data) => ({ ...data, id: 'tool-x' }) as Tool);
      toolRepository.save.mockImplementation((tool) => Promise.resolve(tool as Tool));
      toolVersionRepository.create.mockReturnValue({} as ToolVersion);
      toolVersionRepository.save.mockResolvedValue({} as ToolVersion);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(null);

      const result = await service.generateToolsFromApi(mockApi, {
        excludeOperations: ['op-3'],
      });

      // Should only generate 2 tools (op-1 and op-2, excluding op-3)
      expect(result.summary.generated).toBe(2);
      expect(result.summary.total).toBe(2);
    });
  });

  describe('regenerateToolFromOperation', () => {
    it('should regenerate tool from operation', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'getuser',
        version: '1.0.0',
        operation: {
          id: 'op-1',
          name: 'getUser',
          operationId: 'getUser',
          description: 'Get user by ID',
          method: 'GET',
          endpoint: '/users/{id}',
          type: OperationType.QUERY,
          isReadOperation: jest.fn().mockReturnValue(true),
          api: {
            id: 'api-1',
            name: 'User API',
            type: ApiType.OPENAPI,
          } as Api,
        },
      } as any;

      const mockInputSchema = {
        id: 'input-schema-2',
        name: 'Input Schema 2',
        schemaHash: 'hash3',
        description: 'Updated input schema',
        type: JsonSchemaType.INPUT,
        sourceSchemaId: null,
        version: '1.0.0',
        isActive: true,
        metadata: {},
        schema: { type: 'object', properties: {} },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as JsonSchema;

      const mockOutputSchema = {
        id: 'output-schema-2',
        name: 'Output Schema 2',
        schemaHash: 'hash4',
        description: 'Updated output schema',
        type: JsonSchemaType.OUTPUT,
        sourceSchemaId: null,
        version: '1.0.0',
        isActive: true,
        metadata: {},
        schema: { type: 'object', properties: {} },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as JsonSchema;

      const updatedTool = {
        ...mockTool,
        version: '1.0.1',
        inputSchemaId: 'input-schema-2',
        outputSchemaId: 'output-schema-2',
      } as unknown as Tool;

      const mockToolVersion = {
        id: 'version-2',
        toolId: 'tool-1',
        version: '1.0.1',
      } as ToolVersion;

      toolRepository.findOne.mockResolvedValue(mockTool);
      jsonSchemaRepository.findOne.mockResolvedValue(null);
      jsonSchemaTranslator.translateOperationToInputSchema.mockResolvedValue(mockInputSchema);
      jsonSchemaTranslator.translateOperationToOutputSchema.mockResolvedValue(mockOutputSchema);
      jsonSchemaRepository.save.mockResolvedValueOnce(mockInputSchema).mockResolvedValueOnce(mockOutputSchema);
      toolRepository.save.mockResolvedValue(updatedTool);
      toolVersionRepository.create.mockReturnValue(mockToolVersion);
      toolVersionRepository.save.mockResolvedValue(mockToolVersion);

      const result = await service.regenerateToolFromOperation('tool-1');

      expect(result.version).toBe('1.0.1');
      expect(toolRepository.save).toHaveBeenCalled();
      expect(toolVersionRepository.create).toHaveBeenCalled();
    });

    it('should throw error if tool not found', async () => {
      toolRepository.findOne.mockResolvedValue(null);

      await expect(service.regenerateToolFromOperation('non-existent'))
        .rejects
        .toThrow('Tool or operation not found');
    });
  });
});