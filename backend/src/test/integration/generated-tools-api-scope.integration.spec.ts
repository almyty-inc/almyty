import { DataSource } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { JsonSchema } from '../../entities/json-schema.entity';

import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { ToolsOperationHelper } from '../../modules/tools/tools-operation.helper';
import { ToolGeneratorService } from '../../modules/tools/tool-generator.service';
import { ToolsService } from '../../modules/tools/tools.service';
import { ApisToolGeneratorHelper } from '../../modules/apis/apis-tool-generator.helper';
import { ApisService } from '../../modules/apis/apis.service';
import { GeneratedToolsFollowApiScope1750812730000 } from '../../migrations/1750812730000-GeneratedToolsFollowApiScope';

/**
 * Tools generated from an API carry the API's scope. A team API's tools
 * used to be written org-wide: listed to the whole organization and
 * refused only when one ran. Now generation (both the schema-import path
 * and POST /tools/generate-from-api), regeneration, a later change of the
 * API's scope and the backfill migration all put a generated tool in its
 * API's scope. Hand-made tools on the API keep their own.
 *
 * Real Postgres (migrations, the scope CHECK constraints). Gated on
 * RUN_DB_INTEGRATION=1, isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'generated_tools_api_scope_test';

jest.setTimeout(120_000);

describeIfDb('generated tools take their API scope (real Postgres)', () => {
  let ds: DataSource;
  let policy: AccessPolicyService;
  let organizationId: string;
  let teamId: string;
  let otherTeamId: string;
  const users: Record<'teammate' | 'outsider' | 'admin', string> = {} as any;
  let seq = 0;

  const repo = <T extends object>(entity: new () => T) => ds.getRepository(entity);
  const insert = async <T extends object>(entity: new () => T, data: Record<string, unknown>): Promise<T> =>
    (await repo(entity).save(repo(entity).create(data as any) as unknown as T)) as T;

  /** The schema-import generator (ApisToolGeneratorHelper over ToolsOperationHelper), on the real tables. */
  function importGenerator() {
    const noVersions = { createToolVersion: async () => undefined };
    const ops = new ToolsOperationHelper(repo(Tool), repo(Operation), repo(ApiSchema), noVersions as any);
    const toolsService = new Proxy(
      { ...noVersions, findByName: ToolsService.prototype.findByName.bind({ toolRepository: repo(Tool) }) } as Record<string, any>,
      { get: (target, prop: string) => (prop in target ? target[prop] : typeof (ops as any)[prop] === 'function' ? (ops as any)[prop].bind(ops) : undefined) },
    );
    const apisService = {
      findOne: (id: string, org: string) => repo(Api).findOne({ where: { id, organizationId: org }, relations: { operations: true } }),
    };
    return new ApisToolGeneratorHelper(repo(Api), toolsService as any, apisService as any);
  }

  /** POST /tools/generate-from-api's generator, schema translation stubbed out. */
  function restGenerator() {
    const gen = new ToolGeneratorService(repo(Tool), repo(ToolVersion), repo(Operation), repo(JsonSchema), {} as any);
    jest.spyOn(gen as any, 'generateInputSchemaForOperation').mockResolvedValue(null);
    jest.spyOn(gen as any, 'generateOutputSchemaForOperation').mockResolvedValue(null);
    return gen;
  }

  async function apiWithOperations(scope: Record<string, unknown>, n = 2): Promise<Api> {
    seq += 1;
    const api = await insert(Api, {
      name: `ledger${seq}`, type: ApiType.OPENAPI, baseUrl: 'https://ledger.example.test', organizationId,
      ownerUserId: users.teammate, ...scope,
    });
    await repo(Operation).save(
      Array.from({ length: n }, (_, i) =>
        repo(Operation).create({ name: `op${i}`, operationId: `op${i}`, apiId: api.id, method: 'GET', endpoint: `/things/${i}`, isActive: true } as Partial<Operation>),
      ),
    );
    return api;
  }

  const toolsOf = (api: Api) =>
    repo(Tool)
      .createQueryBuilder('t')
      .where('t."organizationId" = :organizationId', { organizationId })
      .andWhere(`(t."apiId" = :apiId OR t."operationId" IN (SELECT id FROM operations WHERE "apiId" = :apiId))`, { apiId: api.id })
      .orderBy('t.name')
      .getMany();
  const scopes = async (api: Api) => (await toolsOf(api)).map((t) => [t.visibility, t.teamId]);

  beforeAll(async () => {
    const connection = {
      type: 'postgres' as const,
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      database: process.env.DATABASE_NAME || 'almyty_test',
    };
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
    await bootstrap.destroy();

    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
    });
    await ds.initialize();
    policy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));

    organizationId = (await insert(Organization, { name: 'Scope Org', slug: 'scope-org' }) as any).id;
    const roles: Array<[keyof typeof users, OrganizationRole]> = [
      ['teammate', OrganizationRole.MEMBER],
      ['outsider', OrganizationRole.MEMBER],
      ['admin', OrganizationRole.ADMIN],
    ];
    for (const [name, role] of roles) {
      const user = await insert(User, { email: `${name}@gen-scope.test`, passwordHash: 'x', firstName: name, lastName: 'G' });
      users[name] = (user as any).id;
      await insert(UserOrganization, { userId: users[name], organizationId, role, isActive: true, inviteAccepted: true });
    }
    teamId = (await insert(Team, { name: 'Payments', organizationId }) as any).id;
    otherTeamId = (await insert(Team, { name: 'Growth', organizationId }) as any).id;
    await insert(UserTeam, { userId: users.teammate, teamId, role: TeamRole.LEAD, isActive: true });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it("schema import: a team API's tools are its team's, listed to its team and admins only", async () => {
    const api = await apiWithOperations({ visibility: 'team', teamId });
    await importGenerator().generateToolsFromApi(api.id, organizationId, undefined, undefined, users.teammate);
    const tools = await toolsOf(api);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => [t.visibility, t.teamId])).toEqual([['team', teamId], ['team', teamId]]);
    expect(await policy.filterVisible({ id: users.outsider }, organizationId, tools)).toEqual([]);
    expect(await policy.filterVisible({ id: users.teammate }, organizationId, tools)).toHaveLength(2);
    expect(await policy.filterVisible({ id: users.admin }, organizationId, tools)).toHaveLength(2);
  });

  it('generate-from-api: the same, and an org API still generates org-wide tools', async () => {
    const team = await apiWithOperations({ visibility: 'team', teamId });
    await restGenerator().generateToolsFromApi(team, { createdBy: users.teammate, namePrefix: 'rest-team' });
    expect(await scopes(team)).toEqual([['team', teamId], ['team', teamId]]);

    const org = await apiWithOperations({ visibility: 'org', teamId: null });
    await restGenerator().generateToolsFromApi(org, { createdBy: users.teammate, namePrefix: 'rest-org' });
    expect(await scopes(org)).toEqual([['org', null], ['org', null]]);
  });

  it('regeneration puts a generated tool written org-wide back into its API scope', async () => {
    const api = await apiWithOperations({ visibility: 'team', teamId });
    await importGenerator().generateToolsFromApi(api.id, organizationId);
    // What generation used to write.
    await repo(Tool).update({ operationId: (await repo(Operation).findOneByOrFail({ apiId: api.id, name: 'op0' })).id }, { visibility: 'org', teamId: null });
    await repo(Tool).update({ operationId: (await repo(Operation).findOneByOrFail({ apiId: api.id, name: 'op1' })).id }, { visibility: 'org', teamId: null });
    expect(await scopes(api)).toEqual([['org', null], ['org', null]]);

    await importGenerator().generateToolsFromApi(api.id, organizationId);
    expect(await scopes(api)).toEqual([['team', teamId], ['team', teamId]]);

    await repo(Tool).update({ id: (await toolsOf(api))[0].id }, { visibility: 'org', teamId: null });
    const loaded = await repo(Api).findOneByOrFail({ id: api.id });
    await restGenerator().generateToolsFromApi(loaded);
    expect(await scopes(api)).toEqual([['team', teamId], ['team', teamId]]);

    await repo(Tool).update({ id: (await toolsOf(api))[1].id }, { visibility: 'org', teamId: null });
    await restGenerator().regenerateToolFromOperation((await toolsOf(api))[1].id, organizationId);
    expect(await scopes(api)).toEqual([['team', teamId], ['team', teamId]]);
  });

  describe("a change of the API's scope", () => {
    let apis: ApisService;
    const audit = { logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn(), log: jest.fn() } as any;

    beforeAll(() => {
      apis = new ApisService(
        repo(Api), repo(ApiSchema), repo(Operation), repo(Resource), repo(Organization), null as any, null as any,
        audit, ds, null as any, null as any, policy, null as any,
      );
    });

    it('takes the generated tools with it, narrower and wider; hand-made tools on the API keep theirs', async () => {
      const api = await apiWithOperations({ visibility: 'org', teamId: null });
      await importGenerator().generateToolsFromApi(api.id, organizationId);
      const handmade = await insert(Tool, {
        name: `handmade${seq}`, organizationId, type: ToolType.FUNCTION, status: ToolStatus.ACTIVE, parameters: {},
        apiId: api.id, visibility: 'org', teamId: null, createdBy: users.outsider, generated: false,
      });
      const handmadeScope = async () => {
        const row = await repo(Tool).findOneByOrFail({ id: handmade.id });
        return [row.visibility, row.teamId];
      };
      const generatedScopes = async () => (await toolsOf(api)).filter((t) => t.generated).map((t) => [t.visibility, t.teamId]);

      await apis.update(api.id, { visibility: 'team', teamId } as any, organizationId, users.admin);
      expect(await generatedScopes()).toEqual([['team', teamId], ['team', teamId]]);
      expect(await handmadeScope()).toEqual(['org', null]);

      await apis.update(api.id, { teamId: otherTeamId } as any, organizationId, users.admin);
      expect(await generatedScopes()).toEqual([['team', otherTeamId], ['team', otherTeamId]]);

      await apis.update(api.id, { visibility: 'org' } as any, organizationId, users.admin);
      expect(await generatedScopes()).toEqual([['org', null], ['org', null]]);
      expect(await handmadeScope()).toEqual(['org', null]);
    });

    it('going private and back: the owner keeps the generated tools, and they widen with the API again', async () => {
      const api = await apiWithOperations({ visibility: 'team', teamId });
      await importGenerator().generateToolsFromApi(api.id, organizationId);
      await apis.update(api.id, { visibility: 'private' } as any, organizationId, users.teammate);
      const privateRows = await toolsOf(api);
      expect(privateRows.map((t) => [t.visibility, t.teamId, t.createdBy])).toEqual([
        ['private', null, users.teammate], ['private', null, users.teammate],
      ]);
      await apis.update(api.id, { visibility: 'team', teamId } as any, organizationId, users.teammate);
      expect(await scopes(api)).toEqual([['team', teamId], ['team', teamId]]);
    });
  });

  it('the migration aligns existing generated tools with their API and leaves hand-made ones alone', async () => {
    const teamApi = await apiWithOperations({ visibility: 'team', teamId }, 1);
    const privateApi = await apiWithOperations({ visibility: 'private', teamId: null, ownerUserId: users.teammate }, 1);
    const orgApi = await apiWithOperations({ visibility: 'org', teamId: null }, 1);
    const opOf = async (api: Api) => (await repo(Operation).findOneByOrFail({ apiId: api.id })).id;
    const base = { organizationId, type: ToolType.FUNCTION, status: ToolStatus.ACTIVE, parameters: {}, visibility: 'org', teamId: null };
    const viaOperation = await insert(Tool, { ...base, name: `m-team-op${seq}`, operationId: await opOf(teamApi), generated: true, createdBy: null });
    const viaApiId = await insert(Tool, { ...base, name: `m-team-api${seq}`, apiId: teamApi.id, generated: true, createdBy: null });
    const privateTool = await insert(Tool, { ...base, name: `m-private${seq}`, operationId: await opOf(privateApi), generated: true, createdBy: null });
    const stray = await insert(Tool, { ...base, name: `m-org${seq}`, operationId: await opOf(orgApi), generated: true, visibility: 'team', teamId });
    const handmade = await insert(Tool, { ...base, name: `m-handmade${seq}`, apiId: teamApi.id, generated: false, createdBy: users.outsider });

    const runner = { query: (sql: string, params?: unknown[]) => ds.query(sql, params) } as any;
    await new GeneratedToolsFollowApiScope1750812730000().up(runner);
    // Idempotent.
    await new GeneratedToolsFollowApiScope1750812730000().up(runner);

    const row = async (tool: Tool) => {
      const r = await repo(Tool).findOneByOrFail({ id: tool.id });
      return [r.visibility, r.teamId, r.createdBy];
    };
    expect(await row(viaOperation)).toEqual(['team', teamId, null]);
    expect(await row(viaApiId)).toEqual(['team', teamId, null]);
    expect(await row(privateTool)).toEqual(['private', null, users.teammate]);
    expect(await row(stray)).toEqual(['org', null, null]);
    expect(await row(handmade)).toEqual(['org', null, users.outsider]);
  });
});
