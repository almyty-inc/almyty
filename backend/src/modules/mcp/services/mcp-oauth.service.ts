import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { OAuthClient } from '../../../entities/oauth-client.entity';
import { OAuthAuthorizationCode } from '../../../entities/oauth-authorization-code.entity';
import { OAuthAccessToken } from '../../../entities/oauth-access-token.entity';
import { Gateway } from '../../../entities/gateway.entity';

// --- Interfaces ---

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
}

export interface RegisterClientDto {
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
}

export interface ClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
  client_id_issued_at: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface TokenValidationResult {
  valid: boolean;
  clientId?: string;
  userId?: string;
  gatewayId?: string;
  organizationId?: string;
  scope?: string;
}

// --- Constants ---

const ACCESS_TOKEN_LIFETIME_SECONDS = 3600; // 1 hour
const REFRESH_TOKEN_LIFETIME_SECONDS = 30 * 24 * 3600; // 30 days
const AUTHORIZATION_CODE_LIFETIME_SECONDS = 600; // 10 minutes

const DEFAULT_SCOPES = ['tools:read', 'tools:execute'];
const ALLOWED_GRANT_TYPES = ['authorization_code', 'refresh_token'];
const ALLOWED_RESPONSE_TYPES = ['code'];
const ALLOWED_AUTH_METHODS = ['none', 'client_secret_post'];

/**
 * Hard caps on dynamic-client-registration input so the public
 * `/register` endpoint can't be turned into a DoS / storage-fill
 * vector. RFC 7591 is client-friendly by design — the authorization
 * server is supposed to accept registrations from anyone — which
 * makes these limits the only thing between a crafted loop and an
 * unbounded grow of the `oauth_clients` table.
 *
 * Values picked to be comfortably above any legitimate client
 * (a real OAuth client rarely has >5 redirect URIs or a client
 * name longer than a few dozen chars) and low enough that a
 * single attacker can't exhaust a commodity database.
 */
const MAX_CLIENT_NAME_LENGTH = 255;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_REDIRECT_URIS_PER_CLIENT = 20;
const MAX_CLIENTS_PER_GATEWAY = 500;

@Injectable()
export class McpOAuthService {
  private readonly logger = new Logger(McpOAuthService.name);

  constructor(
    @InjectRepository(OAuthClient)
    private oauthClientRepository: Repository<OAuthClient>,
    @InjectRepository(OAuthAuthorizationCode)
    private oauthCodeRepository: Repository<OAuthAuthorizationCode>,
    @InjectRepository(OAuthAccessToken)
    private oauthTokenRepository: Repository<OAuthAccessToken>,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
  ) {}

  // -----------------------------------------------------------------------
  // 1. Authorization Server Metadata (RFC 8414)
  // -----------------------------------------------------------------------

  getAuthorizationServerMetadata(
    gateway: Gateway,
    baseUrl: string,
  ): AuthorizationServerMetadata {
    const gatewayBase = `${baseUrl}/mcp/${gateway.organizationId}/${gateway.id}`;
    const scopes =
      (gateway.configuration?.oauth?.scopes as string[] | undefined) ??
      DEFAULT_SCOPES;

    return {
      issuer: baseUrl,
      authorization_endpoint: `${gatewayBase}/oauth/authorize`,
      token_endpoint: `${gatewayBase}/oauth/token`,
      registration_endpoint: `${gatewayBase}/oauth/register`,
      revocation_endpoint: `${gatewayBase}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: scopes,
    };
  }

  // -----------------------------------------------------------------------
  // 2. Protected Resource Metadata (RFC 9728)
  // -----------------------------------------------------------------------

  getProtectedResourceMetadata(
    gateway: Gateway,
    baseUrl: string,
  ): ProtectedResourceMetadata {
    const gatewayBase = `${baseUrl}/mcp/${gateway.organizationId}/${gateway.id}`;
    const scopes =
      (gateway.configuration?.oauth?.scopes as string[] | undefined) ??
      DEFAULT_SCOPES;

    return {
      resource: `${gatewayBase}/mcp`,
      authorization_servers: [
        `${gatewayBase}/.well-known/oauth-authorization-server`,
      ],
      scopes_supported: scopes,
    };
  }

  // -----------------------------------------------------------------------
  // 3. Dynamic Client Registration (RFC 7591)
  // -----------------------------------------------------------------------

  async registerClient(
    gatewayId: string,
    organizationId: string,
    dto: RegisterClientDto,
  ): Promise<ClientRegistrationResponse> {
    // Input caps — defence against unbounded registration payloads.
    // See MAX_* constants at the top of this file for rationale.
    if (typeof dto.client_name !== 'string' || dto.client_name.length === 0) {
      throw new BadRequestException('client_name is required');
    }
    if (dto.client_name.length > MAX_CLIENT_NAME_LENGTH) {
      throw new BadRequestException(
        `client_name exceeds ${MAX_CLIENT_NAME_LENGTH} characters`,
      );
    }

    // Validate redirect URIs
    if (!dto.redirect_uris || dto.redirect_uris.length === 0) {
      throw new BadRequestException('At least one redirect_uri is required');
    }
    if (dto.redirect_uris.length > MAX_REDIRECT_URIS_PER_CLIENT) {
      throw new BadRequestException(
        `Too many redirect_uris (max ${MAX_REDIRECT_URIS_PER_CLIENT})`,
      );
    }

    for (const uri of dto.redirect_uris) {
      if (typeof uri !== 'string' || uri.length === 0) {
        throw new BadRequestException('redirect_uri must be a non-empty string');
      }
      if (uri.length > MAX_REDIRECT_URI_LENGTH) {
        throw new BadRequestException(
          `redirect_uri exceeds ${MAX_REDIRECT_URI_LENGTH} characters`,
        );
      }
      this.validateRedirectUri(uri);
    }

    // Per-gateway quota — refuse if the gateway has already hit
    // the soft cap on registered clients. Protects against a
    // single misbehaving or adversarial integrator from
    // exhausting shared storage on behalf of every other
    // integrator on the same gateway.
    const existingCount = await this.oauthClientRepository.count({
      where: { gatewayId, isActive: true },
    });
    if (existingCount >= MAX_CLIENTS_PER_GATEWAY) {
      throw new BadRequestException(
        `Gateway has reached the maximum of ${MAX_CLIENTS_PER_GATEWAY} registered OAuth clients`,
      );
    }

    // Validate grant types
    const grantTypes = dto.grant_types ?? ['authorization_code'];
    for (const gt of grantTypes) {
      if (!ALLOWED_GRANT_TYPES.includes(gt)) {
        throw new BadRequestException(`Unsupported grant_type: ${gt}`);
      }
    }

    // Validate response types
    const responseTypes = dto.response_types ?? ['code'];
    for (const rt of responseTypes) {
      if (!ALLOWED_RESPONSE_TYPES.includes(rt)) {
        throw new BadRequestException(`Unsupported response_type: ${rt}`);
      }
    }

    // Validate token endpoint auth method
    const authMethod = dto.token_endpoint_auth_method ?? 'none';
    if (!ALLOWED_AUTH_METHODS.includes(authMethod)) {
      throw new BadRequestException(
        `Unsupported token_endpoint_auth_method: ${authMethod}`,
      );
    }

    // Generate client credentials
    const clientId = `mcp_client_${crypto.randomBytes(24).toString('base64url')}`;

    let clientSecret: string | undefined;
    let clientSecretHash: string | undefined;
    if (authMethod === 'client_secret_post') {
      clientSecret = crypto.randomBytes(48).toString('base64url');
      clientSecretHash = this.hashValue(clientSecret);
    }

    const scope = dto.scope ?? DEFAULT_SCOPES.join(' ');

    const client = this.oauthClientRepository.create({
      clientId,
      clientSecretHash: clientSecretHash ?? null,
      clientName: dto.client_name,
      redirectUris: dto.redirect_uris,
      grantTypes: grantTypes,
      responseTypes: responseTypes,
      tokenEndpointAuthMethod: authMethod,
      scope,
      gatewayId,
      organizationId,
      isActive: true,
    });

    await this.oauthClientRepository.save(client);

    this.logger.log(
      `OAuth client registered: ${clientId} for gateway ${gatewayId}`,
    );

    const response: ClientRegistrationResponse = {
      client_id: clientId,
      client_name: dto.client_name,
      redirect_uris: dto.redirect_uris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: authMethod,
      scope,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };

    if (clientSecret) {
      response.client_secret = clientSecret;
    }

    return response;
  }

  // -----------------------------------------------------------------------
  // 4. Create Authorization Code
  // -----------------------------------------------------------------------

  async createAuthorizationCode(
    clientId: string,
    userId: string,
    gatewayId: string,
    organizationId: string,
    params: {
      redirectUri: string;
      scope?: string;
      codeChallenge: string;
      codeChallengeMethod: string;
      state?: string;
    },
  ): Promise<string> {
    // Validate client
    const client = await this.oauthClientRepository.findOne({
      where: { clientId, gatewayId, isActive: true },
    });

    if (!client) {
      throw new BadRequestException('Invalid or inactive client');
    }

    // Validate redirect URI matches a registered URI
    if (!client.redirectUris.includes(params.redirectUri)) {
      throw new BadRequestException(
        'redirect_uri does not match any registered URI',
      );
    }

    // Only S256 is supported
    if (params.codeChallengeMethod !== 'S256') {
      throw new BadRequestException(
        'Only S256 code_challenge_method is supported',
      );
    }

    // Generate the raw authorization code
    const rawCode = crypto.randomBytes(32).toString('base64url');
    const codeHash = this.hashValue(rawCode);

    const expiresAt = new Date(
      Date.now() + AUTHORIZATION_CODE_LIFETIME_SECONDS * 1000,
    );

    const authCode = this.oauthCodeRepository.create({
      codeHash,
      clientId: client.clientId,
      userId,
      gatewayId,
      organizationId,
      redirectUri: params.redirectUri,
      scope: params.scope ?? client.scope,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      expiresAt,
      isUsed: false,
    });

    await this.oauthCodeRepository.save(authCode);

    this.logger.log(
      `Authorization code created for client ${clientId}, user ${userId}`,
    );

    return rawCode;
  }

  // -----------------------------------------------------------------------
  // 5. Token Exchange (authorization_code grant)
  // -----------------------------------------------------------------------

  async exchangeCode(
    codeValue: string,
    clientId: string,
    codeVerifier: string,
    redirectUri: string,
    /** Gateway id from the URL path. Required — the service used to
     *  look up codes by (hash, clientId) with no gateway filter, which
     *  let a code issued at `/mcp/orgA/gwA/...` be redeemed at
     *  `/mcp/orgB/gwB/token`. Cross-gateway code replay. */
    gatewayId: string,
    /** Only required for clients registered with `client_secret_post`.
     *  Previously the service ignored client secrets entirely — every
     *  "confidential" client was effectively public. */
    clientSecret?: string,
  ): Promise<TokenResponse> {
    // Load the client first so we can enforce the auth method. Missing
    // client => invalid_client; presented-without-needed secret =>
    // invalid_client; bad secret => invalid_client.
    const client = await this.oauthClientRepository.findOne({
      where: { clientId, gatewayId, isActive: true },
    });
    if (!client) {
      throw new UnauthorizedException('Invalid client');
    }
    this.verifyClientAuth(client, clientSecret);

    const codeHash = this.hashValue(codeValue);

    const authCode = await this.oauthCodeRepository.findOne({
      where: { codeHash, clientId, gatewayId },
    });

    if (!authCode) {
      throw new UnauthorizedException('Invalid authorization code');
    }

    if (authCode.isUsed) {
      // OAuth 2.1 §4.1.3: detect replay and limit blast radius. We
      // conservatively revoke EVERY non-revoked token issued to the
      // same (clientId, userId, gatewayId) triple — the stolen code
      // could have been used to produce any of them.
      this.logger.warn(
        `Authorization code replay detected for client ${clientId} — revoking issued tokens for this user+gateway`,
      );
      try {
        await this.oauthTokenRepository.update(
          {
            clientId: authCode.clientId,
            userId: authCode.userId,
            gatewayId: authCode.gatewayId,
            isRevoked: false,
          },
          { isRevoked: true },
        );
      } catch (err) {
        // Best-effort: a failure here shouldn't mask the rejection.
        this.logger.error(`Failed to revoke tokens on replay detection: ${err.message}`);
      }
      throw new UnauthorizedException(
        'Authorization code has already been used',
      );
    }

    if (new Date() > authCode.expiresAt) {
      throw new UnauthorizedException('Authorization code has expired');
    }

    if (authCode.redirectUri !== redirectUri) {
      throw new BadRequestException('redirect_uri mismatch');
    }

    // Verify PKCE: base64url(SHA-256(code_verifier)) must equal the stored code_challenge
    const computedChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    if (computedChallenge !== authCode.codeChallenge) {
      throw new UnauthorizedException('PKCE verification failed');
    }

    // Atomically mark the code as used. Previously this was a plain
    // `save(authCode)` which reads-then-writes — two concurrent
    // exchanges with the same stolen code both saw isUsed=false, both
    // passed, and both generated a valid token pair. The conditional
    // UPDATE + `affected` check is the whole race guard: exactly one
    // caller observes affected=1.
    const claim = await this.oauthCodeRepository.update(
      { id: authCode.id, isUsed: false },
      { isUsed: true },
    );
    if (claim.affected !== 1) {
      // Another caller raced us and consumed the code first. Treat as
      // a replay — the other caller has already generated tokens, and
      // honouring this exchange would produce a second (duplicate)
      // token pair bound to the same code.
      this.logger.warn(
        `Lost race on authorization code consumption for client ${clientId}`,
      );
      throw new UnauthorizedException(
        'Authorization code has already been used',
      );
    }

    // Generate token pair
    const tokens = await this.generateTokenPair(
      authCode.clientId,
      authCode.gatewayId,
      authCode.organizationId,
      authCode.userId,
      authCode.scope,
      redirectUri,
    );

    this.logger.log(`Token exchanged for client ${clientId}`);

    return tokens;
  }

  // -----------------------------------------------------------------------
  // 6. Refresh Token Grant
  // -----------------------------------------------------------------------

  async refreshToken(
    refreshTokenValue: string,
    clientId: string,
    gatewayId: string,
    clientSecret?: string,
  ): Promise<TokenResponse> {
    const client = await this.oauthClientRepository.findOne({
      where: { clientId, gatewayId, isActive: true },
    });
    if (!client) {
      throw new UnauthorizedException('Invalid client');
    }
    this.verifyClientAuth(client, clientSecret);

    const tokenHash = this.hashValue(refreshTokenValue);

    const existingToken = await this.oauthTokenRepository.findOne({
      where: { tokenHash, clientId, gatewayId, tokenType: 'refresh' },
    });

    if (!existingToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existingToken.isRevoked) {
      // OAuth 2.1 §6.1 / RFC 6749bis: reuse of a rotated (revoked)
      // refresh token is a strong indicator of token theft. Revoke
      // the ENTIRE lineage — every access and refresh token issued to
      // the same (clientId, userId, gatewayId) triple — so an attacker
      // who stole an intermediate token can't keep rolling the chain
      // forward while the legitimate user is unaware.
      this.logger.warn(
        `Revoked refresh token reuse detected for client ${clientId} — revoking entire token lineage for this user+gateway`,
      );
      try {
        await this.oauthTokenRepository.update(
          {
            clientId: existingToken.clientId,
            userId: existingToken.userId,
            gatewayId: existingToken.gatewayId,
            isRevoked: false,
          },
          { isRevoked: true },
        );
      } catch (err) {
        this.logger.error(
          `Failed to revoke lineage on reuse detection: ${err.message}`,
        );
      }
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    if (new Date() > existingToken.expiresAt) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    // Atomic rotation: only THIS caller should get to rotate the token.
    // Two concurrent refreshes with the same stolen refresh token would
    // previously both see isRevoked=false, both save `true`, and both
    // produce a fresh token pair — one of which would then look
    // legitimate to the lineage check above. Conditional UPDATE + affected
    // check closes the race.
    const claim = await this.oauthTokenRepository.update(
      { id: existingToken.id, isRevoked: false },
      { isRevoked: true },
    );
    if (claim.affected !== 1) {
      this.logger.warn(
        `Lost race on refresh token rotation for client ${clientId}`,
      );
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    // Generate a new token pair, linking the new refresh token's
    // parentTokenId back to the old one so the lineage is walkable.
    const tokens = await this.generateTokenPair(
      existingToken.clientId,
      existingToken.gatewayId,
      existingToken.organizationId,
      existingToken.userId,
      existingToken.scope,
      existingToken.resource ?? undefined,
      existingToken.id,
    );

    this.logger.log(`Token refreshed for client ${clientId}`);

    return tokens;
  }

  // -----------------------------------------------------------------------
  // 7. Validate Access Token
  // -----------------------------------------------------------------------

  async validateAccessToken(
    tokenValue: string,
  ): Promise<TokenValidationResult> {
    const tokenHash = this.hashValue(tokenValue);

    const token = await this.oauthTokenRepository.findOne({
      where: { tokenHash, tokenType: 'access' },
    });

    if (!token) {
      return { valid: false };
    }

    if (token.isRevoked) {
      return { valid: false };
    }

    if (new Date() > token.expiresAt) {
      return { valid: false };
    }

    return {
      valid: true,
      clientId: token.clientId,
      userId: token.userId,
      gatewayId: token.gatewayId,
      organizationId: token.organizationId,
      scope: token.scope,
    };
  }

  // -----------------------------------------------------------------------
  // 8. Revoke Token (RFC 7009)
  // -----------------------------------------------------------------------

  async revokeToken(
    tokenValue: string,
    clientId: string,
    gatewayId: string,
    clientSecret?: string,
  ): Promise<void> {
    // Load the client to enforce the auth method. If the client doesn't
    // exist in this gateway we silently return (RFC 7009 says the
    // server should still respond 200 for invalid requests), but an
    // EXISTING confidential client with a bad secret fails hard.
    const client = await this.oauthClientRepository.findOne({
      where: { clientId, gatewayId, isActive: true },
    });
    if (!client) {
      return;
    }
    this.verifyClientAuth(client, clientSecret);

    const tokenHash = this.hashValue(tokenValue);

    const token = await this.oauthTokenRepository.findOne({
      where: { tokenHash, clientId, gatewayId },
    });

    if (!token) {
      // RFC 7009: the server responds with HTTP 200 even if the token is invalid
      return;
    }

    // Revoke the token
    token.isRevoked = true;
    await this.oauthTokenRepository.save(token);

    // If revoking a refresh token, also revoke all associated access tokens
    if (token.tokenType === 'refresh') {
      await this.oauthTokenRepository.update(
        {
          clientId: token.clientId,
          userId: token.userId,
          gatewayId: token.gatewayId,
          tokenType: 'access',
          isRevoked: false,
        },
        { isRevoked: true },
      );

      this.logger.log(
        `Refresh token and associated access tokens revoked for client ${clientId}`,
      );
    } else {
      this.logger.log(`Access token revoked for client ${clientId}`);
    }
  }

  // -----------------------------------------------------------------------
  // 9. Generate Token Pair (internal helper)
  // -----------------------------------------------------------------------

  async generateTokenPair(
    clientId: string,
    gatewayId: string,
    organizationId: string,
    userId: string,
    scope: string,
    resource?: string,
    /** id of the refresh token this pair is rotated from, if any. Links
     *  the new refresh token to its predecessor via parentTokenId so the
     *  lineage is walkable and reuse-detection can revoke downstream. */
    parentRefreshTokenId?: string,
  ): Promise<TokenResponse> {
    const rawAccessToken = `almyty_at_${crypto.randomBytes(48).toString('base64url')}`;
    const rawRefreshToken = `almyty_rt_${crypto.randomBytes(48).toString('base64url')}`;

    const accessTokenHash = this.hashValue(rawAccessToken);
    const refreshTokenHash = this.hashValue(rawRefreshToken);

    const now = new Date();
    const accessExpiresAt = new Date(
      now.getTime() + ACCESS_TOKEN_LIFETIME_SECONDS * 1000,
    );
    const refreshExpiresAt = new Date(
      now.getTime() + REFRESH_TOKEN_LIFETIME_SECONDS * 1000,
    );

    const accessTokenEntity = this.oauthTokenRepository.create({
      tokenHash: accessTokenHash,
      tokenType: 'access',
      clientId,
      userId,
      gatewayId,
      organizationId,
      scope,
      resource: resource ?? null,
      expiresAt: accessExpiresAt,
      isRevoked: false,
      parentTokenId: parentRefreshTokenId ?? null,
    });

    const refreshTokenEntity = this.oauthTokenRepository.create({
      tokenHash: refreshTokenHash,
      tokenType: 'refresh',
      clientId,
      userId,
      gatewayId,
      organizationId,
      scope,
      resource: resource ?? null,
      expiresAt: refreshExpiresAt,
      isRevoked: false,
      parentTokenId: parentRefreshTokenId ?? null,
    });

    await this.oauthTokenRepository.save([accessTokenEntity, refreshTokenEntity]);

    return {
      access_token: rawAccessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
      refresh_token: rawRefreshToken,
      scope,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private hashValue(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  /**
   * Enforce the client's registered token-endpoint authentication method.
   * Previously the /token, /revoke, and refresh paths NEVER checked the
   * presented client_secret — even a client registered with
   * `client_secret_post` was effectively public, because the service
   * never took a clientSecret parameter. Any caller who knew the
   * clientId could exchange codes, refresh tokens, and revoke anything
   * on their behalf.
   *
   * Rules:
   * - Public client (`tokenEndpointAuthMethod === 'none'`): secret MUST
   *   NOT be presented. Presenting one is an error — prevents confusing
   *   "worked because we ignored it" behaviour during migration.
   * - Confidential client (`client_secret_post`): secret MUST be
   *   presented and MUST match the stored hash via a timing-safe
   *   comparison of the SHA-256 digests.
   */
  private verifyClientAuth(client: OAuthClient, presented?: string): void {
    const method = client.tokenEndpointAuthMethod || 'none';

    if (method === 'none') {
      if (presented !== undefined && presented !== '') {
        throw new UnauthorizedException(
          'Client is registered as public — client_secret must not be presented',
        );
      }
      return;
    }

    if (method === 'client_secret_post') {
      if (!client.clientSecretHash) {
        // Shouldn't happen — the registration path sets the hash when
        // the method is client_secret_post. If it's missing, refuse
        // rather than falling open.
        throw new UnauthorizedException('Client configuration is invalid');
      }
      if (!presented) {
        throw new UnauthorizedException(
          'client_secret is required for this client',
        );
      }

      const expected = Buffer.from(client.clientSecretHash, 'hex');
      const actual = Buffer.from(this.hashValue(presented), 'hex');
      if (
        expected.length !== actual.length ||
        !crypto.timingSafeEqual(expected, actual)
      ) {
        throw new UnauthorizedException('Invalid client_secret');
      }
      return;
    }

    // Any other method (client_secret_basic, private_key_jwt, etc.) is
    // not supported by this server and must be rejected.
    throw new UnauthorizedException(
      `Unsupported token_endpoint_auth_method: ${method}`,
    );
  }

  private validateRedirectUri(uri: string): void {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new BadRequestException(`Invalid redirect_uri: ${uri}`);
    }

    // OAuth 2.1 requires HTTPS for redirect URIs (except localhost for dev)
    const isLocalhost =
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';

    if (!isLocalhost && parsed.protocol !== 'https:') {
      throw new BadRequestException(
        'redirect_uri must use HTTPS (except for localhost)',
      );
    }

    // Fragment identifiers are not allowed
    if (parsed.hash) {
      throw new BadRequestException(
        'redirect_uri must not contain a fragment identifier',
      );
    }
  }
}
