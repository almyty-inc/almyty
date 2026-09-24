import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { LlmProviderType } from '../../entities/llm-provider-type';
import { Tool, ToolType } from '../../entities/tool.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import {
  notOthersPrivateAgent,
  notOthersPrivateAgentRun,
  notOthersPrivateGateway,
  notOthersPrivateProvider,
  notOthersPrivateTool,
} from '../../modules/monitoring/private-rows';
import { AnalyticsService } from '../../modules/monitoring/analytics.service';
import { AnalyticsSummariesHelper } from '../../modules/monitoring/analytics-summaries.helper';

/**
 * The "not someone else's private resource" SQL fails closed.
 *
 * A private row with no recorded owner is nobody's, and a caller with no
 * id owns nothing: neither may match as "the viewer's own". The fragments
 * used to compare with IS DISTINCT FROM, which treats NULL and NULL as
 * equal, so an ownerless private row was shown to a caller with no id.
 *
 * Every private-tier table has #741's CHECK (a private row needs an owner),
 * so an ownerless private row cannot be written today. This spec drops the
 * CHECK in its own schema to stand in for a row that predates it, or any
 * future table that lacks it.
 *
 * Real Postgres, built by the migrations. Gated on RUN_DB_INTEGRATION=1 and
 * isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'private_rows_fail_closed_test';

jest.setTimeout(120_000);

describeIfDb('private-row SQL fails closed on a null owner or viewer (real Postgres)', () => {
  let ds: DataSource;
  let organizationId: string;
  let owner: string;
  const ownerless = {} as Record<'tool' | 'gateway' | 'provider' | 'agent' | 'run', string>;
  const owned = {} as Record<'tool' | 'gateway' | 'provider' | 'agent' | 'run', string>;

  const connection = () => ({
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  });
  const repo = <T extends ObjectLiteral>(entity: new () => T): Repository<T> => ds.getRepository(entity);
  const insert = async (entity: new () => any, data: Record<string, unknown>): Promise<string> =>
    ((await repo(entity).save(repo(entity).create(data as any))) as any).id;

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

    // Stand-in for rows written before the owner CHECK existed.
    for (const table of ['tools', 'gateways', 'llm_providers', 'agents']) {
      await ds.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_visibility_team_chk`);
    }

    organizationId = await insert(Organization, { name: 'Null Owner Org', slug: 'null-owner-org' });
    owner = await insert(User, { email: 'owner@null.test', passwordHash: 'x', firstName: 'o', lastName: 'T' });

    for (const [bag, who] of [[ownerless, null], [owned, owner]] as const) {
      const tag = who ? 'owned' : 'ownerless';
      bag.tool = await insert(Tool, {
        name: `${tag}_tool`, type: ToolType.FUNCTION, parameters: {}, organizationId, visibility: 'private', createdBy: who,
      });
      bag.gateway = await insert(Gateway, {
        name: `${tag} gw`, type: GatewayType.MCP, kind: GatewayKind.TOOL, endpoint: `/${tag}`, organizationId,
        status: GatewayStatus.ACTIVE, configuration: {}, visibility: 'private', ownerUserId: who,
      });
      bag.provider = await insert(LlmProvider, {
        name: `${tag} provider`, type: LlmProviderType.OPENAI, organizationId, configuration: { model: 'x' },
        status: LlmProviderStatus.ACTIVE, visibility: 'private', ownerUserId: who,
      });
      bag.agent = await insert(Agent, {
        name: `${tag} agent`, status: AgentStatus.ACTIVE, organizationId, pipeline: { nodes: [], edges: [] },
        visibility: 'private', createdBy: who,
      });
      bag.run = await insert(AgentRun, { agentId: bag.agent, organizationId, userId: owner, status: AgentRunStatus.COMPLETED });
      await insert(ToolExecution, { organizationId, userId: owner, toolId: bag.tool, parameters: {}, success: true, executionTime: 1 });
    }
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const fragments = [
    { kind: 'tool', entity: Tool, fragment: notOthersPrivateTool },
    { kind: 'gateway', entity: Gateway, fragment: notOthersPrivateGateway },
    { kind: 'provider', entity: LlmProvider, fragment: notOthersPrivateProvider },
    { kind: 'agent', entity: Agent, fragment: notOthersPrivateAgent },
    { kind: 'run', entity: AgentRun, fragment: notOthersPrivateAgentRun },
  ] as const;

  /** The ids of `kind` the fragment keeps for `viewer`. */
  const kept = async (entity: new () => any, fragment: (c: string) => string, viewer: string | null) =>
    (await repo(entity).createQueryBuilder('r')
      .select('r.id', 'id')
      .where(fragment('r.id'), { privateViewerId: viewer })
      .getRawMany()).map((row) => row.id as string);

  it.each(fragments)('$kind: an ownerless private row is hidden from a caller with no id', async ({ kind, entity, fragment }) => {
    expect(await kept(entity, fragment, null)).not.toContain(ownerless[kind]);
  });

  it.each(fragments)('$kind: an ownerless private row is hidden from a known caller too', async ({ kind, entity, fragment }) => {
    expect(await kept(entity, fragment, owner)).not.toContain(ownerless[kind]);
  });

  it.each(fragments)('$kind: the owner still sees their own; no caller does not', async ({ kind, entity, fragment }) => {
    expect(await kept(entity, fragment, owner)).toContain(owned[kind]);
    expect(await kept(entity, fragment, null)).not.toContain(owned[kind]);
  });

  it('tool usage: an ownerless private tool is left out for no caller; the owner keeps theirs', async () => {
    const analytics = new AnalyticsService(
      null as any, null as any, repo(ToolExecution), null as any, null as any, null as any, repo(AgentRun), null as any, null as any,
    );
    const noCaller = (await analytics.getToolUsage(organizationId, '30d', null)).map((r: any) => r.toolId);
    expect(noCaller).not.toContain(ownerless.tool);
    const forOwner = (await analytics.getToolUsage(organizationId, '30d', owner)).map((r: any) => r.toolId);
    expect(forOwner).toContain(owned.tool);
    expect(forOwner).not.toContain(ownerless.tool);
  });

  it('agent-run summary: runs of an ownerless private agent are not counted for no caller', async () => {
    const summaries = new AnalyticsSummariesHelper(repo(AuditLog), repo(AgentRun));
    const noCaller = await summaries.getAgentRunsSummary(organizationId, null);
    const forOwner = await summaries.getAgentRunsSummary(organizationId, owner);
    // The owner's count proves the query ran (the helper answers zeros on a SQL error).
    expect(forOwner.totals.total).toBe(1);
    expect(noCaller.totals.total).toBe(0);
  });
});
