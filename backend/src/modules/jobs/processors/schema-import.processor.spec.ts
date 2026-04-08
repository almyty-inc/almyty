import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bull';
import { SchemaImportProcessor, SchemaImportJob } from './schema-import.processor';
import { ApisService } from '../../apis/apis.service';
import { Api } from '../../../entities/api.entity';
import { ApiSchema } from '../../../entities/api-schema.entity';
import { Operation } from '../../../entities/operation.entity';
import { Resource } from '../../../entities/resource.entity';
import { Tool } from '../../../entities/tool.entity';

describe('SchemaImportProcessor', () => {
  let processor: SchemaImportProcessor;
  let apisService: jest.Mocked<ApisService>;

  const mockApisService: Partial<jest.Mocked<ApisService>> = {
    importSchema: jest.fn(),
    findOne: jest.fn(),
  };

  function createMockJob(data: SchemaImportJob, id: string | number = 'job-1'): jest.Mocked<Job<SchemaImportJob>> {
    return {
      id,
      data,
      progress: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Job<SchemaImportJob>>;
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemaImportProcessor,
        {
          provide: ApisService,
          useValue: mockApisService,
        },
      ],
    }).compile();

    processor = module.get<SchemaImportProcessor>(SchemaImportProcessor);
    apisService = module.get(ApisService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleSchemaImport', () => {
    const mockApi = { id: 'api-1', name: 'Petstore' } as Api;
    const mockSchema = { id: 'schema-1', apiId: 'api-1' } as ApiSchema;
    const mockOperations: Operation[] = [
      { id: 'op-1', name: 'listPets' } as Operation,
      { id: 'op-2', name: 'createPets' } as Operation,
    ];
    const mockResources: Resource[] = [
      { id: 'res-1', name: 'Pet' } as Resource,
    ];
    const mockTools: Tool[] = [
      { id: 'tool-1', name: 'Petstore_listPets' } as Tool,
      { id: 'tool-2', name: 'Petstore_createPets' } as Tool,
    ];

    it('should successfully import a schema and return a result summary', async () => {
      const jobData: SchemaImportJob = {
        apiId: 'api-1',
        schemaContent: '{"openapi":"3.0.0"}',
        options: { generateTools: true },
      };
      const job = createMockJob(jobData);

      apisService.importSchema.mockResolvedValue({
        api: mockApi,
        schema: mockSchema,
        operations: mockOperations,
        resources: mockResources,
        tools: mockTools,
      });

      const result = await processor.handleSchemaImport(job);

      expect(result).toEqual({
        success: true,
        api: mockApi,
        schema: mockSchema,
        operationCount: 2,
        toolCount: 2,
      });
    });

    it('should call apisService.importSchema with correct arguments', async () => {
      const jobData: SchemaImportJob = {
        apiId: 'api-42',
        schemaContent: '{"swagger":"2.0"}',
        options: { fileName: 'petstore.json', description: 'Petstore API', generateTools: false },
      };
      const job = createMockJob(jobData, 'job-99');

      apisService.importSchema.mockResolvedValue({
        api: mockApi,
        schema: mockSchema,
        operations: mockOperations,
        resources: mockResources,
      });

      await processor.handleSchemaImport(job);

      expect(apisService.importSchema).toHaveBeenCalledWith(
        'api-42',
        '{"swagger":"2.0"}',
        { fileName: 'petstore.json', description: 'Petstore API', generateTools: false },
      );
    });

    it('should update job progress to 10 before import and 100 after', async () => {
      const jobData: SchemaImportJob = {
        apiId: 'api-1',
        schemaContent: '{}',
        options: {},
      };
      const job = createMockJob(jobData);

      apisService.importSchema.mockResolvedValue({
        api: mockApi,
        schema: mockSchema,
        operations: mockOperations,
        resources: mockResources,
      });

      await processor.handleSchemaImport(job);

      expect(job.progress).toHaveBeenNthCalledWith(1, 10);
      expect(job.progress).toHaveBeenNthCalledWith(2, 100);
    });

    it('should set toolCount to 0 when tools array is undefined', async () => {
      const jobData: SchemaImportJob = {
        apiId: 'api-1',
        schemaContent: '{}',
        options: { generateTools: false },
      };
      const job = createMockJob(jobData);

      apisService.importSchema.mockResolvedValue({
        api: mockApi,
        schema: mockSchema,
        operations: mockOperations,
        resources: mockResources,
        tools: undefined,
      });

      const result = await processor.handleSchemaImport(job);

      expect(result.toolCount).toBe(0);
    });

    it('should set toolCount to 0 when tools array is empty', async () => {
      const jobData: SchemaImportJob = {
        apiId: 'api-1',
        schemaContent: '{}',
        options: { generateTools: true },
      };
      const job = createMockJob(jobData);

      apisService.importSchema.mockResolvedValue({
        api: mockApi,
        schema: mockSchema,
        operations: mockOperations,
        resources: mockResources,
        tools: [],
      });

      const result = await processor.handleSchemaImport(job);

      expect(result.toolCount).toBe(0);
    });

    it('should reflect the correct operationCount from import result', async () => {
      const manyOperations: Operation[] = Array.from({ length: 20 }, (_, i) => ({
        id: `op-${i}`,
        name: `operation${i}`,
      } as Operation));

      const jobData: SchemaImportJob = {
        apiId: 'api-1',
        schemaContent: '{}',
        options: {},
      };
      const job = createMockJob(jobData);

      apisService.importSchema.mockResolvedValue({
        api: mockApi,
        schema: mockSchema,
        operations: manyOperations,
        resources: mockResources,
      });

      const result = await processor.handleSchemaImport(job);

      expect(result.operationCount).toBe(20);
    });

    it('should throw the error from apisService.importSchema', async () => {
      const jobData: SchemaImportJob = {
        apiId: 'api-missing',
        schemaContent: '{}',
        options: {},
      };
      const job = createMockJob(jobData);
      const importError = new Error('API not found');

      apisService.importSchema.mockRejectedValue(importError);

      await expect(processor.handleSchemaImport(job)).rejects.toThrow('API not found');
    });

    it('should not update progress to 100 when import fails', async () => {
      const jobData: SchemaImportJob = {
        apiId: 'api-1',
        schemaContent: '{}',
        options: {},
      };
      const job = createMockJob(jobData);

      apisService.importSchema.mockRejectedValue(new Error('Schema parse error'));

      await expect(processor.handleSchemaImport(job)).rejects.toThrow('Schema parse error');

      // Progress 10 should be called, but 100 should not (error happens before it)
      expect(job.progress).toHaveBeenCalledWith(10);
      expect(job.progress).not.toHaveBeenCalledWith(100);
    });

    it('should handle a job with empty options object', async () => {
      const jobData: SchemaImportJob = {
        apiId: 'api-1',
        schemaContent: '{"info": {"title": "Test API"}}',
        options: {},
      };
      const job = createMockJob(jobData);

      apisService.importSchema.mockResolvedValue({
        api: mockApi,
        schema: mockSchema,
        operations: [],
        resources: [],
      });

      const result = await processor.handleSchemaImport(job);

      expect(result.success).toBe(true);
      expect(result.operationCount).toBe(0);
      expect(result.toolCount).toBe(0);
    });

    it('should pass through the imported api and schema in the result', async () => {
      const specificApi = { id: 'api-99', name: 'MyAPI' } as Api;
      const specificSchema = { id: 'schema-99', version: '2.0.0' } as ApiSchema;

      const jobData: SchemaImportJob = {
        apiId: 'api-99',
        schemaContent: '{}',
        options: {},
      };
      const job = createMockJob(jobData);

      apisService.importSchema.mockResolvedValue({
        api: specificApi,
        schema: specificSchema,
        operations: [],
        resources: [],
      });

      const result = await processor.handleSchemaImport(job);

      expect(result.api).toBe(specificApi);
      expect(result.schema).toBe(specificSchema);
    });

    // Defence in depth: the controller already org-checks, but the worker
    // re-verifies the api still belongs to the org from the job payload.
    // This guards against stale jobs and direct Redis manipulation.
    describe('cross-org defence in depth', () => {
      it('refuses to import when the api belongs to a different org', async () => {
        apisService.findOne.mockResolvedValue({
          id: 'api-1',
          organizationId: 'attacker-org',
        } as Api);

        const job = createMockJob({
          apiId: 'api-1',
          organizationId: 'victim-org',
          schemaContent: '{}',
          options: {},
        });

        await expect(processor.handleSchemaImport(job)).rejects.toThrow(
          /not found in organization/,
        );
        expect(apisService.importSchema).not.toHaveBeenCalled();
      });

      it('refuses to import when the api no longer exists', async () => {
        apisService.findOne.mockResolvedValue(null as any);

        const job = createMockJob({
          apiId: 'api-deleted',
          organizationId: 'org-1',
          schemaContent: '{}',
          options: {},
        });

        await expect(processor.handleSchemaImport(job)).rejects.toThrow(/not found/);
        expect(apisService.importSchema).not.toHaveBeenCalled();
      });

      it('proceeds when the api belongs to the org from the payload', async () => {
        apisService.findOne.mockResolvedValue({
          id: 'api-1',
          organizationId: 'org-1',
        } as Api);
        apisService.importSchema.mockResolvedValue({
          api: mockApi,
          schema: mockSchema,
          operations: [],
          resources: [],
        });

        const job = createMockJob({
          apiId: 'api-1',
          organizationId: 'org-1',
          schemaContent: '{}',
          options: {},
        });

        const result = await processor.handleSchemaImport(job);
        expect(result.success).toBe(true);
        expect(apisService.importSchema).toHaveBeenCalled();
      });

      it('skips the cross-check for legacy jobs without an organizationId', async () => {
        // Backwards compatibility: jobs already in Redis from before this
        // change have no organizationId in the payload. The worker should
        // still process them rather than failing every in-flight job.
        apisService.importSchema.mockResolvedValue({
          api: mockApi,
          schema: mockSchema,
          operations: [],
          resources: [],
        });

        const job = createMockJob({
          apiId: 'api-1',
          schemaContent: '{}',
          options: {},
        });

        const result = await processor.handleSchemaImport(job);
        expect(result.success).toBe(true);
        expect(apisService.findOne).not.toHaveBeenCalled();
      });
    });
  });
});
