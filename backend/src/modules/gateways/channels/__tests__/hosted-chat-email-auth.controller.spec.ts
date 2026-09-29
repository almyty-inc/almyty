import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { HostedChatEmailAuthController } from '../hosted-chat-email-auth.controller';
import { HostedChatService } from '../hosted-chat.service';
import { VisitorEmailOtpService } from '../visitor-email-otp.service';
import { GatewayRateLimitService } from '../../gateway-rate-limit.service';
import { MailService } from '../../../mail/mail.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';
import { fakeRepository } from '../../../../test/fake-repository';
import { FakeRedisWithWindows } from '../../../../test/fake-redis-windows';
import { listenOnLoopback } from '../../../../test/http';
import {
  ClauseModel,
  ExecutedQuery,
  RecordingQueryBuilder,
  matchingRows,
} from '../../__tests__/recording-query-builder';

/**
 * Email-code sign-in over real HTTP through Nest: the routes exist at the
 * paths the hosted chat page calls, the code binds the visitor who asked
 * for it, and a verified visitor is what the chat's own gate admits.
 */

const SLUG_CLAUSES: ClauseModel = {
  'gateway.type = :type': (row, p) => row.type === p.type,
  "gateway.configuration -> 'hostedChat' ->> 'slug' = :slug": (row, p) => row.configuration?.hostedChat?.slug === p.slug,
};

function surface(slug: string, authMode: string): Gateway {
  return Object.assign(new Gateway(), {
    id: `gw-${slug}`,
    organizationId: 'org-1',
    type: GatewayType.HOSTED_CHAT,
    status: GatewayStatus.ACTIVE,
    agentId: 'agent-1',
    configuration: { hostedChat: { slug, appName: 'Acme Help', authMode } },
  });
}

const cookieFrom = (res: request.Response): string | undefined =>
  ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith(`${HostedChatService.SESSION_COOKIE}=`));

describe('HostedChatEmailAuthController (HTTP)', () => {
  let app: INestApplication;
  let hostedChat: HostedChatService;
  let endUsers: ReturnType<typeof fakeRepository<any>>;
  let mail: MailService;
  const gateways = [surface('acme', 'email_otp'), surface('corp', 'sso')];

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    endUsers = fakeRepository<any>({ idPrefix: 'eu' });
    const gatewayRepository = {
      createQueryBuilder: jest.fn(
        (alias: string) =>
          new RecordingQueryBuilder(alias, {
            getMany: (query: ExecutedQuery) => matchingRows(query, gateways, SLUG_CLAUSES),
          }),
      ),
    };
    hostedChat = new HostedChatService(
      gatewayRepository as any,
      endUsers as any,
      fakeRepository() as any,
      fakeRepository() as any,
      fakeRepository() as any,
    );
    mail = new MailService();
    const otp = new VisitorEmailOtpService(
      fakeRepository<any>() as any,
      mail,
      new GatewayRateLimitService(new FakeRedisWithWindows() as any),
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [HostedChatEmailAuthController],
      providers: [
        { provide: HostedChatService, useValue: hostedChat },
        { provide: VisitorEmailOtpService, useValue: otp },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await listenOnLoopback(app);
  });

  afterEach(async () => app.close());

  const mailedCode = (to: string) =>
    mail
      .getRecentSends()
      .filter((s) => s.to === to)
      .pop()!
      .subject.slice(0, 6);

  it('signs a visitor in by email code and the chat then admits them', async () => {
    const start = await request(app.getHttpServer())
      .post('/public/chat/acme/auth/email/start')
      .send({ email: 'ada@example.com' })
      .expect(200);
    const anonymous = cookieFrom(start);
    expect(anonymous).toBeDefined();

    const verify = await request(app.getHttpServer())
      .post('/public/chat/acme/auth/email/verify')
      .set('Cookie', anonymous!)
      .send({ email: 'ada@example.com', code: mailedCode('ada@example.com') })
      .expect(200);
    expect(verify.body.data).toEqual({ authenticated: true, email: 'ada@example.com' });

    // The session key rotated (no fixation), and the row behind the new
    // cookie is the signed-in identity the chat's gate checks for.
    const signedIn = cookieFrom(verify);
    expect(signedIn).toBeDefined();
    expect(signedIn).not.toBe(anonymous);
    const [row] = endUsers.rows();
    expect(`${HostedChatService.SESSION_COOKIE}=${row.sessionKey}`).toBe(signedIn);
    expect(row).toMatchObject({ authProvider: 'email_otp', externalId: 'ada@example.com', email: 'ada@example.com' });
    expect(hostedChat.isAuthorized(gateways[0], row)).toBe(true);
  });

  it('a wrong code signs nobody in and issues no new session', async () => {
    const start = await request(app.getHttpServer())
      .post('/public/chat/acme/auth/email/start')
      .send({ email: 'ada@example.com' });
    const code = mailedCode('ada@example.com');
    const res = await request(app.getHttpServer())
      .post('/public/chat/acme/auth/email/verify')
      .set('Cookie', cookieFrom(start)!)
      .send({ email: 'ada@example.com', code: code === '000000' ? '111111' : '000000' })
      .expect(400);
    expect(res.body.code).toBe('CODE_INVALID');
    expect(cookieFrom(res)).toBeUndefined();
    expect(endUsers.rows()[0].authProvider).toBeNull();
  });

  it('a code cannot be redeemed from another browser', async () => {
    await request(app.getHttpServer()).post('/public/chat/acme/auth/email/start').send({ email: 'ada@example.com' });
    const res = await request(app.getHttpServer())
      .post('/public/chat/acme/auth/email/verify')
      .send({ email: 'ada@example.com', code: mailedCode('ada@example.com') })
      .expect(400);
    expect(res.body.code).toBe('CODE_EXPIRED');
  });

  it('refuses a surface that is not set to email sign-in', async () => {
    const res = await request(app.getHttpServer())
      .post('/public/chat/corp/auth/email/start')
      .send({ email: 'ada@example.com' })
      .expect(400);
    expect(res.body.code).toBe('AUTH_MODE_MISMATCH');
    expect(mail.getRecentSends()).toHaveLength(0);
  });

  it('answers a visitor over their send limit with 429 and Retry-After', async () => {
    const first = await request(app.getHttpServer())
      .post('/public/chat/acme/auth/email/start')
      .send({ email: 'a@example.com' });
    const cookie = cookieFrom(first)!;
    for (const email of ['b@example.com', 'c@example.com']) {
      await request(app.getHttpServer()).post('/public/chat/acme/auth/email/start').set('Cookie', cookie).send({ email }).expect(200);
    }
    const res = await request(app.getHttpServer())
      .post('/public/chat/acme/auth/email/start')
      .set('Cookie', cookie)
      .send({ email: 'd@example.com' })
      .expect(429);
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
  });
});

describe('email sign-in is wired into the app', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

  it('GatewaysModule registers the controller, the service and the code entity', () => {
    const mod = src('gateways.module.ts');
    expect(mod).toMatch(/controllers:\s*\[[\s\S]*?\bHostedChatEmailAuthController\b/);
    expect(mod).toMatch(/providers:\s*\[[\s\S]*?\bVisitorEmailOtpService\b/);
    expect(mod).toMatch(/forFeature\(\[[\s\S]*?\bVisitorEmailCode\b/);
  });

  it('the hosted chat page calls these routes', () => {
    const client = readFileSync(join(__dirname, '../../../../../../frontend/src/lib/hosted-chat.ts'), 'utf8');
    expect(client).toContain('/auth/email/start');
    expect(client).toContain('/auth/email/verify');
  });
});
