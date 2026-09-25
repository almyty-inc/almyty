import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

import { hostedChatBlockFor, hostedChatConfigFrom, HOSTED_CHAT_DEFAULTS } from '../../modules/gateways/channels/hosted-chat.config';

/**
 * The AppOwnsBranding migration against a real Postgres.
 *
 * Runs the migration's ACTUAL statements, read out of the file rather than
 * retyped, on tables whose columns have the real types (`json` config and
 * branding, a `timestamp` gateway clock next to a `timestamptz` app
 * clock). What moved is then read back through hostedChatBlockFor, the
 * function the public hosted chat answers with, so "reads branding from
 * the app only" is checked against the code that serves the page.
 */
const FILE = '1750812600000-AppOwnsBranding.ts';

function statements(which: 'up' | 'down'): string[] {
  const src = readFileSync(join(__dirname, '..', '..', 'migrations', FILE), 'utf8');
  const body = which === 'up'
    ? src.slice(src.indexOf('public async up'), src.indexOf('public async down'))
    : src.slice(src.indexOf('public async down'));
  const queries = [...body.matchAll(/await queryRunner\.query\(`\n([\s\S]*?)\n    `\)/g)].map((m) => m[1]);
  if (queries.length === 0) throw new Error(`no statements found in ${FILE} ${which}()`);
  return queries;
}

const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000002';
const AGENT = '00000000-0000-4000-8000-0000000000a1';

describeOrSkip('app owns branding migration (real Postgres)', () => {
  const schema = 'appbrandingmig';
  let db: Client;
  const run = async (which: 'up' | 'down') => {
    for (const q of statements(which)) await db.query(q);
  };

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
    await db.query('DROP TABLE IF EXISTS agent_app_distributions, agent_apps, gateways');
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
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" uuid NOT NULL,
        "appId" uuid NOT NULL REFERENCES agent_apps(id) ON DELETE CASCADE,
        target varchar NOT NULL,
        status varchar NOT NULL DEFAULT 'draft',
        "gatewayId" uuid REFERENCES gateways(id) ON DELETE SET NULL,
        configuration json,
        "lastBuild" json,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
  });

  const gateway = async (opts: {
    org?: string;
    name?: string;
    type?: string;
    status?: string;
    configuration: Record<string, any>;
    updatedAt?: string;
    agentId?: string | null;
  }) => {
    const { rows } = await db.query(
      `INSERT INTO gateways ("organizationId", name, "type", status, configuration, "agentId", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::json, $6, $7) RETURNING id`,
      [
        opts.org ?? ORG,
        opts.name ?? 'Support chat',
        opts.type ?? 'hosted_chat',
        opts.status ?? 'active',
        JSON.stringify(opts.configuration),
        opts.agentId === undefined ? AGENT : opts.agentId,
        opts.updatedAt ?? '2026-01-01T00:00:00Z',
      ],
    );
    return rows[0].id as string;
  };

  const app = async (opts: { slug: string; branding?: Record<string, any>; updatedAt?: string; org?: string }) => {
    const { rows } = await db.query(
      `INSERT INTO agent_apps ("organizationId", name, slug, "agentIds", branding, "updatedAt")
       VALUES ($1, $2, $3, ARRAY[$4::uuid], $5::json, $6) RETURNING id`,
      [opts.org ?? ORG, `App ${opts.slug}`, opts.slug, AGENT, JSON.stringify(opts.branding ?? {}), opts.updatedAt ?? '2026-01-01T00:00:00Z'],
    );
    return rows[0].id as string;
  };

  const place = async (appId: string, gatewayId: string, target = 'web') =>
    db.query(
      `INSERT INTO agent_app_distributions ("organizationId", "appId", target, status, "gatewayId", configuration)
       VALUES ($1, $2, $3, 'live', $4, '{}'::json)`,
      [ORG, appId, target, gatewayId],
    );

  const gatewayConfig = async (id: string) =>
    (await db.query('SELECT configuration FROM gateways WHERE id = $1', [id])).rows[0].configuration;
  const appOf = async (gatewayId: string) =>
    (
      await db.query(
        `SELECT a.*, array_to_json(a."agentIds") AS "agentIdList", d.target, d.status AS "placeStatus"
           FROM agent_app_distributions d JOIN agent_apps a ON a.id = d."appId"
          WHERE d."gatewayId" = $1`,
        [gatewayId],
      )
    ).rows;

  /** What the public page would show for this gateway: the served code path. */
  const served = async (gatewayId: string) => {
    const [owner] = await appOf(gatewayId);
    const config = await gatewayConfig(gatewayId);
    return hostedChatConfigFrom({ ...config, hostedChat: hostedChatBlockFor(owner ?? null, config.hostedChat) });
  };

  const gatewayBranding = {
    appName: 'Acme help',
    primaryColor: '#0f766e',
    greeting: 'Hi there',
    theme: 'dark',
    suggestedPrompts: ['Track my order'],
    aiDisclosure: 'You are talking to a bot.',
  };

  it('moves an app-managed hosted chat edited after publish onto the app, and off the gateway', async () => {
    const appId = await app({ slug: 'acme', branding: { appName: 'Old name', primaryColor: '#111111', logoUrl: 'https://x/logo.png' }, updatedAt: '2026-01-01T00:00:00Z' });
    const gw = await gateway({
      configuration: { hostedChat: { slug: 'acme', authMode: 'public_link', ...gatewayBranding }, branding: { appName: 'stale copy' }, bot: 'kept' },
      updatedAt: '2026-03-01T00:00:00Z',
    });
    await place(appId, gw);

    await run('up');

    const [owner] = await appOf(gw);
    // The newer gateway edit wins field by field; what only the app had stays.
    expect(owner.branding).toEqual({ ...gatewayBranding, logoUrl: 'https://x/logo.png' });

    const config = await gatewayConfig(gw);
    expect(config.branding).toBeUndefined();
    expect(config.hostedChat).toEqual({ slug: 'acme', authMode: 'public_link' });
    expect(config.bot).toBe('kept');

    const page = await served(gw);
    expect(page).toMatchObject({ slug: 'acme', ...gatewayBranding });
  });

  it('keeps the app copy when the app was saved after the gateway', async () => {
    const appId = await app({ slug: 'newer', branding: { appName: 'App wins', primaryColor: '#222222' }, updatedAt: '2026-06-01T00:00:00Z' });
    const gw = await gateway({ configuration: { hostedChat: { slug: 'newer', appName: 'Gateway loses', greeting: 'Only here' } }, updatedAt: '2026-02-01T00:00:00Z' });
    await place(appId, gw);

    await run('up');

    const [owner] = await appOf(gw);
    expect(owner.branding).toEqual({ appName: 'App wins', primaryColor: '#222222', greeting: 'Only here' });
    expect((await served(gw)).appName).toBe('App wins');
  });

  it('gives a hosted chat no app owns an app of its own, live, answering with its agent', async () => {
    const gw = await gateway({
      name: 'Standalone',
      configuration: {
        hostedChat: { slug: 'solo', authMode: 'email_otp', visitorMemory: true, ...gatewayBranding },
      },
    });

    await run('up');

    const rows = await appOf(gw);
    expect(rows).toHaveLength(1);
    const [owner] = rows;
    expect(owner).toMatchObject({
      slug: 'solo',
      name: 'Acme help',
      authMode: 'email_otp',
      target: 'web',
      placeStatus: 'live',
      organizationId: ORG,
    });
    expect(owner.agentIdList).toEqual([AGENT]);
    expect(owner.privacy).toEqual({ visitorMemory: true });
    expect(owner.branding).toEqual(gatewayBranding);

    expect((await gatewayConfig(gw)).hostedChat).toEqual({ slug: 'solo', authMode: 'email_otp', visitorMemory: true });
    expect(await served(gw)).toMatchObject({ slug: 'solo', authMode: 'email_otp', visitorMemory: true, ...gatewayBranding });
  });

  it('does not take a slug the organization already uses for another app, and keeps a draft for an inactive surface', async () => {
    await app({ slug: 'taken' });
    const gw = await gateway({ status: 'inactive', configuration: { hostedChat: { slug: 'taken' } } });
    // Another organization's app of the same name is not a collision.
    await app({ slug: 'elsewhere', org: OTHER_ORG });
    const other = await gateway({ configuration: { hostedChat: { slug: 'elsewhere' } } });

    await run('up');

    const [owner] = await appOf(gw);
    expect(owner.slug).toBe(`taken-${gw.slice(0, 8)}`);
    expect(owner.placeStatus).toBe('draft');
    expect((await appOf(other))[0].slug).toBe('elsewhere');
  });

  it('with nothing to move, the page shows the defaults, not a leftover gateway copy', async () => {
    const gw = await gateway({ configuration: { hostedChat: { slug: 'bare' } }, agentId: null });
    await run('up');
    const [owner] = await appOf(gw);
    expect(owner.agentIdList).toEqual([]);
    const page = await served(gw);
    expect(page.primaryColor).toBe(HOSTED_CHAT_DEFAULTS.primaryColor);
    expect(page.appName).toBe('Support chat');
  });

  it('leaves non hosted chat gateways alone, except for the stale branding copy', async () => {
    const appId = await app({ slug: 'slacky', branding: { appName: 'Slacky' } });
    const slack = await gateway({ type: 'slack', configuration: { bot_token: 'x', branding: { appName: 'copy' } } });
    await place(appId, slack, 'slack');
    const mcp = await gateway({ type: 'mcp', configuration: { hostedChat: { appName: 'not a chat' } } });

    await run('up');

    expect(await gatewayConfig(slack)).toEqual({ bot_token: 'x' });
    expect(await gatewayConfig(mcp)).toEqual({ hostedChat: { appName: 'not a chat' } });
    expect(await appOf(mcp)).toEqual([]);
    expect((await db.query('SELECT branding FROM agent_apps WHERE id = $1', [appId])).rows[0].branding).toEqual({ appName: 'Slacky' });
  });

  it('is idempotent', async () => {
    const appId = await app({ slug: 'twice' });
    const gw = await gateway({ configuration: { hostedChat: { slug: 'twice', ...gatewayBranding } }, updatedAt: '2026-05-01T00:00:00Z' });
    await place(appId, gw);
    await gateway({ configuration: { hostedChat: { slug: 'orphan', appName: 'Orphan' } } });

    await run('up');
    const apps = (await db.query('SELECT id, slug, branding FROM agent_apps ORDER BY slug')).rows;
    const gateways = (await db.query('SELECT id, configuration FROM gateways ORDER BY id')).rows;
    await run('up');
    expect((await db.query('SELECT id, slug, branding FROM agent_apps ORDER BY slug')).rows).toEqual(apps);
    expect((await db.query('SELECT id, configuration FROM gateways ORDER BY id')).rows).toEqual(gateways);
  });

  it('down puts the app branding back on its hosted chat', async () => {
    const appId = await app({ slug: 'back', branding: { appName: 'Back', primaryColor: '#333333' } });
    const gw = await gateway({ configuration: { hostedChat: { slug: 'back' } } });
    await place(appId, gw);
    await run('up');
    await run('down');
    expect((await gatewayConfig(gw)).hostedChat).toEqual({ slug: 'back', appName: 'Back', primaryColor: '#333333' });
  });
});
