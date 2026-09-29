import { Client } from 'pg';

import { EveryChatSurfaceHasAnApp1750812800000 } from '../../migrations/1750812800000-EveryChatSurfaceHasAnApp';
import { AppAuthMode } from '../../entities/agent-app.entity';
import { defaultLimitsFor } from '../../modules/agent-apps/agent-app.rules';
import { APP_SURFACE_GATEWAY_TYPES } from '../../modules/gateways/app-surface';

/**
 * The EveryChatSurfaceHasAnApp migration against a real Postgres: every web
 * chat and messaging gateway no app place pointed at ends up on an app,
 * built the way AgentAppsService.create builds one, and nothing else moves.
 */
const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000002';
const SUPPORT = '00000000-0000-4000-8000-0000000000a1';
const SECRET_AGENT = '00000000-0000-4000-8000-0000000000a2';

describeOrSkip('every chat surface has an app migration (real Postgres)', () => {
  const schema = 'chatsurfaceappmig';
  let db: Client;
  const migration = new EveryChatSurfaceHasAnApp1750812800000();
  const up = () => migration.up({ query: async (sql: string, params?: any[]) => (await db.query(sql, params)).rows } as any);

  beforeAll(async () => {
    db = new Client({
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      user: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await db.connect();
    await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await db.query(`SET search_path TO ${schema}, public`);
  }, 30_000);

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  });

  beforeEach(async () => {
    await db.query('DROP TABLE IF EXISTS agent_app_distributions, agent_apps, gateways, agents');
    await db.query(`
      CREATE TABLE agents (
        id uuid PRIMARY KEY,
        "organizationId" uuid NOT NULL,
        name varchar NOT NULL,
        visibility varchar(8) NOT NULL DEFAULT 'org'
      )`);
    await db.query(`
      CREATE TABLE gateways (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" uuid NOT NULL,
        name varchar NOT NULL,
        description text,
        "agentId" uuid,
        status varchar NOT NULL DEFAULT 'active',
        "type" varchar NOT NULL,
        configuration json,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )`);
    await db.query(`
      CREATE TABLE agent_apps (
        id uuid PRIMARY KEY,
        "organizationId" uuid NOT NULL,
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
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("organizationId", slug)
      )`);
    await db.query(`
      CREATE TABLE agent_app_distributions (
        id uuid PRIMARY KEY,
        "organizationId" uuid NOT NULL,
        "appId" uuid NOT NULL REFERENCES agent_apps(id) ON DELETE CASCADE,
        target varchar NOT NULL,
        status varchar NOT NULL DEFAULT 'draft',
        "gatewayId" uuid REFERENCES gateways(id) ON DELETE SET NULL,
        configuration json,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("appId", target)
      )`);
    await db.query(
      `INSERT INTO agents (id, "organizationId", name, visibility) VALUES ($1, $2, 'Support Desk', 'org'), ($3, $2, 'Just Me', 'private')`,
      [SUPPORT, ORG, SECRET_AGENT],
    );
  });

  let clock = 0;
  const gateway = async (type: string, opts: { org?: string; agentId?: string | null; status?: string; configuration?: any; name?: string } = {}) => {
    const { rows } = await db.query(
      `INSERT INTO gateways ("organizationId", name, "type", status, configuration, "agentId", "createdAt")
       VALUES ($1, $2, $3, $4, $5::json, $6, now() + ($7 || ' seconds')::interval) RETURNING id`,
      [
        opts.org ?? ORG,
        opts.name ?? `${type} gateway`,
        type,
        opts.status ?? 'active',
        JSON.stringify(opts.configuration ?? {}),
        opts.agentId === undefined ? SUPPORT : opts.agentId,
        String(++clock),
      ],
    );
    return rows[0].id as string;
  };

  const app = async (slug: string, org = ORG) => {
    const { rows } = await db.query(
      `INSERT INTO agent_apps (id, "organizationId", name, slug) VALUES (gen_random_uuid(), $1, $2, $2) RETURNING id`,
      [org, slug],
    );
    return rows[0].id as string;
  };

  const placeOf = async (gatewayId: string) =>
    (
      await db.query(
        `SELECT d.target, d.status, d.configuration, a.name, a.slug, a."agentIds", a."authMode", a.limits, a.branding,
                a.capabilities, a.privacy, a."isActive", a."organizationId", a.id AS "appId"
           FROM agent_app_distributions d JOIN agent_apps a ON a.id = d."appId"
          WHERE d."gatewayId" = $1`,
        [gatewayId],
      )
    ).rows;

  it('wraps an agent\'s web chat and channels in one app named after the agent', async () => {
    const slack = await gateway('slack', { configuration: { credentialId: 'cred-slack', credentialKeys: ['bot_token', 'signing_secret'] } });
    const telegram = await gateway('telegram', { status: 'inactive' });
    const web = await gateway('hosted_chat', { configuration: { hostedChat: { slug: 'help', authMode: 'email_otp' } } });

    await up();

    const [webPlace] = await placeOf(web);
    expect(webPlace).toMatchObject({
      target: 'web',
      status: 'live',
      configuration: {},
      name: 'Support Desk',
      // The web chat's address, which its app's slug is.
      slug: 'help',
      agentIds: [SUPPORT],
      authMode: 'email_otp',
      limits: defaultLimitsFor(AppAuthMode.EMAIL_OTP),
      branding: {},
      capabilities: {},
      privacy: null,
      isActive: true,
      organizationId: ORG,
    });
    const [slackPlace] = await placeOf(slack);
    expect(slackPlace).toMatchObject({
      appId: webPlace.appId,
      target: 'slack',
      status: 'live',
      configuration: { credentialId: 'cred-slack', credentialKeys: ['bot_token', 'signing_secret'] },
    });
    const [telegramPlace] = await placeOf(telegram);
    expect(telegramPlace).toMatchObject({ appId: webPlace.appId, target: 'telegram', status: 'draft' });

    const { rows: gateways } = await db.query(`SELECT id, configuration FROM gateways ORDER BY "createdAt"`);
    for (const g of gateways) expect(g.configuration.appId).toBe(webPlace.appId);
    // The web chat keeps its address and sign-in rule.
    expect(gateways.find((g) => g.id === web).configuration.hostedChat).toEqual({ slug: 'help', authMode: 'email_otp' });
    expect((await db.query('SELECT count(*)::int AS n FROM agent_apps')).rows[0].n).toBe(1);
  });

  it('gives a second gateway of the same agent on the same platform an app of its own, with a free slug', async () => {
    await app('support-desk');
    const first = await gateway('slack');
    const second = await gateway('slack');

    await up();

    const [a] = await placeOf(first);
    const [b] = await placeOf(second);
    expect(a.appId).not.toBe(b.appId);
    expect([a.slug, b.slug]).toEqual(['support-desk-2', 'support-desk-3']);
    expect([a.name, b.name]).toEqual(['Support Desk', 'Support Desk']);
  });

  it('keeps secret values off the place and only carries the platform settings', async () => {
    const sms = await gateway('sms', {
      configuration: {
        credentialId: 'cred-sms',
        credentialKeys: ['twilio_auth_token'],
        twilio_auth_token: 'encrypted:gcm:not-moved-yet',
        twilio_account_sid: 'AC123',
        phone_number: '+15550100',
        aiDisclosure: true,
      },
    });

    await up();

    const [place] = await placeOf(sms);
    expect(place.configuration).toEqual({
      credentialId: 'cred-sms',
      credentialKeys: ['twilio_auth_token'],
      twilio_account_sid: 'AC123',
      phone_number: '+15550100',
    });
  });

  it('puts no private agent on an app, and names the app after it all the same', async () => {
    const mine = await gateway('discord', { agentId: SECRET_AGENT });
    const orphanAgent = await gateway('matrix', { agentId: null, name: 'Old Matrix Bridge' });

    await up();

    expect(await placeOf(mine)).toEqual([expect.objectContaining({ name: 'Just Me', slug: 'just-me', agentIds: [] })]);
    expect(await placeOf(orphanAgent)).toEqual([expect.objectContaining({ name: 'Old Matrix Bridge', slug: 'old-matrix-bridge', agentIds: [] })]);
  });

  it('leaves gateways that already have an app, and gateways no app place stands up, alone', async () => {
    const owned = await gateway('slack', { configuration: { appId: 'kept' } });
    const existingApp = await app('acme');
    await db.query(
      `INSERT INTO agent_app_distributions (id, "organizationId", "appId", target, status, "gatewayId") VALUES (gen_random_uuid(), $1, $2, 'slack', 'live', $3)`,
      [ORG, existingApp, owned],
    );
    const tools = await gateway('tools', { agentId: null });
    const widget = await gateway('chat_widget');
    const elsewhere = await gateway('email', { org: OTHER_ORG, agentId: null, name: 'Inbox' });

    await up();

    expect((await placeOf(owned)).map((p) => p.appId)).toEqual([existingApp]);
    expect(await placeOf(tools)).toEqual([]);
    expect(await placeOf(widget)).toEqual([]);
    expect(await placeOf(elsewhere)).toEqual([expect.objectContaining({ organizationId: OTHER_ORG, slug: 'inbox' })]);
    const { rows } = await db.query(`SELECT id, configuration FROM gateways WHERE id = ANY($1)`, [[owned, tools, widget]]);
    for (const row of rows) expect(row.configuration.appId === undefined || row.configuration.appId === 'kept').toBe(true);
  });

  it('leaves no web chat or channel without an app, and a second run changes nothing', async () => {
    for (const type of APP_SURFACE_GATEWAY_TYPES) await gateway(type);

    await up();
    const snapshot = async () =>
      (await db.query(`SELECT "appId", target, "gatewayId" FROM agent_app_distributions ORDER BY "gatewayId"`)).rows;
    const first = await snapshot();
    await up();

    expect(await snapshot()).toEqual(first);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM gateways g
        WHERE g."type" = ANY($1) AND NOT EXISTS (SELECT 1 FROM agent_app_distributions d WHERE d."gatewayId" = g.id)`,
      [[...APP_SURFACE_GATEWAY_TYPES]],
    );
    expect(rows[0].n).toBe(0);
    // One agent, one app per platform: fourteen places on one app.
    expect((await db.query('SELECT count(*)::int AS n FROM agent_apps')).rows[0].n).toBe(1);
    expect(first).toHaveLength(APP_SURFACE_GATEWAY_TYPES.size);
  });
});
