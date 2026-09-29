import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRedisConnectionToken } from '@nestjs-modules/ioredis';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { HostedChatSsoController, SAML_HANDOFF_TTL_MS, SAML_SIGN_IN_TTL_MS } from '../hosted-chat-sso.controller';
import { SsoService } from '../sso.service';
import { SamlReplayCache } from '../saml-replay-cache';
import { OrgLicenseResolver } from '../../../../src/modules/licensing/org-license.resolver';
import { HostedChatService } from '../../../../src/modules/gateways/channels/hosted-chat.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../../src/entities/gateway.entity';
import { fakeRepository } from '../../../../src/test/fake-repository';
import { FakeRedis } from '../../../../src/test/fake-redis';
import { FakeSamlIdp } from '../../../../src/test/fake-saml-idp';
import { listenOnLoopback } from '../../../../src/test/http';
import {
  ClauseModel,
  ExecutedQuery,
  RecordingQueryBuilder,
  matchingRows,
} from '../../../../src/modules/gateways/__tests__/recording-query-builder';

/**
 * SAML sign-in for hosted chat visitors, over real HTTP, with really
 * signed responses that node-saml validates for real.
 *
 * The assertion consumer receives a cross-site POST without the visitor's
 * cookies; the identity is bound on the follow-up GET, only in the browser
 * that started the sign-in. What must hold: the response answers this
 * sign-in's own AuthnRequest, is signed by the org's IdP for this SP, is
 * used once, and binds only the visitor who asked.
 */

jest.setTimeout(30_000);

const SLUG_CLAUSES: ClauseModel = {
  'gateway.type = :type': (row, p) => row.type === p.type,
  "gateway.configuration -> 'hostedChat' ->> 'slug' = :slug": (row, p) => row.configuration?.hostedChat?.slug === p.slug,
};

const SP_ISSUER = 'almyty-sp';
const ACS = 'https://corp.almyty.app/api/public/chat/corp/auth/sso/saml/acs';

const cookiesFrom = (res: request.Response): Record<string, string> =>
  Object.fromEntries(
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0].split('='))
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, ...v]) => [k, v.join('=')]),
  );
const cookieHeader = (jar: Record<string, string>) =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

async function harness(opts: { protocol?: 'saml' | 'oidc' } = {}) {
  process.env.NODE_ENV = 'test';
  process.env.HOSTED_CHAT_BASE_DOMAIN = 'almyty.app';
  const clock = { now: Date.now() };
  const idp = new FakeSamlIdp();
  const redis = new FakeRedis(() => clock.now);
  const gateways = [
    Object.assign(new Gateway(), {
      id: 'gw-corp',
      organizationId: 'org-1',
      name: 'Corp chat',
      type: GatewayType.HOSTED_CHAT,
      status: GatewayStatus.ACTIVE,
      agentId: 'agent-1',
      configuration: { hostedChat: { slug: 'corp', appName: 'Corp Help', authMode: 'sso' } },
      customDomain: null,
      visitorOAuth: null,
    }),
  ];
  const endUsers = fakeRepository<any>({ idPrefix: 'eu' });
  const hostedChat = new HostedChatService(
    {
      createQueryBuilder: jest.fn(
        (alias: string) =>
          new RecordingQueryBuilder(alias, {
            getMany: (query: ExecutedQuery) => matchingRows(query, gateways, SLUG_CLAUSES),
          }),
      ),
    } as any,
    endUsers as any,
    fakeRepository() as any,
    fakeRepository() as any,
    fakeRepository() as any,
  );
  const samlConfig = {
    organizationId: 'org-1',
    protocol: opts.protocol ?? 'saml',
    enabled: true,
    jitProvisioning: false,
    defaultRole: 'member',
    samlEntryPoint: idp.entryPoint,
    samlIssuer: SP_ISSUER,
    samlCert: idp.publicKeyPem,
  };
  // SsoConfigService.getDecrypted's contract: this org's decrypted config, or null.
  const configService = { getDecrypted: async (orgId: string) => (orgId === 'org-1' ? samlConfig : null) };
  const sso = new SsoService(fakeRepository() as any, fakeRepository() as any, configService as any, new SamlReplayCache(redis));
  const orgLicense = { hasForOrg: async (orgId: string, entitlement: string) => orgId === 'org-1' && entitlement === 'sso' };

  const moduleRef = await Test.createTestingModule({
    controllers: [HostedChatSsoController],
    providers: [
      { provide: HostedChatService, useValue: hostedChat },
      { provide: SsoService, useValue: sso },
      { provide: OrgLicenseResolver, useValue: orgLicense },
      { provide: getRedisConnectionToken(), useValue: redis },
    ],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  app.use(cookieParser());
  await listenOnLoopback(app);
  return { app, idp, redis, clock, endUsers, gateways, hostedChat, sso };
}

type H = Awaited<ReturnType<typeof harness>>;

/** Start a sign-in; returns the cookie jar, the relay state and the AuthnRequest ID. */
async function login(h: H, jar: Record<string, string> = {}) {
  let req = request(h.app.getHttpServer()).get('/public/chat/corp/auth/sso/login');
  if (Object.keys(jar).length) req = req.set('Cookie', cookieHeader(jar));
  const res = await req.expect(302);
  const location = res.headers.location as string;
  expect(location.startsWith(h.idp.entryPoint)).toBe(true);
  return {
    jar: { ...jar, ...cookiesFrom(res) },
    relayState: new URL(location).searchParams.get('RelayState')!,
    requestId: FakeSamlIdp.requestIdFrom(location),
  };
}

/** The IdP's form POST to the ACS: no cookies, as a cross-site POST arrives. */
async function postAcs(h: H, SAMLResponse: string, RelayState: string) {
  return request(h.app.getHttpServer())
    .post('/public/chat/corp/auth/sso/saml/acs')
    .type('form')
    .send({ SAMLResponse, RelayState })
    .expect(303);
}

async function complete(h: H, location: string, jar: Record<string, string>) {
  let req = request(h.app.getHttpServer()).get(location.replace(/^\/api/, ''));
  if (Object.keys(jar).length) req = req.set('Cookie', cookieHeader(jar));
  return req.expect(302);
}

describe('SAML sign-in for hosted chat visitors (HTTP)', () => {
  let h: H;
  afterEach(async () => h?.app.close());

  it('signs the visitor in through the org SAML IdP and rotates the session cookie', async () => {
    h = await harness();
    const { jar, relayState, requestId } = await login(h);
    expect(jar[HostedChatService.SESSION_COOKIE]).toBeDefined();
    expect(jar[HostedChatSsoController.SAML_STATE_COOKIE]).toBe(relayState);

    const acs = await postAcs(h, h.idp.response({ inResponseTo: requestId, acsUrl: ACS, audience: SP_ISSUER }), relayState);
    expect(acs.headers.location).toMatch(/^\/api\/public\/chat\/corp\/auth\/sso\/saml\/complete\?handoff=[0-9a-f]{64}$/);
    // Nothing is bound on the cookie-less POST.
    expect(h.endUsers.rows()[0].authProvider).toBeNull();

    const done = await complete(h, acs.headers.location, jar);
    expect(done.headers.location).toBe('/');
    const rotated = cookiesFrom(done)[HostedChatService.SESSION_COOKIE];
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(jar[HostedChatService.SESSION_COOKIE]);
    const [row] = h.endUsers.rows();
    expect(row).toMatchObject({ authProvider: 'sso', externalId: 'saml|https://idp.corp.test|ada@corp.test', email: 'ada@corp.test' });
    expect(row.sessionKey).toBe(rotated);
    expect(h.hostedChat.isAuthorized(h.gateways[0], row)).toBe(true);
  });

  it('refuses an unsolicited response (no InResponseTo)', async () => {
    h = await harness();
    const { relayState } = await login(h);
    const acs = await postAcs(h, h.idp.response({ inResponseTo: null, acsUrl: ACS, audience: SP_ISSUER }), relayState);
    expect(acs.headers.location).toBe('/?signin_error=SIGN_IN_FAILED');
  });

  it("refuses a response that answers another sign-in's request", async () => {
    h = await harness();
    const other = await login(h);
    const mine = await login(h);
    const acs = await postAcs(h, h.idp.response({ inResponseTo: other.requestId, acsUrl: ACS, audience: SP_ISSUER }), mine.relayState);
    expect(acs.headers.location).toBe('/?signin_error=SIGN_IN_FAILED');
  });

  it('refuses a response whose signed assertion answers a different request than its envelope says', async () => {
    h = await harness();
    const other = await login(h);
    const mine = await login(h);
    const acs = await postAcs(
      h,
      h.idp.response({ inResponseTo: mine.requestId, subjectInResponseTo: other.requestId, acsUrl: ACS, audience: SP_ISSUER }),
      mine.relayState,
    );
    expect(acs.headers.location).toBe('/?signin_error=SIGN_IN_FAILED');
  });

  it('refuses an assertion not signed by the org IdP', async () => {
    h = await harness();
    const { relayState, requestId } = await login(h);
    const acs = await postAcs(h, h.idp.response({ inResponseTo: requestId, acsUrl: ACS, audience: SP_ISSUER, foreignKey: true }), relayState);
    expect(acs.headers.location).toBe('/?signin_error=SIGN_IN_FAILED');
  });

  it('refuses an assertion for another service provider', async () => {
    h = await harness();
    const { relayState, requestId } = await login(h);
    const acs = await postAcs(h, h.idp.response({ inResponseTo: requestId, acsUrl: ACS, audience: 'some-other-sp' }), relayState);
    expect(acs.headers.location).toBe('/?signin_error=SIGN_IN_FAILED');
  });

  it('a relay state is spent on first use and expires', async () => {
    h = await harness();
    const { relayState, requestId } = await login(h);
    const response = h.idp.response({ inResponseTo: requestId, acsUrl: ACS, audience: SP_ISSUER });
    expect((await postAcs(h, response, relayState)).headers.location).toMatch(/complete\?handoff=/);
    expect((await postAcs(h, response, relayState)).headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');

    const late = await login(h);
    h.clock.now += SAML_SIGN_IN_TTL_MS + 1;
    const res = await postAcs(h, h.idp.response({ inResponseTo: late.requestId, acsUrl: ACS, audience: SP_ISSUER }), late.relayState);
    expect(res.headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
  });

  it("binds nothing in a browser that did not start the sign-in (login CSRF), and spends the hand-off", async () => {
    h = await harness();
    // The attacker signs in at the IdP and captures the redirect to /complete...
    const attacker = await login(h);
    const acs = await postAcs(h, h.idp.response({ inResponseTo: attacker.requestId, acsUrl: ACS, audience: SP_ISSUER, nameId: 'mallory@corp.test' }), attacker.relayState);
    // ...and sends the victim, who has a chat session of their own, there.
    const victim = await login(h);
    const res = await complete(h, acs.headers.location, victim.jar);
    expect(res.headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
    expect(h.endUsers.rows().filter((r) => r.authProvider === 'sso')).toEqual([]);
    // Spent: not even the attacker's own browser can use it now.
    expect((await complete(h, acs.headers.location, attacker.jar)).headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
  });

  it('binds nothing when the state cookie matches but the chat session is someone else', async () => {
    h = await harness();
    const mine = await login(h);
    const acs = await postAcs(h, h.idp.response({ inResponseTo: mine.requestId, acsUrl: ACS, audience: SP_ISSUER }), mine.relayState);
    const stranger = await login(h);
    const mixed = { ...stranger.jar, [HostedChatSsoController.SAML_STATE_COOKIE]: mine.relayState };
    expect((await complete(h, acs.headers.location, mixed)).headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
    expect(h.endUsers.rows().filter((r) => r.authProvider === 'sso')).toEqual([]);
  });

  it('binds nothing without the state cookie set when this sign-in began, even for the right visitor', async () => {
    h = await harness();
    const { jar, relayState, requestId } = await login(h);
    const acs = await postAcs(h, h.idp.response({ inResponseTo: requestId, acsUrl: ACS, audience: SP_ISSUER }), relayState);
    const { [HostedChatSsoController.SAML_STATE_COOKIE]: _state, ...sessionOnly } = jar;
    expect((await complete(h, acs.headers.location, sessionOnly)).headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
    expect(h.endUsers.rows().filter((r) => r.authProvider === 'sso')).toEqual([]);
  });

  it('a hand-off expires', async () => {
    h = await harness();
    const { jar, relayState, requestId } = await login(h);
    const acs = await postAcs(h, h.idp.response({ inResponseTo: requestId, acsUrl: ACS, audience: SP_ISSUER }), relayState);
    h.clock.now += SAML_HANDOFF_TTL_MS + 1;
    expect((await complete(h, acs.headers.location, jar)).headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
  });

  it('claims each assertion in the replay cache: the same assertion is never accepted twice', async () => {
    h = await harness();
    const { requestId } = await login(h);
    const response = h.idp.response({ inResponseTo: requestId, acsUrl: ACS, audience: SP_ISSUER, assertionId: '_fixed-assertion' });
    await expect(h.sso.resolveHostedChatSamlVisitor('org-1', response, ACS, requestId)).resolves.toMatchObject({
      externalId: 'saml|https://idp.corp.test|ada@corp.test',
    });
    await expect(h.sso.resolveHostedChatSamlVisitor('org-1', response, ACS, requestId)).rejects.toMatchObject({
      message: expect.stringMatching(/already been used/),
    });
    expect(h.redis.commands.some((c) => c.name === 'set' && String(c.args[0]).startsWith('sso:saml:consumed:') && c.args.includes('NX'))).toBe(true);
  });

  it('an org configured for OIDC still goes through OIDC', async () => {
    h = await harness({ protocol: 'oidc' });
    const spy = jest.spyOn(h.sso, 'getOidcLoginUrl').mockResolvedValue({ url: 'https://oidc.idp/authorize', state: 's' });
    const res = await request(h.app.getHttpServer()).get('/public/chat/corp/auth/sso/login').expect(302);
    expect(res.headers.location).toBe('https://oidc.idp/authorize');
    expect(spy).toHaveBeenCalled();
  });
});

describe('hosted chat SAML is wired', () => {
  const src = readFileSync(join(__dirname, '..', 'hosted-chat-sso.controller.ts'), 'utf8');

  it('routes the ACS and the completion under the public chat prefix', () => {
    expect(src).toContain("@Post(':slug/auth/sso/saml/acs')");
    expect(src).toContain("@Get(':slug/auth/sso/saml/complete')");
  });

  it('binds only on completion, as sso, and takes relay and hand-off with GETDEL', () => {
    expect(src).toMatch(/async samlComplete[\s\S]*?\.bindAuthenticatedVisitor\(gateway, endUser, \{\s*provider: 'sso'/);
    const acs = src.slice(src.indexOf('async samlAcs'), src.indexOf('async samlComplete'));
    expect(acs).not.toMatch(/bindAuthenticatedVisitor/);
    expect((src.match(/this\.redis\.getdel\(/g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/this\.redis\.get\(/);
  });

  it('the visitor path claims assertions in the replay cache', () => {
    const svc = readFileSync(join(__dirname, '..', 'sso.service.ts'), 'utf8');
    const method = svc.slice(svc.indexOf('async resolveHostedChatSamlVisitor'), svc.indexOf('// ── OIDC'));
    expect(method).toMatch(/this\.samlReplay\.consume\(facts\)/);
    expect(method).toMatch(/validateInResponseTo: ValidateInResponseTo\.always/);
  });

  it('SsoModule registers the controller', () => {
    const mod = readFileSync(join(__dirname, '..', 'sso.module.ts'), 'utf8');
    expect(mod).toMatch(/controllers:\s*\[[\s\S]*?\bHostedChatSsoController\b/);
  });
});
