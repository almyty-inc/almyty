import { readdirSync } from 'fs';
import { join } from 'path';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';

import { UniqueAgentNames1791001200000 } from '../../migrations/1791001200000-UniqueAgentNames';
import { provisionExtensionsInPublic } from './test-db-extensions';

/**
 * UniqueAgentNames puts a unique index on (organization, name) for agents.
 * Organizations that already hold same-named agents must not abort the
 * deploy: the oldest keeps its name, the others get the first free " (n)".
 * Runs the real migration chain up to it against Postgres.
 */
const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

const TARGET = '1791001200000';
type MigrationClass = new () => unknown;

function migrationsBefore(timestamp: string): MigrationClass[] {
  const dir = join(__dirname, '..', '..', 'migrations');
  return readdirSync(dir)
    .filter((f) => /^\d+-.*\.ts$/.test(f) && !f.endsWith('.spec.ts') && f.split('-')[0] < timestamp)
    .sort()
    .flatMap((f) => Object.values(require(join(dir, f))).filter((v): v is MigrationClass => typeof v === 'function'));
}

async function migratedUpTo(schema: string): Promise<DataSource> {
  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };
  const bootstrap = new DataSource(connection);
  await bootstrap.initialize();
  await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  await provisionExtensionsInPublic((sql, params) => bootstrap.query(sql, params as any[]));
  await bootstrap.destroy();

  const ds = new DataSource({
    ...connection,
    schema,
    extra: { options: `-c search_path=${schema},public` },
    migrations: migrationsBefore(TARGET),
    migrationsTransactionMode: 'each',
    logging: false,
  });
  await ds.initialize();
  await ds.runMigrations();
  return ds;
}

async function runTarget(ds: DataSource): Promise<void> {
  const runner = ds.createQueryRunner();
  await runner.startTransaction();
  try {
    await new UniqueAgentNames1791001200000().up(runner);
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

describeOrSkip('UniqueAgentNames with existing same-named agents (real Postgres)', () => {
  let ds: DataSource;
  let org: string;
  let other: string;

  const addOrg = async (slug: string) => {
    const id = crypto.randomUUID();
    await ds.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)`, [id, slug]);
    return id;
  };
  const addAgent = async (organizationId: string, name: string, createdAt: string) => {
    const [row] = await ds.query(
      `INSERT INTO agents (name, "organizationId", "createdAt", pipeline) VALUES ($1, $2, $3, '{"nodes":[],"edges":[]}') RETURNING id`,
      [name, organizationId, createdAt],
    );
    return row.id as string;
  };
  const nameOf = async (id: string) => (await ds.query(`SELECT name FROM agents WHERE id = $1`, [id]))[0].name;

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ds = await migratedUpTo('unique_agent_names');
    org = await addOrg('names-a');
    other = await addOrg('names-b');
    // Three "Invoices" (one differs only in case and spaces), and an agent
    // already called "Invoices (2)", so the second copy has to skip to (3).
    ids.oldest = await addAgent(org, 'Invoices', '2026-01-01T00:00:00Z');
    ids.second = await addAgent(org, ' invoices ', '2026-02-01T00:00:00Z');
    ids.third = await addAgent(org, 'Invoices', '2026-03-01T00:00:00Z');
    ids.taken = await addAgent(org, 'Invoices (2)', '2026-01-15T00:00:00Z');
    ids.unique = await addAgent(org, 'Support', '2026-01-01T00:00:00Z');
    // The same name in another organization is not a clash.
    ids.elsewhere = await addAgent(other, 'Invoices', '2026-04-01T00:00:00Z');
    await runTarget(ds);
  }, 120_000);

  afterAll(async () => {
    await ds?.destroy();
  });

  it('keeps the oldest name and gives the others the first free suffix, oldest first', async () => {
    expect(await nameOf(ids.oldest)).toBe('Invoices');
    expect(await nameOf(ids.taken)).toBe('Invoices (2)');
    expect(await nameOf(ids.second)).toBe('invoices (3)');
    expect(await nameOf(ids.third)).toBe('Invoices (4)');
    expect(await nameOf(ids.unique)).toBe('Support');
    expect(await nameOf(ids.elsewhere)).toBe('Invoices');
  });

  it('refuses a new agent with a name the organization already has', async () => {
    await expect(addAgent(org, 'SUPPORT ', '2026-05-01T00:00:00Z')).rejects.toThrow(/IDX_agents_org_name_unique/);
    await expect(addAgent(other, 'Support', '2026-05-01T00:00:00Z')).resolves.toBeTruthy();
  });
});
