/**
 * The three check-then-insert paths from the idempotency audit, at
 * the point where the unique index they now sit behind fires.
 *
 * Each of these reads for an existing row and inserts when it finds
 * none; the reads are concurrent (tool generation batches through
 * Promise.all) or separated by a slow hop (the EE policy hook, a
 * provider list), so the second writer has to recognise the
 * violation rather than fail the operation.
 */
import { BadRequestException } from '@nestjs/common';
import { ApisToolGeneratorHelper } from '../../apis/apis-tool-generator.helper';
import { ModelCatalogService } from '../model-catalog.service';
import { ApiType, ApiStatus } from '../../../entities/api.entity';
import { unlimitedToolQuotaManager } from '../../../test/tool-quota.fake';

const uniqueViolation = (constraint: string) =>
  Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint,
  });

describe('tool generation - tools_org_name_uq', () => {
  const api = {
    id: 'api-1',
    name: 'Pet Store',
    type: ApiType.OPENAPI,
    status: ApiStatus.ACTIVE,
    organizationId: 'org-1',
  };
  const operations = [
    { id: 'op-1', name: 'getPet', method: 'GET', endpoint: '/pets/{id}', isActive: true, apiId: 'api-1' },
  ] as any[];

  // The tools table as the batch write sees it. The first read misses:
  // the other writer has not committed yet. Its row lands as this
  // writer inserts, so that insert hits tools_org_name_uq, and the
  // retry reads the name again and finds the row.
  const racingTable = (insertError: Error) => {
    const rows: any[] = [];
    const saves: any[][] = [];
    let raced = false;
    const owner = {
      find: jest.fn(async ({ where }: any) =>
        rows.filter((r) => r.organizationId === where.organizationId && where.name.value.includes(r.name)),
      ),
      save: jest.fn(async (batch: any[]) => {
        if (!raced && batch.some((t) => !t.id)) {
          raced = true;
          if (insertError.message.includes('duplicate')) {
            rows.push({ id: 'tool-raced', name: batch[0].name, organizationId: 'org-1', metadata: {} });
          }
          throw insertError;
        }
        saves.push(batch);
        return batch;
      }),
    };
    return { owner, rows, saves };
  };

  const toolsService = () => ({
    findByName: jest.fn().mockResolvedValue(null),
    buildFromOperation: jest.fn(async (op: any, options: any) => ({ ...options, operationId: op.id })),
    prepareUpdateFromOperation: jest.fn(),
    createToolVersion: jest.fn(),
  });

  it('updates the row the other writer inserted instead of dropping the tool', async () => {
    const table = racingTable(uniqueViolation('tools_org_name_uq'));
    const helper = new ApisToolGeneratorHelper(
      { findOne: jest.fn().mockResolvedValue(api), manager: unlimitedToolQuotaManager(table.owner) } as any,
      toolsService() as any,
      { findOne: jest.fn().mockResolvedValue(api) } as any,
    );

    const result = await helper.generateToolsFromApi('api-1', 'org-1', operations);

    expect(table.saves).toHaveLength(1);
    expect(table.saves[0]).toEqual([expect.objectContaining({ id: 'tool-raced', organizationId: 'org-1' })]);
    expect(result.tools).toHaveLength(1);
    expect(result.failed).toBe(0);
  });

  it('still fails the import when the insert error is not a unique violation', async () => {
    const table = racingTable(new Error('connection terminated'));
    const helper = new ApisToolGeneratorHelper(
      { findOne: jest.fn().mockResolvedValue(api), manager: unlimitedToolQuotaManager(table.owner) } as any,
      toolsService() as any,
      { findOne: jest.fn().mockResolvedValue(api) } as any,
    );

    await expect(helper.generateToolsFromApi('api-1', 'org-1', operations)).rejects.toThrow('connection terminated');
    expect(table.saves).toHaveLength(0);
  });
});

describe('model catalog register - models_org_name_endpoint_uq', () => {
  const build = (saveImpl: jest.Mock) => {
    const models = {
      findOne: jest.fn().mockResolvedValue(null),
      save: saveImpl,
      create: jest.fn((dto) => ({ ...dto })),
    };
    const service = new ModelCatalogService(
      models as any,
      { findOne: jest.fn() } as any,
      { findOne: jest.fn() } as any,
      { candidates: jest.fn() } as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      { log: jest.fn(), logCreate: jest.fn(), logUpdate: jest.fn() } as any,
    );
    return { service, models };
  };

  it('answers a raced endpoint-only registration with MODEL_EXISTS, not a driver error', async () => {
    const { service } = build(
      jest.fn().mockRejectedValue(uniqueViolation('models_org_name_endpoint_uq')),
    );

    const attempt = service.register('org-1', {
      name: 'house-llama',
      vendorModelId: 'llama-3-70b',
      endpointRef: { url: 'https://llm.internal/v1' },
    } as any);

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toMatchObject({
      response: { code: 'MODEL_EXISTS' },
    });
  });

  it('does not swallow a save failure that is not a unique violation', async () => {
    const { service } = build(jest.fn().mockRejectedValue(new Error('disk full')));

    await expect(
      service.register('org-1', {
        name: 'house-llama',
        vendorModelId: 'llama-3-70b',
        endpointRef: { url: 'https://llm.internal/v1' },
      } as any),
    ).rejects.toThrow('disk full');
  });
});
