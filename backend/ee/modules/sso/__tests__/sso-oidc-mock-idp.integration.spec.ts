/**
 * REAL SSO OIDC authorization-code flow against a live mock OIDC issuer (#238).
 *
 * The unit specs (oidc-callback-checks.spec.ts, sso.service.spec.ts) inject
 * a fake OIDC client via `buildOidcClient`, so they never run
 * `openid-client`'s real discovery, JWKS fetch, token exchange, PKCE, or
 * id_token signature / issuer / audience / nonce validation. A bug in any of
 * those would pass the mocked tests and only surface against a real IdP.
 *
 * This spec stands up `oauth2-mock-server` (a real OIDC issuer with
 * /.well-known, JWKS, /authorize and /token, which verifies an S256
 * `code_verifier` against the challenge and echoes the `nonce` into the
 * id_token), points an org's OIDC config at it, and runs the REAL
 * SsoService OIDC path:
 *   getOidcLoginUrl()   -> real discovery + authorization URL carrying
 *                          state, an S256 PKCE challenge and a nonce
 *   handleOidcCallback  -> real token exchange (code + verifier) and
 *                          id_token verification, nonce included, then
 *                          the member lookup / JIT provisioning
 *
 * The issuer is an in-process Node HTTP server on loopback: no Docker, no
 * network, so this runs with the rest of the suite. It used to be gated
 * behind RUN_EMULATOR_TESTS, which nothing set, and had drifted from the
 * flow it describes without anyone noticing -- it still expected an
 * existing non-member to be linked on sign-in, which the service stopped
 * doing (jit-never-adopts-an-existing-account.spec.ts).
 */
import { UnauthorizedException } from '@nestjs/common';
import { OAuth2Server } from 'oauth2-mock-server';
import { URL } from 'url';

import { SsoService } from '../sso.service';
import type { DecryptedSsoConfig } from '../sso-config.service';
import { MemoryOidcLoginStateStore, PendingOidcLogin } from '../oidc-login-state.store';
import { User } from '../../../../src/entities/user.entity';
import {
  UserOrganization,
  OrganizationRole,
} from '../../../../src/entities/user-organization.entity';
import { fakeRepository, FakeRepository } from '../../../../src/test/fake-repository';

const ORG_ID = 'org-oidc-live';
const CLIENT_ID = 'almyty-oidc-client';
const CLIENT_SECRET = 'almyty-oidc-secret';
const REDIRECT_URI = 'http://localhost:9099/sso/org-oidc-live/oidc/callback';

function oidcConfig(issuerUrl: string): DecryptedSsoConfig {
  return {
    organizationId: ORG_ID,
    enabled: true,
    protocol: 'oidc',
    jitProvisioning: true,
    defaultRole: OrganizationRole.MEMBER,
    oidcIssuerUrl: issuerUrl,
    oidcClientId: CLIENT_ID,
    oidcClientSecretPlain: CLIENT_SECRET,
    oidcRedirectUri: REDIRECT_URI,
  } as unknown as DecryptedSsoConfig;
}

/** The real memory store, with a hook to tamper with what a callback takes. */
class TamperableStore extends MemoryOidcLoginStateStore {
  tamper: ((pending: PendingOidcLogin) => PendingOidcLogin) | null = null;
  async take(state: string): Promise<PendingOidcLogin | null> {
    const pending = await super.take(state);
    return pending && this.tamper ? this.tamper(pending) : pending;
  }
}

describe('SSO OIDC — real authorization-code flow vs oauth2-mock-server', () => {
  jest.setTimeout(60_000);

  let server: OAuth2Server;
  let issuerUrl: string;
  let users: FakeRepository<User>;
  let memberships: FakeRepository<UserOrganization>;
  let store: TamperableStore;
  let sso: SsoService;

  // Claims the mock IdP will stamp into the next issued id_token.
  let nextClaims: Record<string, unknown> = {};

  beforeAll(async () => {
    server = new OAuth2Server();
    await server.issuer.keys.generate('RS256');
    await server.start(0, 'localhost');
    issuerUrl = server.issuer.url!;

    // Inject the asserted identity into every id_token the mock signs.
    server.service.on('beforeTokenSigning', (token: any) => {
      Object.assign(token.payload, nextClaims);
      token.payload.aud = CLIENT_ID;
    });
  });

  afterAll(async () => {
    if (server) await server.stop();
  });

  beforeEach(() => {
    nextClaims = {};
    users = fakeRepository<User>({ idPrefix: 'user' });
    memberships = fakeRepository<UserOrganization>({ idPrefix: 'membership' });
    store = new TamperableStore();
    sso = new SsoService(
      users as any,
      memberships as any,
      { getDecrypted: async () => oidcConfig(issuerUrl) } as any,
      undefined,
      store,
    );
  });

  /**
   * Drive the mock /authorize endpoint the same way a browser would, to obtain
   * a genuine authorization code bound to our state, challenge and nonce.
   */
  async function fetchAuthCode(loginUrl: string): Promise<{ code: string; state: string }> {
    const res = await fetch(loginUrl, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (!location) {
      throw new Error(`mock /authorize did not redirect: ${res.status}`);
    }
    const cb = new URL(location);
    const code = cb.searchParams.get('code');
    const state = cb.searchParams.get('state');
    if (!code || !state) {
      throw new Error(`callback URL missing code/state: ${location}`);
    }
    return { code, state };
  }

  async function signIn(): Promise<User> {
    const { url, state } = await sso.getOidcLoginUrl(ORG_ID);
    const { code, state: returnedState } = await fetchAuthCode(url);
    expect(returnedState).toBe(state);
    return sso.handleOidcCallback(ORG_ID, { code, state: returnedState }, state);
  }

  it('discovers the issuer and builds an authorization URL with PKCE and a nonce', async () => {
    const { url, state } = await sso.getOidcLoginUrl(ORG_ID);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toContain(issuerUrl);
    expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(parsed.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toContain('openid');
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parsed.searchParams.get('nonce')).toBeTruthy();
    expect(state).toHaveLength(32);
  });

  it('JIT-provisions a brand-new user + membership from a real id_token', async () => {
    nextClaims = { email: 'newhire@acme.test', given_name: 'New', family_name: 'Hire' };

    const user = await signIn();

    // Real token exchange (PKCE verified by the IdP) + id_token verification
    // (nonce included) succeeded and mapped claims.
    expect(user.email).toBe('newhire@acme.test');
    expect(user.firstName).toBe('New');
    expect(user.lastName).toBe('Hire');
    expect(user.isVerified).toBe(true);

    // JIT provisioning created BOTH the user and the org membership.
    expect(users.rows()).toHaveLength(1);
    expect(memberships.rows()).toHaveLength(1);
    expect(memberships.rows()[0]).toMatchObject({
      userId: user.id,
      organizationId: ORG_ID,
      role: OrganizationRole.MEMBER,
      isActive: true,
    });
  });

  it('signs an existing member in without creating anything', async () => {
    users.seed({ id: 'existing-1', email: 'staff@acme.test', isActive: true, isVerified: true } as User);
    memberships.seed({
      id: 'm-1',
      userId: 'existing-1',
      organizationId: ORG_ID,
      role: OrganizationRole.MEMBER,
      isActive: true,
      inviteAccepted: true,
    } as UserOrganization);
    nextClaims = { email: 'staff@acme.test' };

    const user = await signIn();

    expect(user.id).toBe('existing-1');
    expect(users.rows()).toHaveLength(1);
    expect(memberships.rows()).toHaveLength(1);
  });

  it('refuses an existing account that is not a member here, and adopts nothing', async () => {
    users.seed({ id: 'outsider', email: 'outsider@elsewhere.test', isActive: true } as User);
    nextClaims = { email: 'outsider@elsewhere.test' };

    await expect(signIn()).rejects.toBeInstanceOf(UnauthorizedException);
    expect(memberships.rows()).toHaveLength(0);
  });

  it('rejects an id_token that carries no email claim', async () => {
    nextClaims = { given_name: 'No', family_name: 'Email' };
    await expect(signIn()).rejects.toThrow(/email/i);
  });

  it('refuses a replayed callback: the state is good once', async () => {
    nextClaims = { email: 'newhire@acme.test' };
    const { url, state } = await sso.getOidcLoginUrl(ORG_ID);
    const { code } = await fetchAuthCode(url);
    await sso.handleOidcCallback(ORG_ID, { code, state }, state);

    await expect(sso.handleOidcCallback(ORG_ID, { code, state }, state)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses the code when the verifier does not match the challenge (the IdP checks PKCE)', async () => {
    nextClaims = { email: 'newhire@acme.test' };
    store.tamper = (pending) => ({ ...pending, codeVerifier: 'x'.repeat(43) });

    await expect(signIn()).rejects.toBeInstanceOf(UnauthorizedException);
    expect(users.rows()).toHaveLength(0);
  });

  it('refuses an id_token whose nonce is not the one this sign-in sent', async () => {
    nextClaims = { email: 'newhire@acme.test', nonce: 'minted-for-another-sign-in' };

    await expect(signIn()).rejects.toBeInstanceOf(UnauthorizedException);
    expect(users.rows()).toHaveLength(0);
  });
});
