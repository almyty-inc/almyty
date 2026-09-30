/**
 * The unsaved-icon sweep reads uploads by `metadata ->> 'purpose'` and
 * their age: a JSON query no unit fake evaluates. This runs it on real
 * Postgres, through the migrations, so the column types it reads are the
 * ones production has.
 *
 * Gated behind RUN_DB_INTEGRATION=1 with the standard DATABASE_* env vars.
 */
import { DataSource } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { AgentFile } from '../../entities/file.entity';
import { FilesService } from '../../modules/files/files.service';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'unsaved_icon_sweep_test';

jest.setTimeout(120_000);

const connection = {
  type: 'postgres' as const,
  host: process.env.DATABASE_HOST || '127.0.0.1',
  port: Number(process.env.DATABASE_PORT || 5432),
  username: process.env.DATABASE_USERNAME || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'postgres',
  database: process.env.DATABASE_NAME || 'almyty_test',
};

describeIfDb('uploads found by purpose and age (real Postgres)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.destroy();
    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('returns the app icon uploads older than the cut-off, and nothing else', async () => {
    const org = await ds.getRepository(Organization).save(
      ds.getRepository(Organization).create({ name: 'icons', slug: `icons-${Date.now()}`, plan: 'free', isActive: true } as Partial<Organization>),
    );
    const files = ds.getRepository(AgentFile);
    const row = async (name: string, metadata: Record<string, unknown> | null, hoursAgo: number) => {
      const saved = await files.save(files.create({ organizationId: org.id, name, mimeType: 'image/png', size: 1, storageKey: `${org.id}/${name}`, metadata } as Partial<AgentFile>));
      await ds.query(`UPDATE "${SCHEMA}"."files" SET "createdAt" = now() - ($1 || ' hours')::interval WHERE id = $2`, [String(hoursAgo), saved.id]);
      return saved.id;
    };
    const stale = await row('stale.png', { purpose: 'app_icon' }, 30);
    await row('fresh.png', { purpose: 'app_icon' }, 2);
    await row('report.png', null, 90);
    await row('other.png', { purpose: 'something_else' }, 90);

    const service = new FilesService(files, {} as any, {} as any, { log: jest.fn() } as any);
    const found = await service.findForPurposeBefore('app_icon', new Date(Date.now() - 24 * 60 * 60 * 1000));

    expect(found.map((f) => f.id)).toEqual([stale]);
  });

  it('keeps why a provider connection is inactive', async () => {
    const [column] = await ds.query(
      `SELECT data_type, character_maximum_length FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'llm_providers' AND column_name = 'inactiveReason'`,
      [SCHEMA],
    );
    expect(column).toMatchObject({ data_type: 'character varying', character_maximum_length: 32 });
  });
});
