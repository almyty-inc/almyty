import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { ApisController } from './apis.controller';
import { ApisService } from './apis.service';
import { CredentialService } from './credential.service';
import { SchemaParserService } from '../schema-parser/schema-parser.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

describe('ApisController', () => {
  let controller: ApisController;
  let apisService: jest.Mocked<ApisService>;
  let schemaParserService: jest.Mocked<SchemaParserService>;

  beforeEach(async () => {
    const mockApisService = {
      findAllByOrganization: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      importSchema: jest.fn(),
      generateToolsFromApi: jest.fn(),
      testApiConnection: jest.fn(),
      getOperations: jest.fn(),
    };

    const mockSchemaParserService = {
      parseApiSchema: jest.fn(),
      validateSchema: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApisController],
      providers: [
        {
          provide: ApisService,
          useValue: mockApisService,
        },
        {
          provide: CredentialService,
          useValue: {
            createCredential: jest.fn(),
            getCredentials: jest.fn(),
            updateCredential: jest.fn(),
            deleteCredential: jest.fn(),
            testCredential: jest.fn(),
          },
        },
        {
          provide: SchemaParserService,
          useValue: mockSchemaParserService,
        },
        {
          provide: getQueueToken('schema-import'),
          useValue: {
            add: jest.fn().mockResolvedValue({ id: 'job-1' }),
            getJob: jest.fn(),
          },
        },
      ],
    })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .compile();

    controller = module.get<ApisController>(ApisController);
    apisService = module.get(ApisService);
    schemaParserService = module.get(SchemaParserService);
  });

  describe('findAll', () => {
    it('should return paginated APIs', async () => {
      const mockRequest = {
        user: { currentOrganizationId: 'org-1' }
      };

      const mockResult = {
        apis: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      };

      apisService.findAllByOrganization.mockResolvedValue(mockResult);

      const result = await controller.findAll(mockRequest, undefined, undefined, undefined, 1, 10);

      expect(result).toEqual({ success: true, data: mockResult, message: expect.any(String) });
    });
  });

  describe('findOne', () => {
    it('should return API by id', async () => {
      const mockRequest = {
        user: { currentOrganizationId: 'org-1' }
      };

      const mockApi = {
        id: 'api-1',
        name: 'Test API',
        organizationId: 'org-1',
        baseUrl: 'https://api.example.com',
        type: 'openapi' as any,
        status: 'active' as any,
        version: '1.0.0',
        description: 'Test API description',
        headers: null,
        authentication: null,
        rateLimits: null,
        metadata: null,
        timeoutMs: 30000,
        retryAttempts: 3,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      apisService.findOne.mockResolvedValue(mockApi);

      const result = await controller.findOne(mockRequest, 'api-1');

      expect(result).toEqual({ success: true, data: mockApi, message: expect.any(String) });
    });
  });

  describe('create', () => {
    it('should create API successfully', async () => {
      const mockRequest = {
        user: { currentOrganizationId: 'org-1' }
      };

      const createDto = {
        name: 'New API',
        baseUrl: 'https://api.example.com',
        type: 'openapi' as any,
        description: 'New API description',
      };

      const mockApi = {
        id: 'api-1',
        ...createDto,
        organizationId: 'org-1',
        status: 'draft' as any,
        version: '1.0.0',
        headers: null,
        authentication: null,
        rateLimits: null,
        metadata: null,
        timeoutMs: 30000,
        retryAttempts: 3,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      apisService.create.mockResolvedValue(mockApi);

      const result = await controller.create(mockRequest, createDto);

      expect(result).toEqual({ success: true, data: mockApi, message: expect.any(String) });
    });
  });

  describe('update', () => {
    it('should update API successfully', async () => {
      const mockRequest = {
        user: { currentOrganizationId: 'org-1' }
      };

      const updateDto = {
        description: 'Updated description',
      };

      const mockApi = {
        id: 'api-1',
        name: 'Test API',
        description: 'Updated description',
        baseUrl: 'https://api.example.com',
        type: 'openapi' as any,
        status: 'active' as any,
        version: '1.0.0',
        organizationId: 'org-1',
        headers: null,
        authentication: null,
        rateLimits: null,
        metadata: null,
        timeoutMs: 30000,
        retryAttempts: 3,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      apisService.findOne.mockResolvedValue(mockApi);
      apisService.update.mockResolvedValue(mockApi);

      const result = await controller.update(mockRequest, 'api-1', updateDto);

      expect(result).toEqual({ success: true, data: mockApi, message: expect.any(String) });
    });
  });

  describe('remove', () => {
    it('should delete API successfully', async () => {
      const mockRequest = {
        user: { currentOrganizationId: 'org-1' }
      };

      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      apisService.findOne.mockResolvedValue(mockApi);
      apisService.remove.mockResolvedValue();

      const result = await controller.remove(mockRequest, 'api-1');

      expect(result).toEqual({ success: true, data: null, message: expect.any(String) });
    });
  });

  describe('importSchema', () => {
    it('should import schema from file', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      const mockFile = { buffer: Buffer.from('schema content'), originalname: 'schema.json' };
      const importDto = { generateTools: true };

      apisService.findOne.mockResolvedValue(mockApi);

      const result = await controller.importSchema(mockRequest, 'api-1', importDto, mockFile);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('jobId');
      expect(result.data).toHaveProperty('status', 'processing');
      expect(result).toHaveProperty('message');
    });

    it('should import schema from URL', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      const importDto = { schemaUrl: 'https://api.example.com/schema.json', generateTools: true };

      apisService.findOne.mockResolvedValue(mockApi);
      apisService.fetchSchemaFromUrl = jest.fn().mockResolvedValue('fetched schema');

      const result = await controller.importSchema(mockRequest, 'api-1', importDto);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('jobId');
      expect(result.data).toHaveProperty('status', 'processing');
    });

    it('should import schema from content', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      const importDto = { schemaContent: 'inline schema', generateTools: false };

      apisService.findOne.mockResolvedValue(mockApi);

      const result = await controller.importSchema(mockRequest, 'api-1', importDto);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('jobId');
      expect(result.data).toHaveProperty('status', 'processing');
    });

    it('rejects an oversized schema BEFORE enqueueing the job', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      apisService.findOne.mockResolvedValue(mockApi);

      const queue: any = (controller as any).schemaImportQueue;
      queue.add.mockClear();

      const huge = { schemaContent: 'x'.repeat(11 * 1024 * 1024), generateTools: false };

      await expect(controller.importSchema(mockRequest, 'api-1', huge as any))
        .rejects.toThrow(/Schema too large/);

      // Critical: the job must NOT have hit Redis. Previously the size
      // check was inside the worker, so the oversized payload was already
      // serialised into the queue body before being rejected.
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('includes organizationId in the queued job payload', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      apisService.findOne.mockResolvedValue(mockApi);

      const queue: any = (controller as any).schemaImportQueue;
      queue.add.mockClear();

      await controller.importSchema(
        mockRequest,
        'api-1',
        { schemaContent: '{}', generateTools: false } as any,
      );

      const queuedPayload = queue.add.mock.calls[0][1];
      expect(queuedPayload).toEqual(
        expect.objectContaining({
          apiId: 'api-1',
          organizationId: 'org-1',
        }),
      );
    });
  });

  describe('getImportStatus', () => {
    function setQueueJob(job: any) {
      const queue: any = (controller as any).schemaImportQueue;
      queue.getJob = jest.fn().mockResolvedValue(job);
      return queue;
    }

    it('returns the job status when api + job ownership both check out', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      apisService.findOne.mockResolvedValue({
        id: 'api-1',
        organizationId: 'org-1',
      } as any);

      setQueueJob({
        data: { apiId: 'api-1' },
        getState: jest.fn().mockResolvedValue('completed'),
        progress: jest.fn().mockReturnValue(100),
        returnvalue: { success: true },
      });

      const result = await controller.getImportStatus(mockRequest as any, 'api-1', 'job-1');
      expect(result.data.status).toBe('completed');
    });

    it('returns NotFound when the api belongs to another org (no cross-org poll)', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      apisService.findOne.mockResolvedValue({
        id: 'api-1',
        organizationId: 'other-org',
      } as any);

      // The queue should never be touched if the api ownership check fails.
      const queue: any = (controller as any).schemaImportQueue;
      queue.getJob = jest.fn();

      await expect(
        controller.getImportStatus(mockRequest as any, 'api-1', 'job-1'),
      ).rejects.toThrow('API not found');
      expect(queue.getJob).not.toHaveBeenCalled();
    });

    it('returns NotFound when the job exists but its apiId does not match the path', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      apisService.findOne.mockResolvedValue({
        id: 'api-1',
        organizationId: 'org-1',
      } as any);

      setQueueJob({
        data: { apiId: 'someone-elses-api' },
        getState: jest.fn().mockResolvedValue('completed'),
        progress: jest.fn().mockReturnValue(100),
        returnvalue: { success: true, secret: 'cross-org leak' },
      });

      await expect(
        controller.getImportStatus(mockRequest as any, 'api-1', 'job-1'),
      ).rejects.toThrow('Job not found');
    });
  });

  describe('generateTools', () => {
    it('should generate tools from API', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      const mockTools = [{ id: 'tool-1' }, { id: 'tool-2' }] as any;

      apisService.findOne.mockResolvedValue(mockApi);
      apisService.generateToolsFromApi.mockResolvedValue(mockTools);

      const result = await controller.generateTools(mockRequest, 'api-1');

      expect(result).toEqual({ success: true, data: mockTools, message: expect.any(String) });
    });
  });

  describe('testConnection', () => {
    it('should test API connection', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      const mockResult = { success: true, statusCode: 200, responseTime: 150 };

      apisService.findOne.mockResolvedValue(mockApi);
      apisService.testApiConnection.mockResolvedValue(mockResult);

      const result = await controller.testConnection(mockRequest, 'api-1');

      expect(result).toEqual({ success: true, data: mockResult, message: expect.any(String) });
    });
  });

  describe('getOperations', () => {
    it('should return API operations', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      const mockOperations = [{ id: 'op-1' }, { id: 'op-2' }];

      apisService.findOne.mockResolvedValue(mockApi);
      apisService.getApiOperations = jest.fn().mockResolvedValue(mockOperations);

      const result = await controller.getOperations(mockRequest, 'api-1');

      expect(result).toEqual({ success: true, data: mockOperations, message: expect.any(String) });
    });
  });

  describe('getResources', () => {
    it('should return API resources', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      const mockResources = [{ id: 'res-1' }, { id: 'res-2' }];

      apisService.findOne.mockResolvedValue(mockApi);
      apisService.getApiResources = jest.fn().mockResolvedValue(mockResources);

      const result = await controller.getResources(mockRequest, 'api-1');

      expect(result).toEqual({ success: true, data: mockResources, message: expect.any(String) });
    });
  });

  describe('getSchemas', () => {
    it('should return API schemas', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      const mockSchemas = [{ id: 'schema-1' }, { id: 'schema-2' }];

      apisService.findOne.mockResolvedValue(mockApi);
      apisService.getApiSchemas = jest.fn().mockResolvedValue(mockSchemas);

      const result = await controller.getSchemas(mockRequest, 'api-1');

      expect(result).toEqual({ success: true, data: mockSchemas, message: expect.any(String) });
    });
  });

  describe('testConnection', () => {
    it('should test API connection successfully', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      const mockResult = { success: true, responseTime: 150, message: 'Connection successful' };

      apisService.findOne.mockResolvedValue(mockApi);
      apisService.testApiConnection.mockResolvedValue(mockResult);

      const result = await controller.testConnection(mockRequest, 'api-1');

      expect(result).toEqual({ success: true, data: mockResult, message: expect.any(String) });
      expect(apisService.testApiConnection).toHaveBeenCalledWith('api-1');
    });

    it('should handle failed connection test', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      const mockResult = { success: false, responseTime: 0, error: 'Connection failed' };

      apisService.findOne.mockResolvedValue(mockApi);
      apisService.testApiConnection.mockResolvedValue(mockResult);

      const result = await controller.testConnection(mockRequest, 'api-1');

      expect(result).toEqual({ success: true, data: mockResult, message: expect.any(String) });
      expect(result.data.success).toBe(false);
    });
  });

  describe('generateTools', () => {
    it('should generate tools from API', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;
      const mockTools = [{ id: 'tool-1' }, { id: 'tool-2' }] as any;

      apisService.findOne.mockResolvedValue(mockApi);
      apisService.generateToolsFromApi.mockResolvedValue(mockTools);

      const result = await controller.generateTools(mockRequest, 'api-1');

      expect(result).toEqual({ success: true, data: mockTools, message: expect.any(String) });
      expect(result.data).toHaveLength(2);
      expect(apisService.generateToolsFromApi).toHaveBeenCalledWith('api-1');
    });
  });

  describe('updateStatus', () => {
    it('should update API status', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1', status: 'active' } as any;

      apisService.findOne.mockResolvedValue(mockApi);
      apisService.updateStatus = jest.fn().mockResolvedValue(mockApi);

      const result = await controller.updateStatus(mockRequest, 'api-1', 'active' as any);

      expect(result).toEqual({ success: true, data: mockApi, message: expect.any(String) });
    });

    it('should throw not found when API does not exist', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };

      apisService.findOne.mockResolvedValue(null);

      await expect(controller.updateStatus(mockRequest, 'api-1', 'active' as any))
        .rejects.toThrow('API not found');
    });

    it('should throw forbidden when wrong organization', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-2' } as any;

      apisService.findOne.mockResolvedValue(mockApi);

      await expect(controller.updateStatus(mockRequest, 'api-1', 'active' as any))
        .rejects.toThrow('Access denied');
    });
  });

  // Error handling tests for all branches
  describe('findAll - error handling', () => {
    it('should throw when organizationId is missing', async () => {
      const mockRequest = { user: {} };

      await expect(controller.findAll(mockRequest, undefined, undefined, undefined, 1, 10))
        .rejects.toThrow('Organization ID is required');
    });
  });

  describe('findOne - error handling', () => {
    it('should throw not found when API does not exist', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };

      apisService.findOne.mockResolvedValue(null);

      await expect(controller.findOne(mockRequest, 'api-1'))
        .rejects.toThrow('API not found');
    });

    it('should throw forbidden when wrong organization', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-2' } as any;

      apisService.findOne.mockResolvedValue(mockApi);

      await expect(controller.findOne(mockRequest, 'api-1'))
        .rejects.toThrow('Access denied');
    });
  });

  describe('create - error handling', () => {
    it('should throw when organization context missing', async () => {
      const mockRequest = { user: {} };
      const createDto = { name: 'API', baseUrl: 'http://test.com', type: 'openapi' as any };

      await expect(controller.create(mockRequest, createDto as any))
        .rejects.toThrow('Organization context required');
    });
  });

  describe('update - error handling', () => {
    it('should throw not found when API does not exist', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };

      apisService.findOne.mockResolvedValue(null);

      await expect(controller.update(mockRequest, 'api-1', {}))
        .rejects.toThrow('API not found');
    });

    it('should throw forbidden when wrong organization', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-2' } as any;

      apisService.findOne.mockResolvedValue(mockApi);

      await expect(controller.update(mockRequest, 'api-1', {}))
        .rejects.toThrow('Access denied');
    });
  });

  describe('remove - error handling', () => {
    it('should throw not found when API does not exist', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };

      apisService.findOne.mockResolvedValue(null);

      await expect(controller.remove(mockRequest, 'api-1'))
        .rejects.toThrow('API not found');
    });

    it('should throw forbidden when wrong organization', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-2' } as any;

      apisService.findOne.mockResolvedValue(mockApi);

      await expect(controller.remove(mockRequest, 'api-1'))
        .rejects.toThrow('Access denied');
    });
  });

  describe('importSchema - error handling', () => {
    it('should throw not found when API does not exist', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };

      apisService.findOne.mockResolvedValue(null);

      await expect(controller.importSchema(mockRequest, 'api-1', {} as any))
        .rejects.toThrow('API not found');
    });

    it('should throw forbidden when wrong organization', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-2' } as any;

      apisService.findOne.mockResolvedValue(mockApi);

      await expect(controller.importSchema(mockRequest, 'api-1', {} as any))
        .rejects.toThrow('Access denied');
    });

    it('should throw when no schema source provided', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-1' } as any;

      apisService.findOne.mockResolvedValue(mockApi);

      await expect(controller.importSchema(mockRequest, 'api-1', {} as any))
        .rejects.toThrow('Schema content, file, or URL is required');
    });
  });

  describe('generateTools - error handling', () => {
    it('should throw not found when API does not exist', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };

      apisService.findOne.mockResolvedValue(null);

      await expect(controller.generateTools(mockRequest, 'api-1'))
        .rejects.toThrow('API not found');
    });

    it('should throw forbidden when wrong organization', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-2' } as any;

      apisService.findOne.mockResolvedValue(mockApi);

      await expect(controller.generateTools(mockRequest, 'api-1'))
        .rejects.toThrow('Access denied');
    });
  });

  describe('getOperations - error handling', () => {
    it('should throw not found when API does not exist', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };

      apisService.findOne.mockResolvedValue(null);

      await expect(controller.getOperations(mockRequest, 'api-1'))
        .rejects.toThrow('API not found');
    });

    it('should throw forbidden when wrong organization', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-2' } as any;

      apisService.findOne.mockResolvedValue(mockApi);

      await expect(controller.getOperations(mockRequest, 'api-1'))
        .rejects.toThrow('Access denied');
    });
  });

  describe('getResources - error handling', () => {
    it('should throw not found when API does not exist', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };

      apisService.findOne.mockResolvedValue(null);

      await expect(controller.getResources(mockRequest, 'api-1'))
        .rejects.toThrow('API not found');
    });

    it('should throw forbidden when wrong organization', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-2' } as any;

      apisService.findOne.mockResolvedValue(mockApi);

      await expect(controller.getResources(mockRequest, 'api-1'))
        .rejects.toThrow('Access denied');
    });
  });

  describe('testConnection - error handling', () => {
    it('should throw not found when API does not exist', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };

      apisService.findOne.mockResolvedValue(null);

      await expect(controller.testConnection(mockRequest, 'api-1'))
        .rejects.toThrow('API not found');
    });

    it('should throw forbidden when wrong organization', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-2' } as any;

      apisService.findOne.mockResolvedValue(mockApi);

      await expect(controller.testConnection(mockRequest, 'api-1'))
        .rejects.toThrow('Access denied');
    });
  });

  describe('getSchemas - error handling', () => {
    it('should throw not found when API does not exist', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };

      apisService.findOne.mockResolvedValue(null);

      await expect(controller.getSchemas(mockRequest, 'api-1'))
        .rejects.toThrow('API not found');
    });

    it('should throw forbidden when wrong organization', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockApi = { id: 'api-1', organizationId: 'org-2' } as any;

      apisService.findOne.mockResolvedValue(mockApi);

      await expect(controller.getSchemas(mockRequest, 'api-1'))
        .rejects.toThrow('Access denied');
    });
  });

});