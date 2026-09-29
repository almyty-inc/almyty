import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Api } from '../../entities/api.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Gateway, GatewayKind, GatewayType } from '../../entities/gateway.entity';
import { GatewayAuth } from '../../entities/gateway-auth.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Operation } from '../../entities/operation.entity';
import { Organization } from '../../entities/organization.entity';
import { Team } from '../../entities/team.entity';
import { Tool, ToolExecutionMethod, ToolStatus, ToolType } from '../../entities/tool.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { SplitToolsGateways1750813760000 } from '../../migrations/1750813760000-SplitToolsGateways';
import { McpService } from '../../modules/mcp/mcp.service';
import { McpToolHandler } from '../../modules/mcp/services/mcp-tool.handler';
import { UtcpService } from '../../modules/mcp/utcp.service';
import { SkillGeneratorService } from '../../modules/tools/skill-generator.service';
import { SkillRendererHelper } from '../../modules/tools/skill-renderer.helper';
import { ToolsService } from '../../modules/tools/tools.service';
import { ToolsStatsHelper } from '../../modules/tools/tools-stats.helper';
import { FakeRedis } from '../fake-redis';

/**
 * The SplitToolsGateways migration against a real Postgres, every earlier
 * migration run first. A gateway of type `tools` (one address, three
 * protocols) becomes three gateways that each serve one protocol: MCP at
 * the original row and address, UTCP and Skills at suffixed addresses. All
 * three list the same tools through their own protocol's real service, keep
 * the same scope, and the original's access key stays with the MCP one.
 *
 * Gated on RUN_DB_INTEGRATION=1. Own schema.
 */
const describeIfDb = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const SCHEMA = 'split_tools_gateways_test';

jest.setTimeout(180_000);

describeIfDb('split all-protocol gateways, one protocol each (real Postgres)', () => {
  let ds: DataSource;
  let orgId: string;
  let otherOrgId: string;
  let owner: string;
  let teamId: string;
  let mcp: McpService;
  let utcp: UtcpService;
  let skills: SkillGeneratorService;
  const toolIds: Record<string, string> = {};

  const connection = () => ({
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  });

  const up = () => new SplitToolsGateways1750813760000().up(ds.createQueryRunner());

  /** A `tools` gateway as the type was stored: raw SQL, the enum no longer has it. */
  const toolsGateway = async (opts: { org: string; name: string; endpoint: string; visibility?: string; teamId?: string | null }) => {
    const [row] = await ds.query(
      `INSERT INTO "gateways" ("name", "kind", "type", "organizationId", "visibility", "teamId", "ownerUserId", "endpoint", "configuration", "status")
       VALUES ($1, 'tool', 'tools', $2, $3, $4, $5, $6, '{"note": "kept"}', 'active') RETURNING "id"`,
      [opts.name, opts.org, opts.visibility ?? 'org', opts.teamId ?? null, owner, opts.endpoint],
    );
    await ds.query(
      `INSERT INTO "gateway_auth" ("gatewayId", "type", "isRequired", "isActive", "configuration")
       VALUES ($1, 'api_key', true, true, '{"keyHeader": "x-api-key"}')`,
      [row.id],
    );
    return row.id as string;
  };

  beforeAll(async () => {
    const bootstrap = new DataSource(connection());
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
    await bootstrap.destroy();

    ds = new DataSource(versionsConfig({
      ...connection(),
      schema: SCHEMA,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
    }) as any);
    await ds.initialize();
    await ds.query(`SET search_path TO ${SCHEMA}, public`);

    const orgs = ds.getRepository(Organization);
    orgId = (await orgs.save(orgs.create({ name: 'Split Org', slug: 'split-org' } as any)) as any).id;
    otherOrgId = (await orgs.save(orgs.create({ name: 'Other Org', slug: 'other-org' } as any)) as any).id;
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({ email: 'owner@split.test', passwordHash: 'x', firstName: 'O', lastName: 'W' } as any),
    );
    owner = (user as any).id;
    await ds.getRepository(UserOrganization).save(
      ds.getRepository(UserOrganization).create({ userId: owner, organizationId: orgId, role: OrganizationRole.ADMIN, isActive: true } as any),
    );
    const team = await ds.getRepository(Team).save(ds.getRepository(Team).create({ name: 'Ops', organizationId: orgId } as any));
    teamId = (team as any).id;
    await ds.getRepository(UserTeam).save(ds.getRepository(UserTeam).create({ userId: owner, teamId } as any));

    const tool = async (name: string, extra: Partial<Tool> = {}) => {
      const saved = await ds.getRepository(Tool).save(ds.getRepository(Tool).create({
        name,
        description: `The ${name} tool`,
        type: ToolType.FUNCTION,
        executionMethod: ToolExecutionMethod.HTTP,
        httpConfig: { method: 'GET', path: 'https://upstream.example.com/things' },
        parameters: { type: 'object', properties: {} },
        organizationId: orgId,
        status: ToolStatus.ACTIVE,
        createdBy: owner,
        ...extra,
      } as any));
      toolIds[name] = (saved as any).id;
      return (saved as any).id as string;
    };
    await tool('get_weather');
    await tool('list_cities');
    await tool('draft_tool', { status: ToolStatus.DRAFT });

    const policy = new AccessPolicyService(ds.getRepository(UserOrganization), ds.getRepository(UserTeam));
    const audit = { log: jest.fn(), logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn(), computeChanges: jest.fn() } as any;
    const toolsService = new ToolsService(
      ds.getRepository(Tool),
      ds.getRepository(ToolVersion),
      ds.getRepository(ToolCategory),
      ds.getRepository(ToolExecution),
      ds.getRepository(Api),
      ds.getRepository(Operation),
      ds.getRepository(ApiSchema),
      ds.getRepository(User),
      ds.getRepository(Organization),
      audit,
      null as any,
      new ToolsStatsHelper(ds.getRepository(Tool), ds.getRepository(ToolExecution), policy),
      policy,
    );
    const redis = new FakeRedis() as any;
    const toolHandler = new McpToolHandler(
      ds.getRepository(Tool),
      ds.getRepository(GatewayTool),
      ds.getRepository(ToolCategory),
      toolsService,
      { executeTool: jest.fn() } as any,
      redis,
    );
    mcp = new McpService(ds.getRepository(Gateway), ds.getRepository(Organization), toolsService, toolHandler, null as any, null as any);
    utcp = new UtcpService(
      ds.getRepository(Tool),
      ds.getRepository(Api),
      ds.getRepository(Operation),
      ds.getRepository(Organization),
      ds.getRepository(GatewayTool),
      toolsService,
      null as any,
      redis,
    );
    skills = new SkillGeneratorService(ds.getRepository(Tool), ds.getRepository(Gateway), ds.getRepository(GatewayTool), new SkillRendererHelper());
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await ds.destroy();
    }
  });

  const gatewaysOf = (org: string) =>
    ds.getRepository(Gateway).find({ where: { organizationId: org }, order: { endpoint: 'ASC' } });

  const mcpTools = async (gateway: Gateway) => {
    const res: any = await mcp.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as any, orgId, owner, gateway.id);
    return res.result.tools.map((t: any) => t.name).sort();
  };
  const utcpTools = async (gateway: Gateway) =>
    (await utcp.generateManual({ organizationId: orgId, gateway, baseUrl: 'https://api.test', orgSlug: 'split-org' })).tools.map((t) => t.name).sort();
  const skillTools = async (gateway: Gateway) =>
    (await skills.generateIndividualSkills(gateway.id, orgId, { orgSlug: 'split-org', gatewaySlug: gateway.endpoint.replace(/^\/+/, '') }))
      .map((s) => Object.entries(toolIds).find(([, id]) => s.content.includes(`toolId: "${id}"`))?.[0])
      .sort();

  it('turns one all-protocol gateway into an MCP, a UTCP and a Skills gateway serving the same tools', async () => {
    const id = await toolsGateway({ org: orgId, name: 'Weather', endpoint: '/weather', visibility: 'team', teamId });
    for (const name of ['get_weather', 'list_cities', 'draft_tool']) {
      await ds.query(`INSERT INTO "gateway_tools" ("gatewayId", "toolId", "isActive") VALUES ($1, $2, true)`, [id, toolIds[name]]);
    }
    const key = 'weather_key_0123456789abcdefghijklmnop';
    await ds.getRepository(ApiKey).save(ds.getRepository(ApiKey).create({
      name: 'Weather key',
      keyHash: createHash('sha256').update(key).digest('hex'),
      keyPrefix: key.slice(0, 18),
      userId: owner,
      organizationId: orgId,
      gatewayId: id,
      scopes: ['gateway:use'],
      isActive: true,
    } as any));

    await up();

    const rows = await gatewaysOf(orgId);
    expect(rows.map((g) => [g.name, g.type, g.endpoint])).toEqual([
      ['Weather', GatewayType.MCP, '/weather'],
      ['Weather Skills', GatewayType.SKILLS, '/weather-skills'],
      ['Weather UTCP', GatewayType.UTCP, '/weather-utcp'],
    ]);
    const [asMcp, asSkills, asUtcp] = rows;

    // The MCP one is the row itself: same id, and its transport.
    expect(asMcp.id).toBe(id);
    expect(asMcp.configuration).toEqual({ note: 'kept', transport: 'http' });
    expect(asUtcp.configuration).toEqual({ note: 'kept', protocol: 'http' });
    for (const g of rows) {
      expect(g.kind).toBe(GatewayKind.TOOL);
      expect(g.visibility).toBe('team');
      expect(g.teamId).toBe(teamId);
      expect(g.ownerUserId).toBe(owner);
      expect(g.status).toBe('active');
    }

    // Each serves its protocol, from the same servable set (the draft is attached, never served).
    const servable = ['get_weather', 'list_cities'];
    expect(await mcpTools(asMcp)).toEqual(servable);
    expect(await utcpTools(asUtcp)).toEqual(servable);
    expect(await skillTools(asSkills)).toEqual(servable);

    // The key stays with the MCP gateway; the new ones have none, and auth still applies.
    const keys = await ds.getRepository(ApiKey).find({ where: { organizationId: orgId } });
    expect(keys.map((k) => k.gatewayId)).toEqual([id]);
    const auth = await ds.getRepository(GatewayAuth).find();
    const authOf = (gatewayId: string) => auth.filter((a) => a.gatewayId === gatewayId);
    expect(authOf(asUtcp.id).map((a) => [a.type, a.isRequired, a.configuration])).toEqual([['api_key', true, { keyHeader: 'x-api-key' }]]);
    expect(authOf(asSkills.id)).toHaveLength(1);
    expect(authOf(id)).toHaveLength(1);

    // No all-protocol gateway is left.
    expect(await ds.query(`SELECT count(*)::int AS n FROM "gateways" WHERE "type" = 'tools'`)).toEqual([{ n: 0 }]);
  });

  it('gives a suffixed address that is taken the next free number, per organization', async () => {
    await ds.query(
      `INSERT INTO "gateways" ("name", "kind", "type", "organizationId", "endpoint", "configuration") VALUES ('Taken', 'tool', 'utcp', $1, '/maps-utcp', '{}')`,
      [otherOrgId],
    );
    await toolsGateway({ org: otherOrgId, name: 'Maps', endpoint: '/maps' });
    // The same address in another organization does not collide.
    await toolsGateway({ org: orgId, name: 'Maps', endpoint: '/maps' });

    await up();

    expect((await gatewaysOf(otherOrgId)).map((g) => [g.name, g.type, g.endpoint])).toEqual([
      ['Maps', GatewayType.MCP, '/maps'],
      ['Maps Skills', GatewayType.SKILLS, '/maps-skills'],
      ['Taken', GatewayType.UTCP, '/maps-utcp'],
      ['Maps UTCP', GatewayType.UTCP, '/maps-utcp-2'],
    ]);
    expect((await gatewaysOf(orgId)).filter((g) => g.endpoint.startsWith('/maps')).map((g) => g.endpoint)).toEqual([
      '/maps',
      '/maps-skills',
      '/maps-utcp',
    ]);
  });

  it('leaves every other gateway alone, and runs again without doing anything', async () => {
    const before = await ds.query(`SELECT "id", "type", "endpoint", "configuration"::text FROM "gateways" ORDER BY "id"`);
    await up();
    expect(await ds.query(`SELECT "id", "type", "endpoint", "configuration"::text FROM "gateways" ORDER BY "id"`)).toEqual(before);
  });
});
