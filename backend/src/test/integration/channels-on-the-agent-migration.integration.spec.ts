import { randomUUID } from 'crypto';
import { Client } from 'pg';

import { ChannelsOnTheAgent1750813742000 } from '../../migrations/1750813742000-ChannelsOnTheAgent';
import { moveAppsToChannels } from '../../migrations/support/channels-on-the-agent';

/**
 * The ChannelsOnTheAgent migration against a real Postgres.
 *
 * Runs the migration class itself (its DDL and its data move) on tables
 * with the columns and types production has: apps and their places as
 * the app era left them, the agents, gateways, credentials, builds and
 * runs they point at. Then reads back what an agent, its channels and
 * everything around them hold.
 */
const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeOrSkip('channels on the agent migration (real Postgres)', () => {
  const schema = 'channelsonagentmig';
  let db: Client;
  const queryRunner = {
    query: async (sql: string, params?: unknown[]) => (await db.query(sql, params as any[])).rows,
  };
  const migration = new ChannelsOnTheAgent1750813742000();
  const up = () => migration.up(queryRunner as any);

  const ORG = randomUUID();
  const OTHER_ORG = randomUUID();

  beforeAll(async () => {
    db = new Client({
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      user: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await db.connect();
    await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}, public`);
  }, 30_000);

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  });

  beforeEach(async () => {
    await db.query(
      'DROP TABLE IF EXISTS app_builds, agent_runs, agent_channels, agent_app_distributions, agent_apps, credentials, gateways, agents, organizations CASCADE',
    );
    await db.query(`CREATE TABLE organizations (id uuid PRIMARY KEY, name varchar NOT NULL)`);
    await db.query(`
      CREATE TABLE agents (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name varchar NOT NULL
      )`);
    await db.query(`
      CREATE TABLE gateways (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        name varchar NOT NULL,
        type varchar NOT NULL,
        endpoint varchar NOT NULL,
        configuration json
      )`);
    await db.query(`
      CREATE TABLE credentials (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        metadata json
      )`);
    await db.query(`
      CREATE TABLE agent_apps (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name varchar NOT NULL,
        slug varchar NOT NULL,
        description text,
        "agentIds" uuid[] NOT NULL DEFAULT '{}',
        branding json,
        "authMode" varchar NOT NULL DEFAULT 'public_link',
        capabilities json,
        limits json,
        privacy json,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await db.query(`
      CREATE TABLE agent_app_distributions (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "appId" uuid NOT NULL REFERENCES agent_apps(id) ON DELETE CASCADE,
        target varchar NOT NULL,
        status varchar NOT NULL DEFAULT 'draft',
        "gatewayId" uuid REFERENCES gateways(id) ON DELETE SET NULL,
        configuration json,
        "lastBuild" json,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("appId", target)
      )`);
    await db.query(`
      CREATE TABLE app_builds (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "appId" uuid NOT NULL REFERENCES agent_apps(id) ON DELETE CASCADE,
        target varchar NOT NULL,
        platform varchar NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await db.query(`
      CREATE TABLE agent_runs (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "agentId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "appId" uuid,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await db.query(`INSERT INTO organizations (id, name) VALUES ($1, 'Acme'), ($2, 'Other')`, [ORG, OTHER_ORG]);
  });

  const agent = async (name: string, org = ORG) =>
    (await db.query(`INSERT INTO agents ("organizationId", name) VALUES ($1, $2) RETURNING id`, [org, name])).rows[0].id as string;

  let clock = 0;
  const app = async (fields: {
    name: string;
    slug: string;
    agentIds: string[];
    branding?: any;
    authMode?: string;
    limits?: any;
    privacy?: any;
    capabilities?: any;
    org?: string;
  }) =>
    (
      await db.query(
        `INSERT INTO agent_apps ("organizationId", name, slug, "agentIds", branding, "authMode", limits, privacy, capabilities, "createdAt")
         VALUES ($1, $2, $3, $4::uuid[], $5::json, $6, $7::json, $8::json, $9::json, now() - ($10 || ' minutes')::interval) RETURNING id`,
        [
          fields.org ?? ORG,
          fields.name,
          fields.slug,
          fields.agentIds,
          fields.branding === undefined ? null : JSON.stringify(fields.branding),
          fields.authMode ?? 'public_link',
          fields.limits === undefined ? null : JSON.stringify(fields.limits),
          fields.privacy === undefined ? null : JSON.stringify(fields.privacy),
          fields.capabilities === undefined ? null : JSON.stringify(fields.capabilities),
          String(1000 - ++clock),
        ],
      )
    ).rows[0].id as string;

  const gateway = async (type: string, endpoint: string, configuration: any) =>
    (
      await db.query(`INSERT INTO gateways ("organizationId", name, type, endpoint, configuration) VALUES ($1, $2, $3, $4, $5::json) RETURNING id`, [
        ORG,
        `${type} gateway`,
        type,
        endpoint,
        JSON.stringify(configuration),
      ])
    ).rows[0].id as string;

  const place = async (appId: string, target: string, fields: { status?: string; gatewayId?: string | null; configuration?: any; org?: string } = {}) =>
    (
      await db.query(
        `INSERT INTO agent_app_distributions ("organizationId", "appId", target, status, "gatewayId", configuration)
         VALUES ($1, $2, $3, $4, $5, $6::json) RETURNING id`,
        [fields.org ?? ORG, appId, target, fields.status ?? 'draft', fields.gatewayId ?? null, JSON.stringify(fields.configuration ?? {})],
      )
    ).rows[0].id as string;

  const channel = async (id: string) => (await db.query(`SELECT *, configuration::jsonb AS configuration FROM agent_channels WHERE id = $1`, [id])).rows[0];
  const agentRow = async (id: string) =>
    (await db.query(`SELECT branding::jsonb AS branding, "visitorRules"::jsonb AS "visitorRules" FROM agents WHERE id = $1`, [id])).rows[0];

  it('moves each place onto the agent it answers with, with the same id, keeping what the medium needs', async () => {
    const support = await agent('Support agent');
    const acme = await app({
      name: 'Acme support',
      slug: 'acme-support',
      agentIds: [support],
      branding: { primaryColor: '#0f766e' },
      limits: { costCapCents: 50, perUserRateLimit: 60, perIpRateLimit: 120 },
      privacy: { retentionDays: 30 },
      capabilities: { shell: true, requireApprovalFor: ['shell'] },
    });
    const webGateway = await gateway('hosted_chat', '/apps/acme-support/web', {
      appId: acme,
      authMode: 'public_link',
      hostedChat: { slug: 'acme-help', authMode: 'public_link' },
    });
    const web = await place(acme, 'web', { status: 'live', gatewayId: webGateway });
    const slack = await place(acme, 'slack', {
      configuration: { client_id: '123.456', credentialId: 'c-1', credentialKeys: ['client_secret', 'signing_secret'], agentId: support },
    });
    const desktop = await place(acme, 'desktop', { status: 'built', configuration: { bundleId: 'com.acme.help' } });
    const credential = (
      await db.query(`INSERT INTO credentials ("organizationId", metadata) VALUES ($1, $2::json) RETURNING id`, [
        ORG,
        JSON.stringify({ managedBy: { kind: 'app_distribution', id: slack } }),
      ])
    ).rows[0].id;
    await db.query(`INSERT INTO app_builds ("organizationId", "appId", target, platform) VALUES ($1, $2, 'desktop', 'macos-arm64')`, [ORG, acme]);

    await up();

    expect(await channel(web)).toMatchObject({ agentId: support, organizationId: ORG, type: 'web', status: 'live', slug: 'acme-help', gatewayId: webGateway, configuration: {} });
    // configuration.agentId is gone: a channel has exactly one agent.
    expect(await channel(slack)).toMatchObject({
      agentId: support,
      type: 'slack',
      status: 'draft',
      slug: null,
      configuration: { client_id: '123.456', credentialId: 'c-1', credentialKeys: ['client_secret', 'signing_secret'] },
    });
    expect(await channel(desktop)).toMatchObject({
      type: 'desktop',
      status: 'built',
      slug: 'acme-support',
      configuration: { bundleId: 'com.acme.help', webChatChannelId: web, capabilities: { shell: true, requireApprovalFor: ['shell'] } },
    });

    // The app's settings are the agent's now, named after the app.
    expect(await agentRow(support)).toEqual({
      branding: { primaryColor: '#0f766e', appName: 'Acme support' },
      visitorRules: {
        authMode: 'public_link',
        limits: { costCapCents: 50, perUserRateLimit: 60, perIpRateLimit: 120 },
        privacy: { retentionDays: 30 },
      },
    });

    // The gateway names its channel instead of its app, at the same address.
    const gw = (await db.query(`SELECT endpoint, configuration::jsonb AS configuration FROM gateways WHERE id = $1`, [webGateway])).rows[0];
    expect(gw.endpoint).toBe('/apps/acme-support/web');
    expect(gw.configuration).toEqual({ channelId: web, authMode: 'public_link', hostedChat: { slug: 'acme-help', authMode: 'public_link' } });

    const cred = (await db.query(`SELECT metadata::jsonb AS metadata FROM credentials WHERE id = $1`, [credential])).rows[0];
    expect(cred.metadata.managedBy).toEqual({ kind: 'agent_channel', id: slack });

    const [build] = (await db.query(`SELECT "channelId", "agentId" FROM app_builds`)).rows;
    expect(build).toEqual({ channelId: desktop, agentId: support });

    // New columns exist where the code reads them.
    await db.query(`INSERT INTO agent_runs ("agentId", "organizationId", "channelId") VALUES ($1, $2, $3)`, [support, ORG, web]);
    await db.query(`INSERT INTO app_builds ("organizationId", target, platform, "channelId", "agentId") VALUES ($1, 'tui', 'linux-x64', $2, $3)`, [ORG, desktop, support]);
  });

  it("sends a place to the agent it names, else the app's first agent, and gives both the app's settings", async () => {
    const triage = await agent('Triage');
    const billing = await agent('Billing');
    const acme = await app({ name: 'Acme', slug: 'acme', agentIds: [triage, billing], branding: { greeting: 'Hi' } });
    const web = await place(acme, 'web');
    const email = await place(acme, 'email', { configuration: { agentId: billing, inbound_address: 'billing@acme.test' } });

    await up();

    expect((await channel(web)).agentId).toBe(triage);
    expect(await channel(email)).toMatchObject({ agentId: billing, configuration: { inbound_address: 'billing@acme.test' } });
    expect((await agentRow(triage)).branding).toEqual({ greeting: 'Hi', appName: 'Acme' });
    expect((await agentRow(billing)).branding).toEqual({ greeting: 'Hi', appName: 'Acme' });
  });

  it('keeps the first app on an agent two apps disagree about, and puts the later one on its own channels', async () => {
    const shared = await agent('Shared');
    const first = await app({ name: 'First', slug: 'first', agentIds: [shared], branding: { primaryColor: '#111111' } });
    const second = await app({ name: 'Second', slug: 'second', agentIds: [shared], branding: { primaryColor: '#222222' }, authMode: 'sso' });
    const firstWeb = await place(first, 'web');
    const secondWeb = await place(second, 'web');

    const result = await moveAppsToChannelsAfterDdl();

    expect(result.conflicts).toEqual([{ agentId: shared, keptAppId: first, conflictingAppId: second }]);
    expect(await agentRow(shared)).toMatchObject({
      branding: { primaryColor: '#111111', appName: 'First' },
      visitorRules: { authMode: 'public_link' },
    });
    const firstChannel = await channel(firstWeb);
    expect(firstChannel.branding).toBeNull();
    expect(firstChannel.visitorRules).toBeNull();
    // What visitors of the second app's chat saw is what they still see.
    const secondChannel = (await db.query(`SELECT branding::jsonb AS branding, "visitorRules"::jsonb AS "visitorRules" FROM agent_channels WHERE id = $1`, [secondWeb])).rows[0];
    expect(secondChannel).toEqual({
      branding: { primaryColor: '#222222', appName: 'Second' },
      visitorRules: { authMode: 'sso', limits: null, privacy: null },
    });
  });

  it('is not a conflict when two apps put the same settings on an agent', async () => {
    const shared = await agent('Shared');
    const a = await app({ name: 'Same', slug: 'same-a', agentIds: [shared], branding: { appName: 'Help' } });
    const b = await app({ name: 'Same', slug: 'same-b', agentIds: [shared], branding: { appName: 'Help' } });
    await place(a, 'slack');
    const other = await place(b, 'telegram');

    const result = await moveAppsToChannelsAfterDdl();

    expect(result.conflicts).toEqual([]);
    const row = (await db.query(`SELECT branding FROM agent_channels WHERE id = $1`, [other])).rows[0];
    expect(row.branding).toBeNull();
  });

  it('leaves settings an agent already has alone, and carries the app ones on its channels', async () => {
    const configured = await agent('Configured');
    await db.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS branding json, ADD COLUMN IF NOT EXISTS "visitorRules" json`);
    await db.query(`UPDATE agents SET branding = '{"appName":"Mine"}'::json WHERE id = $1`, [configured]);
    const acme = await app({ name: 'Acme', slug: 'acme', agentIds: [configured] });
    const web = await place(acme, 'web');

    const result = await moveAppsToChannelsAfterDdl();

    expect(result.conflicts).toEqual([{ agentId: configured, keptAppId: 'agent', conflictingAppId: acme }]);
    expect((await agentRow(configured)).branding).toEqual({ appName: 'Mine' });
    expect((await db.query(`SELECT branding::jsonb AS branding FROM agent_channels WHERE id = $1`, [web])).rows[0].branding).toEqual({ appName: 'Acme' });
  });

  it('gives an app with no places its settings on its first agent', async () => {
    const lonely = await agent('Lonely');
    await app({ name: 'Unshipped', slug: 'unshipped', agentIds: [lonely], branding: { greeting: 'Soon' } });
    await up();
    expect((await agentRow(lonely)).branding).toEqual({ greeting: 'Soon', appName: 'Unshipped' });
  });

  it('does not move a place with no agent in its organization, and keeps its rows', async () => {
    const theirs = await agent('Theirs', OTHER_ORG);
    const empty = await app({ name: 'Empty', slug: 'empty', agentIds: [] });
    const orphan = await place(empty, 'web');
    const mine = await agent('Mine');
    const pointing = await app({ name: 'Pointing', slug: 'pointing', agentIds: [mine] });
    // Names another organization's agent: not a fallback to the default, not moved.
    const crossOrg = await place(pointing, 'slack', { configuration: { agentId: theirs } });
    const garbage = await place(pointing, 'telegram', { configuration: { agentId: 'not-a-uuid' } });

    const result = await moveAppsToChannelsAfterDdl();

    expect(result.skipped.map((s: any) => s.placeId).sort()).toEqual([orphan, crossOrg, garbage].sort());
    expect((await db.query(`SELECT count(*)::int AS n FROM agent_channels`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM agent_app_distributions`)).rows[0].n).toBe(3);
    expect((await db.query(`SELECT count(*)::int AS n FROM agent_apps`)).rows[0].n).toBe(2);
  });

  it('runs twice without moving anything twice', async () => {
    const support = await agent('Support');
    const acme = await app({ name: 'Acme', slug: 'acme', agentIds: [support] });
    await place(acme, 'web');
    await up();
    const again = await moveAppsToChannels(queryRunner as any);
    expect(again.moved).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM agent_channels`)).rows[0].n).toBe(1);
  });

  it('down undoes the schema and puts the app references back', async () => {
    const support = await agent('Support');
    const acme = await app({ name: 'Acme', slug: 'acme', agentIds: [support] });
    const gw = await gateway('telegram', '/apps/acme/telegram', { appId: acme });
    const tg = await place(acme, 'telegram', { gatewayId: gw });
    await db.query(`INSERT INTO credentials ("organizationId", metadata) VALUES ($1, $2::json)`, [
      ORG,
      JSON.stringify({ managedBy: { kind: 'app_distribution', id: tg } }),
    ]);
    await up();

    await migration.down(queryRunner as any);

    expect((await db.query(`SELECT to_regclass('agent_channels') AS t`)).rows[0].t).toBeNull();
    const columns = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'agents'`, [schema])).rows.map(
      (r) => r.column_name,
    );
    expect(columns).not.toContain('branding');
    const gatewayConfig = (await db.query(`SELECT configuration::jsonb AS c FROM gateways WHERE id = $1`, [gw])).rows[0].c;
    expect(gatewayConfig).toEqual({ appId: acme });
    const cred = (await db.query(`SELECT metadata::jsonb AS m FROM credentials`)).rows[0].m;
    expect(cred.managedBy.kind).toBe('app_distribution');
  });

  /** The migration's DDL alone (its data move finds no apps), then the move itself, returning what it did. */
  async function moveAppsToChannelsAfterDdl() {
    await migration.up({
      query: async (sql: string, params?: unknown[]) =>
        /to_regclass\('agent_apps'\)/.test(sql) ? [] : (await db.query(sql, params as any[])).rows,
    } as any);
    return moveAppsToChannels(queryRunner as any);
  }
});
