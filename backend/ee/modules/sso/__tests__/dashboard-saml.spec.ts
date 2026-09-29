import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRedisConnectionToken } from '@nestjs-modules/ioredis';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { SsoController } from '../sso.controller';
import { SsoService } from '../sso.service';
import { SsoConfigService } from '../sso-config.service';
import { SamlReplayCache } from '../saml-replay-cache';
import { SAML_HANDOFF_TTL_MS, SAML_SIGN_IN_TTL_MS, SamlSignInStore } from '../saml-sign-in.store';
import { SSO_SAML_STATE_COOKIE } from '../sso.util';
import { AuthService } from '../../../../src/modules/auth/auth.service';
import { fakeRepository } from '../../../../src/test/fake-repository';
import { FakeRedis } from '../../../../src/test/fake-redis';
import { FakeSamlIdp } from '../../../../src/test/fake-saml-idp';
import { listenOnLoopback } from '../../../../src/test/http';
import { snapshotEnv } from '../../../../src/test/env';

/**
 * The dashboard's SAML login, over real HTTP, with really signed responses
 * that node-saml validates for real.
 *
 * Every dashboard SAML response has to answer a request this server issued
 * (stored under a single-use relay state, for a short time), be addressed
 * to this ACS (Recipient, Destination), and is turned into a session only
 * in the browser that started the sign-in. There is no IdP-initiated mode:
 * an unsolicited response signs nobody in, which is what closes login CSRF.
 */

jest.setTimeout(30_000);

const API = 'https://api.almyty.test';
const ORG = 'org-1';
const SP_ISSUER = 'almyty-sp';
const ACS = `${API}/sso/${ORG}/saml/callback`;

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

async function harness() {
  const clock = { now: Date.now() };
  const idp = new FakeSamlIdp();
  const redis = new FakeRedis(() => clock.now);
  const users = fakeRepository<any>([{ id: 'u-ada', email: 'ada@corp.test', isActive: true }]);
  const memberships = fakeRepository<any>([
    { id: 'm-ada', userId: 'u-ada', organizationId: ORG, isActive: true, inviteAccepted: true },
  ]);
  const samlConfig = {
    organizationId: ORG,
    protocol: 'saml',
    enabled: true,
    jitProvisioning: false,
    defaultRole: 'member',
    samlEntryPoint: idp.entryPoint,
    samlIssuer: SP_ISSUER,
    samlCert: idp.publicKeyPem,
  };
  const configService = { getDecrypted: async (orgId: string) => (orgId === ORG ? samlConfig : null) };
  const sso = new SsoService(users as any, memberships as any, configService as any, new SamlReplayCache(redis));
  const sessions: Array<{ userId: string; ssoOrganizationId: string }> = [];
  const auth = {
    generateTokens: async (user: any, options: any) => {
      sessions.push({ userId: user.id, ssoOrganizationId: options.ssoOrganizationId });
      return { accessToken: `session-for-${user.id}` };
    },
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [SsoController],
    providers: [
      { provide: SsoService, useValue: sso },
      { provide: AuthService, useValue: auth },
      { provide: SsoConfigService, useValue: configService },
      { provide: getRedisConnectionToken(), useValue: redis },
      SamlSignInStore,
    ],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  app.use(cookieParser());
  await listenOnLoopback(app);
  return { app, idp, clock, sessions };
}

type H = Awaited<ReturnType<typeof harness>>;

async function login(h: H) {
  const res = await request(h.app.getHttpServer()).get(`/sso/${ORG}/saml/login`).expect(302);
  const location = res.headers.location as string;
  expect(location.startsWith(h.idp.entryPoint)).toBe(true);
  return {
    jar: cookiesFrom(res),
    relayState: new URL(location).searchParams.get('RelayState')!,
    requestId: FakeSamlIdp.requestIdFrom(location),
  };
}

/** The IdP's form POST to the ACS: no cookies, as a cross-site POST arrives. */
function postAcs(h: H, body: Record<string, string>) {
  return request(h.app.getHttpServer()).post(`/sso/${ORG}/saml/callback`).type('form').send(body);
}

function complete(h: H, location: string, jar: Record<string, string>) {
  // Resolved as the browser resolves the relative Location against the ACS.
  const url = new URL(location, ACS);
  const path = url.pathname + url.search;
  let req = request(h.app.getHttpServer()).get(path);
  if (Object.keys(jar).length) req = req.set('Cookie', cookieHeader(jar));
  return req;
}

describe('dashboard SAML login (HTTP)', () => {
  let h: H;
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotEnv('PUBLIC_API_URL', 'SSO_SUCCESS_REDIRECT');
    process.env.PUBLIC_API_URL = API;
    process.env.SSO_SUCCESS_REDIRECT = 'https://app.almyty.test/';
  });
  afterEach(async () => {
    await h?.app.close();
    restore();
  });

  const valid = (h: H, requestId: string, extra: Record<string, unknown> = {}) =>
    h.idp.response({ inResponseTo: requestId, acsUrl: ACS, audience: SP_ISSUER, ...extra });

  it('signs the member in only after the browser that started it collects the response', async () => {
    h = await harness();
    const { jar, relayState, requestId } = await login(h);
    expect(jar[SSO_SAML_STATE_COOKIE]).toBe(relayState);

    const acs = await postAcs(h, { SAMLResponse: valid(h, requestId), RelayState: relayState }).expect(303);
    expect(acs.headers.location).toMatch(/^complete\?handoff=[0-9a-f]{64}$/);
    expect(h.sessions).toEqual([]);

    const done = await complete(h, acs.headers.location, jar).expect(302);
    expect(done.headers.location).toBe('https://app.almyty.test/');
    expect(cookiesFrom(done).access_token).toBe('session-for-u-ada');
    expect(h.sessions).toEqual([{ userId: 'u-ada', ssoOrganizationId: ORG }]);
  });

  it('refuses an IdP-initiated response: no relay state, no request of ours', async () => {
    h = await harness();
    await postAcs(h, { SAMLResponse: h.idp.response({ inResponseTo: null, acsUrl: ACS, audience: SP_ISSUER }) }).expect(401);
    expect(h.sessions).toEqual([]);
  });

  it('refuses an unsolicited response even when posted with a live relay state', async () => {
    h = await harness();
    const { relayState } = await login(h);
    await postAcs(h, { SAMLResponse: h.idp.response({ inResponseTo: null, acsUrl: ACS, audience: SP_ISSUER }), RelayState: relayState }).expect(401);
  });

  it("refuses a response that answers another sign-in's request", async () => {
    h = await harness();
    const other = await login(h);
    const mine = await login(h);
    await postAcs(h, { SAMLResponse: valid(h, other.requestId), RelayState: mine.relayState }).expect(401);
  });

  it('refuses a response whose Recipient is not this ACS', async () => {
    h = await harness();
    const { relayState, requestId } = await login(h);
    await postAcs(h, {
      SAMLResponse: valid(h, requestId, { recipient: 'https://other-sp.test/acs' }),
      RelayState: relayState,
    }).expect(401);
  });

  it('refuses a response with no Recipient', async () => {
    h = await harness();
    const { relayState, requestId } = await login(h);
    await postAcs(h, { SAMLResponse: valid(h, requestId, { recipient: null }), RelayState: relayState }).expect(401);
  });

  it('refuses a response whose Destination is not this ACS', async () => {
    h = await harness();
    const { relayState, requestId } = await login(h);
    await postAcs(h, {
      SAMLResponse: valid(h, requestId, { destination: `${API}/sso/org-2/saml/callback` }),
      RelayState: relayState,
    }).expect(401);
  });

  it('a relay state is spent on first use and expires', async () => {
    h = await harness();
    const first = await login(h);
    const response = valid(h, first.requestId);
    await postAcs(h, { SAMLResponse: response, RelayState: first.relayState }).expect(303);
    await postAcs(h, { SAMLResponse: response, RelayState: first.relayState }).expect(401);

    const late = await login(h);
    h.clock.now += SAML_SIGN_IN_TTL_MS + 1;
    await postAcs(h, { SAMLResponse: valid(h, late.requestId), RelayState: late.relayState }).expect(401);
  });

  it('signs nobody in when the completion is opened in a browser that did not start it (login CSRF)', async () => {
    h = await harness();
    // The attacker completes the IdP leg for their own account...
    const attacker = await login(h);
    const acs = await postAcs(h, { SAMLResponse: valid(h, attacker.requestId), RelayState: attacker.relayState }).expect(303);
    // ...and sends the victim, who started a sign-in of their own, to the completion.
    const victim = await login(h);
    const res = await complete(h, acs.headers.location, victim.jar).expect(401);
    expect(cookiesFrom(res).access_token).toBeUndefined();
    // And with no state cookie at all.
    await complete(h, acs.headers.location, {}).expect(401);
    expect(h.sessions).toEqual([]);
    // Spent: not even the attacker's own browser can use it now.
    await complete(h, acs.headers.location, attacker.jar).expect(401);
  });

  it('a hand-off expires', async () => {
    h = await harness();
    const { jar, relayState, requestId } = await login(h);
    const acs = await postAcs(h, { SAMLResponse: valid(h, requestId), RelayState: relayState }).expect(303);
    h.clock.now += SAML_HANDOFF_TTL_MS + 1;
    await complete(h, acs.headers.location, jar).expect(401);
  });
});
