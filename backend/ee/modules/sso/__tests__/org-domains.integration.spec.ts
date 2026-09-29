import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Organization } from '../../../../src/entities/organization.entity';
import { OrgDomain } from '../../../../src/entities/org-domain.entity';
import { OrgDomainService } from '../org-domain.service';

/**
 * Organization domains against a real, migrated Postgres: the migration's
 * partial unique index is what keeps a verified domain to one
 * organization, while any number may hold it pending.
 */
const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const SCHEMA = 'org_domains_it';

jest.setTimeout(120_000);

describeOrSkip('OrgDomainService (real Postgres, migrated schema)', () => {
  let ds: DataSource;
  let service: OrgDomainService;
  let published: string[];
  let orgA: string;
  let orgB: string;

  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };

  beforeAll(async () => {
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.destroy();

    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../../../src/migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
      entities: [__dirname + '/../../../../src/entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();
    const orgs = ds.getRepository(Organization);
    orgA = (await orgs.save(orgs.create({ name: 'Domain A', slug: 'domain-a', plan: 'free', isActive: true } as any)) as any).id;
    orgB = (await orgs.save(orgs.create({ name: 'Domain B', slug: 'domain-b', plan: 'free', isActive: true } as any)) as any).id;

    published = [];
    service = new OrgDomainService(ds.getRepository(OrgDomain), async () => published.map((value) => [value]));
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await ds.destroy();
    }
  });

  it('lets two organizations claim a domain, and only one verify it', async () => {
    const a = await service.add(orgA, 'acme.test');
    const b = await service.add(orgB, 'acme.test');
    // Both proofs are in the zone: the unique index, not DNS, decides.
    published.push(a.record.value, b.record.value);

    expect(await service.verify(orgA, a.id)).toMatchObject({ status: 'verified' });
    await expect(service.verify(orgB, b.id)).rejects.toBeInstanceOf(ConflictException);

    expect(await service.coversEmail(orgA, 'ada@acme.test')).toBe(true);
    expect(await service.coversEmail(orgB, 'ada@acme.test')).toBe(false);
    const [row] = await ds.query(`SELECT status, "lastError" FROM org_domains WHERE id = $1`, [b.id]);
    expect(row.status).toBe('failed');
  });

  it('adding the same domain twice in one organization returns the one claim', async () => {
    const first = await service.add(orgA, 'twice.test');
    const again = await service.add(orgA, 'TWICE.test');
    expect(again.id).toBe(first.id);
  });
});
