import { Client } from 'pg';

import { EveryWidgetAndA2aHasAnApp1750812900000 } from '../../migrations/1750812900000-EveryWidgetAndA2aHasAnApp';
import { AppAuthMode, defaultLimitsFor } from '../../migrations/legacy/app-model';

/**
 * The EveryWidgetAndA2aHasAnApp migration against a real Postgres: every
 * website widget and A2A gateway no place pointed at ends up a place on
 * an app -- the agent's app when it has one -- and nothing else moves.
 */
const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

const ORG = '00000000-0000-4000-8000-000000000001';
const SUPPORT = '00000000-0000-4000-8000-0000000000a1';
const SALES = '00000000-0000-4000-8000-0000000000a3';

describeOrSkip('every widget and A2A gateway has an app migration (real Postgres)', () => {
  const schema = 'widgeta2aappmig';
  let db: Client;
  const migration = new EveryWidgetAndA2aHasAnApp1750812900000();
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
        endpoint varchar,
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
      `INSERT INTO agents (id, "organizationId", name, visibility) VALUES ($1, $2, 'Support Desk', 'org'), ($3, $2, 'Sales Bot', 'org')`,
      [SUPPORT, ORG, SALES],
    );
  });

  let clock = 0;
  const gateway = async (type: string, opts: { agentId?: string | null; status?: string; configuration?: any; endpoint?: string } = {}) => {
    const { rows } = await db.query(
      `INSERT INTO gateways ("organizationId", name, "type", status, configuration, "agentId", endpoint, "createdAt")
       VALUES ($1, $2, $3, $4, $5::json, $6, $7, now() + ($8 || ' seconds')::interval) RETURNING id`,
      [
        ORG,
        `${type} gateway`,
        type,
        opts.status ?? 'active',
        JSON.stringify(opts.configuration ?? {}),
        opts.agentId === undefined ? SUPPORT : opts.agentId,
        opts.endpoint ?? `/${type}-${clock}`,
        String(++clock),
      ],
    );
    return rows[0].id as string;
  };

  const agentApp = async (slug: string, agentIds: string[], places: Array<{ target: string; gatewayId?: string | null }> = []) => {
    const { rows } = await db.query(
      `INSERT INTO agent_apps (id, "organizationId", name, slug, "agentIds", "createdAt")
       VALUES (gen_random_uuid(), $1, $2, $2, $3::uuid[], now() + ($4 || ' seconds')::interval) RETURNING id`,
      [ORG, slug, agentIds, String(++clock)],
    );
    for (const place of places) {
      await db.query(
        `INSERT INTO agent_app_distributions (id, "organizationId", "appId", target, status, "gatewayId") VALUES (gen_random_uuid(), $1, $2, $3, 'live', $4)`,
        [ORG, rows[0].id, place.target, place.gatewayId ?? null],
      );
    }
    return rows[0].id as string;
  };

  const placeOf = async (gatewayId: string) =>
    (
      await db.query(
        `SELECT d.target, d.status, d.configuration, a.name, a.slug, a."agentIds", a."authMode", a.limits, a.branding, a.id AS "appId"
           FROM agent_app_distributions d JOIN agent_apps a ON a.id = d."appId"
          WHERE d."gatewayId" = $1`,
        [gatewayId],
      )
    ).rows;

  it('puts an agent\'s widget and A2A endpoint on the app it already has', async () => {
    const web = await gateway('hosted_chat');
    const existing = await agentApp('help', [SUPPORT], [{ target: 'web', gatewayId: web }]);
    const widget = await gateway('chat_widget', { configuration: { widget: { title: 'Ask us', primaryColor: '#FF00AA' } } });
    const a2a = await gateway('a2a', { status: 'inactive', endpoint: '/support-a2a' });

    await up();

    expect(await placeOf(widget)).toEqual([expect.objectContaining({ appId: existing, target: 'widget', status: 'live', configuration: {} })]);
    expect(await placeOf(a2a)).toEqual([expect.objectContaining({ appId: existing, target: 'a2a', status: 'draft' })]);
    // Joining an app never touches its look.
    expect((await placeOf(widget))[0].branding).toBeNull();
    const { rows } = await db.query(`SELECT id, endpoint, configuration FROM gateways WHERE id = ANY($1)`, [[widget, a2a]]);
    for (const row of rows) expect(row.configuration.appId).toBe(existing);
    // The A2A endpoint keeps its address, so callers holding its card still reach it.
    expect(rows.find((r) => r.id === a2a).endpoint).toBe('/support-a2a');
    expect((await db.query('SELECT count(*)::int AS n FROM agent_apps')).rows[0].n).toBe(1);
  });

  it('makes an app for an agent that has none, taking the widget look as its branding', async () => {
    const widget = await gateway('chat_widget', {
      agentId: SALES,
      configuration: { widget: { title: 'Talk to sales', primaryColor: '#FF00AA', greeting: 'Hi', theme: 'dark', position: 'bottom-left', onload: 'x' } },
    });

    await up();

    expect(await placeOf(widget)).toEqual([
      expect.objectContaining({
        target: 'widget',
        name: 'Sales Bot',
        slug: 'sales-bot',
        agentIds: [SALES],
        authMode: 'public_link',
        limits: defaultLimitsFor(AppAuthMode.PUBLIC_LINK),
        branding: { appName: 'Talk to sales', primaryColor: '#ff00aa', greeting: 'Hi', theme: 'dark' },
      }),
    ]);
  });

  it('does not join an app that already has that place, or one another agent answers', async () => {
    const otherWidget = await gateway('chat_widget');
    const full = await agentApp('full', [SUPPORT], [{ target: 'widget', gatewayId: otherWidget }]);
    const salesApp = await agentApp('sales', [SALES]);
    const widget = await gateway('chat_widget');

    await up();

    const [place] = await placeOf(widget);
    expect([full, salesApp]).not.toContain(place.appId);
    expect(place).toMatchObject({ slug: 'support-desk', agentIds: [SUPPORT] });
  });

  it('leaves web chats, channels, shared tools and ACP alone, and a second run changes nothing', async () => {
    const slack = await gateway('slack');
    const tools = await gateway('tools', { agentId: null });
    const acp = await gateway('acp');
    await gateway('chat_widget');
    await gateway('a2a');

    await up();
    const snapshot = async () =>
      (await db.query(`SELECT "appId", target, "gatewayId" FROM agent_app_distributions ORDER BY "gatewayId"`)).rows;
    const first = await snapshot();
    await up();

    expect(await snapshot()).toEqual(first);
    expect(first.map((r) => r.target).sort()).toEqual(['a2a', 'widget']);
    for (const id of [slack, tools, acp]) expect(await placeOf(id)).toEqual([]);
  });
});
