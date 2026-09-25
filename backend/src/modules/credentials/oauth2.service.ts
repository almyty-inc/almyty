import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';

import { Credential, CredentialType } from '../../entities/credential.entity';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { validateUrl, validateResponseSize } from '../../common/security/url-validator';
import { ssrfSafeDispatcher } from '../../common/security/safe-fetch';

export interface OAuth2Preset {
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  defaultScopes: string[];
  requiresPKCE: boolean;
}

interface AuthorizeParams {
  organizationId: string;
  userId: string;
  apiId?: string;
  provider?: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  redirectUri?: string;
  credentialName?: string;
  /** App path to return to after the callback (e.g. /apis/:id). */
  returnTo?: string;
}

interface ClientCredentialsParams {
  organizationId: string;
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  scopes?: string[];
  credentialName?: string;
  apiId?: string;
}

/**
 * A path in the app to send the browser back to after a sign-in, or null.
 * Only a same-origin path: a full URL or a protocol-relative one (//host)
 * would make the callback an open redirect.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^\/(?![\/\\])[A-Za-z0-9\-._~\/?=&%]*$/.test(value) || value.length > 512) return null;
  return value;
}

function generatePKCE() {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * PKCE (RFC 7636) primitives shared with the Connections layer. The
 * verifier is 32 random bytes, base64url; the challenge is its SHA-256,
 * base64url, method S256. Exported so a connector flow that keeps the
 * verifier server-side (keyed by state) uses the same construction as
 * the /oauth2 primitives.
 */
export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export function generatePkcePair(): PkcePair {
  const { codeVerifier, codeChallenge } = generatePKCE();
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

export function pkceChallengeFor(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/** True when `codeChallenge` is the S256 challenge of `codeVerifier` (constant-time). */
export function verifyPkceChallenge(codeVerifier: string, codeChallenge: string): boolean {
  const expected = Buffer.from(pkceChallengeFor(codeVerifier));
  const given = Buffer.from(codeChallenge);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/**
 * Both `authorizationUrl` and `tokenUrl` come from caller-controlled
 * request bodies on the OAuth2 authorize / client-credentials
 * endpoints. Authorization URL is returned to the browser for a
 * redirect; token URL is fetched server-side during callback and
 * client_credentials grant. Without validation:
 *
 *  - tokenUrl is a straight server-side SSRF — an authenticated
 *    caller can point it at 169.254.169.254, localhost, link-local,
 *    or any internal service and the server will POST to it
 *    (leaking IMDS creds, hitting Redis/Postgres, etc).
 *
 *  - authorizationUrl accepts any scheme from `new URL(...)`. That
 *    includes `javascript:` / `data:` / `file:` — the frontend will
 *    happily navigate to the returned string, which becomes a
 *    reflected XSS or a phishing landing page.
 *
 * Both must be http(s) and pass the SSRF guard that already exists
 * for the other external call-sites in this codebase.
 */
function assertSafeOAuthUrl(kind: 'authorizationUrl' | 'tokenUrl', value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException(`Invalid ${kind}: not a valid URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException(`${kind} must use http(s), got ${parsed.protocol}`);
  }
  const check = validateUrl(value);
  if (!check.valid) {
    throw new BadRequestException(`Refused ${kind}: ${check.error}`);
  }
}

/**
 * A token endpoint's reply is a few hundred bytes of JSON. `tokenUrl` is
 * supplied by an org admin and fetched server-side, so a hostile or
 * compromised endpoint can answer a megabyte-a-second stream instead, and
 * `await response.json()` will buffer all of it into the API process.
 *
 * The tool executors are already covered: they go through axios, whose
 * `maxContentLength` clamps the stream. These two call sites use native
 * `fetch`, which has no such option — which is why `validateResponseSize`
 * exists in common/security and, until this was wired, had no caller
 * outside its own unit test.
 *
 * Declared size is checked first (cheap, and rejects before a byte of body
 * is read); an undeclared or chunked length falls through to reading with
 * a hard byte budget, because `validateResponseSize` returns true for an
 * unknown length by design and a cap that a missing header switches off is
 * not a cap.
 */
const OAUTH_TOKEN_MAX_BYTES = 256 * 1024;

async function readTokenJson(response: Response): Promise<any> {
  const declared = response.headers.get('content-length');
  const contentLength = declared == null ? undefined : Number(declared);
  if (!validateResponseSize(contentLength, OAUTH_TOKEN_MAX_BYTES)) {
    throw new BadRequestException(
      `Token endpoint replied with ${contentLength} bytes, over the ${OAUTH_TOKEN_MAX_BYTES}-byte limit`,
    );
  }

  const body = await readCapped(response, OAUTH_TOKEN_MAX_BYTES);
  try {
    return JSON.parse(body);
  } catch {
    throw new BadRequestException('Token endpoint did not return JSON');
  }
}

/** Read a body, aborting once it passes `max` bytes rather than after. */
async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new BadRequestException(
        `Token endpoint body exceeded the ${max}-byte limit`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

@Injectable()
export class OAuth2Service {
  private readonly logger = new Logger(OAuth2Service.name);

  private static readonly PRESETS: Record<string, OAuth2Preset> = {
    microsoft: {
      name: 'Microsoft / Azure AD',
      authorizationUrl:
        'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl:
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      defaultScopes: ['openid', 'offline_access'],
      requiresPKCE: true,
    },
    google: {
      name: 'Google',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      defaultScopes: [],
      requiresPKCE: true,
    },
    slack: {
      name: 'Slack',
      authorizationUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      defaultScopes: [],
      requiresPKCE: false,
    },
    github: {
      name: 'GitHub',
      authorizationUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      defaultScopes: [],
      requiresPKCE: false,
    },
    salesforce: {
      name: 'Salesforce',
      authorizationUrl:
        'https://login.salesforce.com/services/oauth2/authorize',
      tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
      defaultScopes: ['api', 'refresh_token'],
      requiresPKCE: true,
    },
  };

  private static readonly STATE_TTL = 600; // 10 minutes

  constructor(
    @InjectRepository(Credential)
    private readonly credentialRepository: Repository<Credential>,
    @InjectRedis() private readonly redis: Redis.Redis,
    private readonly envelopeCrypto: EnvelopeCryptoService,
  ) {}

  /**
   * Returns the list of OAuth2 provider presets.
   */
  getPresets(): Record<string, OAuth2Preset> {
    return { ...OAuth2Service.PRESETS };
  }

  /**
   * Generates an authorization URL and stores PKCE + state in Redis.
   */
  async generateAuthorizationUrl(
    params: AuthorizeParams,
  ): Promise<{ authorizationUrl: string; state: string }> {
    const {
      organizationId,
      userId,
      apiId,
      provider,
      clientId,
      clientSecret,
      scopes,
      redirectUri,
      credentialName,
    } = params;

    if (!clientId) {
      throw new BadRequestException('clientId is required');
    }
    if (!clientSecret) {
      throw new BadRequestException('clientSecret is required');
    }

    // Resolve URLs from preset or from explicit params
    let authorizationUrl = params.authorizationUrl;
    let tokenUrl = params.tokenUrl;
    let resolvedScopes = scopes || [];
    let usePKCE = false;

    if (provider && OAuth2Service.PRESETS[provider]) {
      const preset = OAuth2Service.PRESETS[provider];
      authorizationUrl = authorizationUrl || preset.authorizationUrl;
      tokenUrl = tokenUrl || preset.tokenUrl;
      if (resolvedScopes.length === 0) {
        resolvedScopes = preset.defaultScopes;
      }
      usePKCE = preset.requiresPKCE;
    }

    if (!authorizationUrl) {
      throw new BadRequestException(
        'authorizationUrl is required (or specify a known provider)',
      );
    }
    if (!tokenUrl) {
      throw new BadRequestException(
        'tokenUrl is required (or specify a known provider)',
      );
    }

    // Both URLs are user-controlled when no preset is selected (and
    // even with a preset, tokenUrl/authorizationUrl can be overridden
    // via params). Reject anything that isn't a public http(s)
    // endpoint before we store it in Redis or hand it back to the
    // browser. Presets are hardcoded public URLs and will pass.
    assertSafeOAuthUrl('authorizationUrl', authorizationUrl);
    assertSafeOAuthUrl('tokenUrl', tokenUrl);

    // Generate PKCE pair
    const { codeVerifier, codeChallenge } = generatePKCE();

    // Generate state token
    const state = randomBytes(32).toString('hex');

    // Resolve redirect URI
    const callbackUri =
      redirectUri ||
      process.env.OAUTH2_CALLBACK_URL ||
      `${process.env.API_BASE_URL || 'https://api.staging.almyty.com'}/credentials/oauth2/callback`;

    // Store state in Redis
    const statePayload = {
      organizationId,
      userId,
      apiId,
      clientId,
      clientSecret,
      tokenUrl,
      codeVerifier,
      redirectUri: callbackUri,
      scopes: resolvedScopes,
      credentialName: credentialName || `OAuth2 - ${provider || 'Custom'}`,
      // Where the browser goes after the callback: a path in the app only.
      returnTo: safeReturnPath(params.returnTo),
    };

    await this.redis.set(
      `oauth2:state:${state}`,
      JSON.stringify(statePayload),
      'EX',
      OAuth2Service.STATE_TTL,
    );

    // Build authorization URL
    const url = new URL(authorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUri);
    url.searchParams.set('state', state);

    if (resolvedScopes.length > 0) {
      url.searchParams.set('scope', resolvedScopes.join(' '));
    }

    if (usePKCE) {
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }

    this.logger.log(
      `OAuth2 authorization URL generated for org ${organizationId}, provider: ${provider || 'custom'}`,
    );

    return { authorizationUrl: url.toString(), state };
  }

  /**
   * Handles the OAuth2 callback: validates state, exchanges code for tokens, creates Credential.
   */
  async handleCallback(
    code: string,
    state: string,
  ): Promise<{ credentialId: string; returnTo: string | null }> {
    if (!code || !state) {
      throw new BadRequestException('Missing code or state parameter');
    }

    // Consume the state in one step. A GET followed by a DEL leaves a
    // window in which a replayed callback reads the same state, so one
    // authorization would be exchanged -- and a credential created --
    // twice. GETDEL (Redis 6.2+) reads and removes atomically: of any
    // number of concurrent callbacks carrying this state, exactly one
    // gets the payload.
    const stateKey = `oauth2:state:${state}`;
    const raw = await this.redis.getdel(stateKey);

    if (!raw) {
      throw new UnauthorizedException(
        'Invalid or expired OAuth2 state. Please try again.',
      );
    }

    const statePayload = JSON.parse(raw);
    const {
      organizationId,
      apiId,
      clientId,
      clientSecret,
      tokenUrl,
      codeVerifier,
      redirectUri,
      scopes,
      credentialName,
    } = statePayload;

    // Defence in depth: the state blob came from Redis, so under
    // normal flow tokenUrl was already validated in
    // generateAuthorizationUrl. Re-validate here in case the guard
    // there is ever relaxed or a state payload is crafted by another
    // code path — we must never fetch an internal URL on callback.
    assertSafeOAuthUrl('tokenUrl', tokenUrl);

    // Exchange authorization code for tokens
    const tokenParams = new URLSearchParams();
    tokenParams.set('grant_type', 'authorization_code');
    tokenParams.set('code', code);
    tokenParams.set('redirect_uri', redirectUri);
    tokenParams.set('client_id', clientId);
    tokenParams.set('client_secret', clientSecret);
    tokenParams.set('code_verifier', codeVerifier);

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      // SSRF: refuse redirects so a 302 from the token endpoint can't bounce this credential-bearing POST to an internal host.
      redirect: 'manual',
      // ...and pin DNS: tokenUrl passed validateUrl as a string, which says
      // nothing about what the name resolves to at connect time.
      dispatcher: ssrfSafeDispatcher,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenParams.toString(),
    } as RequestInit);

    const tokenData = await readTokenJson(tokenResponse);

    if (!tokenResponse.ok || tokenData.error) {
      const errorMsg =
        tokenData.error_description ||
        tokenData.error ||
        'Token exchange failed';
      this.logger.error(`OAuth2 token exchange failed: ${errorMsg}`);
      throw new BadRequestException(`Token exchange failed: ${errorMsg}`);
    }

    // Calculate expiration
    let expiresAt: Date | null = null;
    if (tokenData.expires_in) {
      expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
    }

    // Create credential entity
    const credential = this.credentialRepository.create({
      name: credentialName,
      type: CredentialType.OAUTH2,
      organizationId,
      apiId: apiId || null,
      scopes: scopes || [],
      expiresAt,
      config: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || null,
        tokenEndpoint: tokenUrl,
        clientId,
        clientSecret,
        tokenType: tokenData.token_type || 'Bearer',
      },
    });

    // Encrypt sensitive data before saving (org-aware envelope path).
    await credential.encryptSensitiveDataForOrg(this.envelopeCrypto);

    const saved = await this.credentialRepository.save(credential);
    this.logger.log(
      `OAuth2 credential created: ${saved.id} (${saved.name}) for org ${organizationId}`,
    );

    return { credentialId: saved.id, returnTo: safeReturnPath(statePayload.returnTo) };
  }

  /**
   * Performs a client_credentials grant and creates a Credential.
   */
  async clientCredentialsGrant(
    params: ClientCredentialsParams,
  ): Promise<{ credentialId: string }> {
    const {
      organizationId,
      clientId,
      clientSecret,
      tokenUrl,
      scopes,
      credentialName,
      apiId,
    } = params;

    if (!clientId || !clientSecret || !tokenUrl) {
      throw new BadRequestException(
        'clientId, clientSecret, and tokenUrl are required',
      );
    }

    // tokenUrl is fetched server-side with the client secret attached.
    // An authenticated org admin could otherwise target the metadata
    // service or any internal endpoint — refuse anything that isn't
    // a public http(s) URL.
    assertSafeOAuthUrl('tokenUrl', tokenUrl);

    const tokenParams = new URLSearchParams();
    tokenParams.set('grant_type', 'client_credentials');
    tokenParams.set('client_id', clientId);
    tokenParams.set('client_secret', clientSecret);

    if (scopes && scopes.length > 0) {
      tokenParams.set('scope', scopes.join(' '));
    }

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      // SSRF: refuse redirects so a 302 from the token endpoint can't bounce this credential-bearing POST to an internal host.
      redirect: 'manual',
      // ...and pin DNS: tokenUrl passed validateUrl as a string, which says
      // nothing about what the name resolves to at connect time.
      dispatcher: ssrfSafeDispatcher,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenParams.toString(),
    } as RequestInit);

    const tokenData = await readTokenJson(tokenResponse);

    if (!tokenResponse.ok || tokenData.error) {
      const errorMsg =
        tokenData.error_description ||
        tokenData.error ||
        'Client credentials grant failed';
      this.logger.error(`OAuth2 client credentials failed: ${errorMsg}`);
      throw new BadRequestException(
        `Client credentials grant failed: ${errorMsg}`,
      );
    }

    // Calculate expiration
    let expiresAt: Date | null = null;
    if (tokenData.expires_in) {
      expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
    }

    // Create credential entity
    const credential = this.credentialRepository.create({
      name: credentialName || 'OAuth2 Client Credentials',
      type: CredentialType.OAUTH2,
      organizationId,
      apiId: apiId || null,
      scopes: scopes || [],
      expiresAt,
      config: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || null,
        tokenEndpoint: tokenUrl,
        clientId,
        clientSecret,
        tokenType: tokenData.token_type || 'Bearer',
      },
    });

    // Encrypt sensitive data before saving (org-aware envelope path).
    await credential.encryptSensitiveDataForOrg(this.envelopeCrypto);

    const saved = await this.credentialRepository.save(credential);
    this.logger.log(
      `OAuth2 client credentials credential created: ${saved.id} for org ${organizationId}`,
    );

    return { credentialId: saved.id };
  }
}
