import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { versionsConfig } from 'typeorm-versions';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { Message } from '../../entities/message.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { UsageMetric, MetricStatus, MetricType } from '../../entities/usage-metric.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Conversation } from '../../entities/conversation.entity';
import { AnalyticsService } from '../../modules/monitoring/analytics.service';
import { AnalyticsExportHelper } from '../../modules/monitoring/analytics-export.helper';
import { AnalyticsSummariesHelper } from '../../modules/monitoring/analytics-summaries.helper';

/**
 * Analytics' per-gateway usage lists gateways: MCP, UTCP and Skills. A2A,
 * the web chat, the widget and the messaging platforms are channels on an
 * agent, and their traffic is not shown as a gateway's.
 *
 * Real Postgres, built by the migrations. Gated on RUN_DB_INTEGRATION=1
 * and isolated in its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'gateway_usage_protocols_test';

jest.setTimeout(120_000);

describeIfDb('gateway usage covers MCP, UTCP and Skills gateways only (real Postgres)', () => {
  let ds: DataSource;
  let organizationId: string;
  let userId: string;
  let analytics: AnalyticsService;
  const ids = {} as Record<string, string>;

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

    organizationId = await insert(Organization, { name: 'Usage Org', slug: 'usage-org' });
    userId = await insert(User, { email: 'owner@usage.test', passwordHash: 'x', firstName: 'O', lastName: 'W' });

    const types = [
      GatewayType.MCP, GatewayType.UTCP, GatewayType.SKILLS,
      GatewayType.A2A, GatewayType.HOSTED_CHAT, GatewayType.CHAT_WIDGET, GatewayType.SLACK,
    ];
    for (const type of types) {
      ids[type] = await insert(Gateway, {
        name: `${type} gw`, type, kind: Gateway.kindForType(type) ?? GatewayKind.TOOL, endpoint: `/${type}-gw`, organizationId,
        status: GatewayStatus.ACTIVE, configuration: {}, visibility: 'org', ownerUserId: userId,
      });
      await insert(UsageMetric, {
        type: MetricType.REQUEST_COUNT, value: 1, status: MetricStatus.SUCCESS, gatewayId: ids[type], organizationId, timestamp: new Date(),
      });
    }

    analytics = new AnalyticsService(
      repo(RequestLog), repo(UsageMetric), repo(ToolExecution), repo(Conversation), repo(Message), repo(AuditLog), repo(AgentRun),
      new AnalyticsExportHelper(repo(RequestLog), repo(ToolExecution), repo(Conversation)),
      new AnalyticsSummariesHelper(repo(AuditLog), repo(AgentRun)),
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('lists the MCP, UTCP and Skills gateways and none of the channels', async () => {
    const usage = await analytics.getGatewayUsage(organizationId, '7d', userId);
    expect(usage.map((r) => r.gatewayId).sort()).toEqual(
      [ids[GatewayType.MCP], ids[GatewayType.UTCP], ids[GatewayType.SKILLS]].sort(),
    );
  });
});
