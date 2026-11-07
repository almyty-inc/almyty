/**
 * "Sign out other devices" over real HTTP against real Postgres.
 *
 *   - Every other session dies: another browser's cookie, a non-browser
 *     client's access token and its refresh token.
 *   - The caller stays signed in, on the fresh cookie the response sets;
 *     the cookie it sent dies with the rest.
 *   - An account without a password (single sign-on) gets the same, and
 *     its new session keeps its organization scope.
 *   - An API key cannot do it: that would turn a key into a browser login.
 *   - It is recorded in the audit trail.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import * as crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';

import { listenOnLoopback } from '../http';
import { TestAppModule } from '../test-app.module';
import { User } from '../../entities/user.entity';
import { AuthSession } from '../../entities/auth-session.entity';
import { AuditAction } from '../../entities/audit-log.entity';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';
import { AuthService } from '../../modules/auth/auth.service';
import { MailService } from '../../modules/mail/mail.service';
import { useIsolatedSchema, ensureSchema } from './isolated-schema.helper';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;

const SCHEMA = 'sign_out_other_devices_test';
if (SHOULD_RUN) useIsolatedSchema(SCHEMA);

const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

describeIfDb('sign out other devices (real HTTP, real Postgres)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let auth: AuthService;
  const SUFFIX = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const PASSWORD = 'TestPass123!';
  const audited: any[] = [];

  let counter = 0;
  async function newVerifiedUser(): Promise<{ email: string; user: User }> {
    counter += 1;
    const email = `signout-${SUFFIX}-${counter}@test.com`;
    await auth.register({
      email,
      password: PASSWORD,
      firstName: 'Sign',
      lastName: 'Out',
      organizationName: `signout-${SUFFIX}-${counter}`,
    });
    const users = ds.getRepository(User);
    const user = await users.findOneOrFail({
      where: { email },
      relations: { organizationMemberships: { organization: true } },
    });
    await users.update({ id: user.id }, { isVerified: true, verifiedAt: new Date() });
    return { email, user };
  }

  const cookieOf = (res: request.Response) => {
    const setCookie = res.headers['set-cookie'] as unknown as string[] | string | undefined;
    const raw = (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).find((c) =>
      c.startsWith('access_token='),
    );
    if (!raw) throw new Error('no access_token cookie set');
    expect(raw).toMatch(/HttpOnly/i);
    return raw.split(';')[0];
  };

  async function browserLogin(email: string) {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD }).expect(200);
    return cookieOf(res);
  }

  async function tokenLogin(email: string) {
    const res = await request(app.getHttpServer()).post('/auth/token').send({ email, password: PASSWORD }).expect(200);
    return { accessToken: res.body.data.accessToken as string, refreshToken: res.body.data.refreshToken as string };
  }

  const profileWithCookie = (cookie: string) => request(app.getHttpServer()).get('/auth/profile').set('Cookie', cookie);
  const profileWithBearer = (token: string) =>
    request(app.getHttpServer()).get('/auth/profile').set('Authorization', `Bearer ${token}`);
  const revokeOthers = (cookie: string) =>
    request(app.getHttpServer())
      .post('/auth/sessions/revoke-others')
      .set('Origin', 'http://localhost:3002')
      .set('Cookie', cookie);

  beforeAll(async () => {
    useIsolatedSchema(SCHEMA);
    await ensureSchema(SCHEMA);

    const module: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(AuditLogService)
      .useValue({
        log: async (options: any) => {
          audited.push(options);
          return null;
        },
        logCreate: () => {},
        logUpdate: () => {},
        logDelete: () => {},
        logInTransaction: async () => ({}),
        publishCommitted: () => {},
      })
      .overrideProvider(MailService)
      .useValue({
        sendPasswordReset: async () => true,
        sendEmailVerification: async () => true,
        sendTemplate: async () => true,
        sendInvitation: async () => true,
        sendEmail: async () => true,
      })
      .compile();

    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await listenOnLoopback(app);

    ds = module.get(DataSource);
    auth = module.get(AuthService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("ends a second session's tokens while the caller's new cookie keeps working", async () => {
    const { email, user } = await newVerifiedUser();
    const here = await browserLogin(email);
    const otherBrowser = await browserLogin(email);
    const cli = await tokenLogin(email);
    // Registration started a session of its own; every live one but the caller's is an other.
    const others =
      (await ds.getRepository(AuthSession).find({ where: { userId: user.id } })).filter((s) => !s.revokedAt).length - 1;
    expect(others).toBeGreaterThanOrEqual(2);
    await profileWithCookie(otherBrowser).expect(200);
    await profileWithBearer(cli.accessToken).expect(200);

    const res = await revokeOthers(here).expect(200);
    const fresh = cookieOf(res);
    expect(fresh).not.toBe(here);
    expect(res.body.data).toEqual({ signedOut: others, expiresIn: expect.any(Number) });
    // The body carries no token: the session is the httpOnly cookie only.
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);

    // Every other session is refused...
    await profileWithCookie(otherBrowser).expect(401);
    await profileWithBearer(cli.accessToken).expect(401);
    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: cli.refreshToken }).expect(401);
    // ...and so is the cookie the caller sent: a copy of it is no use now.
    await profileWithCookie(here).expect(401);

    // The caller is still signed in, on the new cookie.
    const profile = await profileWithCookie(fresh).expect(200);
    expect(profile.body.data.email).toBe(email);

    // Exactly one session is left, the new one.
    const live = (await ds.getRepository(AuthSession).find({ where: { userId: user.id } })).filter((s) => !s.revokedAt);
    expect(live.map((s) => s.id)).toEqual([claims(fresh.slice('access_token='.length)).sid]);

    // TestAppModule's audit service is a stub; this spec records what is
    // handed to it (the dev stack run shows the row landing in audit_logs).
    const entries = audited.filter((o) => o.userId === user.id && o.action === AuditAction.SESSIONS_REVOKE);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      organizationId: user.organizationMemberships[0].organizationId,
      resourceType: 'user',
      resourceId: user.id,
      details: { signedOut: others },
    });
  });

  it('works the same for an account without a password, and keeps its single sign-on scope', async () => {
    const { user } = await newVerifiedUser();
    const orgId = user.organizationMemberships[0].organizationId;
    await ds.getRepository(User).update({ id: user.id }, { hasPassword: false });

    // Two sessions minted the way the SSO callback mints them.
    const here = `access_token=${(await auth.generateTokens(user, { ssoOrganizationId: orgId })).accessToken}`;
    const elsewhere = await auth.generateTokens(user, { ssoOrganizationId: orgId });
    await profileWithBearer(elsewhere.accessToken).expect(200);

    const fresh = cookieOf(await revokeOthers(here).expect(200));

    await profileWithBearer(elsewhere.accessToken).expect(401);
    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: elsewhere.refreshToken }).expect(401);
    await profileWithCookie(fresh).expect(200);
    expect(claims(fresh.slice('access_token='.length)).sso).toBe(orgId);
  });

  it('refuses an API key: a key is not a session to re-issue', async () => {
    const { email } = await newVerifiedUser();
    const cookie = await browserLogin(email);
    const created = await request(app.getHttpServer())
      .post('/auth/api-keys')
      .set('Cookie', cookie)
      .send({ name: 'laptop' })
      .expect(201);
    const apiKey = created.body.data.apiKey as string;

    const res = await request(app.getHttpServer())
      .post('/auth/sessions/revoke-others')
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(403);
    expect(res.headers['set-cookie']).toBeUndefined();
    // Nothing was ended.
    await profileWithCookie(cookie).expect(200);
  });

  it('refuses a caller who is not signed in', async () => {
    await request(app.getHttpServer()).post('/auth/sessions/revoke-others').expect(401);
  });
});
