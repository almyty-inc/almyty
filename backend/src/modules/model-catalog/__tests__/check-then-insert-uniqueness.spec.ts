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

  it('updates the row the other writer inserted instead of dropping the tool', async () => {
    const racedTool = { id: 'tool-raced', name: 'pet_store_get_pet' };
    const toolsService = {
      // The pre-insert read misses: the other writer has not committed
      // yet. The post-violation read sees the row it wrote.
      findByName: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(racedTool),
      createFromOperation: jest.fn().mockRejectedValue(uniqueViolation('tools_org_name_uq')),
      updateFromOperation: jest.fn().mockImplementation(async (id) => ({ id, name: 'pet_store_get_pet' })),
    };
    const helper = new ApisToolGeneratorHelper(
      { findOne: jest.fn().mockResolvedValue(api), manager: unlimitedToolQuotaManager() } as any,
      toolsService as any,
      { findOne: jest.fn().mockResolvedValue(api) } as any,
    );

    const result = await helper.generateToolsFromApi('api-1', 'org-1', operations);

    expect(toolsService.updateFromOperation).toHaveBeenCalledWith(
      'tool-raced',
      operations[0],
      expect.objectContaining({ organizationId: 'org-1' }),
    );
    expect(result.tools).toHaveLength(1);
    expect(result.failed).toBe(0);
  });

  it('still fails the operation when the insert error is not a unique violation', async () => {
    const toolsService = {
      findByName: jest.fn().mockResolvedValue(null),
      createFromOperation: jest.fn().mockRejectedValue(new Error('connection terminated')),
      updateFromOperation: jest.fn(),
    };
    const helper = new ApisToolGeneratorHelper(
      { findOne: jest.fn().mockResolvedValue(api), manager: unlimitedToolQuotaManager() } as any,
      toolsService as any,
      { findOne: jest.fn().mockResolvedValue(api) } as any,
    );

    const result = await helper.generateToolsFromApi('api-1', 'org-1', operations);

    expect(result.tools).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(toolsService.updateFromOperation).not.toHaveBeenCalled();
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
