/**
 * Real-Postgres regression test for the importSchema-with-tools path.
 *
 * Bug: importSchema wraps every DB write in a queryRunner
 * transaction. generateToolsFromApi was re-fetching the api via
 * the default repository pool, which uses a *different* connection
 * — that connection can't see the transaction's just-saved
 * operations, so api.operations came back [] and the import
 * died with "No operations found for this API. Import a schema
 * first." This test exercises the same path against real Postgres
 * so the fix can't silently regress.
 *
 * Gated behind RUN_DB_INTEGRATION=1.
 */
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import {
  UserOrganization,
  OrganizationRole,
} from '../../entities/user-organization.entity';
import { Api, ApiType, ApiStatus } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { Tool, ToolStatus } from '../../entities/tool.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { JsonSchema } from '../../entities/json-schema.entity';

import { ApisService } from '../../modules/apis/apis.service';
import { ToolsService } from '../../modules/tools/tools.service';
import { SchemaParserService } from '../../modules/schema-parser/schema-parser.service';
import { OpenAPIParserService } from '../../modules/schema-parser/parsers/openapi-parser.service';
import { GraphQLParserService } from '../../modules/schema-parser/parsers/graphql-parser.service';
import { SOAPParserService } from '../../modules/schema-parser/parsers/soap-parser.service';
import { ProtobufParserService } from '../../modules/schema-parser/parsers/protobuf-parser.service';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';
import { JsonSchemaTranslatorService } from '../../modules/json-schema-translator/json-schema-translator.service';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;

jest.setTimeout(60_000);

const SAMPLE_SCHEMA = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'AuthTest', version: '1.0' },
  paths: {
    '/get': {
      get: {
        operationId: 'authtest_get',
        summary: 'GET /get',
        parameters: [{ name: 'foo', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
});

describeIfDb('importSchema with tool generation (real Postgres)', () => {
  let ds: DataSource;
  let service: ApisService;
  let org: Organization;
  let api: Api;

  beforeAll(async () => {
    const bootstrap = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await bootstrap.initialize();
    await bootstrap.query('CREATE SCHEMA IF NOT EXISTS import_schema_test');
    await bootstrap.destroy();

    ds = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      database: process.env.DATABASE_NAME || 'almyty_test',
      schema: 'import_schema_test',
      synchronize: true,
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();

    // Seed an org + owner user (audit-log writes need a real user FK).
    const orgRepo = ds.getRepository(Organization);
    const userRepo = ds.getRepository(User);
    const uoRepo = ds.getRepository(UserOrganization);

    org = (await orgRepo.save(
      orgRepo.create({
        name: 'Import Schema Test',
        slug: 'import-schema-test',
        plan: 'free',
        isActive: true,
      }),
    )) as unknown as Organization;
    const owner = await userRepo.save(
      userRepo.create({
        email: 'import-test@example.com',
        firstName: 'Import',
        lastName: 'Test',
        passwordHash: 'x',
        isActive: true,
        isVerified: true,
      }),
    );
    await uoRepo.save(
      uoRepo.create({
        userId: owner.id,
        organizationId: org.id,
        role: OrganizationRole.OWNER,
        isActive: true,
      }),
    );

    const apiRepo = ds.getRepository(Api);
    api = (await apiRepo.save(
      apiRepo.create({
        name: 'Test',
        type: ApiType.OPENAPI,
        status: ApiStatus.DRAFT,
        baseUrl: 'https://example.com',
        organizationId: org.id,
        authentication: {
          type: 'api_key' as any,
          config: { parameter: 'X-Key', location: 'header', apiKey: 'leak-canary' },
        },
      } as any),
    )) as unknown as Api;

    // Wire real services. SchemaParserService and ToolsService both
    // have many constructor deps; we provide the minimum needed for
    // the import path (parsing OpenAPI + creating Tool rows).
    const moduleRef = await Test.createTestingModule({
      providers: [
        ApisService,
        SchemaParserService,
        OpenAPIParserService,
        GraphQLParserService,
        SOAPParserService,
        ProtobufParserService,
        ToolsService,
        JsonSchemaTranslatorService,
        { provide: AuditLogService, useValue: { logCreate: jest.fn(), logUpdate: jest.fn(), logAction: jest.fn() } },
        { provide: getRepositoryToken(Api), useValue: ds.getRepository(Api) },
        { provide: getRepositoryToken(ApiSchema), useValue: ds.getRepository(ApiSchema) },
        { provide: getRepositoryToken(Operation), useValue: ds.getRepository(Operation) },
        { provide: getRepositoryToken(Resource), useValue: ds.getRepository(Resource) },
        { provide: getRepositoryToken(Organization), useValue: ds.getRepository(Organization) },
        { provide: getRepositoryToken(User), useValue: ds.getRepository(User) },
        { provide: getRepositoryToken(Tool), useValue: ds.getRepository(Tool) },
        { provide: getRepositoryToken(ToolVersion), useValue: ds.getRepository(ToolVersion) },
        { provide: getRepositoryToken(ToolCategory), useValue: ds.getRepository(ToolCategory) },
        { provide: getRepositoryToken(ToolExecution), useValue: ds.getRepository(ToolExecution) },
        { provide: getRepositoryToken(JsonSchema), useValue: ds.getRepository(JsonSchema) },
        { provide: DataSource, useValue: ds },
      ],
    }).compile();

    service = moduleRef.get(ApisService);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('imports an OpenAPI schema and generates tools — does not throw "No operations found"', async () => {
    const result = await service.importSchema(api.id, SAMPLE_SCHEMA, org.id, {
      generateTools: true,
    });

    // The bug surfaces as zero operations + zero tools because the
    // re-read inside the open transaction sees nothing. After the
    // fix, both are populated.
    expect(result.api).toBeDefined();
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].method).toBe('GET');
    expect(result.operations[0].endpoint).toBe('/get');

    expect(result.tools).toBeDefined();
    expect(result.tools!.length).toBe(1);
    expect(result.tools![0].operationId).toBe(result.operations[0].id);

    // Verify against a fresh read — tool must have actually been
    // committed, not just lived in the now-released transaction's
    // memory. If the queryRunner.commit silently fails or rolls
    // back, this assertion catches it.
    const persistedTools = await ds.getRepository(Tool).find({
      where: { organizationId: org.id },
    });
    expect(persistedTools.length).toBe(1);
    expect(persistedTools[0].status).toBe(ToolStatus.ACTIVE);
    expect(persistedTools[0].operationId).toBe(result.operations[0].id);
  });
});
