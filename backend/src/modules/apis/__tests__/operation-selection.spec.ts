/**
 * Microsoft Graph's Files description (1,619 operations) is over the
 * per-schema tool limit. The import used to throw "the limit per schema is
 * 1000. Select a subset of operations" from tool generation, after a
 * minutes-long parse -- and the job retried it twice more with backoff, so
 * "Finish connecting" spun for 10+ minutes with no way to pick a subset.
 *
 * Now: the import keeps the operations, makes no tools, and says
 * `selectionRequired`; the person picks operations (selectOperations) and a
 * `generate` job makes tools from those. A quota refusal fails the job at
 * once. The limit reads MAX_TOOLS_PER_SCHEMA.
 */
import { Repository } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { Job } from 'bull';

import { ApisImportHelper } from '../apis-import.helper';
import { ApisService } from '../apis.service';
import { Api, ApiType, ApiStatus } from '../../../entities/api.entity';
import { ApiSchema } from '../../../entities/api-schema.entity';
import { Operation } from '../../../entities/operation.entity';
import { MAX_TOOLS_PER_SCHEMA, ToolQuotaExceededException, assertWithinPerSchemaCap, maxToolsPerSchema } from '../../tools/tool-quota';
import { SchemaImportProcessor } from '../../jobs/processors/schema-import.processor';
import { restoreEnv } from '../../../test/env';

const ENV = 'MAX_TOOLS_PER_SCHEMA';

function withLimit(value: string | undefined, run: () => Promise<void> | void) {
  return async () => {
    const before = process.env[ENV];
    restoreEnv(ENV, value);
    try {
      await run();
    } finally {
      restoreEnv(ENV, before);
    }
  };
}

describe('per-schema tool limit is configurable', () => {
  it('defaults to 1000', withLimit(undefined, () => {
    expect(maxToolsPerSchema()).toBe(MAX_TOOLS_PER_SCHEMA);
    expect(MAX_TOOLS_PER_SCHEMA).toBe(1000);
  }));

  it('reads MAX_TOOLS_PER_SCHEMA', withLimit('2500', () => {
    expect(maxToolsPerSchema()).toBe(2500);
    expect(() => assertWithinPerSchemaCap(1619, "API 'Files'")).not.toThrow();
    expect(() => assertWithinPerSchemaCap(2501, "API 'Files'")).toThrow(/limit per schema is 2500/);
  }));

  it('ignores a value that is not a positive number', withLimit('lots', () => {
    expect(maxToolsPerSchema()).toBe(1000);
  }));
});

describe('an import over the limit asks for a subset instead of failing', () => {
  const api = { id: 'api-1', type: ApiType.OPENAPI, status: ApiStatus.ACTIVE, organizationId: 'org-1', metadata: null } as any as Api;

  function helperWith(operationCount: number) {
    const saved: Operation[] = [];
    const generateToolsFromApi = jest.fn().mockResolvedValue({ tools: [{ id: 't' }], generated: 1, failed: 0, total: operationCount });
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      isTransactionActive: false,
      manager: {
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn(async (arg: any) => {
          if (Array.isArray(arg)) {
            arg.forEach((op, i) => { op.id = op.id ?? `op-${saved.length + i}`; });
            saved.push(...arg);
          }
          return arg;
        }),
        update: jest.fn(),
      },
    };
    const helper = new ApisImportHelper(
      { findOne: jest.fn().mockResolvedValue(api) } as any,
      { create: (dto: any) => Object.assign(new ApiSchema(), dto) } as unknown as Repository<ApiSchema>,
      {
        parseApiSchema: jest.fn().mockResolvedValue({ version: '1.0', metadata: {} }),
        getParserForApiType: () => ({
          extractResources: async () => [],
          extractOperations: async () =>
            Array.from({ length: operationCount }, (_, i) => Object.assign(new Operation(), { operationId: `op${i}`, name: `op${i}` })),
        }),
      } as any,
      {} as any,
      { createQueryRunner: () => queryRunner } as any,
      { findOne: jest.fn().mockResolvedValue(api) } as any,
      { logMemoryPhase: jest.fn(), detectSchemaFormat: () => 'json', awaitHeapHeadroom: jest.fn(), generateToolsFromApi } as any,
    );
    return { helper, generateToolsFromApi, saved };
  }

  it('keeps all 1,619 operations, makes no tools and says how many there are and the limit', withLimit(undefined, async () => {
    const { helper, generateToolsFromApi, saved } = helperWith(1619);
    const result = await helper.importSchema('api-1', '{}', 'org-1', { generateTools: true });
    expect(saved).toHaveLength(1619);
    expect(generateToolsFromApi).not.toHaveBeenCalled();
    expect(result.selectionRequired).toEqual({ operations: 1619, limit: 1000 });
    expect(result.tools).toBeUndefined();
  }));

  it('makes tools as before when the description is within the limit', withLimit(undefined, async () => {
    const { helper, generateToolsFromApi } = helperWith(40);
    const result = await helper.importSchema('api-1', '{}', 'org-1', { generateTools: true });
    expect(generateToolsFromApi).toHaveBeenCalledTimes(1);
    expect(result.selectionRequired).toBeUndefined();
  }));

  it('follows a raised limit', withLimit('2000', async () => {
    const { helper, generateToolsFromApi } = helperWith(1619);
    const result = await helper.importSchema('api-1', '{}', 'org-1', { generateTools: true });
    expect(generateToolsFromApi).toHaveBeenCalledTimes(1);
    expect(result.selectionRequired).toBeUndefined();
  }));
});

describe('picking the operations to make tools from', () => {
  function serviceWith(existingIds: string[]) {
    const updates: Array<{ where: any; patch: any }> = [];
    const operationRepository = {
      count: jest.fn(async ({ where }: any) => existingIds.filter((id) => where.id.value.includes(id)).length),
    };
    const service = Object.create(ApisService.prototype) as ApisService;
    Object.assign(service, {
      apiRepository: { findOne: jest.fn().mockResolvedValue({ id: 'api-1' }) },
      operationRepository,
      dataSource: {
        transaction: async (work: any) =>
          work({ getRepository: () => ({ update: async (where: any, patch: any) => updates.push({ where, patch }) }) }),
      },
    });
    return { service, updates };
  }

  it('activates the picked operations and deactivates the rest', async () => {
    const { service, updates } = serviceWith(['a', 'b', 'c']);
    await expect(service.selectOperations('api-1', 'org-1', ['a', 'b', 'a'])).resolves.toEqual({ selected: 2 });
    expect(updates.map((u) => u.patch)).toEqual([{ isActive: false }, { isActive: true }]);
    expect(updates[1].where.id.value).toEqual(['a', 'b']);
  });

  it('refuses an empty selection, one over the limit, and operations of another API', withLimit('2', async () => {
    const { service, updates } = serviceWith(['a', 'b', 'c']);
    await expect(service.selectOperations('api-1', 'org-1', [])).rejects.toThrow(BadRequestException);
    await expect(service.selectOperations('api-1', 'org-1', ['a', 'b', 'c'])).rejects.toThrow(/limit per schema is 2/);
    await expect(service.selectOperations('api-1', 'org-1', ['a', 'zzz'])).rejects.toThrow(/not part of this API/);
    expect(updates).toEqual([]);
  }));
});

describe('the import job', () => {
  function processorWith(apisService: Partial<ApisService>) {
    const apiRepository = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    return { processor: new SchemaImportProcessor(apisService as ApisService, apiRepository as any), apiRepository };
  }
  const job = (data: any) =>
    ({ id: 'job-1', data, opts: { attempts: 3 }, attemptsMade: 1, progress: jest.fn(), discard: jest.fn(function (this: any) { this._discarded = true; }), isDiscarded() { return !!(this as any)._discarded; } }) as any as Job;

  it('returns selectionRequired so the page can ask for a subset', async () => {
    const { processor } = processorWith({
      findOne: jest.fn().mockResolvedValue({ id: 'api-1' }),
      importSchema: jest.fn().mockResolvedValue({ api: {}, schema: {}, operations: new Array(1619), resources: [], selectionRequired: { operations: 1619, limit: 1000 } }),
    } as any);
    const result = await processor.handleSchemaImport(job({ apiId: 'api-1', organizationId: 'org-1', schemaContent: '{}', options: { generateTools: true } }));
    expect(result).toMatchObject({ operationCount: 1619, toolCount: 0, selectionRequired: { operations: 1619, limit: 1000 } });
  });

  it('fails at once on a quota refusal and records why, instead of retrying it', async () => {
    const { processor, apiRepository } = processorWith({
      findOne: jest.fn().mockResolvedValue({ id: 'api-1' }),
      importSchema: jest.fn().mockRejectedValue(new ToolQuotaExceededException('Schema import failed: Organization has reached tool limit')),
    } as any);
    const j = job({ apiId: 'api-1', organizationId: 'org-1', schemaContent: '{}', options: {} });
    await expect(processor.handleSchemaImport(j)).rejects.toThrow(/tool limit/);
    expect(j.discard).toHaveBeenCalled();
    await processor.onFailed(j, new Error('Schema import failed: Organization has reached tool limit'));
    expect(apiRepository.update).toHaveBeenCalledWith({ id: 'api-1', organizationId: 'org-1' }, expect.objectContaining({ lastImportError: expect.stringMatching(/tool limit/) }));
  });

  it('still retries any other failure', async () => {
    const { processor, apiRepository } = processorWith({
      findOne: jest.fn().mockResolvedValue({ id: 'api-1' }),
      importSchema: jest.fn().mockRejectedValue(new Error('connection reset')),
    } as any);
    const j = job({ apiId: 'api-1', organizationId: 'org-1', schemaContent: '{}', options: {} });
    await expect(processor.handleSchemaImport(j)).rejects.toThrow('connection reset');
    expect(j.discard).not.toHaveBeenCalled();
    await processor.onFailed(j, new Error('connection reset'));
    expect(apiRepository.update).not.toHaveBeenCalled();
  });

  it('a generate job makes tools from the active operations and reports the counts', async () => {
    const generateToolsFromApi = jest.fn().mockResolvedValue({ tools: [], generated: 240, failed: 0, skippedInactive: 1379, skippedExisting: 0, total: 1619 });
    const { processor } = processorWith({ generateToolsFromApi } as any);
    const result = await processor.handleGenerateTools(job({ apiId: 'api-1', organizationId: 'org-1', createdBy: 'user-1' }));
    expect(generateToolsFromApi).toHaveBeenCalledWith('api-1', 'org-1', undefined, expect.any(Function), 'user-1');
    expect(result).toEqual({ success: true, operationCount: 240, toolCount: 240 });
  });
});
