import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ToolGeneratorService } from '../tool-generator.service';
import { Tool } from '../../../entities/tool.entity';
import { ToolVersion } from '../../../entities/tool-version.entity';
import { Operation, OperationType } from '../../../entities/operation.entity';
import { JsonSchema } from '../../../entities/json-schema.entity';
import { Api, ApiType } from '../../../entities/api.entity';
import { JsonSchemaTranslatorService } from '../../json-schema-translator/json-schema-translator.service';

/**
 * `Tool.organizationId` is `@Column()` — NOT NULL, no default, and the
 * entity has no @BeforeInsert hook that fills it. The generator built
 * its Tool without the field, so every INSERT was rejected by the
 * database, the rejection was swallowed by a catch that returns null,
 * and the caller recorded it as a skipped operation. The route answered
 * `success: true, "Generated 0 tools successfully"` and generated none.
 *
 * `saveRejectingNullOrg` below stands in for that NOT NULL constraint,
 * so this runs as a plain unit test and still reproduces the symptom.
 */
describe('ToolGeneratorService - generated tools carry their organization', () => {
  const ORG = '11111111-1111-1111-1111-111111111111';

  const api = {
    id: 'api-1',
    name: 'Test API',
    type: ApiType.OPENAPI,
    baseUrl: 'https://api.example.com',
    organizationId: ORG,
  } as Api;

  const operation = {
    id: 'op-1',
    name: 'getUser',
    operationId: 'getUserById',
    description: 'Get user by ID',
    method: 'GET',
    endpoint: '/users/{id}',
    type: OperationType.QUERY,
    apiId: 'api-1',
    isActive: true,
    parameters: { path: {}, query: {}, header: {}, body: {} },
    isReadOperation: () => true,
  } as unknown as Operation;

  let service: ToolGeneratorService;
  let created: any[];

  /** Stands in for the `organizationId uuid NOT NULL` column. */
  const saveRejectingNullOrg = jest.fn(async (entity: any) => {
    if (!entity.organizationId) {
      throw new Error(
        'null value in column "organizationId" of relation "tools" ' +
          'violates not-null constraint',
      );
    }
    return { ...entity, id: entity.id ?? 'tool-1' };
  });

  beforeEach(async () => {
    created = [];
    saveRejectingNullOrg.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolGeneratorService,
        {
          provide: getRepositoryToken(Tool),
          useValue: {
            create: jest.fn((dto: any) => {
              created.push(dto);
              return { ...dto };
            }),
            save: saveRejectingNullOrg,
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: getRepositoryToken(ToolVersion),
          useValue: {
            create: jest.fn((dto: any) => dto),
            save: jest.fn(async (v: any) => ({ ...v, id: 'ver-1' })),
          },
        },
        {
          provide: getRepositoryToken(Operation),
          useValue: { find: jest.fn().mockResolvedValue([operation]) },
        },
        {
          provide: getRepositoryToken(JsonSchema),
          useValue: {
            findOne: jest.fn().mockResolvedValue({ id: 'schema-1', schema: {} }),
            save: jest.fn(async (s: any) => s),
          },
        },
        {
          provide: JsonSchemaTranslatorService,
          useValue: {
            translateOperationToInputSchema: jest.fn().mockResolvedValue(null),
            translateOperationToOutputSchema: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = module.get(ToolGeneratorService);
  });

  it('stamps the API organization onto a generated tool', async () => {
    const tool = await service.generateToolFromOperation(operation, api);

    expect(created).toHaveLength(1);
    expect(created[0].organizationId).toBe(ORG);
    expect(tool).not.toBeNull();
  });

  it('actually generates tools instead of reporting them all skipped', async () => {
    const result = await service.generateToolsFromApi(api);

    expect(result.summary).toMatchObject({ total: 1, generated: 1, skipped: 0 });
    expect(result.skippedOperations).toEqual([]);
  });

  it('scopes the existing-tool lookup to the organization', async () => {
    const toolRepo: any = (service as any).toolRepository;
    await service.generateToolsFromApi(api);

    expect(toolRepo.findOne).toHaveBeenCalledWith({
      where: { operationId: operation.id, organizationId: ORG },
    });
  });
});
