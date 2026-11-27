/**
 * CatchUpUserFunnelClaims1791002100000 against real Postgres: milestones
 * that servers from before the claim wrote while the backfill's release
 * rolled out (rows written, claims left NULL, the service never called)
 * are marked, so once PostHog is on none of them is reported as new, not
 * even after an email change re-confirms the address or after an old run
 * row was edited. Someone new is still reported once per event.
 *
 * Gated behind RUN_DB_INTEGRATION=1 like every spec in this folder.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';

import { User } from '../../entities/user.entity';
import { Agent } from '../../entities/agent.entity';
import { Organization } from '../../entities/organization.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { AgentRun, AgentRunStatus, AgentMode } from '../../entities/agent-run.entity';
import { AgentExecution, AgentExecutionStatus } from '../../entities/agent-execution.entity';
import {
  FIRST_RUN_SUCCEEDED_EVENT,
  ProductAnalyticsService,
  SIGNUP_COMPLETED_EVENT,
} from '../../modules/product-analytics/product-analytics.service';
import { ensureSchema } from './isolated-schema.helper';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'funnel_analytics_catch_up_test';
const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
/** The backfill; the catch-up comes after it. */
const BACKFILL_MIGRATION = 1791002000000;

jest.setTimeout(180_000);

function connection(migrations: string[], extra: Partial<DataSourceOptions> = {}): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'password',
    database: process.env.DATABASE_NAME || 'almyty_test',
    schema: SCHEMA,
    extra: { options: `-c search_path=${SCHEMA},public` },
    migrations,
    migrationsTransactionMode: 'each',
    entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
    logging: false,
    ...extra,
  } as DataSourceOptions);
}

const migrationFiles = (upTo?: number) =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+-.+\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
    .filter((f) => upTo === undefined || Number(f.split('-')[0]) <= upTo)
    .map((f) => path.join(MIGRATIONS_DIR, f));

const CONFIRMED = new Date('2026-11-27T09:00:00Z');
const FINISHED = new Date('2026-11-27T09:05:00Z');

describeIfDb('funnel analytics catch-up after the backfill rollout (real Postgres)', () => {
  let ds: DataSource;
  let service: ProductAnalyticsService;
  let fetchMock: jest.Mock;
  let org: Organization;
  const savedKey = process.env.POSTHOG_API_KEY;
  const savedFetch = global.fetch;
  const people: Record<string, User> = {};
  const agents: Record<string, Agent> = {};
  let seq = 0;

  async function user(key: string, fields: Partial<User>): Promise<User> {
    seq++;
    const saved = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        email: `catchup-${seq}@example.com`,
        normalizedEmail: `catchup-${seq}@example.com`,
        passwordHash: 'x',
        firstName: 'C',
        lastName: 'U',
        isVerified: false,
        verifiedAt: null,
        ...fields,
      }),
    );
    await ds.getRepository(UserOrganization).save(
      ds.getRepository(UserOrganization).create({
        userId: saved.id,
        organizationId: org.id,
        role: OrganizationRole.MEMBER,
        isActive: true,
        inviteAccepted: true,
      }),
    );
    people[key] = saved;
    return saved;
  }

  async function agent(key: string, createdBy: string, fields: Partial<Agent> = {}): Promise<Agent> {
    const saved = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        name: `catchup-agent-${key}`,
        organizationId: org.id,
        createdBy,
        pipeline: { nodes: [], edges: [] } as any,
        ...fields,
      }),
    );
    agents[key] = saved;
    return saved;
  }

  async function run(a: Agent, userId: string | null, at: Date): Promise<string> {
    const saved = await ds.getRepository(AgentRun).save(
      ds.getRepository(AgentRun).create({
        agentId: a.id,
        organizationId: org.id,
        userId: userId as any,
        mode: AgentMode.AUTONOMOUS,
        status: AgentRunStatus.COMPLETED,
      }),
    );
    await ds.query(`UPDATE "agent_runs" SET "updatedAt" = $1 WHERE "id" = $2`, [at, saved.id]);
    return saved.id;
  }

  async function execution(a: Agent, userId: string | null, at: Date): Promise<void> {
    const saved = await ds.getRepository(AgentExecution).save(
      ds.getRepository(AgentExecution).create({
        agentId: a.id,
        organizationId: org.id,
        userId: userId as any,
        status: AgentExecutionStatus.COMPLETED,
      }),
    );
    // timestamp without zone, written as UTC wall time.
    await ds.query(`UPDATE "agent_executions" SET "updatedAt" = $1 WHERE "id" = $2`, [at.toISOString(), saved.id]);
  }

  const row = (key: string) => ds.getRepository(User).findOneByOrFail({ id: people[key].id });
  const events = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));

  beforeAll(async () => {
    await ensureSchema(SCHEMA);

    // 1. The release with the backfill: its migrations have run.
    ds = connection(migrationFiles(BACKFILL_MIGRATION), { dropSchema: true, migrationsRun: true });
    await ds.initialize();
    org = await ds.getRepository(Organization).save(
      ds.getRepository(Organization).create({ name: 'catchup', slug: `catchup-${Date.now()}`, plan: 'pro', isActive: true }),
    );

    // 2. While it rolls out, older servers write milestones without claims.
    await user('confirmedByOld', { isVerified: true, verifiedAt: CONFIRMED });
    const ran = await user('ranByOld', { isVerified: true, verifiedAt: CONFIRMED });
    const ranRun = await run(await agent('ranByOld', ran.id), ran.id, FINISHED);
    // That run row is edited later, so its updatedAt is recent.
    await ds.query(`UPDATE "agent_runs" SET "updatedAt" = now() WHERE "id" = $1`, [ranRun]);
    const scheduled = await user('scheduledByOld', { isVerified: true, verifiedAt: CONFIRMED });
    await execution(await agent('scheduledByOld', scheduled.id, { mode: 'workflow' } as any), null, FINISHED);
    for (const key of ['confirmedByOld', 'ranByOld', 'scheduledByOld']) {
      const r = await row(key);
      expect([r.signupEventAt, r.firstRunEventAt]).toEqual([null, null]);
    }

    // 3. The next release: the catch-up.
    const upgrade = connection(migrationFiles());
    await upgrade.initialize();
    await upgrade.runMigrations({ transaction: 'each' });
    await upgrade.destroy();

    service = new ProductAnalyticsService(
      ds.getRepository(User),
      ds.getRepository(Agent),
      ds.getRepository(Organization),
      ds.getRepository(UserOrganization),
    );
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.POSTHOG_API_KEY;
    else process.env.POSTHOG_API_KEY = savedKey;
    global.fetch = savedFetch;
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(() => {
    process.env.POSTHOG_API_KEY = 'phc_integration';
    fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
    global.fetch = fetchMock as any;
  });

  it('marks the milestones the older servers left unclaimed', async () => {
    expect((await row('confirmedByOld')).signupEventAt?.toISOString()).toBe(CONFIRMED.toISOString());
    expect((await row('ranByOld')).signupEventAt).toBeInstanceOf(Date);
    expect((await row('ranByOld')).firstRunEventAt).toBeInstanceOf(Date);
    expect((await row('scheduledByOld')).firstRunEventAt?.toISOString()).toBe(FINISHED.toISOString());
  });

  it('reports none of them once a key is set: not after an email change, not after more runs', async () => {
    // An email change clears verifiedAt (AuthService.changeEmail); the new
    // address is confirmed now (verifyEmail), which calls signupCompleted.
    await ds.getRepository(User).update({ id: people.confirmedByOld.id }, { isVerified: false, verifiedAt: null });
    await ds.getRepository(User).update({ id: people.confirmedByOld.id }, { isVerified: true, verifiedAt: new Date() });
    await service.signupCompleted(people.confirmedByOld.id);

    await run(agents.ranByOld, people.ranByOld.id, new Date());
    await service.runSucceeded({ agentId: agents.ranByOld.id, userId: people.ranByOld.id });
    await execution(agents.scheduledByOld, null, new Date());
    await service.runSucceeded({ agentId: agents.scheduledByOld.id, userId: null });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still reports someone new once per event', async () => {
    const fresh = await user('fresh', { isVerified: true, verifiedAt: new Date() });
    const freshAgent = await agent('fresh', fresh.id);
    await Promise.all(Array.from({ length: 3 }, () => service.signupCompleted(fresh.id)));
    await run(freshAgent, fresh.id, new Date());
    await Promise.all(Array.from({ length: 3 }, () => service.runSucceeded({ agentId: freshAgent.id, userId: fresh.id })));
    expect(events().map((e) => [e.event, e.distinct_id])).toEqual([
      [SIGNUP_COMPLETED_EVENT, fresh.id],
      [FIRST_RUN_SUCCEEDED_EVENT, fresh.id],
    ]);
  });

  it('changes nothing when run again', async () => {
    const before = await ds.query(`SELECT "id", "signupEventAt", "firstRunEventAt" FROM "users" ORDER BY "id"`);
    const qr = ds.createQueryRunner();
    const { CatchUpUserFunnelClaims1791002100000 } = await import('../../migrations/1791002100000-CatchUpUserFunnelClaims');
    await new CatchUpUserFunnelClaims1791002100000().up(qr);
    await qr.release();
    expect(await ds.query(`SELECT "id", "signupEventAt", "firstRunEventAt" FROM "users" ORDER BY "id"`)).toEqual(before);
  });
});
