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
import { ApisImportHelper } from '../../modules/apis/apis-import.helper';
import { ApisToolGeneratorHelper } from '../../modules/apis/apis-tool-generator.helper';
import { ToolsService } from '../../modules/tools/tools.service';
import { ToolsOperationHelper } from '../../modules/tools/tools-operation.helper';
import { ToolsStatsHelper } from '../../modules/tools/tools-stats.helper';
import { SchemaParserService } from '../../modules/schema-parser/schema-parser.service';
import { OpenAPIParserService } from '../../modules/schema-parser/parsers/openapi-parser.service';
import { GraphQLParserService } from '../../modules/schema-parser/parsers/graphql-parser.service';
import { SOAPParserService } from '../../modules/schema-parser/parsers/soap-parser.service';
import { ProtobufParserService } from '../../modules/schema-parser/parsers/protobuf-parser.service';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { JsonSchemaTranslatorService } from '../../modules/json-schema-translator/json-schema-translator.service';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;

jest.setTimeout(60_000);

const SAMPLE_OPENAPI = JSON.stringify({
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

const SAMPLE_GRAPHQL = `
type User { id: ID! name: String! }
type Query { getUser(id: ID!): User }
type Mutation { createUser(name: String!): User }
`;

// WSDL with two portTypes (SOAP + HttpPost) declaring the same
// operations — mimics real-world WSDLs like w3schools' TempConvert.
// The parser must dedupe to one operation per logical name, not
// emit one per portType (bug 11a).
const SAMPLE_WSDL = `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" name="UserService">
  <wsdl:portType name="UserSoap">
    <wsdl:operation name="GetUser"/>
    <wsdl:operation name="ListUsers"/>
  </wsdl:portType>
  <wsdl:portType name="UserHttpPost">
    <wsdl:operation name="GetUser"/>
    <wsdl:operation name="ListUsers"/>
  </wsdl:portType>
</wsdl:definitions>`;

const SAMPLE_PROTO = `
syntax = "proto3";
package user;
service UserService {
  rpc GetUser(GetUserRequest) returns (User);
}
message User { string id = 1; string name = 2; }
message GetUserRequest { string user_id = 1; }
`;

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
        ApisImportHelper,
        ApisToolGeneratorHelper,
        SchemaParserService,
        OpenAPIParserService,
        GraphQLParserService,
        SOAPParserService,
        ProtobufParserService,
        ToolsService,
        ToolsOperationHelper,
        ToolsStatsHelper,
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
        { provide: AccessPolicyService, useValue: { canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }) } },
      ],
    }).compile();

    service = moduleRef.get(ApisService);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  /**
   * Helper to seed a fresh draft API of a given type and run the
   * import pipeline against the real DB. The bug 7 fix is parser-
   * agnostic — every parser feeds into the same transactional save
   * + post-commit tool generation flow — but we exercise each one
   * end-to-end so a regression in any parser path is caught.
   */
  async function importInto(apiType: ApiType, schema: string, baseUrl: string) {
    const apiRepo = ds.getRepository(Api);
    const fresh = (await apiRepo.save(
      apiRepo.create({
        name: `${apiType} fixture`,
        type: apiType,
        status: ApiStatus.DRAFT,
        baseUrl,
        organizationId: org.id,
        authentication: { type: 'none' as any, config: {} },
      } as any),
    )) as unknown as Api;
    return service.importSchema(fresh.id, schema, org.id, { generateTools: true });
  }

  it('imports an OpenAPI schema and generates tools — does not throw "No operations found"', async () => {
    const result = await service.importSchema(api.id, SAMPLE_OPENAPI, org.id, {
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

  it('imports a GraphQL schema and generates tools', async () => {
    const result = await importInto(ApiType.GRAPHQL, SAMPLE_GRAPHQL, 'https://example.com/graphql');
    expect(result.operations.length).toBeGreaterThan(0);
    expect(result.tools).toBeDefined();
    expect(result.tools!.length).toBeGreaterThan(0);
  });

  it('imports a SOAP/WSDL schema and generates tools — dedupes operations across portTypes (bug 11a)', async () => {
    const result = await importInto(ApiType.SOAP, SAMPLE_WSDL, 'https://example.com/soap');
    // Two portTypes × two ops = 4 candidates, but the parser must
    // dedupe to two distinct logical operations.
    const names = result.operations.map((o: any) => o.name).sort();
    expect(names).toEqual(['GetUser', 'ListUsers']);

    expect(result.tools).toBeDefined();
    const toolNames = result.tools!.map((t: any) => t.name);
    expect(new Set(toolNames).size).toBe(toolNames.length); // unique
  });

  it('imports a Protobuf/gRPC schema and generates tools', async () => {
    const result = await importInto(ApiType.GRPC, SAMPLE_PROTO, 'https://example.com/grpc');
    expect(result.operations.length).toBeGreaterThan(0);
    expect(result.tools).toBeDefined();
    expect(result.tools!.length).toBeGreaterThan(0);
  });

  /**
   * Re-import upserts operations by (apiId, operationId-string)
   * instead of inserting fresh rows. Previously every re-import
   * orphaned the existing tools/resources/skills that pointed at
   * the prior operation_id UUIDs — a regression noticed when the
   * GraphQL parser was upgraded to capture return-type fields and
   * the new field info never reached the SKILL.md generator,
   * because tools still pointed at the now-stale operation rows.
   */
  it('re-importing the same schema upserts operations instead of inserting duplicates', async () => {
    // Fresh API row to keep this test isolated from the OpenAPI
    // happy-path fixture above.
    const apiRepo = ds.getRepository(Api);
    const fresh = (await apiRepo.save(
      apiRepo.create({
        name: 'Re-import GraphQL fixture',
        type: ApiType.GRAPHQL,
        status: ApiStatus.DRAFT,
        baseUrl: 'https://example.com/graphql',
        organizationId: org.id,
        authentication: { type: 'none' as any, config: {} },
      } as any),
    )) as unknown as Api;

    const r1 = await service.importSchema(fresh.id, SAMPLE_GRAPHQL, org.id, {
      generateTools: true,
    });
    const opIdsByName1 = new Map(r1.operations.map((o: any) => [o.name, o.id]));

    const r2 = await service.importSchema(fresh.id, SAMPLE_GRAPHQL, org.id, {
      generateTools: true,
    });
    expect(r2.operations.length).toBe(r1.operations.length);

    // Every operation that existed before re-import must keep the
    // same row UUID — anything else means we re-inserted and the
    // tool→operation FK is now dangling.
    for (const op of r2.operations as any[]) {
      expect(opIdsByName1.get(op.name)).toBe(op.id);
    }

    // Total row count (across runs) shouldn't have doubled.
    const total = await ds.getRepository(Operation).count({ where: { apiId: fresh.id } });
    expect(total).toBe(r1.operations.length);
  });

  /**
   * Memory regression: `findOne` previously eager-loaded
   * `['organization', 'schemas', 'operations', 'resources']`, and
   * `importSchema` called it twice (inside generateToolsFromApi and
   * again for the post-commit reload). On any non-trivial spec the
   * `schemas` relation deserialized the full raw + processed schema
   * JSON column on every load, blowing past a 4 GB heap before
   * tool generation could run on Stripe-class specs.
   *
   * This test pins the contract: `findOne` must not eager-load
   * `schemas`, `resources`, or `organization`. If any future commit
   * adds them back this test fails — a developer can always opt into
   * those relations explicitly per call site, but the default must
   * stay slim.
   */
  it('findOne does not eager-load heavy relations (memory regression)', async () => {
    // Import enough data to make the assertion meaningful — if
    // findOne eagerly loaded `schemas`, this api would carry the
    // entire SAMPLE_OPENAPI string + parsed object graph hanging
    // off `.schemas`.
    await service.importSchema(api.id, SAMPLE_OPENAPI, org.id, { generateTools: true });

    const reloaded = await service.findOne(api.id, org.id);
    expect(reloaded).toBeDefined();

    // The fields must be `undefined` (relation not requested), NOT
    // `[]` (relation requested but empty). TypeORM materializes
    // requested relations as arrays even when there are no rows, so
    // an empty-array result is still a memory leak waiting to grow.
    expect((reloaded as any).schemas).toBeUndefined();
    expect((reloaded as any).resources).toBeUndefined();
    expect((reloaded as any).organization).toBeUndefined();

    // `operations` is the one relation findOne is allowed to load
    // (generateToolsFromApi falls back to it when preloadedOperations
    // isn't supplied). Confirm it's still wired so we don't silently
    // break that fallback.
    expect((reloaded as any).operations).toBeDefined();
    expect(Array.isArray((reloaded as any).operations)).toBe(true);
  });

  /**
   * Memory regression part 2: the importSchema return path used to
   * call `findOne` after tool generation to reload the api with
   * relations. After this fix the returned `api` is the lightweight
   * row only — operations/resources/tools are returned alongside it,
   * so the caller already has everything without re-deserializing
   * the schemas JSON.
   */
  it('importSchema returns a lightweight api row without schemas/resources hanging off it', async () => {
    const result = await importInto(ApiType.OPENAPI, SAMPLE_OPENAPI, 'https://example.com/light');
    expect(result.api).toBeDefined();
    expect((result.api as any).schemas).toBeUndefined();
    expect((result.api as any).resources).toBeUndefined();
    // operations + resources + schema come back as siblings, not
    // hanging off `result.api` — that's the contract callers rely on.
    expect(Array.isArray(result.operations)).toBe(true);
    expect(Array.isArray(result.resources)).toBe(true);
    expect(result.schema).toBeDefined();
  });

  /**
   * On-demand parse: the parsed object form is no longer persisted
   * on api_schemas (the processedSchema column was dropped). The
   * UI gets the parsed view from parseSchemaOnDemand, which runs
   * the parser against rawSchema for one specific schema row and
   * returns the result ephemerally. This test pins three real
   * properties:
   *   1. importSchema still works against the entity that no
   *      longer declares processedSchema (would throw a TypeORM
   *      column-doesn't-exist error if the entity / DB drift).
   *   2. parseSchemaOnDemand returns a parser-shaped result.
   *   3. parseSchemaOnDemand is read-only — no rows are added or
   *      modified by it.
   */
  it('parseSchemaOnDemand re-derives a parsed view from rawSchema without writing anything', async () => {
    const apiRepo = ds.getRepository(Api);
    const fresh = (await apiRepo.save(
      apiRepo.create({
        name: 'Parse-on-demand fixture',
        type: ApiType.OPENAPI,
        status: ApiStatus.DRAFT,
        baseUrl: 'https://example.com/parse-od',
        organizationId: org.id,
        authentication: { type: 'none' as any, config: {} },
      } as any),
    )) as unknown as Api;

    const result = await service.importSchema(fresh.id, SAMPLE_OPENAPI, org.id, {
      generateTools: false,
    });
    expect(result.schema?.id).toBeDefined();

    // rawSchema is the single source of truth for re-derivation.
    const persisted = await ds.getRepository(ApiSchema).findOne({
      where: { id: result.schema.id },
    });
    expect(persisted!.rawSchema).toBe(SAMPLE_OPENAPI);
    const beforeUpdatedAt = (persisted as any).createdAt;

    // The on-demand endpoint hands back parser-shaped output.
    const parsed = await service.parseSchemaOnDemand(fresh.id, result.schema.id, org.id);
    expect(parsed).toBeDefined();
    expect(Array.isArray(parsed.operations)).toBe(true);
    expect(parsed.operations.length).toBe(1);
    expect(parsed.operations[0].method).toBe('GET');
    expect(parsed.operations[0].endpoint).toBe('/get');

    // Read-only contract: no new schema rows, no row mutation.
    const allSchemas = await ds.getRepository(ApiSchema).find({
      where: { apiId: fresh.id },
    });
    expect(allSchemas.length).toBe(1);
    expect((allSchemas[0] as any).createdAt).toEqual(beforeUpdatedAt);
  });

  /**
   * Memory regression: findAllByOrganization is the org's API list
   * endpoint. It used to eager-load ['schemas', 'operations',
   * 'operations.tools'] which on an org with several Stripe-class
   * imports meant each list request deserialized N × (full
   * rawSchema text + 587 operations + 587 tools) into the heap
   * — a single GET /apis?limit=100 reproducibly OOM-killed the
   * worker at 4 GB. Both real callers (controller findAll, mcp
   * list_apis) only use scalar Api fields. Pin that contract:
   * the rows returned by findAllByOrganization must not carry
   * the heavy relations, even when present in DB.
   */
  it('findAllByOrganization does not eager-load schemas/operations/tools (memory regression)', async () => {
    // Import enough data to make the assertion meaningful — if
    // findAllByOrganization eagerly loaded the relations, the
    // returned api row would carry rawSchema, 1 operation, etc.
    const apiRepo = ds.getRepository(Api);
    const fresh = (await apiRepo.save(
      apiRepo.create({
        name: 'List-test fixture',
        type: ApiType.OPENAPI,
        status: ApiStatus.DRAFT,
        baseUrl: 'https://example.com/list-test',
        organizationId: org.id,
        authentication: { type: 'none' as any, config: {} },
      } as any),
    )) as unknown as Api;
    await service.importSchema(fresh.id, SAMPLE_OPENAPI, org.id, {
      generateTools: true,
    });

    const { apis, total } = await service.findAllByOrganization(org.id, {
      limit: 100,
    });
    expect(total).toBeGreaterThan(0);
    expect(apis.length).toBeGreaterThan(0);

    // Every row must come back lightweight — relations not loaded.
    // `undefined` (relation skipped) is the contract; an empty array
    // would mean the relation was requested but happened to be empty,
    // which is also a leak the moment data exists.
    for (const a of apis) {
      expect((a as any).schemas).toBeUndefined();
      expect((a as any).operations).toBeUndefined();
      expect((a as any).resources).toBeUndefined();
      // Scalar fields must still be populated.
      expect(a.id).toBeDefined();
      expect(a.name).toBeDefined();
    }
  });

  /**
   * Tenant guard on parseSchemaOnDemand — a parsed view exposes the
   * full schema content, so it has to fail for callers from a
   * different organization. We simulate that by passing a wrong
   * organizationId and asserting we get NotFound (not a leak).
   */
  it('parseSchemaOnDemand rejects cross-tenant access', async () => {
    const apiRepo = ds.getRepository(Api);
    const fresh = (await apiRepo.save(
      apiRepo.create({
        name: 'Tenant-guard fixture',
        type: ApiType.OPENAPI,
        status: ApiStatus.DRAFT,
        baseUrl: 'https://example.com/tenant',
        organizationId: org.id,
        authentication: { type: 'none' as any, config: {} },
      } as any),
    )) as unknown as Api;

    const result = await service.importSchema(fresh.id, SAMPLE_OPENAPI, org.id, {
      generateTools: false,
    });

    await expect(
      service.parseSchemaOnDemand(
        fresh.id,
        result.schema.id,
        '00000000-0000-0000-0000-000000000000',
      ),
    ).rejects.toThrow();
  });
});
