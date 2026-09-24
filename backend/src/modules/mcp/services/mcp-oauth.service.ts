import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { OAuthClient } from '../../../entities/oauth-client.entity';
import { OAuthAuthorizationCode } from '../../../entities/oauth-authorization-code.entity';
import {
  hashValue,
  validateRedirectUri,
} from './mcp-oauth-helpers.helper';
import { McpOAuthTokensHelper } from './mcp-oauth-tokens.helper';

// --- Interfaces ---

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

const AUTHORIZATION_CODE_LIFETIME_SECONDS = 600; // 10 minutes

/**
 * The scopes an MCP OAuth client can register and be granted: exactly the
 * `scopes_supported` both metadata documents advertise. Registration
 * refuses anything else, and a grant is a subset of what the client
 * registered, so a token never carries a scope string its caller made up
 * (such as one a gateway tool's `requiredScopes` names -- those are for
 * admin-minted gateway keys).
 */
export const MCP_OAUTH_SCOPES = ['mcp:tools', 'mcp:resources', 'mcp:prompts', 'mcp:*'];

/**
 * The scope a grant carries: what was asked for, provided every part of
 * it is in the client's registered scope, or the registered scope when
 * nothing was asked for. Anything outside it is `invalid_scope`, not
 * silently widened or narrowed, so the consent screen shows exactly what
 * the token will hold.
 */
export function grantedScope(client: Pick<OAuthClient, 'scope'>, requested?: string | null): string {
  const registered = (client.scope ?? '').split(/\s+/).filter(Boolean);
  const asked = (requested ?? '').split(/\s+/).filter(Boolean);
  if (asked.length === 0) {
    if (registered.length === 0) throw new BadRequestException('invalid_scope: the client registered no scope');
    return registered.join(' ');
  }
  const outside = asked.filter((s) => !registered.includes(s));
  if (outside.length > 0) {
    throw new BadRequestException(`invalid_scope: not registered for this client: ${outside.join(' ')}`);
  }
  return [...new Set(asked)].join(' ');
}

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

/**
 * Authorization-server half of MCP OAuth 2.1: dynamic client
 * registration, consent validation and authorization-code issuance. The
 * two discovery documents are served by McpOAuthController and
 * McpOAuthDiscoveryController, from MCP_OAUTH_SCOPES.
 */
@Injectable()
export class McpOAuthService {
  private readonly logger = new Logger(McpOAuthService.name);

  constructor(
    @InjectRepository(OAuthClient)
    private oauthClientRepository: Repository<OAuthClient>,
    @InjectRepository(OAuthAuthorizationCode)
    private oauthCodeRepository: Repository<OAuthAuthorizationCode>,
    private readonly tokens: McpOAuthTokensHelper,
  ) {}

  // -----------------------------------------------------------------------
  // 3. Dynamic Client Registration (RFC 7591)
  // -----------------------------------------------------------------------
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

    // A client registers from the vocabulary the metadata advertises and
    // nothing else; every later grant is bounded by what it registered.
    const requestedScopes = dto.scope?.split(/\s+/).filter(Boolean) ?? [];
    const unknownScopes = requestedScopes.filter((s) => !MCP_OAUTH_SCOPES.includes(s));
    if (unknownScopes.length > 0) {
      throw new BadRequestException(`Unsupported scope: ${unknownScopes.join(' ')}`);
    }
    const scope = (requestedScopes.length ? requestedScopes : MCP_OAUTH_SCOPES).join(' ');

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
    const scopes = grantedScope(client, scope).split(' ');
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
      /** RFC 8707 resource indicator the client asked for, already checked by the caller. */
      resource?: string;
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
      scope: grantedScope(client, params.scope),
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      resource: params.resource ?? null,
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
