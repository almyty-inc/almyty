import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as oidc from 'openid-client';

import type { EndUser } from '../../../entities/end-user.entity';
import type { Gateway, VisitorOAuthConfig } from '../../../entities/gateway.entity';
import { safeFetch } from '../../../common/security/safe-fetch';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { hostedChatConfigFrom } from './hosted-chat.config';
import {
  OutboundFetch,
  VISITOR_OAUTH_FETCH,
  VisitorSignInErrorCode,
  emailDomainAllowed,
  isOidc,
  visitorOAuthConfigured,
  visitorOAuthRedirectUri,
} from './visitor-oauth';
/**
 * The visitor half of hosted chat OAuth: send a visitor to the surface's
 * provider and turn what comes back into a verified identity.
 *
 * Every sign-in carries a state, a PKCE S256 verifier and, for OpenID
 * Connect, a nonce. They live in Redis under the state for ten minutes,
 * bound to the surface and to the visitor row behind the session cookie
 * that started the sign-in, and are taken with GETDEL: a callback can use
 * a state once, and only from the browser that asked for it (login CSRF
 * plants a code minted for someone else's session; this refuses it).
 *
 * The redirect URI is exact and built from configuration: the surface's
 * own subdomain or its verified custom domain, never an arbitrary Host
 * header. The code is exchanged server-side through openid-client with
 * the shared SSRF-safe fetch, so a provider endpoint that resolves to an
 * internal address is refused at connect time.
 */

export const VISITOR_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const STATE_PREFIX = 'hc:oauth:state:';

/** The Redis commands this needs. ioredis has both. */
export interface SignInStateStore {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
}

interface PendingSignIn {
  gatewayId: string;
  endUserId: string;
  redirectUri: string;
  codeVerifier: string;
  nonce: string | null;
  /** The provider configuration the sign-in was started against. */
  configVersion: string;
}

export interface VisitorIdentity {
  externalId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

/** A refusal the callback turns into a redirect with a reason code. */
export class VisitorOAuthError extends Error {
  constructor(readonly code: VisitorSignInErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'VisitorOAuthError';
  }
}

@Injectable()
export class VisitorOAuthService {
  private readonly logger = new Logger(VisitorOAuthService.name);

  constructor(
    @InjectRedis() private readonly redis: SignInStateStore,
    private readonly credentialRefs: CredentialRefResolver,
    @Optional() @Inject(VISITOR_OAUTH_FETCH) private readonly fetchImpl: OutboundFetch = safeFetch,
  ) {}

  /** Whether the surface has a provider a visitor can actually be sent to. */
  static configured(gateway: Pick<Gateway, 'visitorOAuth'>): boolean {
    return visitorOAuthConfigured(gateway.visitorOAuth);
  }

  /**
   * The redirect URI for the host the visitor is on: the verified custom
   * domain when that is where they are, the surface's subdomain otherwise.
   */
  static redirectUriFor(gateway: Pick<Gateway, 'configuration' | 'customDomain'>, requestHost: string | undefined): string {
    const slug = hostedChatConfigFrom(gateway.configuration).slug;
    const host = (requestHost ?? '').split(':')[0].trim().toLowerCase();
    const custom = gateway.customDomain?.status === 'active' ? gateway.customDomain.hostname : null;
    return visitorOAuthRedirectUri(slug, custom && host === custom ? custom : null);
  }

  /** Start a sign-in: record the pending state and return where to send the browser. */
  async begin(gateway: Gateway, endUser: EndUser, requestHost: string | undefined): Promise<string> {
    const config = gateway.visitorOAuth;
    if (!config || !VisitorOAuthService.configured(gateway)) throw new VisitorOAuthError('SIGN_IN_UNAVAILABLE');

    const state = oidc.randomState();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const nonce = isOidc(config) ? oidc.randomNonce() : null;
    const redirectUri = VisitorOAuthService.redirectUriFor(gateway, requestHost);

    const pending: PendingSignIn = {
      gatewayId: gateway.id,
      endUserId: endUser.id,
      redirectUri,
      codeVerifier,
      nonce,
      configVersion: config.updatedAt,
    };
    const stored = await this.redis.set(STATE_PREFIX + state, JSON.stringify(pending), 'PX', VISITOR_OAUTH_STATE_TTL_MS, 'NX');
    if (stored !== 'OK') throw new VisitorOAuthError('SIGN_IN_UNAVAILABLE', 'state not stored');

    const url = new URL(config.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', config.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (nonce) url.searchParams.set('nonce', nonce);
    return url.href;
  }

  /**
   * Finish a sign-in from the provider's redirect. Returns the identity or
   * throws VisitorOAuthError; never binds anything itself.
   */
  async finish(gateway: Gateway, endUser: EndUser, query: Record<string, unknown>): Promise<VisitorIdentity> {
    const state = typeof query.state === 'string' ? query.state : '';
    if (!state) throw new VisitorOAuthError('SIGN_IN_EXPIRED', 'no state');
    // Taken, not read: whatever happens next, this state is spent.
    const raw = await this.redis.getdel(STATE_PREFIX + state);
    if (!raw) throw new VisitorOAuthError('SIGN_IN_EXPIRED', 'unknown or used state');
    let pending: PendingSignIn;
    try {
      pending = JSON.parse(raw);
    } catch {
      throw new VisitorOAuthError('SIGN_IN_EXPIRED', 'unreadable state');
    }
    if (pending.gatewayId !== gateway.id || pending.endUserId !== endUser.id) {
      throw new VisitorOAuthError('SIGN_IN_EXPIRED', 'state belongs to another session');
    }
    if (typeof query.error === 'string') throw new VisitorOAuthError('SIGN_IN_DENIED', query.error);

    const config = gateway.visitorOAuth;
    if (!config || !VisitorOAuthService.configured(gateway)) throw new VisitorOAuthError('SIGN_IN_UNAVAILABLE');
    if (config.updatedAt !== pending.configVersion) throw new VisitorOAuthError('SIGN_IN_EXPIRED', 'provider changed');

    const client = await this.client(gateway, config);
    const currentUrl = new URL(pending.redirectUri);
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === 'string') currentUrl.searchParams.set(key, value);
    }

    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      tokens = await oidc.authorizationCodeGrant(client, currentUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: state,
        expectedNonce: pending.nonce ?? undefined,
        idTokenExpected: isOidc(config),
      });
    } catch (err) {
      this.logger.warn(`Visitor OAuth code exchange refused for gateway ${gateway.id}: ${err}`);
      throw new VisitorOAuthError('SIGN_IN_FAILED', 'code exchange');
    }

    const identity = await this.identity(client, config, tokens);
    if (!emailDomainAllowed(config.allowedEmailDomains, identity.email, identity.emailVerified)) {
      throw new VisitorOAuthError('EMAIL_NOT_ALLOWED');
    }
    return identity;
  }

  private async client(gateway: Gateway, config: VisitorOAuthConfig): Promise<oidc.Configuration> {
    const resolved = await this.credentialRefs
      .resolve(gateway.organizationId, config.credentialId!, {
        context: { purpose: 'hosted_chat_visitor_sign_in', resourceType: 'gateway', resourceId: gateway.id },
      })
      .catch((err) => {
        this.logger.warn(`Visitor OAuth secret for gateway ${gateway.id} is unusable: ${err?.message ?? err}`);
        throw new VisitorOAuthError('SIGN_IN_UNAVAILABLE', 'secret');
      });
    const secret = resolved.config.client_secret;
    if (typeof secret !== 'string' || !secret) throw new VisitorOAuthError('SIGN_IN_UNAVAILABLE', 'secret');

    const server: oidc.ServerMetadata = {
      // Plain OAuth 2.0 providers have no issuer; the authorization
      // server's origin stands in, and no ID token is checked against it.
      issuer: config.issuer ?? new URL(config.authorizationEndpoint).origin,
      authorization_endpoint: config.authorizationEndpoint,
      token_endpoint: config.tokenEndpoint,
      ...(config.userinfoEndpoint ? { userinfo_endpoint: config.userinfoEndpoint } : {}),
      ...(config.jwksUri ? { jwks_uri: config.jwksUri } : {}),
    };
    const auth = config.tokenEndpointAuthMethod === 'client_secret_basic'
      ? oidc.ClientSecretBasic(secret)
      : oidc.ClientSecretPost(secret);
    const client = new oidc.Configuration(server, config.clientId, undefined, auth);
    // Every request openid-client makes (token, JWKS, userinfo) goes
    // through the SSRF gate.
    client[oidc.customFetch] = (url: string, options: any) => this.fetchImpl(url, options);
    // Verify the ID token's signature against the provider's keys as well
    // as its claims, rather than relying on TLS to the token endpoint alone.
    if (isOidc(config) && config.jwksUri) oidc.enableNonRepudiationChecks(client);
    return client;
  }

  private async identity(
    client: oidc.Configuration,
    config: VisitorOAuthConfig,
    tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>,
  ): Promise<VisitorIdentity> {
    if (isOidc(config)) {
      const claims = tokens.claims();
      const sub = typeof claims?.sub === 'string' ? claims.sub : '';
      if (!sub) throw new VisitorOAuthError('SIGN_IN_FAILED', 'no subject');
      let email = typeof claims!.email === 'string' ? claims!.email : null;
      let verified = claims!.email_verified === true || (config.preset === 'microsoft' && claims!.xms_edov === true);
      let name = typeof claims!.name === 'string' ? claims!.name : null;
      if (!email && config.userinfoEndpoint) {
        const info = await oidc.fetchUserInfo(client, tokens.access_token, sub).catch(() => null);
        if (info) {
          email = typeof info.email === 'string' ? info.email : null;
          verified = info.email_verified === true || (config.preset === 'microsoft' && (info as any).xms_edov === true);
          name = name ?? (typeof info.name === 'string' ? info.name : null);
        }
      }
      return { externalId: `${config.issuer}|${sub}`, email: email?.toLowerCase() ?? null, emailVerified: verified, displayName: name };
    }

    // Plain OAuth 2.0: the identity comes from the user info endpoint.
    const user = await this.getJson(config.userinfoEndpoint!, tokens.access_token);
    const rawId = user?.sub ?? user?.id;
    const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : '';
    if (!id) throw new VisitorOAuthError('SIGN_IN_FAILED', 'no subject');
    const name = typeof user?.name === 'string' ? user.name : typeof user?.login === 'string' ? user.login : null;

    if (config.preset === 'github') {
      // GitHub's profile email is whatever the user typed as public; only
      // /user/emails says which address GitHub verified.
      const emails = await this.getJson('https://api.github.com/user/emails', tokens.access_token).catch(() => null);
      const primary = Array.isArray(emails) ? emails.find((e: any) => e?.primary === true && e?.verified === true) : null;
      return {
        externalId: `github|${id}`,
        email: typeof primary?.email === 'string' ? primary.email.toLowerCase() : null,
        emailVerified: !!primary,
        displayName: name,
      };
    }
    const email = typeof user?.email === 'string' ? user.email.toLowerCase() : null;
    return {
      externalId: `${new URL(config.tokenEndpoint).origin}|${id}`,
      email,
      emailVerified: user?.email_verified === true,
      displayName: name,
    };
  }

  private async getJson(url: string, accessToken: string): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
          // GitHub's API refuses requests without one.
          'user-agent': 'almyty-hosted-chat',
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.warn(`Visitor OAuth user info request failed: ${err}`);
      throw new VisitorOAuthError('SIGN_IN_FAILED', 'user info');
    }
    if (!res.ok) throw new VisitorOAuthError('SIGN_IN_FAILED', `user info ${res.status}`);
    return res.json();
  }
}
