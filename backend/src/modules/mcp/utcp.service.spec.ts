import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UtcpService } from './utcp.service';
import { Tool } from '../../entities/tool.entity';
import { Api } from '../../entities/api.entity';
import { Operation } from '../../entities/operation.entity';
import { Organization } from '../../entities/organization.entity';
import { ToolsService } from '../tools/tools.service';
import { ToolExecutorService } from '../tools/tool-executor.service';

describe('UtcpService', () => {
  let service: UtcpService;
  let toolRepository: any;
  let apiRepository: any;
  let operationRepository: any;
  let organizationRepository: any;
  let toolsService: any;
  let toolExecutorService: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UtcpService,
        {
          provide: getRepositoryToken(Tool),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Api),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
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
          provide: getRepositoryToken(Organization),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: ToolsService,
          useValue: {
            getTools: jest.fn(),
            getTool: jest.fn(),
          },
        },
        {
          provide: ToolExecutorService,
          useValue: {
            executeTool: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<UtcpService>(UtcpService);
    toolRepository = module.get(getRepositoryToken(Tool));
    apiRepository = module.get(getRepositoryToken(Api));
    operationRepository = module.get(getRepositoryToken(Operation));
    organizationRepository = module.get(getRepositoryToken(Organization));
    toolsService = module.get(ToolsService);
    toolExecutorService = module.get(ToolExecutorService);
  });

  describe('generateManual', () => {
    it('should generate UTCP manual successfully', async () => {
      const mockOrganization = {
        id: 'org-1',
        name: 'Test Organization',
      } as Organization;

      const mockTools = [
        {
          id: 'tool-1',
          name: 'getUser',
          description: 'Get user by ID',
          type: 'api',
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {},
        },
        {
          id: 'tool-2',
          name: 'createUser',
          description: 'Create new user',
          type: 'api',
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {},
        },
      ];

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      toolRepository.find.mockResolvedValue(mockTools);
      toolsService.getTools.mockResolvedValue({ tools: mockTools, total: 2 });

      const result = await service.generateManual('org-1');

      expect(result).toEqual({
        version: expect.any(String),
        info: expect.any(Object),
        tools: expect.any(Array),
        callTemplates: expect.any(Array),
        authentication: expect.any(Object),
        metadata: expect.any(Object),
      });
    });

    it('should throw error for non-existent organization', async () => {
      organizationRepository.findOne.mockResolvedValue(null);

      await expect(service.generateManual('non-existent'))
        .rejects
        .toThrow('Organization not found');
    });
  });


  describe('getToolManual', () => {
    it('should return tool manual', async () => {
      const mockTool = {
        id: 'tool-1',
        name: 'getUser',
        description: 'Get user by ID',
        organizationId: 'org-1',
        parameters: { type: 'object', properties: { id: { type: 'string' } } },
        operation: {
          method: 'GET',
          endpoint: '/users/{id}',
          api: { baseUrl: 'https://api.example.com' },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {},
      } as any;

      toolRepository.findOne.mockResolvedValue(mockTool);

      const result = await service.getToolManual('tool-1', 'org-1');

      expect(result).toEqual({
        id: 'tool-1',
        name: 'getUser',
        description: 'Get user by ID',
        version: undefined,
        inputSchema: expect.any(Object),
        outputSchema: expect.any(Object),
        examples: expect.any(Array),
        tags: expect.any(Array),
        metadata: expect.any(Object),
      });
    });

    it('should throw error for non-existent tool', async () => {
      toolRepository.findOne.mockResolvedValue(null);

      await expect(service.getToolManual('non-existent', 'org-1'))
        .rejects
        .toThrow('Tool not found');
    });
  });

  describe('executeUtcpTool', () => {
    it('should execute tool successfully', async () => {
      const context = {
        toolId: 'tool-1',
        callTemplateId: 'template-1',
        parameters: { id: 'user-123' },
        options: { timeout: 5000 },
      };

      const mockResult = {
        success: true,
        data: { id: 'user-123', name: 'John Doe' },
        executionTime: 250,
        cached: false,
        retryCount: 0,
      };

      toolExecutorService.executeTool.mockResolvedValue(mockResult);

      const result = await service.executeUtcpTool(context, 'org-1');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: 'user-123', name: 'John Doe' });
      expect(result.metadata).toBeDefined();
      expect(result.metadata.executionTime).toBe(250);
      expect(result.metadata.toolId).toBe('tool-1');
      expect(result.metadata.cached).toBe(false);
    });

    it('should handle execution failure', async () => {
      const context = {
        toolId: 'tool-1',
        callTemplateId: 'template-1',
        parameters: { id: 'user-123' },
      };

      const mockResult = {
        success: false,
        error: 'Tool execution failed',
        executionTime: 100,
        cached: false,
        retryCount: 0,
      };

      toolExecutorService.executeTool.mockResolvedValue(mockResult);

      const result = await service.executeUtcpTool(context, 'org-1');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe('EXECUTION_ERROR');
      expect(result.metadata.toolId).toBe('tool-1');
    });

    it('should handle internal errors', async () => {
      const context = {
        toolId: 'tool-1',
        callTemplateId: 'template-1',
        parameters: { id: 'user-123' },
      };

      toolExecutorService.executeTool.mockRejectedValue(new Error('Internal error'));

      const result = await service.executeUtcpTool(context, 'org-1');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe('INTERNAL_ERROR');
      expect(result.error.message).toBe('Internal error');
    });
  });

  describe('getDiscoveryInfo', () => {
    it('should return UTCP discovery information', () => {
      const result = service.getDiscoveryInfo('org-1');

      expect(result.protocol).toBe('utcp');
      expect(result.version).toBeDefined();
      expect(result.server.name).toBe('apifai');
      expect(result.endpoints.manual).toContain('/api/utcp/org-1/manual');
      expect(result.endpoints.execute).toContain('/api/utcp/org-1/execute');
      expect(result.capabilities.directCalling).toBe(true);
      expect(result.capabilities.proxyMode).toBe(true);
      expect(result.capabilities.authentication).toContain('bearer');
      expect(result.experimental.apifai.universalApiTranslation).toBe(true);
    });
  });

  describe('validateManual', () => {
    it('should validate valid manual', async () => {
      const validManual = {
        version: '1.0.0',
        info: {
          title: 'Test Manual',
          description: 'Test description',
          version: '1.0.0',
        },
        tools: [
          {
            id: 'tool-1',
            name: 'testTool',
            description: 'Test tool',
            version: '1.0.0',
            inputSchema: { type: 'object', properties: {} },
            outputSchema: { type: 'object' },
            tags: [],
            examples: [],
            metadata: {},
          },
        ],
        callTemplates: [
          {
            id: 'template-1',
            name: 'Test Template',
            description: 'Test',
            endpoint: {
              url: 'https://api.example.com/test',
              method: 'GET',
            },
            parameterMappings: [],
          },
        ],
        authentication: [],
        metadata: {},
      } as any;

      const result = await service.validateManual(validManual);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing version', async () => {
      const invalidManual = {
        info: { title: 'Test' },
        tools: [],
      } as any;

      const result = await service.validateManual(invalidManual);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Manual version is required');
    });

    it('should detect missing title', async () => {
      const invalidManual = {
        version: '1.0.0',
        info: {},
        tools: [],
      } as any;

      const result = await service.validateManual(invalidManual);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Manual title is required');
    });

    it('should warn about no tools', async () => {
      const manualWithoutTools = {
        version: '1.0.0',
        info: { title: 'Test' },
        tools: [],
      } as any;

      const result = await service.validateManual(manualWithoutTools);

      expect(result.warnings).toContain('No tools defined in manual');
    });

    it('should detect tool without ID', async () => {
      const invalidManual = {
        version: '1.0.0',
        info: { title: 'Test' },
        tools: [{ name: 'testTool' }],
      } as any;

      const result = await service.validateManual(invalidManual);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('missing ID'))).toBe(true);
    });

    it('should detect call template without endpoint', async () => {
      const invalidManual = {
        version: '1.0.0',
        info: { title: 'Test' },
        tools: [],
        callTemplates: [{ id: 'template-1', endpoint: {} }],
      } as any;

      const result = await service.validateManual(invalidManual);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('missing endpoint URL'))).toBe(true);
    });
  });

  describe('generateManual - with tool details', () => {
    it('should handle tool with operation', async () => {
      const mockOrganization = {
        id: 'org-1',
        name: 'Test Organization',
      } as Organization;

      const mockOperation = {
        id: 'op-1',
        method: 'POST',
        endpoint: '/users',
        parameters: {
          path: { id: { type: 'string', required: true } },
          query: { filter: { type: 'string', required: false, default: 'all' } },
          header: { 'X-API-Key': { type: 'string', required: false } },
          body: { name: { type: 'string', required: true } },
        },
        metadata: { contentType: 'application/json' },
        api: {
          id: 'api-1',
          name: 'Test API',
          baseUrl: 'https://api.test.com',
          authentication: {
            type: 'bearer',
            config: { location: 'header', parameter: 'Authorization' },
          },
        },
      };

      const mockTools = [
        {
          id: 'tool-1',
          name: 'createUser',
          description: 'Create new user',
          type: 'api',
          status: 'active',
          operationId: 'op-1',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', example: 'John Doe' },
              age: { type: 'number', example: 30 },
              active: { type: 'boolean', example: true },
              tags: { type: 'array', example: ['user', 'active'] },
              metadata: { type: 'object', example: { key: 'value' } },
            },
          },
          outputSchema: { type: 'object' },
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {
            sourceApi: { name: 'Test API', type: 'openapi', baseUrl: 'https://api.test.com' },
            sourceOperation: { name: 'createUser' },
            autoGenerated: true,
          },
        },
      ];

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      toolsService.getTools.mockResolvedValue({ tools: mockTools, total: 1 });
      operationRepository.findOne.mockResolvedValue(mockOperation);

      const result = await service.generateManual('org-1');

      expect(result.tools).toHaveLength(1);
      expect(result.callTemplates).toHaveLength(1);
      expect(result.callTemplates[0].endpoint.url).toContain(mockOperation.endpoint);
      expect(result.authentication).toHaveLength(1);
      expect(result.authentication[0].type).toBe('bearer');
    });

    it('should handle tool without operation', async () => {
      const mockOrganization = {
        id: 'org-1',
        name: 'Test Organization',
      } as Organization;

      const mockTools = [
        {
          id: 'tool-1',
          name: 'manualTool',
          description: 'Manual tool',
          type: 'custom',
          status: 'active',
          operationId: null,
          parameters: { type: 'object', properties: {} },
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {},
        },
      ];

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      toolsService.getTools.mockResolvedValue({ tools: mockTools, total: 1 });

      const result = await service.generateManual('org-1');

      expect(result.tools).toHaveLength(1);
      expect(result.callTemplates).toHaveLength(0);
    });

    it('should handle API with no authentication', async () => {
      const mockOrganization = {
        id: 'org-1',
        name: 'Test Organization',
      } as Organization;

      const mockOperation = {
        id: 'op-1',
        method: 'GET',
        endpoint: '/users',
        parameters: {},
        api: {
          id: 'api-1',
          name: 'Test API',
          baseUrl: 'https://api.test.com',
          authentication: { type: 'none', config: {} },
        },
      };

      const mockTools = [
        {
          id: 'tool-1',
          name: 'getUser',
          type: 'api',
          status: 'active',
          operationId: 'op-1',
          parameters: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {},
        },
      ];

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      toolsService.getTools.mockResolvedValue({ tools: mockTools, total: 1 });
      operationRepository.findOne.mockResolvedValue(mockOperation);

      const result = await service.generateManual('org-1');

      expect(result.authentication).toHaveLength(1);
      expect(result.authentication[0].type).toBe('none');
    });

    it('should handle different authentication types', async () => {
      const mockOrganization = {
        id: 'org-1',
        name: 'Test Organization',
      } as Organization;

      const mockOperation = {
        id: 'op-1',
        method: 'GET',
        endpoint: '/data',
        parameters: {},
        api: {
          id: 'api-1',
          name: 'Test API',
          baseUrl: 'https://api.test.com',
          authentication: {
            type: 'api_key',
            config: { location: 'header', parameter: 'X-API-Key' },
          },
        },
      };

      const mockTools = [
        {
          id: 'tool-1',
          name: 'getData',
          type: 'api',
          status: 'active',
          operationId: 'op-1',
          parameters: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {},
        },
      ];

      organizationRepository.findOne.mockResolvedValue(mockOrganization);
      toolsService.getTools.mockResolvedValue({ tools: mockTools, total: 1 });
      operationRepository.findOne.mockResolvedValue(mockOperation);

      const result = await service.generateManual('org-1');

      expect(result.authentication[0].type).toBe('api_key');
      expect(result.authentication[0].configuration.parameter).toBe('X-API-Key');
    });
  });

  describe('validateManual - additional cases', () => {
    it('should detect tool without name', async () => {
      const invalidManual = {
        version: '1.0.0',
        info: { title: 'Test' },
        tools: [{ id: 'tool-1' }],
      } as any;

      const result = await service.validateManual(invalidManual);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('missing name'))).toBe(true);
    });

    it('should warn about tool without input schema', async () => {
      const manual = {
        version: '1.0.0',
        info: { title: 'Test' },
        tools: [{ id: 'tool-1', name: 'testTool' }],
      } as any;

      const result = await service.validateManual(manual);

      expect(result.warnings.some(w => w.includes('missing input schema'))).toBe(true);
    });

    it('should detect call template without ID', async () => {
      const invalidManual = {
        version: '1.0.0',
        info: { title: 'Test' },
        tools: [],
        callTemplates: [{ endpoint: { url: 'https://test.com' } }],
      } as any;

      const result = await service.validateManual(invalidManual);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Call template missing ID'))).toBe(true);
    });
  });

  describe('executeUtcpTool - additional cases', () => {
    it('should handle execution with metadata', async () => {
      const context = {
        toolId: 'tool-1',
        callTemplateId: 'template-1',
        parameters: { id: 'test' },
        options: { timeout: 10000, retries: 3, skipCache: true },
      };

      const mockResult = {
        success: true,
        data: { result: 'success' },
        executionTime: 300,
        cached: false,
        retryCount: 1,
        metadata: { extra: 'data' },
      };

      toolExecutorService.executeTool.mockResolvedValue(mockResult);

      const result = await service.executeUtcpTool(context, 'org-1');

      expect(result.success).toBe(true);
      expect(result.metadata.retryCount).toBe(1);
      expect(result.metadata.toolId).toBe('tool-1');
      expect(result.metadata.callTemplateId).toBe('template-1');
      expect(result.metadata.requestId).toBeDefined();
      expect(result.metadata.timestamp).toBeDefined();
    });

    it('should generate unique request IDs', async () => {
      const context = {
        toolId: 'tool-1',
        callTemplateId: 'template-1',
        parameters: {},
      };

      const mockResult = {
        success: true,
        data: {},
        executionTime: 100,
        cached: false,
        retryCount: 0,
      };

      toolExecutorService.executeTool.mockResolvedValue(mockResult);

      const result1 = await service.executeUtcpTool(context, 'org-1');
      const result2 = await service.executeUtcpTool(context, 'org-1');

      expect(result1.metadata.requestId).not.toBe(result2.metadata.requestId);
    });
  });

  describe('private method branch coverage', () => {
    it('should handle generateCallTemplate when operation is null', async () => {
      const tool = {
        id: 'tool-1',
        name: 'Test Tool',
        operationId: 'op-1',
      };

      operationRepository.findOne.mockResolvedValue(null);

      // Access private method via any cast
      const result = await (service as any).generateCallTemplate(tool);
      expect(result).toBeNull();
    });

    it('should handle generateCallTemplate when API is null', async () => {
      const tool = {
        id: 'tool-1',
        name: 'Test Tool',
        operationId: 'op-1',
      };

      const operation = {
        id: 'op-1',
        api: null,
      };

      operationRepository.findOne.mockResolvedValue(operation);

      const result = await (service as any).generateCallTemplate(tool);
      expect(result).toBeNull();
    });

    it('should handle generateExampleValue with default case', () => {
      const schema = { type: 'unknown-type' };
      const result = (service as any).generateExampleValue(schema);
      expect(result).toBe('example');
    });

    it('should handle getContentType with default case', () => {
      const operation = { method: 'OPTIONS' };
      const result = (service as any).getContentType(operation);
      expect(result).toBe('application/json');
    });

    it('should handle getAuthParameter with basic auth', () => {
      const auth = { type: 'basic' };
      const result = (service as any).getAuthParameter(auth);
      expect(result).toBe('Authorization');
    });

    it('should handle getAuthTemplate with basic auth', () => {
      const auth = { type: 'basic' };
      const result = (service as any).getAuthTemplate(auth);
      expect(result).toBe('Basic {credentials}');
    });

    it('should handle getAuthTemplate with oauth2', () => {
      const auth = { type: 'oauth2' };
      const result = (service as any).getAuthTemplate(auth);
      expect(result).toBe('Bearer {access_token}');
    });

    it('should handle getDefaultAuthParameter with bearer', () => {
      const result = (service as any).getDefaultAuthParameter('bearer');
      expect(result).toBe('Authorization');
    });

    it('should handle getDefaultAuthParameter with basic', () => {
      const result = (service as any).getDefaultAuthParameter('basic');
      expect(result).toBe('Authorization');
    });

    it('should handle getDefaultAuthParameter with oauth2', () => {
      const result = (service as any).getDefaultAuthParameter('oauth2');
      expect(result).toBe('Authorization');
    });

    it('should handle getDefaultAuthParameter with api_key', () => {
      const result = (service as any).getDefaultAuthParameter('api_key');
      expect(result).toBe('X-API-Key');
    });

    it('should handle getDefaultAuthParameter with default case', () => {
      const result = (service as any).getDefaultAuthParameter('unknown');
      expect(result).toBe('Authorization');
    });

    it('should handle getDefaultAuthScheme with basic', () => {
      const result = (service as any).getDefaultAuthScheme('basic');
      expect(result).toBe('Basic');
    });

    it('should handle getDefaultAuthScheme with oauth2', () => {
      const result = (service as any).getDefaultAuthScheme('oauth2');
      expect(result).toBe('Bearer');
    });

    it('should handle generateAuthExample with basic', () => {
      const auth = { type: 'basic' };
      const result = (service as any).generateAuthExample(auth);
      expect(result).toBe('Authorization: Basic base64(username:password)');
    });

    it('should handle generateAuthExample with oauth2', () => {
      const auth = { type: 'oauth2' };
      const result = (service as any).generateAuthExample(auth);
      expect(result).toBe('Authorization: Bearer your_oauth_token_here');
    });

    it('should handle generateAuthExample with default case', () => {
      const auth = { type: 'unknown' };
      const result = (service as any).generateAuthExample(auth);
      expect(result).toBe('Authentication required');
    });
  });

});
