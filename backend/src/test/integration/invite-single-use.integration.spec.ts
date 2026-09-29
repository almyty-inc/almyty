import { DataSource } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { OrganizationRole, UserOrganization } from '../../entities/user-organization.entity';
import { OrganizationsInvitesHelper, hashInviteToken } from '../../modules/organizations/organizations-invites.helper';

/**
 * Invites against a real, migrated Postgres: what is stored is the token's
 * hash, and each invite admits exactly one accept, however many race for
 * it. The pending-invite claim is raw SQL on a jsonb array, so only a real
 * database says whether its row lock makes the claim single use.
 */
const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const SCHEMA = 'invite_single_use';

jest.setTimeout(120_000);

describeOrSkip('invites (real Postgres, migrated schema)', () => {
  let ds: DataSource;
  let helper: OrganizationsInvitesHelper;
  let sent: Array<{ inviteToken: string; to: string }>;
  let orgId: string;
  let ownerId: string;

  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };

  const user = (email: string) =>
    ds.getRepository(User).save(
      ds.getRepository(User).create({
        email,
        passwordHash: 'x',
        firstName: 'F',
        lastName: 'L',
        isVerified: true,
        verifiedAt: new Date(),
      } as any),
    ) as Promise<any>;

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

    const orgs = ds.getRepository(Organization);
    orgId = (await orgs.save(orgs.create({ name: 'Invite Org', slug: 'invite-org', plan: 'free', isActive: true } as any)) as any).id;
    ownerId = (await user('owner@invite.test')).id;
    await ds.getRepository(UserOrganization).save({
      userId: ownerId,
      organizationId: orgId,
      role: OrganizationRole.OWNER,
      isActive: true,
      inviteAccepted: true,
    } as any);

    sent = [];
    helper = new OrganizationsInvitesHelper(
      orgs,
      ds.getRepository(UserOrganization),
      ds.getRepository(User),
      { sendInvitation: async (p: any) => (sent.push(p), true) } as any,
      {} as any,
      { joinDefaultTeam: async () => undefined } as any,
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await ds.destroy();
    }
  });

  it('stores the hash of a pending invite and lets one of two racing accepts through', async () => {
    await helper.inviteUser(orgId, { email: 'new@invite.test', role: OrganizationRole.MEMBER } as any, ownerId);
    const token = sent[sent.length - 1].inviteToken;

    const [{ settings }] = await ds.query(`SELECT settings FROM organizations WHERE id = $1`, [orgId]);
    expect(JSON.stringify(settings)).not.toContain(token);
    expect(settings.pendingInvites[0].inviteToken).toBe(hashInviteToken(token));

    const joiner = await user('new@invite.test');
    const results = await Promise.allSettled([
      helper.acceptInvite(token, joiner.id),
      helper.acceptInvite(token, joiner.id),
      helper.acceptInvite(token, joiner.id),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await ds.query(`SELECT id FROM user_organizations WHERE "userId" = $1 AND "organizationId" = $2`, [joiner.id, orgId]);
    expect(rows).toHaveLength(1);
    const [{ settings: after }] = await ds.query(`SELECT settings FROM organizations WHERE id = $1`, [orgId]);
    expect(after.pendingInvites).toEqual([]);
  });

  it('stores the hash of a membership invite and lets one of two racing accepts through', async () => {
    const invitee = await user('existing@invite.test');
    await helper.inviteUser(orgId, { email: 'existing@invite.test', role: OrganizationRole.MEMBER } as any, ownerId);
    const token = sent[sent.length - 1].inviteToken;

    const [row] = await ds.query(`SELECT "inviteToken" FROM user_organizations WHERE "userId" = $1`, [invitee.id]);
    expect(row.inviteToken).toBe(hashInviteToken(token));

    const results = await Promise.allSettled([
      helper.acceptInvite(token, invitee.id),
      helper.acceptInvite(token, invitee.id),
      helper.acceptInvite(token, invitee.id),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [spent] = await ds.query(`SELECT "inviteToken", "inviteAccepted" FROM user_organizations WHERE "userId" = $1`, [invitee.id]);
    expect(spent).toEqual({ inviteToken: null, inviteAccepted: true });
  });
});
