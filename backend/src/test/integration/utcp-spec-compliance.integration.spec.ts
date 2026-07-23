/**
 * Real-Postgres integration test that locks UTCP spec compliance.
 *
 * The unit tests in `utcp.service.spec.ts` mock every repository, so
 * a regression that breaks the actual DB query path (e.g. forgetting
 * to filter by `gatewayId`, leaking `inputSchema` instead of `inputs`)
 * could pass mocked tests while serving a non-compliant manual to
 * real UTCP clients (python-utcp, typescript-utcp, go-utcp).
 *
 * This spec spins up a real Postgres schema, seeds an API + tool +
 * gateway, calls `UtcpService.generateManual` against the live
 * repositories, and asserts every spec field by name.
 *
 * Spec source: https://utcp.io — fields are snake_case and the SDK
 * parsers reject unknown keys, so any drift from these assertions
 * means a manual that crashes the SDK.
 *
 * Gated behind RUN_DB_INTEGRATION=1; runs via `npm run test:db`.
 */
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import {
  UserOrganization,
  OrganizationRole,
} from '../../entities/user-organization.entity';
import { Api, ApiType, ApiStatus } from '../../entities/api.entity';
import { Operation, HttpMethod, OperationType } from '../../entities/operation.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { Gateway, GatewayType, GatewayStatus } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { GatewayAuth, GatewayAuthType } from '../../entities/gateway-auth.entity';

import { UtcpService } from '../../modules/mcp/utcp.service';
import { ToolsService } from '../../modules/tools/tools.service';
import { ToolExecutorService } from '../../modules/tools/tool-executor.service';
import { getRepositoryToken } from '@nestjs/typeorm';

// `repo.save(repo.create(x))` infers as the array overload when `x`
// is structurally typed loosely. `as any` then `as Entity` reads the
// resulting row without TypeScript fighting the overload.
const asEntity = <T>(v: unknown): T => v as T;

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;

const REDIS_TOKEN = 'default_IORedisModuleConnectionToken';

jest.setTimeout(60_000);

describeIfDb('UTCP spec compliance (real Postgres)', () => {
  let ds: DataSource;
  let service: UtcpService;
  let org: Organization;
  let api: Api;
  let operation: Operation;
  let assignedTool: Tool;
  let unassignedTool: Tool;
  let gateway: Gateway;

  beforeAll(async () => {
    // TypeORM's `dropSchema: true` is "drop the named schema, then
    // synchronize", but synchronize tries to CREATE TABLE in that
    // schema before re-creating the schema itself, so a clean DB
    // (or a previous failed run that left the schema absent) blows
    // up with `schema "utcp_spec_test" does not exist`. Pre-create
    // it via a throwaway connection.
    const bootstrap = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await bootstrap.initialize();
    await bootstrap.query('CREATE SCHEMA IF NOT EXISTS utcp_spec_test');
    await bootstrap.destroy();

    ds = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      database: process.env.DATABASE_NAME || 'almyty_test',
      schema: 'utcp_spec_test',
      synchronize: true,
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();

    // ─── Seed: org + user ─────────────────────────────────────────
    const orgRepo = ds.getRepository(Organization);
    const userRepo = ds.getRepository(User);
    const uoRepo = ds.getRepository(UserOrganization);

    org = await orgRepo.save(
      orgRepo.create({
        name: 'UTCP Spec Test Org',
        slug: 'utcp-spec-test',
        plan: 'free',
        isActive: true,
      }),
    );
    const owner = await userRepo.save(
      userRepo.create({
        email: 'utcp-owner@example.com',
        firstName: 'UTCP',
        lastName: 'Owner',
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

    // ─── Seed: API with API_KEY auth + secret (must NOT leak) ─────
    const apiRepo = ds.getRepository(Api);
    api = asEntity<Api>(await apiRepo.save(
      apiRepo.create({
        name: 'Weather API',
        type: ApiType.OPENAPI,
        status: ApiStatus.ACTIVE,
        baseUrl: 'https://api.weather.test',
        organizationId: org.id,
        authentication: {
          type: 'api_key' as any,
          config: {
            parameter: 'X-Weather-Key',
            location: 'header',
            apiKey: 'EXTREMELY-SECRET-RAW-KEY',
          },
        },
        headers: { 'X-App': 'almyty' },
      } as any),
    ));

    // ─── Seed: Operation ──────────────────────────────────────────
    const operationRepo = ds.getRepository(Operation);
    operation = asEntity<Operation>(await operationRepo.save(
      operationRepo.create({
        apiId: api.id,
        name: 'getForecast',
        type: OperationType.QUERY,
        method: HttpMethod.GET,
        endpoint: '/v1/forecast',
        parameters: { query: { lat: { type: 'number', required: true } } },
        metadata: {},
      } as any),
    ));

    // ─── Seed: Two tools — one assigned, one orphan ──────────────
    const toolRepo = ds.getRepository(Tool);
    assignedTool = asEntity<Tool>(await toolRepo.save(
      toolRepo.create({
        name: 'weather_get_forecast',
        description: 'Get the weather forecast',
        type: ToolType.API,
        status: ToolStatus.ACTIVE,
        organizationId: org.id,
        operationId: operation.id,
        parameters: { type: 'object', properties: { lat: { type: 'number' } } },
        outputSchema: { type: 'object' },
        metadata: { sourceApi: { type: 'openapi' }, autoGenerated: true },
      } as any),
    ));
    unassignedTool = asEntity<Tool>(await toolRepo.save(
      toolRepo.create({
        name: 'should_not_appear_in_manual',
        description: 'Belongs to the org but is NOT assigned to the gateway',
        type: ToolType.API,
        status: ToolStatus.ACTIVE,
        organizationId: org.id,
        operationId: operation.id,
        parameters: { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
      } as any),
    ));

    // ─── Seed: Gateway + tool assignment + API_KEY auth ──────────
    const gatewayRepo = ds.getRepository(Gateway);
    gateway = asEntity<Gateway>(await gatewayRepo.save(
      gatewayRepo.create({
        name: 'UTCP Spec Gateway',
        type: GatewayType.UTCP,
        status: GatewayStatus.ACTIVE,
        endpoint: '/utcp-spec',
        organizationId: org.id,
        configuration: { protocol: 'http' },
      } as any),
    ));

    const gtRepo = ds.getRepository(GatewayTool);
    await gtRepo.save(
      gtRepo.create({
        gatewayId: gateway.id,
        toolId: assignedTool.id,
        isActive: true,
      } as any),
    );

    const gaRepo = ds.getRepository(GatewayAuth);
    await gaRepo.save(
      gaRepo.create({
        gatewayId: gateway.id,
        type: GatewayAuthType.API_KEY,
        isActive: true,
        isRequired: true,
        configuration: { keyHeader: 'x-api-key' },
      } as any),
    );

    // Reload the gateway with auth configs (the service expects
    // `gateway.authConfigs` populated).
    gateway = (await gatewayRepo.findOne({
      where: { id: gateway.id },
      relations: { authConfigs: true },
    })) as Gateway;

    // ─── Wire UtcpService against real repos ─────────────────────
    const fakeRedis = {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
    };

    // ToolsService is only consulted by generateManual when no gateway
    // is supplied (legacy global manual). Every assertion here passes
    // a gateway, so the gateway-scoped path through GatewayTool is the
    // only one exercised. A stub keeps us from needing the full ten-arg
    // ToolsService constructor wired against real repos.
    const stubToolsService = {
      getTools: jest.fn().mockImplementation(async ({ organizationId }: any) => {
        const tools = await ds
          .getRepository(Tool)
          .find({ where: { organizationId, status: ToolStatus.ACTIVE } });
        return { tools, total: tools.length };
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UtcpService,
        { provide: getRepositoryToken(Tool), useValue: ds.getRepository(Tool) },
        { provide: getRepositoryToken(Api), useValue: ds.getRepository(Api) },
        { provide: getRepositoryToken(Operation), useValue: ds.getRepository(Operation) },
        { provide: getRepositoryToken(Organization), useValue: ds.getRepository(Organization) },
        { provide: getRepositoryToken(GatewayTool), useValue: ds.getRepository(GatewayTool) },
        { provide: ToolsService, useValue: stubToolsService },
        { provide: ToolExecutorService, useValue: { executeTool: jest.fn() } },
        { provide: REDIS_TOKEN, useValue: fakeRedis },
      ],
    }).compile();

    service = moduleRef.get(UtcpService);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('manual top-level: utcp_version + manual_version + tools (snake_case, no extension fields)', async () => {
    const manual = await service.generateManual({
      organizationId: org.id,
      gateway,
    });

    expect(manual.utcp_version).toBe('1.0.0');
    expect(typeof manual.manual_version).toBe('string');
    expect(manual.manual_version).toContain(gateway.id);
    expect(Array.isArray(manual.tools)).toBe(true);

    const top = Object.keys(manual);
    expect(top.sort()).toEqual(['manual_version', 'tools', 'utcp_version']);
  });

  it('manual scopes to gateway-assigned tools — unassigned org tools must NOT leak', async () => {
    const manual = await service.generateManual({
      organizationId: org.id,
      gateway,
    });

    const names = manual.tools.map((t) => t.name);
    expect(names).toEqual(['weather_get_forecast']);
    expect(names).not.toContain('should_not_appear_in_manual');
  });

  it('UtcpTool: name/description/inputs/outputs/tags/tool_call_template — no inputSchema/metadata/id', async () => {
    const manual = await service.generateManual({
      organizationId: org.id,
      gateway,
    });
    const tool = manual.tools[0];

    expect(tool.name).toBe('weather_get_forecast');
    expect(tool.description).toBe('Get the weather forecast');
    expect(tool.inputs).toEqual({
      type: 'object',
      properties: { lat: { type: 'number' } },
    });
    expect(tool.outputs).toEqual({ type: 'object' });
    expect(tool.tags).toContain('openapi');
    expect(tool.tags).toContain('auto-generated');
    expect(tool.tool_call_template).toBeDefined();

    expect((tool as any).id).toBeUndefined();
    expect((tool as any).version).toBeUndefined();
    expect((tool as any).inputSchema).toBeUndefined();
    expect((tool as any).outputSchema).toBeUndefined();
    expect((tool as any).examples).toBeUndefined();
    expect((tool as any).metadata).toBeUndefined();
  });

  it('HttpCallTemplate: call_template_type=http, http_method, url, content_type — no protocol/endpoint nesting', async () => {
    const manual = await service.generateManual({
      organizationId: org.id,
      gateway,
    });
    const tmpl = manual.tools[0].tool_call_template as any;

    expect(tmpl.call_template_type).toBe('http');
    expect(tmpl.http_method).toBe('GET');
    expect(tmpl.url).toBe('https://api.weather.test/v1/forecast');
    expect(tmpl.content_type).toBe('application/json');

    expect(tmpl.protocol).toBeUndefined();
    expect(tmpl.endpoint).toBeUndefined();
    expect(tmpl.requestMapping).toBeUndefined();
    expect(tmpl.responseMapping).toBeUndefined();
  });

  it('ApiKeyAuth: auth_type=api_key with var_name + location + placeholder api_key — no raw secret', async () => {
    const manual = await service.generateManual({
      organizationId: org.id,
      gateway,
    });
    const auth = manual.tools[0].tool_call_template.auth as any;

    expect(auth.auth_type).toBe('api_key');
    expect(auth.var_name).toBe('X-Weather-Key');
    expect(auth.location).toBe('header');
    expect(auth.api_key).toMatch(/^\{\{.*\}\}$/);
  });

  it('manual must never leak the raw API secret stored on the API entity', async () => {
    const manual = await service.generateManual({
      organizationId: org.id,
      gateway,
    });
    expect(JSON.stringify(manual)).not.toContain('EXTREMELY-SECRET-RAW-KEY');
  });

  it('discovery: utcp_version + manual_url points at gateway path (no /api/ prefix)', () => {
    const info = service.getDiscoveryInfo({
      organizationId: org.id,
      gateway,
      baseUrl: 'https://api.staging.almyty.com',
      orgSlug: org.slug,
    });

    expect(info.utcp_version).toBe('1.0.0');
    expect(info.manual_url).toBe(
      `https://api.staging.almyty.com/${org.slug}${gateway.endpoint}/manual`,
    );
    expect(info.manual_url).not.toContain('/api/utcp');

    const auth = info.auth as any;
    expect(auth?.auth_type).toBe('api_key');
    expect(auth?.var_name).toBe('x-api-key');
  });
});
