/**
 * The account lifecycle over real HTTP against real Postgres: what a
 * token is good for, when a session ends, and what a reset link is worth.
 *
 *   - Only an access token is a session. The email-verification link and
 *     the refresh token are signed with the same secret; neither may open
 *     a protected route.
 *   - Logout ends the session server-side: the token it clears from the
 *     browser stops working everywhere.
 *   - A refresh token is redeemed once. Presenting it again revokes the
 *     session, so neither holder of a copied token keeps it.
 *   - A reset token is stored hashed, used once, and dies when the password
 *     or the login address changes.
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
import { AuthService } from '../../modules/auth/auth.service';
import { MailService } from '../../modules/mail/mail.service';
import { useIsolatedSchema, ensureSchema } from './isolated-schema.helper';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;

const SCHEMA = 'auth_session_lifecycle_test';
if (SHOULD_RUN) useIsolatedSchema(SCHEMA);

describeIfDb('account lifecycle (real HTTP, real Postgres)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let auth: AuthService;
  const SUFFIX = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const PASSWORD = 'TestPass123!';

  // What the app mailed, by recipient: the reset and verification links.
  const mailed: Array<{ kind: string; to: string; token: string }> = [];
  const mail = {
    sendPasswordReset: async (to: string, token: string) => {
      mailed.push({ kind: 'reset', to, token });
      return true;
    },
    sendEmailVerification: async (to: string, token: string) => {
      mailed.push({ kind: 'verify', to, token });
      return true;
    },
    sendTemplate: async () => true,
    sendInvitation: async () => true,
    sendEmail: async () => true,
  };
  const lastMailed = (kind: string, to: string) =>
    [...mailed].reverse().find((m) => m.kind === kind && m.to === to)?.token;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  let counter = 0;
  async function newVerifiedUser(): Promise<{ email: string; user: User }> {
    counter += 1;
    const email = `lifecycle-${SUFFIX}-${counter}@test.com`;
    await auth.register({
      email,
      password: PASSWORD,
      firstName: 'Life',
      lastName: 'Cycle',
      organizationName: `lifecycle-${SUFFIX}-${counter}`,
    });
    const users = ds.getRepository(User);
    const user = await users.findOneOrFail({ where: { email } });
    await users.update({ id: user.id }, { isVerified: true, verifiedAt: new Date() });
    return { email, user };
  }

  /** The browser login: the session is the cookie, whose value is the access token. */
  async function login(email: string, password = PASSWORD) {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);
    const setCookie = res.headers['set-cookie'] as unknown as string[] | string;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
    return { cookie, accessToken: cookie.slice('access_token='.length) };
  }

  /** The non-browser login: both tokens in the body, no cookie. */
  async function tokenLogin(email: string, password = PASSWORD) {
    const res = await request(app.getHttpServer()).post('/auth/token').send({ email, password }).expect(200);
    return { accessToken: res.body.data.accessToken as string, refreshToken: res.body.data.refreshToken as string };
  }

  const profileWithBearer = (token: string) =>
    request(app.getHttpServer()).get('/auth/profile').set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    useIsolatedSchema(SCHEMA);
    await ensureSchema(SCHEMA);

    const module: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(MailService)
      .useValue(mail)
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

  describe('only an access token is a session', () => {
    it('the email-verification link token does not open a protected route', async () => {
      const email = `verify-link-${SUFFIX}@test.com`;
      await auth.register({
        email,
        password: PASSWORD,
        firstName: 'V',
        lastName: 'L',
        organizationName: `verify-link-${SUFFIX}`,
      });
      await settle();
      const linkToken = lastMailed('verify', email);
      expect(linkToken).toBeTruthy();

      await profileWithBearer(linkToken!).expect(401);
      await request(app.getHttpServer())
        .get('/auth/profile')
        .set('Cookie', `access_token=${linkToken}`)
        .expect(401);

      // It still does what it is for.
      await request(app.getHttpServer()).post('/auth/verify-email').send({ token: linkToken }).expect(200);
    });

    it('the refresh token does not open a protected route', async () => {
      const { email } = await newVerifiedUser();
      const { accessToken, refreshToken } = await tokenLogin(email);

      await profileWithBearer(accessToken).expect(200);
      await profileWithBearer(refreshToken).expect(401);
    });

    it('an access token is not a verification link', async () => {
      const { email } = await newVerifiedUser();
      const { accessToken } = await login(email);

      await request(app.getHttpServer()).post('/auth/verify-email').send({ token: accessToken }).expect(400);
    });
  });

  describe('logout', () => {
    it('ends the session: the cleared cookie stops working everywhere', async () => {
      const { email } = await newVerifiedUser();
      const { cookie, accessToken } = await login(email);
      await request(app.getHttpServer()).get('/auth/profile').set('Cookie', cookie).expect(200);

      await request(app.getHttpServer()).post('/auth/logout').set('Cookie', cookie).expect(200);

      await request(app.getHttpServer()).get('/auth/profile').set('Cookie', cookie).expect(401);
      await profileWithBearer(accessToken).expect(401);
    });

    it('ends only that session', async () => {
      const { email } = await newVerifiedUser();
      const first = await login(email);
      const second = await login(email);

      await request(app.getHttpServer()).post('/auth/logout').set('Cookie', first.cookie).expect(200);

      await profileWithBearer(first.accessToken).expect(401);
      await profileWithBearer(second.accessToken).expect(200);
    });

    it('also ends the session its refresh token belongs to', async () => {
      const { email } = await newVerifiedUser();
      const { accessToken, refreshToken } = await tokenLogin(email);
      await request(app.getHttpServer()).post('/auth/logout').set('Authorization', `Bearer ${accessToken}`).expect(200);

      await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken }).expect(401);
    });
  });

  describe('where tokens are delivered', () => {
    it('the browser login answers with the cookie and no token in the body', async () => {
      const { email } = await newVerifiedUser();
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .set('Origin', 'http://localhost:3002')
        .send({ email, password: PASSWORD })
        .expect(200);

      expect(res.headers['set-cookie']).toBeDefined();
      expect(res.body.data).toEqual({ expiresIn: expect.any(Number) });
      expect(JSON.stringify(res.body)).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
    });

    it('registration answers the same way', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: `register-body-${SUFFIX}@test.com`,
          password: PASSWORD,
          firstName: 'R',
          lastName: 'B',
          organizationName: `register-body-${SUFFIX}`,
        })
        .expect(201);

      expect(res.body.data).not.toHaveProperty('accessToken');
      expect(res.body.data).not.toHaveProperty('refreshToken');
    });

    it('the non-browser login returns tokens and sets no cookie, and refuses a page', async () => {
      const { email } = await newVerifiedUser();
      const res = await request(app.getHttpServer()).post('/auth/token').send({ email, password: PASSWORD }).expect(200);
      expect(res.headers['set-cookie']).toBeUndefined();
      await profileWithBearer(res.body.data.accessToken).expect(200);

      await request(app.getHttpServer())
        .post('/auth/token')
        .set('Origin', 'http://localhost:3002')
        .send({ email, password: PASSWORD })
        .expect(400);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Origin', 'http://localhost:3002')
        .send({ refreshToken: res.body.data.refreshToken })
        .expect(400);
    });
  });

  describe('refresh', () => {
    it('redeems a refresh token once, and a replay revokes the whole session', async () => {
      const { email, user } = await newVerifiedUser();
      const first = await tokenLogin(email);

      const rotated = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(200);
      const second = rotated.body.data;
      expect(second.refreshToken).not.toBe(first.refreshToken);
      await profileWithBearer(second.accessToken).expect(200);

      // The first token again: a copy is in someone else's hands.
      await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);

      // Neither holder keeps the session.
      await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: second.refreshToken }).expect(401);
      await profileWithBearer(second.accessToken).expect(401);
      const sessions = await ds.getRepository(AuthSession).find({ where: { userId: user.id } });
      const loginSession = sessions.find((s) => s.id === (JSON.parse(Buffer.from(first.accessToken.split('.')[1], 'base64url').toString()) as any).sid);
      expect(loginSession?.revokedReason).toBe('refresh_reuse');
    });

    it('lets exactly one of two simultaneous redemptions through', async () => {
      const { email } = await newVerifiedUser();
      const { refreshToken } = await tokenLogin(email);

      const results = await Promise.all([
        request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken }),
        request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });
  });

  describe('password reset token', () => {
    it('is stored as its hash, and works once', async () => {
      const { email, user } = await newVerifiedUser();
      await request(app.getHttpServer()).post('/auth/forgot-password').send({ email }).expect(200);
      await settle();
      const token = lastMailed('reset', email)!;
      expect(token).toBeTruthy();

      const stored = await ds.getRepository(User).findOneOrFail({ where: { id: user.id } });
      expect(stored.resetPasswordToken).not.toBe(token);
      expect(stored.resetPasswordToken).toBe(crypto.createHash('sha256').update(token).digest('hex'));

      // The stored value is not itself a reset token.
      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: stored.resetPasswordToken, password: 'Another123!' })
        .expect(400);

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token, password: 'Another123!' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token, password: 'YetAnother123!' })
        .expect(400);
      await login(email, 'Another123!');
    });

    it('dies when the password is changed', async () => {
      const { email } = await newVerifiedUser();
      const { cookie } = await login(email);
      await request(app.getHttpServer()).post('/auth/forgot-password').send({ email }).expect(200);
      await settle();
      const token = lastMailed('reset', email)!;

      await request(app.getHttpServer())
        .patch('/auth/change-password')
        .set('Cookie', cookie)
        .send({ currentPassword: PASSWORD, newPassword: 'Changed123!' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token, password: 'Hijack123!' })
        .expect(400);
      await login(email, 'Changed123!');
    });

    it('dies when the login address moves', async () => {
      const { email } = await newVerifiedUser();
      const { cookie } = await login(email);
      await request(app.getHttpServer()).post('/auth/forgot-password').send({ email }).expect(200);
      await settle();
      const token = lastMailed('reset', email)!;

      await request(app.getHttpServer())
        .patch('/auth/profile')
        .set('Cookie', cookie)
        .send({ email: `moved-${SUFFIX}-${counter}@test.com`, currentPassword: PASSWORD })
        .expect(200);

      // Whoever reads the old mailbox does not get the account back.
      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token, password: 'Hijack123!' })
        .expect(400);
    });
  });
});
