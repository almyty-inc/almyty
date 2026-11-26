/**
 * BackfillUserFunnelClaims1791002000000 against real Postgres: accounts
 * that existed before the funnel events were turned on are marked as
 * counted, so their next run or a re-confirmed address sends nothing,
 * while someone who signs up afterwards is still reported exactly once.
 *
 * The schema is built in two steps: every migration up to the one that
 * added the claim columns, then the data an existing install would hold,
 * then the remaining migrations.
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
const SCHEMA = 'funnel_analytics_backfill_test';
const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
/** The migration that added the claim columns; the backfill comes after it. */
const CLAIM_COLUMNS_MIGRATION = 1791001900000;

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

const VERIFIED_AT = new Date('2026-03-01T10:00:00Z');
const T_FAILED = new Date('2026-03-02T10:00:00Z');
const T_FIRST = new Date('2026-03-03T10:00:00Z');
const T_LATER = new Date('2026-03-04T10:00:00Z');
const PRESET_CLAIM = new Date('2026-02-01T10:00:00Z');

describeIfDb('funnel analytics backfill of existing accounts (real Postgres)', () => {
  let ds: DataSource;
  let service: ProductAnalyticsService;
  let fetchMock: jest.Mock;
  const savedKey = process.env.POSTHOG_API_KEY;
  const savedFetch = global.fetch;

  let seq = 0;
  const people: Record<string, User> = {};
  const agents: Record<string, Agent> = {};
  let org: Organization;

  async function user(key: string, fields: Partial<User>): Promise<User> {
    seq++;
    const saved = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        email: `backfill-${seq}@example.com`,
        normalizedEmail: `backfill-${seq}@example.com`,
        passwordHash: 'x',
        firstName: 'B',
        lastName: 'F',
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
        name: `backfill-agent-${key}`,
        organizationId: org.id,
        createdBy,
        pipeline: { nodes: [], edges: [] } as any,
        ...fields,
      }),
    );
    agents[key] = saved;
    return saved;
  }

  /** An autonomous run, its row last written at `at`. */
  async function run(a: Agent, userId: string | null, status: AgentRunStatus, at: Date): Promise<void> {
    const saved = await ds.getRepository(AgentRun).save(
      ds.getRepository(AgentRun).create({
        agentId: a.id,
        organizationId: org.id,
        userId: userId as any,
        mode: AgentMode.AUTONOMOUS,
        status,
      }),
    );
    await ds.query(`UPDATE "agent_runs" SET "updatedAt" = $1 WHERE "id" = $2`, [at, saved.id]);
  }

  /** A workflow execution, its row last written at `at`. */
  async function execution(a: Agent, userId: string | null, status: AgentExecutionStatus, at: Date): Promise<void> {
    const saved = await ds.getRepository(AgentExecution).save(
      ds.getRepository(AgentExecution).create({
        agentId: a.id,
        organizationId: org.id,
        userId: userId as any,
        status,
      }),
    );
    // `updatedAt` here is a timestamp without zone, written by the app as
    // UTC wall time (the server's now()); a Date would land as local time.
    await ds.query(`UPDATE "agent_executions" SET "updatedAt" = $1 WHERE "id" = $2`, [at.toISOString(), saved.id]);
  }

  const row = (key: string) => ds.getRepository(User).findOneByOrFail({ id: people[key].id });
  const events = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));

  beforeAll(async () => {
    await ensureSchema(SCHEMA);

    // 1. An install as it stood with the claim columns but before the backfill.
    ds = connection(migrationFiles(CLAIM_COLUMNS_MIGRATION), { dropSchema: true, migrationsRun: true });
    await ds.initialize();

    org = await ds.getRepository(Organization).save(
      ds.getRepository(Organization).create({ name: 'backfill', slug: `backfill-${Date.now()}`, plan: 'pro', isActive: true }),
    );

    // 2. Its accounts and their history.
    // Ran an own autonomous agent (after a failed attempt, and again later).
    const ranOwn = await user('ranOwn', { isVerified: true, verifiedAt: VERIFIED_AT });
    await agent('ranOwn', ranOwn.id, { mode: 'autonomous' } as any);
    await run(agents.ranOwn, ranOwn.id, AgentRunStatus.FAILED, T_FAILED);
    await run(agents.ranOwn, ranOwn.id, AgentRunStatus.COMPLETED, T_LATER);
    await run(agents.ranOwn, ranOwn.id, AgentRunStatus.COMPLETED, T_FIRST);

    // Ran an own workflow agent.
    const ranWorkflow = await user('ranWorkflow', { isVerified: true, verifiedAt: VERIFIED_AT });
    await agent('ranWorkflow', ranWorkflow.id, { mode: 'workflow' } as any);
    await execution(agents.ranWorkflow, ranWorkflow.id, AgentExecutionStatus.COMPLETED, T_FIRST);

    // Only ever ran the sample and a sub-agent's temporary copy.
    const sampleOnly = await user('sampleOnly', { isVerified: true, verifiedAt: VERIFIED_AT });
    await agent('sample', sampleOnly.id, { metadata: { sampleWorkspace: true } } as any);
    await agent('temporary', sampleOnly.id, { isTemporary: true });
    await agent('sampleOnlyOwn', sampleOnly.id);
    await run(agents.sample, sampleOnly.id, AgentRunStatus.COMPLETED, T_FIRST);
    await execution(agents.temporary, sampleOnly.id, AgentExecutionStatus.COMPLETED, T_FIRST);

    // Only failed runs.
    const failedOnly = await user('failedOnly', { isVerified: true, verifiedAt: VERIFIED_AT });
    await agent('failedOnly', failedOnly.id);
    await run(agents.failedOnly, failedOnly.id, AgentRunStatus.FAILED, T_FIRST);
    await execution(agents.failedOnly, failedOnly.id, AgentExecutionStatus.FAILED, T_FIRST);

    // Built an agent someone else ran; the runner gets the credit.
    const builder = await user('builder', { isVerified: true, verifiedAt: VERIFIED_AT });
    const runner = await user('runner', { isVerified: true, verifiedAt: VERIFIED_AT });
    await agent('shared', builder.id);
    await run(agents.shared, runner.id, AgentRunStatus.COMPLETED, T_FIRST);

    // A schedule/visitor run (no starting user) counts for the agent's creator.
    const scheduled = await user('scheduled', { isVerified: true, verifiedAt: VERIFIED_AT });
    await agent('scheduled', scheduled.id);
    await execution(agents.scheduled, null, AgentExecutionStatus.COMPLETED, T_FIRST);

    // Confirmed before verifiedAt existed: only the old flag is set.
    await user('legacyVerified', { isVerified: true, verifiedAt: null });
    // Mid email change (both flags reset) but signed in before.
    await user('changingEmail', { isVerified: false, verifiedAt: null, lastLoginAt: VERIFIED_AT });
    // Registered, never confirmed, never used.
    await user('neverConfirmed', { isVerified: false, verifiedAt: null });
    // Already claimed: kept as is.
    const preset = await user('preset', { isVerified: true, verifiedAt: VERIFIED_AT });
    await ds.query(`UPDATE "users" SET "signupEventAt" = $1, "firstRunEventAt" = $1 WHERE "id" = $2`, [PRESET_CLAIM, preset.id]);
    await agent('preset', preset.id);
    await run(agents.preset, preset.id, AgentRunStatus.COMPLETED, T_FIRST);

    // 3. The upgrade: every migration still pending.
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

  it('sets firstRunEventAt to the earliest completed run of an own agent, autonomous or workflow', async () => {
    expect((await row('ranOwn')).firstRunEventAt?.toISOString()).toBe(T_FIRST.toISOString());
    expect((await row('ranWorkflow')).firstRunEventAt?.toISOString()).toBe(T_FIRST.toISOString());
  });

  it('credits the user who started the run, else the agent creator', async () => {
    expect((await row('runner')).firstRunEventAt?.toISOString()).toBe(T_FIRST.toISOString());
    expect((await row('builder')).firstRunEventAt).toBeNull();
    expect((await row('scheduled')).firstRunEventAt?.toISOString()).toBe(T_FIRST.toISOString());
  });

  it('leaves firstRunEventAt NULL for sample-only, temporary-only and failed-only histories', async () => {
    expect((await row('sampleOnly')).firstRunEventAt).toBeNull();
    expect((await row('failedOnly')).firstRunEventAt).toBeNull();
  });

  it('sets signupEventAt for confirmed or used accounts, and only those', async () => {
    for (const key of ['ranOwn', 'ranWorkflow', 'sampleOnly', 'failedOnly', 'builder', 'runner', 'scheduled']) {
      expect((await row(key)).signupEventAt?.toISOString()).toBe(VERIFIED_AT.toISOString());
    }
    // No confirmation time on record: claimed as of the upgrade.
    expect((await row('legacyVerified')).signupEventAt).toBeInstanceOf(Date);
    expect((await row('changingEmail')).signupEventAt).toBeInstanceOf(Date);
    expect((await row('neverConfirmed')).signupEventAt).toBeNull();
  });

  it('keeps a claim that was already made', async () => {
    const preset = await row('preset');
    expect(preset.signupEventAt?.toISOString()).toBe(PRESET_CLAIM.toISOString());
    expect(preset.firstRunEventAt?.toISOString()).toBe(PRESET_CLAIM.toISOString());
  });

  it('sends nothing for a backfilled account: its next run, or its address confirmed again', async () => {
    await service.runSucceeded({ agentId: agents.ranOwn.id, userId: people.ranOwn.id });
    await service.runSucceeded({ agentId: agents.scheduled.id, userId: null });
    await service.signupCompleted(people.ranOwn.id);
    // An existing account confirming a changed address.
    await ds.getRepository(User).update({ id: people.changingEmail.id }, { isVerified: true, verifiedAt: new Date() });
    await service.signupCompleted(people.changingEmail.id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still reports an account created after the upgrade, once per event', async () => {
    const fresh = await user('fresh', { isVerified: true, verifiedAt: new Date() });
    const own = await agent('fresh', fresh.id);

    await service.signupCompleted(fresh.id);
    await service.signupCompleted(fresh.id);
    await service.runSucceeded({ agentId: own.id, userId: fresh.id });
    await service.runSucceeded({ agentId: own.id, userId: fresh.id });

    expect(events().map((e) => [e.event, e.distinct_id])).toEqual([
      [SIGNUP_COMPLETED_EVENT, fresh.id],
      [FIRST_RUN_SUCCEEDED_EVENT, fresh.id],
    ]);
  });
});
