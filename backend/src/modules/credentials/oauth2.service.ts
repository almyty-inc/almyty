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
import { randomBytes, createHash } from 'crypto';

import { Credential, CredentialType } from '../../entities/credential.entity';
import { validateUrl } from '../../common/security/url-validator';

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

function generatePKCE() {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
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
  ): Promise<{ credentialId: string }> {
    if (!code || !state) {
      throw new BadRequestException('Missing code or state parameter');
    }

    // Retrieve and delete state from Redis
    const stateKey = `oauth2:state:${state}`;
    const raw = await this.redis.get(stateKey);

    if (!raw) {
      throw new UnauthorizedException(
        'Invalid or expired OAuth2 state. Please try again.',
      );
    }

    await this.redis.del(stateKey);

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
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenParams.toString(),
    });

    const tokenData = await tokenResponse.json();

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

    // Encrypt sensitive data before saving
    credential.encryptSensitiveData();

    const saved = await this.credentialRepository.save(credential);
    this.logger.log(
      `OAuth2 credential created: ${saved.id} (${saved.name}) for org ${organizationId}`,
    );

    return { credentialId: saved.id };
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
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenParams.toString(),
    });

    const tokenData = await tokenResponse.json();

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

    // Encrypt sensitive data before saving
    credential.encryptSensitiveData();

    const saved = await this.credentialRepository.save(credential);
    this.logger.log(
      `OAuth2 client credentials credential created: ${saved.id} for org ${organizationId}`,
    );

    return { credentialId: saved.id };
  }
}
