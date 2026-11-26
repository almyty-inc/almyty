/**
 * The funnel events' once-only claim against real Postgres: the
 * conditional UPDATE in ProductAnalyticsService lets exactly one of many
 * simultaneous callers through (as several replicas would be), the claim
 * columns come from the migration, and an unverified account or a sample
 * agent claims nothing.
 *
 * Gated behind RUN_DB_INTEGRATION=1 like every spec in this folder.
 */
import { DataSource } from 'typeorm';

import { User } from '../../entities/user.entity';
import { Agent } from '../../entities/agent.entity';
import { Organization } from '../../entities/organization.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import {
  FIRST_RUN_SUCCEEDED_EVENT,
  ProductAnalyticsService,
  SIGNUP_COMPLETED_EVENT,
} from '../../modules/product-analytics/product-analytics.service';
import { ensureSchema } from './isolated-schema.helper';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'funnel_analytics_test';

jest.setTimeout(120_000);

describeIfDb('funnel analytics once-only claim (real Postgres)', () => {
  let ds: DataSource;
  let service: ProductAnalyticsService;
  let fetchMock: jest.Mock;
  const savedKey = process.env.POSTHOG_API_KEY;
  const savedFetch = global.fetch;

  beforeAll(async () => {
    await ensureSchema(SCHEMA);
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'password',
      database: process.env.DATABASE_NAME || 'almyty_test',
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public`, max: 20 },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      migrationsTransactionMode: 'each',
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();
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

  let seq = 0;
  async function seed(opts: { verified: boolean; agent?: Partial<Agent> }) {
    seq++;
    const org = await ds.getRepository(Organization).save(
      ds.getRepository(Organization).create({ name: `funnel-${seq}`, slug: `funnel-${seq}`, plan: 'pro', isActive: true }),
    );
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        email: `funnel-${seq}@example.com`,
        normalizedEmail: `funnel-${seq}@example.com`,
        passwordHash: 'x',
        firstName: 'F',
        lastName: 'A',
        isVerified: opts.verified,
        verifiedAt: opts.verified ? new Date() : null,
        signupAttribution: { utm_source: 'almyty.com', cta: 'hero' },
      }),
    );
    await ds.getRepository(UserOrganization).save(
      ds.getRepository(UserOrganization).create({
        userId: user.id,
        organizationId: org.id,
        role: OrganizationRole.OWNER,
        isActive: true,
        inviteAccepted: true,
      }),
    );
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        name: `agent-${seq}`,
        organizationId: org.id,
        createdBy: user.id,
        pipeline: { nodes: [], edges: [] } as any,
        ...opts.agent,
      }),
    );
    return { org, user, agent };
  }

  const events = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));

  it('sends signup_completed once when ten callers race for it', async () => {
    const { user, org } = await seed({ verified: true });

    await Promise.all(Array.from({ length: 10 }, () => service.signupCompleted(user.id)));
    await service.signupCompleted(user.id);

    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      event: SIGNUP_COMPLETED_EVENT,
      distinct_id: user.id,
      properties: { organization_id: org.id, plan: 'pro', signup_method: 'email', utm_source: 'almyty.com', cta: 'hero' },
    });
    const row = await ds.getRepository(User).findOneByOrFail({ id: user.id });
    expect(row.signupEventAt).toBeInstanceOf(Date);
  });

  it('claims nothing for an unverified account', async () => {
    const { user } = await seed({ verified: false });
    await service.signupCompleted(user.id);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await ds.getRepository(User).findOneByOrFail({ id: user.id })).signupEventAt).toBeNull();
  });

  it('sends first_run_succeeded once when ten completed runs race for it', async () => {
    const { user, agent } = await seed({ verified: true, agent: { mode: 'workflow' } });

    await Promise.all(Array.from({ length: 10 }, () => service.runSucceeded({ agentId: agent.id, userId: user.id })));
    await service.runSucceeded({ agentId: agent.id, userId: null });

    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      event: FIRST_RUN_SUCCEEDED_EVENT,
      distinct_id: user.id,
      properties: { agent_mode: 'workflow', plan: 'pro', utm_source: 'almyty.com' },
    });
  });

  it('claims nothing for a sample agent', async () => {
    const { user, agent } = await seed({ verified: true, agent: { metadata: { sampleWorkspace: true } } });
    await service.runSucceeded({ agentId: agent.id, userId: user.id });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await ds.getRepository(User).findOneByOrFail({ id: user.id })).firstRunEventAt).toBeNull();
  });
});
