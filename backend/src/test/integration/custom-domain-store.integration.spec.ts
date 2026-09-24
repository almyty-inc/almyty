import { DataSource, Repository } from 'typeorm';

import { Gateway, GatewayType, type VisitorOAuthConfig } from '../../entities/gateway.entity';
import { Organization } from '../../entities/organization.entity';
import { PgCustomDomainStore } from '../../modules/gateways/channels/custom-domain.service';
import { PgVisitorOAuthStore } from '../../modules/gateways/channels/visitor-oauth-config.service';
import { newCustomDomain, type CustomDomainConfig } from '../../modules/gateways/channels/custom-domain';

/**
 * The custom-domain store's SQL against a real Postgres whose schema is
 * built by running the migrations, so the column, its type and the
 * one-live-owner index are the ones production has.
 *
 * Also the race the column exists for: a gateway loaded before a domain
 * changed, then saved through TypeORM, must not write the old claim back.
 */
const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const SCHEMA = 'customdomain_store';

jest.setTimeout(120_000);

describeOrSkip('PgCustomDomainStore (real Postgres, migrated schema)', () => {
  let ds: DataSource;
  let gateways: Repository<Gateway>;
  let store: PgCustomDomainStore;
  let ORG_A: string;
  let ORG_B: string;
  let GW_A: string;
  let GW_B: string;

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
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();
    gateways = ds.getRepository(Gateway);
    store = new PgCustomDomainStore(gateways);

    const orgs = ds.getRepository(Organization);
    ORG_A = (await orgs.save(orgs.create({ name: 'Org A', slug: 'cd-org-a', plan: 'free', isActive: true } as any)) as any).id;
    ORG_B = (await orgs.save(orgs.create({ name: 'Org B', slug: 'cd-org-b', plan: 'free', isActive: true } as any)) as any).id;
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await ds.destroy();
    }
  });

  beforeEach(async () => {
    await ds.query(`DELETE FROM "gateways"`);
    const make = (organizationId: string, slug: string) =>
      gateways.save(
        gateways.create({
          name: `Chat ${slug}`,
          type: GatewayType.HOSTED_CHAT,
          organizationId,
          endpoint: `/gateways/${slug}`,
          configuration: { hostedChat: { slug }, allowedOrigins: [] },
        } as Partial<Gateway>),
      );
    GW_A = (await make(ORG_A, 'acme')).id;
    GW_B = (await make(ORG_B, 'bravo')).id;
  });

  const claimOf = async (id: string): Promise<CustomDomainConfig | null> =>
    (await ds.query(`SELECT "customDomain" FROM "gateways" WHERE id = $1`, [id]))[0].customDomain;
  const configOf = async (id: string) =>
    (await ds.query(`SELECT "configuration" FROM "gateways" WHERE id = $1`, [id]))[0].configuration;

  it('writes only the customDomain column and leaves the configuration alone', async () => {
    const claim = newCustomDomain('chat.acme.com');
    await store.write(GW_A, ORG_A, claim);
    expect(await claimOf(GW_A)).toEqual(claim);
    expect(await configOf(GW_A)).toEqual({ hostedChat: { slug: 'acme' }, allowedOrigins: [] });
    await store.write(GW_A, ORG_A, null);
    expect(await claimOf(GW_A)).toBeNull();
  });

  it("never writes another organization's gateway", async () => {
    await store.write(GW_A, ORG_B, newCustomDomain('chat.acme.com'));
    expect(await claimOf(GW_A)).toBeNull();
  });

  it('a TypeORM save of a gateway loaded before the claim changed does not write the old claim back', async () => {
    const claim = newCustomDomain('chat.acme.com');
    await store.write(GW_A, ORG_A, claim);

    // A generic gateway edit loads the row...
    const loadedEarly = await gateways.findOneByOrFail({ id: GW_A });
    expect(loadedEarly.customDomain?.status).toBe('pending_verification');

    // ...the domain is verified meanwhile...
    await expect(store.replaceClaim(GW_A, ORG_A, claim, { ...claim, status: 'active' })).resolves.toBe('ok');

    // ...and the edit saves what it loaded, with its own change.
    loadedEarly.name = 'Renamed';
    loadedEarly.configuration = { ...loadedEarly.configuration, greeting: 'hi' };
    await gateways.save(loadedEarly);

    expect((await claimOf(GW_A))?.status).toBe('active');
    expect((await gateways.findOneByOrFail({ id: GW_A })).name).toBe('Renamed');

    // Same for a removal: a stale save does not resurrect a removed claim.
    const loadedAgain = await gateways.findOneByOrFail({ id: GW_A });
    await store.write(GW_A, ORG_A, null);
    loadedAgain.description = 'edited';
    await gateways.save(loadedAgain);
    expect(await claimOf(GW_A)).toBeNull();

    // And create never takes one from the caller.
    const created = await gateways.save(
      gateways.create({
        name: 'Sneaky',
        type: GatewayType.HOSTED_CHAT,
        organizationId: ORG_A,
        endpoint: '/gateways/sneaky',
        configuration: {},
        customDomain: { ...newCustomDomain('chat.victim.com'), status: 'active' },
      } as Partial<Gateway>),
    );
    expect(await claimOf(created.id)).toBeNull();
  });

  it('the visitor OAuth column is written only by its store, never by a TypeORM save', async () => {
    const oauthStore = new PgVisitorOAuthStore(gateways);
    const loadedEarly = await gateways.findOneByOrFail({ id: GW_A });
    const provider: VisitorOAuthConfig = {
      preset: 'google',
      issuer: 'https://accounts.google.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      userinfoEndpoint: null,
      jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
      discoveryUrl: null,
      tenant: null,
      clientId: 'gid',
      scopes: ['openid'],
      allowedEmailDomains: [],
      credentialId: null,
      tokenEndpointAuthMethod: 'client_secret_post',
      updatedAt: '2026-09-24T00:00:00.000Z',
    };
    await oauthStore.write(GW_A, ORG_B, { ...provider });
    expect((await gateways.findOneByOrFail({ id: GW_A })).visitorOAuth).toBeNull();
    await oauthStore.write(GW_A, ORG_A, { ...provider });

    loadedEarly.name = 'Edited meanwhile';
    await gateways.save(loadedEarly);
    expect((await gateways.findOneByOrFail({ id: GW_A })).visitorOAuth).toMatchObject({ clientId: 'gid' });

    await oauthStore.write(GW_A, ORG_A, null);
    expect((await gateways.findOneByOrFail({ id: GW_A })).visitorOAuth).toBeNull();
  });

  it('replaceClaim is a compare-and-set on hostname and token', async () => {
    const claim = newCustomDomain('chat.acme.com');
    await store.write(GW_A, ORG_A, claim);
    const active: CustomDomainConfig = { ...claim, status: 'active', verifiedAt: new Date().toISOString() };

    await expect(store.replaceClaim(GW_A, ORG_A, { ...claim, verificationToken: 'other' }, active)).resolves.toBe('stale');
    await expect(store.replaceClaim(GW_A, ORG_B, claim, active)).resolves.toBe('stale');
    await expect(store.replaceClaim(GW_A, ORG_A, claim, active)).resolves.toBe('ok');
    expect((await claimOf(GW_A))?.status).toBe('active');
  });

  it('refuses a second ACTIVE owner of a hostname, from any organization', async () => {
    const a = newCustomDomain('chat.shared.com');
    const b = newCustomDomain('chat.shared.com');
    await store.write(GW_A, ORG_A, a);
    await store.write(GW_B, ORG_B, b); // two pending claims coexist
    await expect(store.replaceClaim(GW_A, ORG_A, a, { ...a, status: 'active' })).resolves.toBe('ok');
    await expect(store.replaceClaim(GW_B, ORG_B, b, { ...b, status: 'active' })).resolves.toBe('conflict');
    expect((await claimOf(GW_B))?.status).toBe('pending_verification');

    await expect(store.activeHolder('chat.shared.com', GW_B)).resolves.toMatchObject({ gatewayId: GW_A, organizationId: ORG_A });
    await expect(store.activeHolder('chat.shared.com', GW_A)).resolves.toBeNull();
  });

  it('of two surfaces activating one hostname at the same moment, exactly one wins', async () => {
    const a = newCustomDomain('race.shared.com');
    const b = newCustomDomain('race.shared.com');
    await store.write(GW_A, ORG_A, a);
    await store.write(GW_B, ORG_B, b);
    const results = await Promise.all([
      store.replaceClaim(GW_A, ORG_A, a, { ...a, status: 'active' }),
      store.replaceClaim(GW_B, ORG_B, b, { ...b, status: 'active' }),
    ]);
    expect(results.sort()).toEqual(['conflict', 'ok']);
  });

  describe('takeOver', () => {
    async function heldByA() {
      const a = newCustomDomain('chat.shared.com');
      const b = newCustomDomain('chat.shared.com');
      await store.write(GW_A, ORG_A, { ...a, status: 'active' });
      await store.write(GW_B, ORG_B, b);
      return { a: { ...a, status: 'active' as const }, b };
    }

    it('demotes the holder and makes the winner live in one step', async () => {
      const { a, b } = await heldByA();
      const result = await store.takeOver(
        { gatewayId: GW_B, organizationId: ORG_B, current: b, next: { ...b, status: 'active' } },
        { gatewayId: GW_A, current: a, demoted: { ...a, status: 'failed', lastError: 'taken over' } },
      );
      expect(result).toBe('ok');
      expect(await claimOf(GW_A)).toMatchObject({ status: 'failed', lastError: 'taken over' });
      expect(await claimOf(GW_B)).toMatchObject({ status: 'active' });
    });

    it('changes nothing when the holder claim is no longer the one that was checked', async () => {
      const { a, b } = await heldByA();
      const result = await store.takeOver(
        { gatewayId: GW_B, organizationId: ORG_B, current: b, next: { ...b, status: 'active' } },
        { gatewayId: GW_A, current: { ...a, verificationToken: 'rotated' }, demoted: { ...a, status: 'failed' } },
      );
      expect(result).toBe('holder_changed');
      expect((await claimOf(GW_A))?.status).toBe('active');
      expect((await claimOf(GW_B))?.status).toBe('pending_verification');
    });

    it('rolls the demotion back when the winner claim changed underneath', async () => {
      const { a, b } = await heldByA();
      const result = await store.takeOver(
        { gatewayId: GW_B, organizationId: ORG_B, current: { ...b, verificationToken: 'stale' }, next: { ...b, status: 'active' } },
        { gatewayId: GW_A, current: a, demoted: { ...a, status: 'failed' } },
      );
      expect(result).toBe('stale');
      expect((await claimOf(GW_A))?.status).toBe('active');
      expect((await claimOf(GW_B))?.status).toBe('pending_verification');
    });
  });

  describe('re-check', () => {
    it('lists live claims that are due, oldest first, and records a check only against the claim that was read', async () => {
      const a = { ...newCustomDomain('a.example.com'), status: 'active' as const, lastCheckedAt: '2026-09-01T00:00:00.000Z' };
      const b = { ...newCustomDomain('b.example.com'), status: 'active' as const, lastCheckedAt: null };
      await store.write(GW_A, ORG_A, a);
      await store.write(GW_B, ORG_B, b);

      const due = await store.dueForRecheck('2026-09-02T00:00:00.000Z', 10);
      expect(due.map((d) => d.gatewayId)).toEqual([GW_B, GW_A]);
      expect(await store.dueForRecheck('2026-08-01T00:00:00.000Z', 10)).toHaveLength(1);

      const next = { ...a, lastCheckedAt: '2026-09-02T00:00:00.000Z', consecutiveFailures: 1 };
      await expect(store.recordRecheck(GW_A, a, next)).resolves.toBe('ok');
      // A second worker holding the same read is refused.
      await expect(store.recordRecheck(GW_A, a, { ...next, consecutiveFailures: 2 })).resolves.toBe('stale');
      expect((await claimOf(GW_A))?.consecutiveFailures).toBe(1);
      // A null lastCheckedAt compares too.
      await expect(store.recordRecheck(GW_B, b, { ...b, lastCheckedAt: 'x' })).resolves.toBe('ok');
      // A claim that is no longer live is never written by a re-check.
      await store.write(GW_A, ORG_A, null);
      await expect(store.recordRecheck(GW_A, next, next)).resolves.toBe('stale');
      expect(await claimOf(GW_A)).toBeNull();
    });
  });
});
