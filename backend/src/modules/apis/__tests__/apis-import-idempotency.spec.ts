/**
 * Schema import must be idempotent per (apiId, version).
 *
 * The import job carries attempts: 3 and tool generation runs after
 * the import transaction commits, re-throwing on failure — so a
 * tool-gen failure retries the whole import from the top. Before the
 * fix that meant a fresh api_schemas row (a full copy of the raw
 * spec) and a fresh set of resource rows with new UUIDs on every
 * attempt.
 */
import { Repository } from 'typeorm';
import { ApisImportHelper } from '../apis-import.helper';
import { Api, ApiType, ApiStatus } from '../../../entities/api.entity';
import { ApiSchema } from '../../../entities/api-schema.entity';
import { Operation } from '../../../entities/operation.entity';
import { Resource, ResourceType } from '../../../entities/resource.entity';

/**
 * A tiny in-memory stand-in for the transactional EntityManager: it
 * keeps rows per entity class and mints ids on insert, which is the
 * only behaviour these assertions depend on.
 */
class FakeStore {
  rows = new Map<Function, any[]>();
  private seq = 0;

  private tableOf(entity: Function): any[] {
    let t = this.rows.get(entity);
    if (!t) { t = []; this.rows.set(entity, t); }
    return t;
  }

  of<T>(entity: Function): T[] {
    return this.tableOf(entity) as T[];
  }

  private classOf(obj: any): Function {
    if (obj instanceof ApiSchema) return ApiSchema;
    if (obj instanceof Operation) return Operation;
    if (obj instanceof Resource) return Resource;
    return obj.constructor;
  }

  private matches(row: any, where: any): boolean {
    return Object.entries(where || {}).every(([k, v]) => row[k] === v);
  }

  manager = {
    find: async (entity: Function, opts: any = {}) =>
      this.tableOf(entity).filter((r) => this.matches(r, opts.where)),
    findOne: async (entity: Function, opts: any = {}) =>
      this.tableOf(entity).find((r) => this.matches(r, opts.where)) ?? null,
    save: async (arg: any) => {
      if (Array.isArray(arg)) {
        const out = [];
        for (const item of arg) out.push(await this.manager.save(item));
        return out;
      }
      const cls = this.classOf(arg);
      const table = this.tableOf(cls);
      if (arg.id) {
        const idx = table.findIndex((r) => r.id === arg.id);
        if (idx >= 0) { table[idx] = Object.assign(table[idx], arg); return table[idx]; }
      } else {
        arg.id = `row-${++this.seq}`;
      }
      arg.createdAt = arg.createdAt ?? new Date(Date.now() + this.seq);
      table.push(arg);
      return arg;
    },
    update: async () => undefined,
  };
}

describe('ApisImportHelper - import idempotency', () => {
  let store: FakeStore;
  let helper: ApisImportHelper;
  let toolGenShouldFail: boolean;

  const api: Api = {
    id: 'api-1',
    type: ApiType.OPENAPI,
    status: ApiStatus.ACTIVE,
    organizationId: 'org-1',
    metadata: null,
  } as any;

  const makeResource = (name: string, type = ResourceType.MODEL) => {
    const r = new Resource();
    r.name = name;
    r.type = type;
    return r;
  };

  const makeOperation = (operationId: string) => {
    const op = new Operation();
    op.operationId = operationId;
    op.name = operationId;
    return op;
  };

  beforeEach(() => {
    store = new FakeStore();
    toolGenShouldFail = true;

    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      isTransactionActive: false,
      manager: store.manager,
    };

    const apiSchemaRepository = {
      create: (dto: any) => Object.assign(new ApiSchema(), dto),
    } as unknown as Repository<ApiSchema>;

    helper = new ApisImportHelper(
      { findOne: jest.fn().mockResolvedValue(api) } as any,
      apiSchemaRepository,
      {
        parseApiSchema: jest.fn().mockResolvedValue({ version: '1.0.0', metadata: {} }),
        getParserForApiType: () => ({
          // Two resources share a name-and-type on purpose: the protobuf
          // parser emits nested messages by short name, so identity
          // resolution has to be a multiset match, not a collapse.
          extractResources: async () => [
            makeResource('Pet'),
            makeResource('Options'),
            makeResource('Options'),
            makeResource('PetInput', ResourceType.INPUT),
          ],
          extractOperations: async () => [makeOperation('getPet')],
        }),
      } as any,
      {} as any,
      { createQueryRunner: () => queryRunner } as any,
      { findOne: jest.fn().mockResolvedValue(api) } as any,
      {
        logMemoryPhase: jest.fn(),
        detectSchemaFormat: () => 'json',
        awaitHeapHeadroom: jest.fn(),
        generateToolsFromApi: jest.fn().mockImplementation(async () => {
          if (toolGenShouldFail) throw new Error('provider timeout');
          return { tools: [], failed: 0, total: 0 };
        }),
      } as any,
    );
  });

  const runImport = () =>
    helper.importSchema('api-1', '{"openapi":"3.0.0"}', 'org-1', { generateTools: true });

  it('writes one schema row per (apiId, version) across a failed attempt and its retry', async () => {
    await expect(runImport()).rejects.toThrow(/Schema import failed/);
    expect(store.of<ApiSchema>(ApiSchema)).toHaveLength(1);
    const firstId = store.of<ApiSchema>(ApiSchema)[0].id;

    toolGenShouldFail = false;
    await runImport();

    const schemas = store.of<ApiSchema>(ApiSchema);
    expect(schemas).toHaveLength(1);
    expect(schemas[0].id).toBe(firstId);
  });

  it('reuses resource rows on retry instead of inserting a fresh set', async () => {
    await expect(runImport()).rejects.toThrow(/Schema import failed/);
    const firstIds = store.of<Resource>(Resource).map((r) => r.id).sort();
    expect(firstIds).toHaveLength(4);

    toolGenShouldFail = false;
    await runImport();

    const rows = store.of<Resource>(Resource);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.id).sort()).toEqual(firstIds);
    // The two same-named resources stay two rows — the multiset match
    // maps them onto the two existing ids rather than collapsing them.
    expect(rows.filter((r) => r.name === 'Options')).toHaveLength(2);
  });

  it('reuses operation rows on retry', async () => {
    await expect(runImport()).rejects.toThrow(/Schema import failed/);
    const firstIds = store.of<Operation>(Operation).map((o) => o.id);

    toolGenShouldFail = false;
    await runImport();

    expect(store.of<Operation>(Operation)).toHaveLength(1);
    expect(store.of<Operation>(Operation).map((o) => o.id)).toEqual(firstIds);
  });
});
