/**
 * Tests for tool generation from API operations.
 *
 * Regression: generateToolsFromApi used to fire ALL operations in parallel
 * via Promise.all, exhausting the DB connection pool on large APIs (438+
 * concurrent saves). Now processes in batches of 3.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApisService } from '../apis.service';
import { ApisImportHelper } from '../apis-import.helper';
import { ApisToolGeneratorHelper } from '../apis-tool-generator.helper';
import { Api, ApiType, ApiStatus } from '../../../entities/api.entity';
import { ApiSchema } from '../../../entities/api-schema.entity';
import { Operation } from '../../../entities/operation.entity';
import { Resource } from '../../../entities/resource.entity';
import { Organization } from '../../../entities/organization.entity';
import { SchemaParserService } from '../../schema-parser/schema-parser.service';
import { ToolsService } from '../../tools/tools.service';
import { AuditLogService } from '../../audit-log/audit-log.service';

describe('ApisService - tool generation', () => {
  let service: ApisService;
  let toolsService: any;
  let createCallTimestamps: number[];

  beforeEach(async () => {
    createCallTimestamps = [];

    toolsService = {
      findByName: jest.fn().mockResolvedValue(null), // no existing tools
      createFromOperation: jest.fn().mockImplementation(async (op, opts) => {
        createCallTimestamps.push(Date.now());
        // Simulate a small DB delay
        await new Promise(r => setTimeout(r, 10));
        return { id: `tool-${op.name}`, name: opts.name, status: 'active' };
      }),
      updateFromOperation: jest.fn(),
    };

    // 60 operations: with BATCH_SIZE=20 that's 3 batches, so we can
    // observe the parallel-within-batch + sequential-between-batch
    // behavior. The earlier 20-op fixture matched the old batch
    // size (5 → 4 batches) but doesn't fit the new batch size where
    // 20 ops would all run in one go.
    const mockApi: Partial<Api> = {
      id: 'api-1',
      name: 'Test API',
      type: ApiType.OPENAPI,
      status: ApiStatus.ACTIVE,
      organizationId: 'org-1',
      operations: Array.from({ length: 60 }, (_, i) => ({
        id: `op-${i}`,
        name: `operation_${i}`,
        method: 'GET',
        endpoint: `/test/${i}`,
        isActive: true,
        apiId: 'api-1',
      })) as any[],
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApisService,
        ApisImportHelper,
        ApisToolGeneratorHelper,
        { provide: getRepositoryToken(Api), useValue: { findOne: jest.fn().mockResolvedValue(mockApi) } },
        { provide: getRepositoryToken(ApiSchema), useValue: {} },
        { provide: getRepositoryToken(Operation), useValue: {} },
        { provide: getRepositoryToken(Resource), useValue: {} },
        { provide: getRepositoryToken(Organization), useValue: {} },
        { provide: SchemaParserService, useValue: {} },
        { provide: ToolsService, useValue: toolsService },
        { provide: AuditLogService, useValue: { logCreate: jest.fn() } },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    service = module.get(ApisService);
  });

  it('generates tools for all active operations', async () => {
    const tools = await service.generateToolsFromApi('api-1', 'org-1');
    expect(tools).toHaveLength(60);
    expect(toolsService.createFromOperation).toHaveBeenCalledTimes(60);
  });

  it('processes in batches, not all at once', async () => {
    await service.generateToolsFromApi('api-1', 'org-1');

    // BATCH_SIZE = 20, 60 ops → 3 batches. Within each batch ops
    // run in parallel; the next batch waits for the previous to
    // settle. The original concern this guards against is the old
    // bug where a 600-op import did Promise.all on the whole array
    // and grabbed 600 connections at once. We re-prove it didn't
    // come back: not all 60 timestamps arrived within ~1ms.
    expect(createCallTimestamps.length).toBe(60);

    const firstCall = createCallTimestamps[0];
    const lastCall = createCallTimestamps[createCallTimestamps.length - 1];
    // Each tool sleeps 10ms in the mock. With 3 batches of 20 each,
    // wall time should be at least ~30ms; if the batching collapsed
    // back to one giant Promise.all it would be ~10ms.
    expect(lastCall - firstCall).toBeGreaterThanOrEqual(20);
  });

  it('generates UNIQUE tool names for distinct operations whose semantic name overflows 64 chars', async () => {
    // Reproduces bug 11: a real Google Translate proto import lost
    // 22/38 operations because the truncator kept the prefix and
    // dropped the discriminator. Distinct ops collapsed to the same
    // tool name, last-write-wins.
    const apiRepo = (service as any).apiRepository;
    apiRepo.findOne = jest.fn().mockResolvedValue({
      id: 'api-1',
      name: 'Real Google Translate Protobuf API',
      type: ApiType.GRPC,
      status: ApiStatus.ACTIVE,
      organizationId: 'org-1',
      operations: [],
    });
    const ops = [
      { id: 'o1', name: 'TranslateText',          method: 'POST', endpoint: '/grpc/TranslateText',          operationId: 'TranslationService.TranslateText',          isActive: true },
      { id: 'o2', name: 'TranslateDocument',      method: 'POST', endpoint: '/grpc/TranslateDocument',      operationId: 'TranslationService.TranslateDocument',      isActive: true },
      { id: 'o3', name: 'BatchTranslateText',     method: 'POST', endpoint: '/grpc/BatchTranslateText',     operationId: 'TranslationService.BatchTranslateText',     isActive: true },
      { id: 'o4', name: 'BatchTranslateDocument', method: 'POST', endpoint: '/grpc/BatchTranslateDocument', operationId: 'TranslationService.BatchTranslateDocument', isActive: true },
      { id: 'o5', name: 'GetModel',               method: 'POST', endpoint: '/grpc/GetModel',               operationId: 'TranslationService.GetModel',               isActive: true },
      { id: 'o6', name: 'GetAdaptiveMtFile',      method: 'POST', endpoint: '/grpc/GetAdaptiveMtFile',      operationId: 'TranslationService.GetAdaptiveMtFile',      isActive: true },
    ] as any[];

    await service.generateToolsFromApi('api-1', 'org-1', ops);

    const names = (toolsService.createFromOperation as jest.Mock).mock.calls.map((c) => c[1].name);
    expect(names).toHaveLength(6);
    expect(new Set(names).size).toBe(6); // all distinct
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(64);
    }
  });

  it('calls onBatchProgress between tool-gen batches so a host BullMQ job can refresh its lock', async () => {
    const apiRepo = (service as any).apiRepository;
    apiRepo.findOne = jest.fn().mockResolvedValue({
      id: 'api-1',
      name: 'Test',
      type: ApiType.OPENAPI,
      status: ApiStatus.ACTIVE,
      organizationId: 'org-1',
      operations: [],
    });
    const ops = Array.from({ length: 12 }, (_, i) => ({
      id: `op-${i}`,
      name: `op_${i}`,
      method: 'GET',
      endpoint: `/p/${i}`,
      isActive: true,
    })) as any[];

    const heartbeat = jest.fn();
    await service.generateToolsFromApi('api-1', 'org-1', ops, heartbeat);

    expect(heartbeat).toHaveBeenCalled();
    // Last call should reach 100% of operations.
    const lastCall = heartbeat.mock.calls[heartbeat.mock.calls.length - 1];
    expect(lastCall[0]).toBe(12);
    expect(lastCall[1]).toBe(12);
  });

  it('uses preloadedOperations when supplied — must not fall through to api.operations (transaction-isolation regression)', async () => {
    // Simulate the importSchema call site: api.operations is empty
    // because the operations row was just saved in an open
    // transaction the repository can't see. preloadedOperations
    // must be used directly so we still generate tools.
    const apiRepo = (service as any).apiRepository;
    apiRepo.findOne = jest.fn().mockResolvedValue({
      id: 'api-1',
      name: 'Test API',
      type: ApiType.OPENAPI,
      status: ApiStatus.ACTIVE,
      organizationId: 'org-1',
      operations: [], // empty as far as the repo can see
    });

    const preloaded = Array.from({ length: 3 }, (_, i) => ({
      id: `op-${i}`,
      name: `op_${i}`,
      method: 'GET',
      endpoint: `/p/${i}`,
      isActive: true,
      apiId: 'api-1',
    })) as any[];

    const tools = await service.generateToolsFromApi('api-1', 'org-1', preloaded);
    expect(tools).toHaveLength(3);
    expect(toolsService.createFromOperation).toHaveBeenCalledTimes(3);
  });

  it('continues generating even if one tool fails', async () => {
    toolsService.createFromOperation
      .mockResolvedValue({ id: 'tool-ok', name: 'ok' })
      .mockRejectedValueOnce(new Error('DB error'));

    const tools = await service.generateToolsFromApi('api-1', 'org-1');
    // 59 succeed, 1 fails (60 ops in fixture)
    expect(tools.length).toBe(59);
    expect(toolsService.createFromOperation).toHaveBeenCalledTimes(60);
  });
});
