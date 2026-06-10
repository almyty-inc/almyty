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
import {
  hashValue,
  validateRedirectUri,
  verifyClientAuth,
} from './mcp-oauth-helpers.helper';
import { McpOAuthTokensHelper } from './mcp-oauth-tokens.helper';
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
    private readonly tokens: McpOAuthTokensHelper,
  ) {}

  // -----------------------------------------------------------------------
  // 1. Authorization Server Metadata (RFC 8414)
  // -----------------------------------------------------------------------

  getAuthorizationServerMetadata(
    gateway: Gateway,
    baseUrl: string,
  ): AuthorizationServerMetadata {
    const gatewayBase = `${baseUrl}/${gateway.organizationId}/${gateway.id}`;
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
    const gatewayBase = `${baseUrl}/${gateway.organizationId}/${gateway.id}`;
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
      validateRedirectUri(uri);
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
      clientSecretHash = hashValue(clientSecret);
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
  // 3c. Consent info — validate a pending authorization request and return
  // the human-facing details the consent screen needs. Validates the same
  // way createAuthorizationCode does (client active for this gateway,
  // redirect_uri registered) so the consent screen never displays — and a
  // user can never approve — a request that the code-issuing step would
  // reject. Returns NO secrets.
  // -----------------------------------------------------------------------
  async getConsentInfo(
    clientId: string,
    gatewayId: string,
    redirectUri: string,
    scope?: string,
  ): Promise<{ clientName: string; scopes: string[] }> {
    const client = await this.oauthClientRepository.findOne({
      where: { clientId, gatewayId, isActive: true },
    });
    if (!client) {
      throw new BadRequestException('Invalid or inactive client');
    }
    if (!client.redirectUris.includes(redirectUri)) {
      throw new BadRequestException('redirect_uri does not match any registered URI');
    }
    const scopes = (scope || 'mcp:*').split(/\s+/).filter(Boolean);
    return { clientName: client.clientName, scopes };
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
    const codeHash = hashValue(rawCode);

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


  // ── Delegations to McpOAuthTokensHelper ─────────────────────────────────

  exchangeCode(...args: Parameters<McpOAuthTokensHelper['exchangeCode']>) {
    return this.tokens.exchangeCode(...args);
  }

  refreshToken(...args: Parameters<McpOAuthTokensHelper['refreshToken']>) {
    return this.tokens.refreshToken(...args);
  }

  validateAccessToken(...args: Parameters<McpOAuthTokensHelper['validateAccessToken']>) {
    return this.tokens.validateAccessToken(...args);
  }

  revokeToken(...args: Parameters<McpOAuthTokensHelper['revokeToken']>) {
    return this.tokens.revokeToken(...args);
  }

  generateTokenPair(...args: Parameters<McpOAuthTokensHelper['generateTokenPair']>) {
    return this.tokens.generateTokenPair(...args);
  }
}
