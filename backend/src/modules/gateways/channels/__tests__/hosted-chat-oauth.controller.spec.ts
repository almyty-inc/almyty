import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { HostedChatOAuthController } from '../hosted-chat-oauth.controller';
import { HostedChatService } from '../hosted-chat.service';
import { VisitorOAuthService, VISITOR_OAUTH_STATE_TTL_MS } from '../visitor-oauth.service';
import { VisitorOAuthConfigService, VisitorOAuthStore, visitorOAuthManagedBy } from '../visitor-oauth-config.service';
import { Gateway, GatewayStatus, GatewayType, VisitorOAuthConfig } from '../../../../entities/gateway.entity';
import { Credential } from '../../../../entities/credential.entity';
import { CredentialRefResolver } from '../../../credentials/credential-ref.resolver';
import { fakeRepository } from '../../../../test/fake-repository';
import { FakeRedis } from '../../../../test/fake-redis';
import { FakeIdp } from '../../../../test/fake-oidc-provider';
import { listenOnLoopback } from '../../../../test/http';
import { makeEnvelopeCryptoMock } from '../../../../test/envelope-crypto.mock';
import { ClauseModel, ExecutedQuery, RecordingQueryBuilder, matchingRows } from '../../__tests__/recording-query-builder';

/**
 * OAuth / OIDC visitor sign-in over real HTTP through Nest, against a
 * provider double that enforces what a real one does (single-use codes,
 * exact redirect URI, PKCE S256, client authentication, signed ID tokens).
 *
 * The provider is configured through VisitorOAuthConfigService, so the
 * client secret really goes through the credential store and comes back
 * out of it for the exchange.
 */

const SLUG_CLAUSES: ClauseModel = {
  'gateway.type = :type': (row, p) => row.type === p.type,
  "gateway.configuration -> 'hostedChat' ->> 'slug' = :slug": (row, p) => row.configuration?.hostedChat?.slug === p.slug,
};

function surface(slug: string, authMode: string, over: Partial<Gateway> = {}): Gateway {
  return Object.assign(new Gateway(), {
    id: `gw-${slug}`,
    organizationId: 'org-1',
    name: `${slug} chat`,
    type: GatewayType.HOSTED_CHAT,
    status: GatewayStatus.ACTIVE,
    agentId: 'agent-1',
    configuration: { hostedChat: { slug, appName: 'Acme Help', authMode } },
    customDomain: null,
    visitorOAuth: null,
    ...over,
  });
}

const cookieFrom = (res: request.Response): string | undefined =>
  ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith(`${HostedChatService.SESSION_COOKIE}=`));

/** Writes the column onto the in-memory gateway rows, like the SQL does. */
class MemoryOAuthStore implements VisitorOAuthStore {
  constructor(private readonly gateways: Gateway[]) {}
  async write(gatewayId: string, organizationId: string, config: VisitorOAuthConfig | null) {
    const row = this.gateways.find((g) => g.id === gatewayId && g.organizationId === organizationId);
    if (row) row.visitorOAuth = config ? JSON.parse(JSON.stringify(config)) : null;
  }
}

interface Harness {
  app: INestApplication;
  idp: FakeIdp;
  gateways: Gateway[];
  endUsers: ReturnType<typeof fakeRepository<any>>;
  credentials: ReturnType<typeof fakeRepository<Credential>>;
  redis: FakeRedis;
  clock: { now: number };
  hostedChat: HostedChatService;
  configService: VisitorOAuthConfigService;
}

async function harness(opts: { flavour?: 'oidc' | 'github'; allowedEmailDomains?: string[]; fetchImpl?: any } = {}): Promise<Harness> {
  process.env.NODE_ENV = 'test';
  process.env.HOSTED_CHAT_BASE_DOMAIN = 'almyty.app';
  const clock = { now: Date.parse('2026-09-24T10:00:00Z') };
  const idp = new FakeIdp({ flavour: opts.flavour ?? 'oidc' });
  const gateways = [
    surface('acme', 'oauth', { customDomain: { hostname: 'chat.acme.com', status: 'active', verificationToken: 't', verifiedAt: null, lastCheckedAt: null, lastError: null } }),
    surface('open', 'public_link'),
  ];
  const endUsers = fakeRepository<any>({ idPrefix: 'eu' });
  const credentials = fakeRepository<Credential>({ make: () => new Credential(), idPrefix: 'cred' });
  const credentialRefs = new CredentialRefResolver(credentials as any, makeEnvelopeCryptoMock());
  const redis = new FakeRedis(() => clock.now);

  const configService = new VisitorOAuthConfigService(
    {
      findManageable: async (id: string, organizationId: string) => {
        const g = gateways.find((x) => x.id === id && x.organizationId === organizationId);
        if (!g) throw new NotFoundException('Gateway not found');
        return g;
      },
    } as any,
    new MemoryOAuthStore(gateways),
    credentialRefs,
    idp.fetch as any,
  );
  if (opts.flavour === 'github') {
    await configService.set('gw-acme', 'org-1', 'admin', {
      preset: 'github',
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      allowedEmailDomains: opts.allowedEmailDomains,
    });
  } else {
    await configService.set('gw-acme', 'org-1', 'admin', {
      preset: 'oidc',
      discoveryUrl: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      allowedEmailDomains: opts.allowedEmailDomains,
    });
  }

  const gatewayRepository = {
    createQueryBuilder: jest.fn(
      (alias: string) =>
        new RecordingQueryBuilder(alias, {
          getMany: (query: ExecutedQuery) => matchingRows(query, gateways, SLUG_CLAUSES),
        }),
    ),
  };
  const hostedChat = new HostedChatService(
    gatewayRepository as any,
    endUsers as any,
    fakeRepository() as any,
    fakeRepository() as any,
    fakeRepository() as any,
  );
  const oauth = new VisitorOAuthService(redis as any, credentialRefs, opts.fetchImpl ?? (idp.fetch as any));

  const moduleRef = await Test.createTestingModule({
    controllers: [HostedChatOAuthController],
    providers: [
      { provide: HostedChatService, useValue: hostedChat },
      { provide: VisitorOAuthService, useValue: oauth },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await listenOnLoopback(app);
  return { app, idp, gateways, endUsers, credentials, redis, clock, hostedChat, configService };
}

/** Start a sign-in as a browser with (or without) a cookie; returns the cookie and the authorize URL. */
async function start(h: Harness, cookie?: string, host?: string) {
  let req = request(h.app.getHttpServer()).get('/public/chat/acme/auth/oauth/login');
  if (cookie) req = req.set('Cookie', cookie);
  if (host) req = req.set('Host', host);
  const res = await req.expect(302);
  return { cookie: cookieFrom(res) ?? cookie, authorizeUrl: res.headers.location as string };
}

/** Come back from the provider to the callback, as a browser holding `cookie`. */
async function callback(h: Harness, query: Record<string, string>, cookie?: string) {
  let req = request(h.app.getHttpServer()).get('/public/chat/acme/auth/oauth/callback').query(query);
  if (cookie) req = req.set('Cookie', cookie);
  return req.expect(302);
}

const ADA = { sub: 'ada-1', email: 'ada@acme.com', email_verified: true, name: 'Ada' };

// RSA key generation and the first openid-client import are slow on a busy machine.
jest.setTimeout(30_000);

describe('OAuth visitor sign-in (HTTP)', () => {
  let h: Harness;
  afterEach(async () => h?.app.close());

  it('sends the visitor to the provider with state, PKCE S256, a nonce and the exact redirect URI', async () => {
    h = await harness();
    const { authorizeUrl, cookie } = await start(h);
    expect(cookie).toBeDefined();
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://idp.test/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('https://acme.almyty.app/api/public/chat/acme/auth/oauth/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    // The verifier never leaves the server.
    expect(authorizeUrl).not.toContain('code_verifier');
  });

  it('signs the visitor in, rotates the session cookie, and the chat admits them', async () => {
    h = await harness();
    const { authorizeUrl, cookie } = await start(h);
    const back = h.idp.authorize(authorizeUrl, ADA);
    const res = await callback(h, back.query, cookie);
    expect(res.headers.location).toBe('/');

    const signedIn = cookieFrom(res);
    expect(signedIn).toBeDefined();
    expect(signedIn).not.toBe(cookie);
    const [row] = h.endUsers.rows();
    expect(`${HostedChatService.SESSION_COOKIE}=${row.sessionKey}`).toBe(signedIn);
    expect(row).toMatchObject({ authProvider: 'oauth', externalId: 'https://idp.test|ada-1', email: 'ada@acme.com', displayName: 'Ada' });
    expect(h.hostedChat.isAuthorized(h.gateways[0], row)).toBe(true);
    // The secret reached the provider from the credential store, and every
    // server-side call went through the injected (SSRF-gated in production) fetch.
    expect(h.idp.requests).toEqual(expect.arrayContaining(['https://idp.test/token', 'https://idp.test/jwks']));
  });

  it('a state is spent on first use: replaying the callback signs nobody in', async () => {
    h = await harness();
    const { authorizeUrl, cookie } = await start(h);
    const back = h.idp.authorize(authorizeUrl, ADA);
    const first = await callback(h, back.query, cookie);
    const signedIn = cookieFrom(first)!;
    const replay = await callback(h, back.query, signedIn);
    expect(replay.headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
    expect(cookieFrom(replay)).toBeUndefined();
  });

  it('a callback from another browser is refused and spends the state (login CSRF)', async () => {
    h = await harness();
    // The attacker starts a sign-in and gets a code for their own account...
    const attacker = await start(h);
    const back = h.idp.authorize(attacker.authorizeUrl, { sub: 'mallory', email: 'm@evil.test', email_verified: true });
    // ...and lures a victim, who has their own chat session, to the callback.
    const victimVisit = await start(h);
    const res = await callback(h, back.query, victimVisit.cookie);
    expect(res.headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
    expect(cookieFrom(res)).toBeUndefined();
    expect(h.endUsers.rows().filter((r) => r.authProvider === 'oauth')).toEqual([]);
    // The state is gone even for the browser that started it.
    const late = await callback(h, back.query, attacker.cookie);
    expect(late.headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
  });

  it('a callback without the session cookie is refused', async () => {
    h = await harness();
    const { authorizeUrl } = await start(h);
    const back = h.idp.authorize(authorizeUrl, ADA);
    const res = await callback(h, back.query);
    expect(res.headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
    expect(h.endUsers.rows().every((r) => r.authProvider === null)).toBe(true);
  });

  it('a state expires after ten minutes', async () => {
    h = await harness();
    const { authorizeUrl, cookie } = await start(h);
    const back = h.idp.authorize(authorizeUrl, ADA);
    h.clock.now += VISITOR_OAUTH_STATE_TTL_MS + 1;
    const res = await callback(h, back.query, cookie);
    expect(res.headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
  });

  it('an unknown or missing state is refused', async () => {
    h = await harness();
    const { authorizeUrl, cookie } = await start(h);
    const back = h.idp.authorize(authorizeUrl, ADA);
    expect((await callback(h, { code: back.query.code, state: 'forged' }, cookie)).headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
    expect((await callback(h, { code: back.query.code }, cookie)).headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
  });

  it('an ID token with the wrong nonce is refused', async () => {
    h = await harness();
    h.idp.tamper.nonce = 'someone-elses-nonce';
    const { authorizeUrl, cookie } = await start(h);
    const res = await callback(h, h.idp.authorize(authorizeUrl, ADA).query, cookie);
    expect(res.headers.location).toBe('/?signin_error=SIGN_IN_FAILED');
    expect(h.endUsers.rows()[0].authProvider).toBeNull();
  });

  it('an ID token from another issuer is refused', async () => {
    h = await harness();
    h.idp.tamper.issuer = 'https://evil.test';
    const { authorizeUrl, cookie } = await start(h);
    const res = await callback(h, h.idp.authorize(authorizeUrl, ADA).query, cookie);
    expect(res.headers.location).toBe('/?signin_error=SIGN_IN_FAILED');
  });

  it('an ID token for another client is refused', async () => {
    h = await harness();
    h.idp.tamper.audience = 'another-client';
    const { authorizeUrl, cookie } = await start(h);
    const res = await callback(h, h.idp.authorize(authorizeUrl, ADA).query, cookie);
    expect(res.headers.location).toBe('/?signin_error=SIGN_IN_FAILED');
  });

  it('an ID token not signed by the provider keys is refused', async () => {
    h = await harness();
    h.idp.tamper.foreignKey = true;
    const { authorizeUrl, cookie } = await start(h);
    const res = await callback(h, h.idp.authorize(authorizeUrl, ADA).query, cookie);
    expect(res.headers.location).toBe('/?signin_error=SIGN_IN_FAILED');
  });

  it('a wrong client secret fails the exchange', async () => {
    h = await harness();
    h.idp.clientSecret = 'rotated-at-the-provider';
    const { authorizeUrl, cookie } = await start(h);
    const res = await callback(h, h.idp.authorize(authorizeUrl, ADA).query, cookie);
    expect(res.headers.location).toBe('/?signin_error=SIGN_IN_FAILED');
  });

  it('a provider error is reported and spends the state', async () => {
    h = await harness();
    const { authorizeUrl, cookie } = await start(h);
    const state = new URL(authorizeUrl).searchParams.get('state')!;
    const res = await callback(h, { error: 'access_denied', state }, cookie);
    expect(res.headers.location).toBe('/?signin_error=SIGN_IN_DENIED');
    expect(h.redis.keys()).toEqual([]);
  });

  it('a provider changed mid-sign-in invalidates the pending state', async () => {
    h = await harness();
    const { authorizeUrl, cookie } = await start(h);
    const back = h.idp.authorize(authorizeUrl, ADA);
    h.clock.now += 1000;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await h.configService.set('gw-acme', 'org-1', 'admin', { preset: 'oidc', discoveryUrl: h.idp.issuer, clientId: h.idp.clientId, scopes: 'openid email' });
    const res = await callback(h, back.query, cookie);
    expect(res.headers.location).toBe('/?signin_error=SIGN_IN_EXPIRED');
  });

  describe('allowed email domains', () => {
    it('admits a provider-verified address on an allowed domain', async () => {
      h = await harness({ allowedEmailDomains: ['acme.com'] });
      const { authorizeUrl, cookie } = await start(h);
      const res = await callback(h, h.idp.authorize(authorizeUrl, ADA).query, cookie);
      expect(res.headers.location).toBe('/');
    });

    it('refuses an address on another domain', async () => {
      h = await harness({ allowedEmailDomains: ['acme.com'] });
      const { authorizeUrl, cookie } = await start(h);
      const res = await callback(h, h.idp.authorize(authorizeUrl, { ...ADA, email: 'ada@other.com' }).query, cookie);
      expect(res.headers.location).toBe('/?signin_error=EMAIL_NOT_ALLOWED');
      expect(h.endUsers.rows()[0].authProvider).toBeNull();
    });

    it('refuses an allowed-looking address the provider did not verify', async () => {
      h = await harness({ allowedEmailDomains: ['acme.com'] });
      const { authorizeUrl, cookie } = await start(h);
      const res = await callback(h, h.idp.authorize(authorizeUrl, { ...ADA, email_verified: false }).query, cookie);
      expect(res.headers.location).toBe('/?signin_error=EMAIL_NOT_ALLOWED');
    });

    it('does not record an unverified address on the visitor when no domain rule applies', async () => {
      h = await harness();
      const { authorizeUrl, cookie } = await start(h);
      await callback(h, h.idp.authorize(authorizeUrl, { ...ADA, email_verified: false }).query, cookie);
      expect(h.endUsers.rows()[0]).toMatchObject({ authProvider: 'oauth', email: null });
    });
  });

  it('on the verified custom domain the redirect URI is that domain; any other Host gets the subdomain', async () => {
    h = await harness();
    const custom = await start(h, undefined, 'chat.acme.com');
    expect(new URL(custom.authorizeUrl).searchParams.get('redirect_uri')).toBe('https://chat.acme.com/api/public/chat/acme/auth/oauth/callback');
    const spoofed = await start(h, undefined, 'evil.example.com');
    expect(new URL(spoofed.authorizeUrl).searchParams.get('redirect_uri')).toBe('https://acme.almyty.app/api/public/chat/acme/auth/oauth/callback');
    // And the exchange uses the URI the sign-in started with.
    const res = await callback(h, h.idp.authorize(custom.authorizeUrl, ADA).query, custom.cookie);
    expect(res.headers.location).toBe('/');
  });

  it('with the production fetch, a token endpoint on a private address is refused before any socket opens', async () => {
    h = await harness({ fetchImpl: undefined });
    await h.app.close();
    // Same surface, but the flow service uses the default, SSRF-gated fetch.
    const credentialRefs = new CredentialRefResolver(h.credentials as any, makeEnvelopeCryptoMock());
    const gated = new VisitorOAuthService(h.redis as any, credentialRefs);
    const gw = h.gateways[0];
    gw.visitorOAuth = { ...gw.visitorOAuth!, tokenEndpoint: 'https://169.254.169.254/token', jwksUri: null };
    const endUser = { id: 'eu-x' } as any;
    const url = await gated.begin(gw, endUser, undefined);
    const back = h.idp.authorize(url.replace('https://idp.test/authorize', h.idp.endpoints.authorization), ADA);
    await expect(gated.finish(gw, endUser, back.query)).rejects.toMatchObject({ code: 'SIGN_IN_FAILED' });
  });

  it('refuses a surface that is not set to OAuth sign-in', async () => {
    h = await harness();
    const res = await request(h.app.getHttpServer()).get('/public/chat/open/auth/oauth/login').expect(400);
    expect(res.body.code).toBe('AUTH_MODE_MISMATCH');
  });

  it('a surface with no provider sends the visitor back with a reason instead of a dead link', async () => {
    h = await harness();
    h.gateways[0].visitorOAuth = null;
    const res = await request(h.app.getHttpServer()).get('/public/chat/acme/auth/oauth/login').expect(302);
    expect(res.headers.location).toBe('/?signin_error=SIGN_IN_UNAVAILABLE');
    expect(await h.hostedChat.authModeAvailable(h.gateways[0])).toBe(false);
  });

  describe('GitHub', () => {
    it('signs in with the numeric id and only a verified primary address', async () => {
      h = await harness({ flavour: 'github' });
      h.idp.githubEmails.set('4242', [
        { email: 'typed@acme.com', primary: false, verified: false },
        { email: 'Ada@Acme.com', primary: true, verified: true },
      ]);
      const { authorizeUrl, cookie } = await start(h);
      const url = new URL(authorizeUrl);
      expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
      expect(url.searchParams.get('nonce')).toBeNull();
      const res = await callback(h, h.idp.authorize(authorizeUrl, { sub: '4242', name: 'Ada' }).query, cookie);
      expect(res.headers.location).toBe('/');
      expect(h.endUsers.rows()[0]).toMatchObject({ authProvider: 'oauth', externalId: 'github|4242', email: 'ada@acme.com' });
    });

    it('an unverified primary address does not pass a domain rule', async () => {
      h = await harness({ flavour: 'github', allowedEmailDomains: ['acme.com'] });
      h.idp.githubEmails.set('4242', [{ email: 'ada@acme.com', primary: true, verified: false }]);
      const { authorizeUrl, cookie } = await start(h);
      const res = await callback(h, h.idp.authorize(authorizeUrl, { sub: '4242', email: 'ada@acme.com' }).query, cookie);
      expect(res.headers.location).toBe('/?signin_error=EMAIL_NOT_ALLOWED');
    });
  });

  it('keeps the client secret in credentials only, managed by this surface', async () => {
    h = await harness();
    const stored = h.gateways[0].visitorOAuth!;
    expect(JSON.stringify(stored)).not.toContain(h.idp.clientSecret);
    const [row] = h.credentials.rows();
    expect(row.id).toBe(stored.credentialId);
    expect(CredentialRefResolver.isManagedBy(row, visitorOAuthManagedBy('gw-acme'))).toBe(true);
    expect(JSON.stringify(row.config)).not.toContain(h.idp.clientSecret);
  });
});

describe('OAuth visitor sign-in is wired into the app', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

  it('GatewaysModule registers both controllers, both services and the Postgres store', () => {
    const mod = src('gateways.module.ts');
    expect(mod).toMatch(/controllers:\s*\[[\s\S]*?\bHostedChatOAuthController\b/);
    expect(mod).toMatch(/controllers:\s*\[[\s\S]*?\bVisitorOAuthConfigController\b/);
    expect(mod).toMatch(/providers:\s*\[[\s\S]*?\bVisitorOAuthService\b/);
    expect(mod).toMatch(/providers:\s*\[[\s\S]*?\bVisitorOAuthConfigService\b/);
    expect(mod).toMatch(/provide:\s*VISITOR_OAUTH_STORE,\s*useClass:\s*PgVisitorOAuthStore/);
  });

  it('the callback binds through bindAuthenticatedVisitor as oauth and rotates the cookie', () => {
    const ctl = src('channels/hosted-chat-oauth.controller.ts');
    expect(ctl).toContain("@Get(':slug/auth/oauth/login')");
    expect(ctl).toContain("@Get(':slug/auth/oauth/callback')");
    expect(ctl).toMatch(/\.bindAuthenticatedVisitor\(gateway, endUser, \{\s*provider: 'oauth'/);
    expect(ctl).toMatch(/res\.cookie\(HostedChatService\.SESSION_COOKIE, bound\.issuedSessionKey/);
  });

  it('the flow uses the SSRF-safe fetch by default and takes states with GETDEL', () => {
    const svc = src('channels/visitor-oauth.service.ts');
    expect(svc).toMatch(/private readonly fetchImpl: OutboundFetch = safeFetch/);
    expect(svc).toMatch(/client\[oidc\.customFetch\] = /);
    expect(svc).toMatch(/this\.redis\.getdel\(/);
    expect(svc).not.toMatch(/this\.redis\.get\(/);
    const cfg = src('channels/visitor-oauth-config.service.ts');
    expect(cfg).toMatch(/private readonly fetchImpl: OutboundFetch = safeFetch/);
  });

  it('the hosted chat page links to the login route and the dashboard calls the config routes', () => {
    const client = readFileSync(join(__dirname, '../../../../../../frontend/src/lib/hosted-chat.ts'), 'utf8');
    expect(client).toContain('/auth/oauth/login');
    const api = readFileSync(join(__dirname, '../../../../../../frontend/src/lib/api.ts'), 'utf8');
    expect(api).toContain('/visitor-oauth');
  });
});
