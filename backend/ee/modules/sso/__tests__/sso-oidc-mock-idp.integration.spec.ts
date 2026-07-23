/**
 * REAL SSO OIDC authorization-code flow against a live mock OIDC issuer (#238).
 *
 * The unit spec (ee/modules/sso/__tests__/sso.service.spec.ts) injects a fake
 * OIDC client via `buildOidcClient`, so it never runs `openid-client`'s real
 * discovery, JWKS fetch, token exchange, or id_token signature/issuer/audience
 * validation. A bug in any of those — a malformed discovery URL, a JWKS the
 * library can't consume, an id_token the library rejects — would pass the
 * mocked test and only surface against a real IdP.
 *
 * This spec stands up `oauth2-mock-server` (a real, spec-compliant OIDC issuer
 * with /.well-known, JWKS, /authorize and /token endpoints), points an org's
 * OIDC config at its issuer, and runs the REAL SsoService OIDC path:
 *   getOidcLoginUrl()  -> real Issuer.discover + authorizationUrl
 *   handleOidcCallback -> real client.callback (token exchange + id_token
 *                         verification) -> JIT user + membership provisioning
 *
 * Gated behind RUN_EMULATOR_TESTS=1 (the mock server binds a loopback port);
 * skipped otherwise so normal CI is unaffected. No Docker needed — the issuer
 * is an in-process Node HTTP server.
 */
import { OAuth2Server } from 'oauth2-mock-server';
import { URL } from 'url';

import { SsoService } from '../sso.service';
import type { DecryptedSsoConfig } from '../sso-config.service';
import { User } from '../../../../src/entities/user.entity';
import {
  UserOrganization,
  OrganizationRole,
} from '../../../../src/entities/user-organization.entity';

const RUN = process.env.RUN_EMULATOR_TESTS === '1';
const d = RUN ? describe : describe.skip;

const ORG_ID = 'org-oidc-live';
const CLIENT_ID = 'almyty-oidc-client';
const CLIENT_SECRET = 'almyty-oidc-secret';
const REDIRECT_URI = 'http://localhost:9099/sso/org-oidc-live/oidc/callback';

/** Minimal in-memory User repo covering the surface SsoService.resolveUser uses. */
class InMemoryUserRepo {
  rows: User[] = [];
  private seq = 1;
  create(partial: Partial<User>): User {
    return { ...partial } as User;
  }
  async findOne({ where }: any): Promise<User | null> {
    return (
      this.rows.find((r) =>
        Object.entries(where).every(([k, v]) => (r as any)[k] === v),
      ) ?? null
    );
  }
  async save(user: User): Promise<User> {
    if (!user.id) user.id = `user-${this.seq++}`;
    const idx = this.rows.findIndex((r) => r.id === user.id);
    if (idx >= 0) this.rows[idx] = user;
    else this.rows.push(user);
    return user;
  }
}

class InMemoryMembershipRepo {
  rows: UserOrganization[] = [];
  create(partial: Partial<UserOrganization>): UserOrganization {
    return { ...partial } as UserOrganization;
  }
  async findOne({ where }: any): Promise<UserOrganization | null> {
    return (
      this.rows.find((r) =>
        Object.entries(where).every(([k, v]) => (r as any)[k] === v),
      ) ?? null
    );
  }
  async save(m: UserOrganization): Promise<UserOrganization> {
    this.rows.push(m);
    return m;
  }
}

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

d('SSO OIDC — real authorization-code flow vs oauth2-mock-server', () => {
  jest.setTimeout(60_000);

  let server: OAuth2Server;
  let issuerUrl: string;
  let userRepo: InMemoryUserRepo;
  let membershipRepo: InMemoryMembershipRepo;
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
    userRepo = new InMemoryUserRepo();
    membershipRepo = new InMemoryMembershipRepo();
    sso = new SsoService(userRepo as any, membershipRepo as any, {
      getDecrypted: async () => oidcConfig(issuerUrl),
    } as any);
  });

  /**
   * Drive the mock /authorize endpoint the same way a browser would, to obtain
   * a genuine authorization code bound to our state/redirect_uri.
   */
  async function fetchAuthCode(loginUrl: string): Promise<{
    code: string;
    state: string;
  }> {
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

  it('discovers the issuer and builds an authorization URL', async () => {
    const { url, state } = await sso.getOidcLoginUrl(ORG_ID);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toContain(issuerUrl);
    expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(parsed.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toContain('openid');
    expect(state).toHaveLength(32);
  });

  it('JIT-provisions a brand-new user + membership from a real id_token', async () => {
    nextClaims = {
      email: 'newhire@acme.test',
      given_name: 'New',
      family_name: 'Hire',
    };

    const { url, state } = await sso.getOidcLoginUrl(ORG_ID);
    const { code, state: returnedState } = await fetchAuthCode(url);
    expect(returnedState).toBe(state);

    const user = await sso.handleOidcCallback(
      ORG_ID,
      { code, state: returnedState },
      state,
    );

    // Real token exchange + id_token verification succeeded and mapped claims.
    expect(user.email).toBe('newhire@acme.test');
    expect(user.firstName).toBe('New');
    expect(user.lastName).toBe('Hire');
    expect(user.isVerified).toBe(true);

    // JIT provisioning created BOTH the user and the org membership.
    expect(userRepo.rows).toHaveLength(1);
    expect(membershipRepo.rows).toHaveLength(1);
    expect(membershipRepo.rows[0]).toMatchObject({
      userId: user.id,
      organizationId: ORG_ID,
      role: OrganizationRole.MEMBER,
      isActive: true,
    });
  });

  it('links an existing user to the org (no duplicate user) on OIDC login', async () => {
    userRepo.rows.push({
      id: 'existing-1',
      email: 'staff@acme.test',
      firstName: 'Staff',
      lastName: 'Member',
      isActive: true,
      isVerified: true,
    } as User);

    nextClaims = { email: 'staff@acme.test' };
    const { url, state } = await sso.getOidcLoginUrl(ORG_ID);
    const { code } = await fetchAuthCode(url);

    const user = await sso.handleOidcCallback(ORG_ID, { code, state }, state);

    expect(user.id).toBe('existing-1');
    // No new user row; membership provisioned for the existing user.
    expect(userRepo.rows).toHaveLength(1);
    expect(membershipRepo.rows).toHaveLength(1);
    expect(membershipRepo.rows[0].userId).toBe('existing-1');
  });

  it('rejects an id_token that carries no email claim', async () => {
    nextClaims = { given_name: 'No', family_name: 'Email' };
    const { url, state } = await sso.getOidcLoginUrl(ORG_ID);
    const { code } = await fetchAuthCode(url);

    await expect(
      sso.handleOidcCallback(ORG_ID, { code, state }, state),
    ).rejects.toThrow(/email/i);
  });
});
