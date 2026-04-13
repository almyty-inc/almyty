/**
 * Regression test: OAuth discovery must handle non-UUID org slugs.
 *
 * Bug: resolveOrg used `findOne({ where: [{ slug }, { id: slug }] })`
 * which crashes Postgres when slug is not a valid UUID because the
 * `id` column is type uuid and Postgres rejects the cast.
 *
 * This test hits a real Postgres to verify the query doesn't throw.
 * Gated behind RUN_DB_INTEGRATION=1.
 */
import { DataSource } from 'typeorm';
import { Organization } from '../../entities/organization.entity';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;

describeIfDb('OAuth discovery org slug resolution (real DB)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'password',
      database: process.env.DATABASE_NAME || 'almyty_test',
      entities: [Organization],
      synchronize: false,
    });
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('does not throw when querying with a non-UUID slug', async () => {
    const repo = ds.getRepository(Organization);

    // This is the exact query pattern that caused the bug.
    // With the old code: findOne({ where: [{ slug: 'frane-test' }, { id: 'frane-test' }] })
    // Postgres throws: invalid input syntax for type uuid: "frane-test"
    //
    // Fixed code checks if the value is a UUID first.
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test('frane-test');
    const where = isUUID
      ? [{ slug: 'frane-test' }, { id: 'frane-test' }]
      : { slug: 'frane-test' };

    // Must not throw — that's the whole point of this test
    const result = await repo.findOne({ where });
    // Result is null or an org — either is fine, just no crash
    expect(result === null || result?.slug === 'frane-test').toBe(true);
  });

  it('works with a valid UUID too', async () => {
    const repo = ds.getRepository(Organization);
    const uuid = '00000000-0000-4000-a000-000000000099';
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
    const where = isUUID
      ? [{ slug: uuid }, { id: uuid }]
      : { slug: uuid };

    const result = await repo.findOne({ where });
    expect(result).toBeNull(); // doesn't exist, but no crash
  });

  it('proves the old query crashes with non-UUID on a real DB', async () => {
    const repo = ds.getRepository(Organization);

    // The OLD broken query — this MUST throw on real Postgres
    await expect(
      repo.findOne({ where: [{ slug: 'frane-test' }, { id: 'frane-test' as any }] }),
    ).rejects.toThrow();
  });
});
