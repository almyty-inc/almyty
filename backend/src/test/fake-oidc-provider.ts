import { createHash, createSign, generateKeyPairSync, KeyObject, randomBytes } from 'crypto';

/**
 * A truthful in-memory OAuth 2.0 / OpenID Connect provider for unit specs,
 * served through a `fetch` function.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 *
 * It enforces what a real provider enforces, so a client that skips a
 * step fails here the way it would in production: codes are single use
 * and expire, the redirect URI must match the one authorized exactly,
 * PKCE S256 is checked, the client must authenticate with the right
 * secret, and ID tokens are RS256-signed JWTs with iss, aud, exp, iat and
 * the nonce the client asked for. Knobs let a spec make the provider
 * misbehave (wrong nonce, wrong issuer, foreign signing key) to prove the
 * client notices.
 */

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export interface FakeUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  nonce: string | null;
  scope: string;
  user: FakeUser;
  expiresAt: number;
}

export interface FakeIdpOptions {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  /** 'oidc' issues ID tokens; 'github' behaves like GitHub's OAuth 2.0 + API. */
  flavour?: 'oidc' | 'github';
  now?: () => number;
}

export class FakeIdp {
  readonly issuer: string;
  readonly clientId: string;
  clientSecret: string;
  readonly flavour: 'oidc' | 'github';
  private readonly now: () => number;
  private readonly key: { privateKey: KeyObject; publicKey: KeyObject };
  private readonly foreignKey: { privateKey: KeyObject; publicKey: KeyObject };
  private readonly codes = new Map<string, IssuedCode>();
  private readonly accessTokens = new Map<string, FakeUser>();
  /** GitHub's /user/emails answer, per user sub. */
  githubEmails = new Map<string, Array<{ email: string; primary: boolean; verified: boolean }>>();
  /** Every URL the client fetched, in order. */
  readonly requests: string[] = [];
  /** Misbehaviour knobs. */
  tamper: { nonce?: string; issuer?: string; foreignKey?: boolean; audience?: string } = {};

  constructor(opts: FakeIdpOptions = {}) {
    this.issuer = opts.issuer ?? 'https://idp.test';
    this.clientId = opts.clientId ?? 'client-123';
    this.clientSecret = opts.clientSecret ?? 's3cret-value';
    this.flavour = opts.flavour ?? 'oidc';
    this.now = opts.now ?? (() => Date.now());
    this.key = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.foreignKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  }

  get endpoints() {
    const base = this.issuer;
    if (this.flavour === 'github') {
      return {
        authorization: 'https://github.com/login/oauth/authorize',
        token: 'https://github.com/login/oauth/access_token',
        userinfo: 'https://api.github.com/user',
        jwks: 'https://github.invalid/jwks',
        discovery: 'https://github.invalid/.well-known/openid-configuration',
      };
    }
    return {
      authorization: `${base}/authorize`,
      token: `${base}/token`,
      userinfo: `${base}/userinfo`,
      jwks: `${base}/jwks`,
      discovery: `${base}/.well-known/openid-configuration`,
    };
  }

  /**
   * What the provider does when the person consents at the authorize URL:
   * check the request, then redirect back with a code. Returns the query
   * of that redirect (code + state), or an error if the request is bad.
   */
  authorize(authorizeUrl: string, user: FakeUser): { redirectUri: string; query: Record<string, string> } {
    const url = new URL(authorizeUrl);
    if (`${url.origin}${url.pathname}` !== this.endpoints.authorization) throw new Error(`fake idp: not my authorize endpoint: ${url.href}`);
    const p = url.searchParams;
    if (p.get('response_type') !== 'code') throw new Error('fake idp: response_type must be code');
    if (p.get('client_id') !== this.clientId) throw new Error('fake idp: unknown client');
    const redirectUri = p.get('redirect_uri');
    if (!redirectUri) throw new Error('fake idp: redirect_uri required');
    const code = b64url(randomBytes(24));
    this.codes.set(code, {
      clientId: this.clientId,
      redirectUri,
      codeChallenge: p.get('code_challenge'),
      codeChallengeMethod: p.get('code_challenge_method'),
      nonce: p.get('nonce'),
      scope: p.get('scope') ?? '',
      user,
      expiresAt: this.now() + 60_000,
    });
    const query: Record<string, string> = { code };
    const state = p.get('state');
    if (state !== null) query.state = state;
    return { redirectUri, query };
  }

  /** The fetch a client is handed. */
  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    this.requests.push(url.href);
    const path = `${url.origin}${url.pathname}`;
    if (path === this.endpoints.jwks) return this.json({ keys: [this.jwk()] });
    if (path === this.endpoints.discovery) return this.json(this.discovery());
    if (path === this.endpoints.token && (init.method ?? 'GET').toUpperCase() === 'POST') return this.token(init);
    if (path === this.endpoints.userinfo) return this.userinfo(init);
    if (this.flavour === 'github' && path === 'https://api.github.com/user/emails') return this.githubUserEmails(init);
    return new Response('not found', { status: 404 });
  };

  discovery() {
    return {
      issuer: this.issuer,
      authorization_endpoint: this.endpoints.authorization,
      token_endpoint: this.endpoints.token,
      userinfo_endpoint: this.endpoints.userinfo,
      jwks_uri: this.endpoints.jwks,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
    };
  }

  private jwk() {
    return { ...this.key.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  private headersOf(init: RequestInit): Headers {
    return new Headers(init.headers as any);
  }

  private async token(init: RequestInit): Promise<Response> {
    const headers = this.headersOf(init);
    const body = new URLSearchParams(typeof init.body === 'string' ? init.body : init.body ? String(init.body) : '');

    // Client authentication: basic header or post body, exactly one.
    let clientId = body.get('client_id');
    let clientSecret = body.get('client_secret');
    const basic = headers.get('authorization');
    if (basic?.startsWith('Basic ')) {
      const [id, secret] = Buffer.from(basic.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
      clientId = id;
      clientSecret = secret;
    }
    if (clientId !== this.clientId || clientSecret !== this.clientSecret) {
      return this.json({ error: 'invalid_client' }, 401);
    }
    if (body.get('grant_type') !== 'authorization_code') return this.json({ error: 'unsupported_grant_type' }, 400);

    const code = body.get('code') ?? '';
    const issued = this.codes.get(code);
    // Single use: a code is gone the moment it is presented.
    this.codes.delete(code);
    if (!issued || issued.expiresAt < this.now()) return this.json({ error: 'invalid_grant' }, 400);
    if (body.get('redirect_uri') !== issued.redirectUri) return this.json({ error: 'invalid_grant', error_description: 'redirect_uri' }, 400);
    if (issued.codeChallenge) {
      const verifier = body.get('code_verifier');
      if (!verifier || issued.codeChallengeMethod !== 'S256') return this.json({ error: 'invalid_grant', error_description: 'pkce' }, 400);
      const computed = b64url(createHash('sha256').update(verifier).digest());
      if (computed !== issued.codeChallenge) return this.json({ error: 'invalid_grant', error_description: 'pkce' }, 400);
    }

    const accessToken = b64url(randomBytes(24));
    this.accessTokens.set(accessToken, issued.user);
    const response: Record<string, unknown> = { access_token: accessToken, token_type: 'bearer', expires_in: 3600, scope: issued.scope };
    if (this.flavour === 'oidc' && issued.scope.split(' ').includes('openid')) {
      response.id_token = this.idToken(issued);
    }
    return this.json(response);
  }

  private idToken(issued: IssuedCode): string {
    const nowS = Math.floor(this.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid: 'k1' };
    const claims: Record<string, unknown> = {
      iss: this.tamper.issuer ?? this.issuer,
      aud: this.tamper.audience ?? issued.clientId,
      sub: issued.user.sub,
      iat: nowS,
      exp: nowS + 300,
      ...(issued.user.email !== undefined ? { email: issued.user.email } : {}),
      ...(issued.user.email_verified !== undefined ? { email_verified: issued.user.email_verified } : {}),
      ...(issued.user.name ? { name: issued.user.name } : {}),
    };
    const nonce = this.tamper.nonce ?? issued.nonce;
    if (nonce) claims.nonce = nonce;
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = signer.sign(this.tamper.foreignKey ? this.foreignKey.privateKey : this.key.privateKey);
    return `${signingInput}.${b64url(signature)}`;
  }

  private bearer(init: RequestInit): FakeUser | null {
    const auth = this.headersOf(init).get('authorization') ?? '';
    const m = auth.match(/^Bearer (.+)$/i);
    return m ? this.accessTokens.get(m[1]) ?? null : null;
  }

  private userinfo(init: RequestInit): Response {
    const user = this.bearer(init);
    if (!user) return this.json({ error: 'invalid_token' }, 401);
    if (this.flavour === 'github') {
      return this.json({ id: Number(user.sub), login: `user${user.sub}`, name: user.name ?? null, email: user.email ?? null });
    }
    return this.json({ sub: user.sub, email: user.email, email_verified: user.email_verified, name: user.name });
  }

  private githubUserEmails(init: RequestInit): Response {
    const user = this.bearer(init);
    if (!user) return this.json({ message: 'Requires authentication' }, 401);
    return this.json(this.githubEmails.get(user.sub) ?? []);
  }
}
