import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Api, ApiType } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Gateway, GatewayType } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Operation } from '../../entities/operation.entity';
import { Organization } from '../../entities/organization.entity';
import { Resource, ResourceType } from '../../entities/resource.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { McpService } from '../../modules/mcp/mcp.service';
import { McpContentHandler } from '../../modules/mcp/services/mcp-content.handler';
import { McpToolHandler } from '../../modules/mcp/services/mcp-tool.handler';
import { ToolsService } from '../../modules/tools/tools.service';
import { ToolsStatsHelper } from '../../modules/tools/tools-stats.helper';
import { FakeRedis } from '../fake-redis';

/**
 * What an MCP gateway publishes beyond tools/list, against a real Postgres:
 * resources/list and resources/read must answer from the same set (the
 * resources of the APIs whose tools the gateway serves, by the shared rule
 * in gateway-servable.ts), a resource the gateway does not publish must read
 * exactly like one that does not exist, and tools/discover and tools/search
 * must count only what the gateway serves.
 *
 * Seed: one org, two gateways. G1 serves `pub_widget` (API "pub"). Also
 * attached to G1 but NOT servable: a tool whose gateway_tools row is
 * inactive, a draft tool, and the owner's private tool (G1 is an org
 * gateway). G2 serves `other_widget` (API "other"). `loose_widget` is on no
 * gateway at all. Every API has one resource.
 *
 * Gated on RUN_DB_INTEGRATION=1. Own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'mcp_gateway_resources_test';

jest.setTimeout(120_000);

describeIfDb('MCP gateway resources, discover and search scope (real Postgres)', () => {
  let ds: DataSource;
  let mcp: McpService;
  let orgId: string;
  let owner: string;
  let member: string;
  let g1: Gateway;
  let g2: Gateway;
  const resourceOf: Record<'pub' | 'other' | 'inactiveRow' | 'draft' | 'priv' | 'loose', Resource> = {} as any;

  const connection = () => ({
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  });

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

    const org = await ds.getRepository(Organization).save(
      ds.getRepository(Organization).create({ name: 'Gateway Res Org', slug: 'gateway-res-org' } as any),
    );
    orgId = (org as any).id;
    const addUser = async (key: string, role: OrganizationRole) => {
      const user = await ds.getRepository(User).save(
        ds.getRepository(User).create({ email: `${key}@gwres.test`, passwordHash: 'x', firstName: key, lastName: 'T' } as any),
      );
      const id = (user as any).id as string;
      await ds.getRepository(UserOrganization).save(
        ds.getRepository(UserOrganization).create({ userId: id, organizationId: orgId, role, isActive: true } as any),
      );
      return id;
    };
    owner = await addUser('owner', OrganizationRole.ADMIN);
    member = await addUser('member', OrganizationRole.MEMBER);

    const policy = new AccessPolicyService(ds.getRepository(UserOrganization), ds.getRepository(UserTeam));
    const audit = { log: jest.fn(), logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn(), computeChanges: jest.fn() } as any;
    const tools = new ToolsService(
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
      new ToolsStatsHelper(ds.getRepository(Tool), ds.getRepository(ToolExecution)),
      policy,
    );
    const toolHandler = new McpToolHandler(
      ds.getRepository(Tool),
      ds.getRepository(GatewayTool),
      ds.getRepository(ToolCategory),
      tools,
      { executeTool: jest.fn() } as any,
      new FakeRedis() as any,
    );
    const contentHandler = new McpContentHandler(
      ds.getRepository(Tool),
      ds.getRepository(Resource),
      ds.getRepository(GatewayTool),
      null as any,
      toolHandler,
      null as any,
    );
    mcp = new McpService(
      ds.getRepository(Gateway),
      ds.getRepository(Organization),
      tools,
      toolHandler,
      contentHandler,
      null as any,
    );

    // ── Seed ──────────────────────────────────────────────────────────
    const gateways = ds.getRepository(Gateway);
    g1 = await gateways.save(gateways.create({
      name: 'g1', type: GatewayType.MCP, endpoint: '/g1', organizationId: orgId, configuration: {},
    } as any)) as unknown as Gateway;
    g2 = await gateways.save(gateways.create({
      name: 'g2', type: GatewayType.MCP, endpoint: '/g2', organizationId: orgId, configuration: {},
    } as any)) as unknown as Gateway;

    const catA = await ds.getRepository(ToolCategory).save({ name: 'Published', slug: 'cat-a', organizationId: orgId, sortOrder: 0 } as any);
    const catB = await ds.getRepository(ToolCategory).save({ name: 'Unpublished', slug: 'cat-b', organizationId: orgId, sortOrder: 1 } as any);

    const seed = async (
      key: keyof typeof resourceOf,
      tool: { name: string; status?: ToolStatus; visibility?: string },
      category: ToolCategory,
      attach?: { gateway: Gateway; isActive: boolean },
    ) => {
      const api = await ds.getRepository(Api).save(ds.getRepository(Api).create({
        name: `api ${key}`, type: ApiType.OPENAPI, baseUrl: `https://${key}.example.com`, organizationId: orgId,
      } as any)) as unknown as Api;
      const saved = await ds.getRepository(Tool).save(ds.getRepository(Tool).create({
        name: tool.name,
        description: 'a widget',
        type: ToolType.FUNCTION,
        parameters: {},
        organizationId: orgId,
        apiId: api.id,
        status: tool.status ?? ToolStatus.ACTIVE,
        createdBy: owner,
        ...(tool.visibility ? { visibility: tool.visibility } : {}),
        categories: [category],
      } as any)) as unknown as Tool;
      if (attach) {
        await ds.getRepository(GatewayTool).save({ gatewayId: attach.gateway.id, toolId: saved.id, isActive: attach.isActive } as any);
      }
      resourceOf[key] = await ds.getRepository(Resource).save(ds.getRepository(Resource).create({
        name: `resource ${key}`, apiId: api.id, type: ResourceType.MODEL, schema: { title: key },
      } as any)) as unknown as Resource;
    };

    await seed('pub', { name: 'pub_widget' }, catA, { gateway: g1, isActive: true });
    await seed('other', { name: 'other_widget' }, catB, { gateway: g2, isActive: true });
    await seed('inactiveRow', { name: 'inactive_row_widget' }, catB, { gateway: g1, isActive: false });
    await seed('draft', { name: 'draft_widget', status: ToolStatus.DRAFT }, catB, { gateway: g1, isActive: true });
    await seed('priv', { name: 'priv_widget', visibility: 'private' }, catB, { gateway: g1, isActive: true });
    await seed('loose', { name: 'loose_widget' }, catB);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  let rpcId = 0;
  const rpc = (method: string, params: any, gatewayId?: string, userId: string = owner) =>
    mcp.handleJsonRpc({ jsonrpc: '2.0', id: ++rpcId, method, params }, orgId, userId, gatewayId) as Promise<any>;
  const uri = (r: Resource) => `almyty://resources/${r.id}`;
  const errorShape = (res: any) => (res.error ? { code: res.error.code, message: res.error.message } : { result: res.result });

  // ── Item 1: resources/list and resources/read agree ────────────────

  it('lists on each gateway only the resources of the APIs it serves', async () => {
    const onG1 = await rpc('resources/list', {}, g1.id);
    expect(onG1.result.resources.map((r: any) => r.uri)).toEqual([uri(resourceOf.pub)]);
    const onG2 = await rpc('resources/list', {}, g2.id);
    expect(onG2.result.resources.map((r: any) => r.uri)).toEqual([uri(resourceOf.other)]);
  });

  it('reads through a gateway exactly the resources that gateway lists', async () => {
    for (const gateway of [g1, g2]) {
      for (const who of [owner, member]) {
        const listed = new Set(
          (await rpc('resources/list', {}, gateway.id, who)).result.resources.map((r: any) => r.uri),
        );
        for (const resource of Object.values(resourceOf)) {
          const read = await rpc('resources/read', { uri: uri(resource) }, gateway.id, who);
          expect({ uri: uri(resource), readable: !read.error }).toEqual({ uri: uri(resource), readable: listed.has(uri(resource)) });
        }
      }
    }
  });

  it('answers a resource the gateway does not publish exactly like a nonexistent one', async () => {
    const missing = errorShape(await rpc('resources/read', { uri: `almyty://resources/${randomUUID()}` }, g1.id));
    expect(missing).toEqual({ code: -32001, message: 'Resource not found' });
    for (const key of ['other', 'inactiveRow', 'draft', 'priv', 'loose'] as const) {
      const read = errorShape(await rpc('resources/read', { uri: uri(resourceOf[key]) }, g1.id));
      expect({ key, ...read }).toEqual({ key, ...missing });
    }
    const pubOnG2 = errorShape(await rpc('resources/read', { uri: uri(resourceOf.pub) }, g2.id));
    expect(pubOnG2).toEqual(missing);
    // A malformed id is not found too, not an internal error.
    const junk = errorShape(await rpc('resources/read', { uri: 'almyty://resources/not-a-uuid' }, g1.id));
    expect(junk).toEqual(missing);
  });

  it('reads the published resource through its gateway, and any org resource off-gateway', async () => {
    const onG1 = await rpc('resources/read', { uri: uri(resourceOf.pub) }, g1.id);
    expect(JSON.parse(onG1.result.contents[0].text)).toEqual({ title: 'pub' });
    const offGateway = await rpc('resources/read', { uri: uri(resourceOf.other) }, undefined);
    expect(JSON.parse(offGateway.result.contents[0].text)).toEqual({ title: 'other' });
  });

  // ── Item 2: discover / search / get count what the gateway serves ──

  it('tools/list on G1 is the servable set the rest must match', async () => {
    const listed = await rpc('tools/list', {}, g1.id);
    expect(listed.result.tools.map((t: any) => t.name)).toEqual(['pub_widget']);
  });

  it('tools/discover on a gateway counts only the tools the gateway serves', async () => {
    for (const who of [owner, member]) {
      const onG1 = (await rpc('tools/discover', {}, g1.id, who)).result;
      expect(onG1.totalTools).toBe(1);
      expect(onG1.uncategorizedCount).toBe(0);
      expect(onG1.categories.map((c: any) => [c.slug, c.toolCount])).toEqual([['cat-a', 1]]);

      const onG2 = (await rpc('tools/discover', {}, g2.id, who)).result;
      expect(onG2.totalTools).toBe(1);
      expect(onG2.categories.map((c: any) => [c.slug, c.toolCount])).toEqual([['cat-b', 1]]);
    }
    // A category holding none of G1's tools reads like an unknown one.
    const hidden = (await rpc('tools/discover', { depth: 'tools', category: 'cat-b' }, g1.id)).result;
    const unknown = (await rpc('tools/discover', { depth: 'tools', category: 'no-such-cat' }, g1.id)).result;
    expect(hidden).toEqual(unknown);
    expect(hidden.tools.map((t: any) => t.name)).toEqual(['pub_widget']);
  });

  it('tools/discover off a gateway keeps its org-wide category counts', async () => {
    const off = (await rpc('tools/discover', {}, undefined, owner)).result;
    // cat-b: other, inactive_row, priv (the owner's own), loose -- active only.
    expect(off.categories.map((c: any) => [c.slug, c.toolCount])).toEqual([['cat-a', 1], ['cat-b', 4]]);
  });

  it('tools/search on a gateway searches and counts only the servable set', async () => {
    const onG1 = (await rpc('tools/search', { query: 'widget' }, g1.id)).result;
    expect(onG1.tools.map((t: any) => t.name)).toEqual(['pub_widget']);
    expect(onG1.total).toBe(1);
    expect(onG1.hasMore).toBe(false);
    // Paging runs over the servable set, not over an org-wide page.
    const paged = (await rpc('tools/search', { query: 'widget', limit: 1, page: 1 }, g2.id)).result;
    expect(paged).toMatchObject({ total: 1, hasMore: false });
    expect(paged.tools.map((t: any) => t.name)).toEqual(['other_widget']);
  });

  it('tools/get on a gateway answers an unpublished tool like a nonexistent one', async () => {
    const missing = errorShape(await rpc('tools/get', { name: 'no_such_widget' }, g1.id));
    for (const name of ['other_widget', 'inactive_row_widget', 'draft_widget', 'priv_widget', 'loose_widget']) {
      const got = errorShape(await rpc('tools/get', { name }, g1.id));
      expect(got.code).toBe(missing.code);
      expect(got.message).toBe(`Tool not found: ${name}`);
    }
    expect((await rpc('tools/get', { name: 'pub_widget' }, g1.id)).result.name).toBe('pub_widget');
  });
});
