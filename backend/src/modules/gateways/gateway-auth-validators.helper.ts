import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

import { Gateway } from '../../entities/gateway.entity';
import { GatewayAuth } from '../../entities/gateway-auth.entity';
import { AuthenticationResult } from './gateway-auth.service';
import { User } from '../../entities/user.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { OAuthAccessToken } from '../../entities/oauth-access-token.entity';
import { GatewayAuthType } from '../../entities/gateway-auth.entity';
import { compileSafeRegex, boundRegexInput } from '../../common/security/regex-safety';
import { hashKey, isIpInCIDR, isIpInRanges, validateAuthConfiguration, validateKeyFormat } from './gateway-auth-utils';

@Injectable()
export class GatewayAuthValidators {
  private readonly logger = new Logger(GatewayAuthValidators.name);

  constructor(
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(ApiKey)
    private apiKeyRepository: Repository<ApiKey>,
    @InjectRepository(OAuthAccessToken)
    private oauthAccessTokenRepository: Repository<OAuthAccessToken>,
    private jwtService: JwtService,
  ) {}

  async validateAuthConfig(
    authConfig: GatewayAuth,
    headers: Record<string, string>,
    query: Record<string, string>,
    body?: any,
    clientIp?: string
  ): Promise<AuthenticationResult> {
    // Check IP restrictions
    if (authConfig.validationRules?.allowedIpRanges?.length > 0 && clientIp) {
      if (!this.isIpInRanges(clientIp, authConfig.validationRules.allowedIpRanges)) {
        return {
          isValid: false,
          error: 'IP address not allowed',
          errorCode: 'IP_RESTRICTED',
        };
      }
    }

    // Check required headers
    if (authConfig.validationRules?.requiredHeaders?.length > 0) {
      const missingHeaders = authConfig.validationRules.requiredHeaders.filter(
        header => !headers[header.toLowerCase()]
      );
      
      if (missingHeaders.length > 0) {
        return {
          isValid: false,
          error: `Missing required headers: ${missingHeaders.join(', ')}`,
          errorCode: 'MISSING_HEADERS',
        };
      }
    }

    // Validate based on auth type
    switch (authConfig.type) {
      case GatewayAuthType.NONE:
        return { isValid: true };

      case GatewayAuthType.API_KEY:
        return this.validateApiKey(authConfig, headers, query);

      case GatewayAuthType.BEARER_TOKEN:
        return this.validateBearerToken(authConfig, headers);

      case GatewayAuthType.BASIC_AUTH:
        return this.validateBasicAuth(authConfig, headers);

      case GatewayAuthType.JWT:
        return this.validateJWT(authConfig, headers);

      case GatewayAuthType.OAUTH2:
        return this.validateOAuth2(authConfig, headers);

      case GatewayAuthType.CUSTOM:
        return this.validateCustomAuth(authConfig, headers, query, body);

      default:
        return {
          isValid: false,
          error: 'Unsupported authentication type',
          errorCode: 'UNSUPPORTED_AUTH_TYPE',
        };
    }
  }

  async validateApiKey(
    authConfig: GatewayAuth,
    headers: Record<string, string>,
    query: Record<string, string>
  ): Promise<AuthenticationResult> {
    const keyHeader = authConfig.configuration.keyHeader || 'x-api-key';
    const keyQuery = authConfig.configuration.keyQuery || 'api_key';

    const apiKey = headers[keyHeader.toLowerCase()] || query[keyQuery];

    if (!apiKey) {
      return {
        isValid: false,
        error: 'API key is required',
        errorCode: 'API_KEY_MISSING',
      };
    }

    // Validate key format
    if (!this.validateKeyFormat(apiKey, authConfig.validationRules)) {
      return {
        isValid: false,
        error: 'Invalid API key format',
        errorCode: 'API_KEY_INVALID_FORMAT',
      };
    }

    // Resolve the gateway's organizationId so we can enforce org scoping.
    // CRITICAL: without this, an API key issued to a user in org A could
    // authenticate against a gateway in org B — cross-org bypass. The
    // query below now requires `organizationId` to match the gateway's
    // org on both the gateway-specific and org-wide paths.
    const gateway = await this.gatewayRepository.findOne({
      where: { id: authConfig.gatewayId },
      select: { id: true, organizationId: true },
    });
    if (!gateway) {
      return { isValid: false, error: 'Gateway not found', errorCode: 'GATEWAY_NOT_FOUND' };
    }

    const keyHash = hashKey(apiKey);
    // A key counts as valid for this gateway if it's either explicitly
    // scoped to the gateway OR is an org-wide key (no gatewayId). In both
    // cases the key's organizationId MUST match the gateway's org.
    const apiKeyRecord = await this.apiKeyRepository.findOne({
      where: [
        { keyHash, isActive: true, gatewayId: authConfig.gatewayId, organizationId: gateway.organizationId },
        { keyHash, isActive: true, gatewayId: null as any, organizationId: gateway.organizationId },
      ],
      relations: { user: { organizationMemberships: true } },
    });

    if (!apiKeyRecord) {
      return {
        isValid: false,
        error: 'Invalid API key',
        errorCode: 'API_KEY_INVALID',
      };
    }

    if (apiKeyRecord.isExpired()) {
      return {
        isValid: false,
        error: 'API key expired',
        errorCode: 'API_KEY_EXPIRED',
      };
    }

    // Update last used timestamp
    apiKeyRecord.lastUsedAt = new Date();
    await this.apiKeyRepository.save(apiKeyRecord);

    return {
      isValid: true,
      userId: apiKeyRecord.userId,
      user: apiKeyRecord.user,
      scopes: apiKeyRecord.scopes,
      roles: apiKeyRecord.user?.organizationMemberships?.map(m => m.role) || [],
      organizationId: apiKeyRecord.organizationId,
      metadata: {
        keyId: apiKeyRecord.id,
        keyName: apiKeyRecord.name,
      },
    };
  }

  async validateBearerToken(
    authConfig: GatewayAuth,
    headers: Record<string, string>
  ): Promise<AuthenticationResult> {
    const authHeader = headers.authorization || headers.Authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        isValid: false,
        error: 'Bearer token is required',
        errorCode: 'BEARER_TOKEN_MISSING',
      };
    }

    const token = authHeader.substring(7);

    if (!token) {
      return {
        isValid: false,
        error: 'Invalid bearer token',
        errorCode: 'BEARER_TOKEN_INVALID',
      };
    }

    // Scope the lookup to the gateway's organization. Without this, an
    // API key from any other org could authenticate here as long as the
    // hash matched. Same class of bug as the API_KEY path above.
    const gateway = await this.gatewayRepository.findOne({
      where: { id: authConfig.gatewayId },
      select: { id: true, organizationId: true },
    });
    if (!gateway) {
      return { isValid: false, error: 'Gateway not found', errorCode: 'GATEWAY_NOT_FOUND' };
    }

    const tokenHash = hashKey(token);
    const apiKeyRecord = await this.apiKeyRepository.findOne({
      where: { keyHash: tokenHash, isActive: true, organizationId: gateway.organizationId },
      relations: { user: { organizationMemberships: true } },
    });

    if (!apiKeyRecord) {
      return {
        isValid: false,
        error: 'Invalid bearer token',
        errorCode: 'BEARER_TOKEN_INVALID',
      };
    }

    if (apiKeyRecord.isExpired()) {
      return {
        isValid: false,
        error: 'Bearer token expired',
        errorCode: 'BEARER_TOKEN_EXPIRED',
      };
    }

    return {
      isValid: true,
      userId: apiKeyRecord.userId,
      user: apiKeyRecord.user,
      scopes: apiKeyRecord.scopes,
      roles: apiKeyRecord.user?.organizationMemberships?.map(m => m.role) || [],
      organizationId: apiKeyRecord.organizationId,
    };
  }

  async validateBasicAuth(
    authConfig: GatewayAuth,
    headers: Record<string, string>
  ): Promise<AuthenticationResult> {
    const authHeader = headers.authorization || headers.Authorization;
    
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return {
        isValid: false,
        error: 'Basic authentication is required',
        errorCode: 'BASIC_AUTH_MISSING',
      };
    }

    try {
      const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf-8');
      const [username, password] = credentials.split(':');
      
      if (!username || !password) {
        return {
          isValid: false,
          error: 'Invalid basic auth credentials',
          errorCode: 'BASIC_AUTH_INVALID',
        };
      }

      // Look up user by email
      const user = await this.userRepository.findOne({
        where: { email: username },
        relations: { organizationMemberships: true },
      });

      if (!user || !user.isActive) {
        return {
          isValid: false,
          error: 'Invalid credentials',
          errorCode: 'BASIC_AUTH_INVALID',
        };
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.passwordHash);

      if (!isValidPassword) {
        return {
          isValid: false,
          error: 'Invalid credentials',
          errorCode: 'BASIC_AUTH_INVALID',
        };
      }

      // Confirm the user actually belongs to the gateway's organization.
      // Previously we returned organizationMemberships[0], which would
      // grant access using the user's FIRST org regardless of which
      // gateway was being accessed — a silent cross-org bypass.
      const gateway = await this.gatewayRepository.findOne({
        where: { id: authConfig.gatewayId },
        select: { id: true, organizationId: true },
      });
      if (!gateway) {
        return { isValid: false, error: 'Gateway not found', errorCode: 'GATEWAY_NOT_FOUND' };
      }
      const membership = user.organizationMemberships?.find(
        (m) => m.organizationId === gateway.organizationId,
      );
      if (!membership) {
        return {
          isValid: false,
          error: 'User is not a member of the gateway organization',
          errorCode: 'BASIC_AUTH_CROSS_ORG',
        };
      }

      return {
        isValid: true,
        userId: user.id,
        user,
        scopes: authConfig.configuration.defaultScopes || [],
        roles: [membership.role],
        organizationId: gateway.organizationId,
      };

    } catch (error) {
      return {
        isValid: false,
        error: 'Invalid basic auth format',
        errorCode: 'BASIC_AUTH_FORMAT_ERROR',
      };
    }
  }

  async validateJWT(
    authConfig: GatewayAuth,
    headers: Record<string, string>
  ): Promise<AuthenticationResult> {
    const authHeader = headers.authorization || headers.Authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        isValid: false,
        error: 'JWT token is required',
        errorCode: 'JWT_MISSING',
      };
    }

    const token = authHeader.substring(7);

    try {
      // CRITICAL: do NOT fall back to process.env.JWT_SECRET. That would
      // accept the backend's own login JWTs as gateway auth tokens,
      // granting any authenticated backend user access to any gateway
      // with JWT auth but no explicit secret configured — a cross-org
      // bypass. The gateway owner MUST configure a distinct secret in
      // authConfig.configuration.secret (or jwksUri / publicKey for
      // asymmetric signing, future work).
      const jwtSecret = authConfig.configuration.secret;
      if (!jwtSecret) {
        return {
          isValid: false,
          error: 'JWT auth not configured for this gateway (missing configuration.secret)',
          errorCode: 'JWT_NOT_CONFIGURED',
        };
      }

      const payload = this.jwtService.verify(token, { secret: jwtSecret });

      // Get user if userId is in payload
      let user: User | null = null;
      if (payload.sub || payload.userId) {
        user = await this.userRepository.findOne({
          where: { id: payload.sub || payload.userId },
          relations: { organizationMemberships: true },
        });
      }

      // Resolve the gateway's org so we can enforce that the token's
      // subject actually belongs to it (when a user was found).
      const gateway = await this.gatewayRepository.findOne({
        where: { id: authConfig.gatewayId },
        select: { id: true, organizationId: true },
      });
      const gatewayOrgId = gateway?.organizationId;

      if (user && gatewayOrgId) {
        const userInGatewayOrg = user.organizationMemberships?.some(
          (m) => m.organizationId === gatewayOrgId,
        );
        if (!userInGatewayOrg) {
          return {
            isValid: false,
            error: 'Token subject is not a member of the gateway organization',
            errorCode: 'JWT_CROSS_ORG',
          };
        }
      }

      return {
        isValid: true,
        userId: payload.sub || payload.userId,
        user,
        scopes: payload.scopes || payload.scope?.split(' ') || [],
        roles: payload.roles || user?.organizationMemberships?.map(m => m.role) || [],
        // Prefer the gateway's org (authoritative) over the first
        // membership of the user (which was the "silently default to
        // first org" bug we fixed in the backend JWT strategy).
        organizationId: gatewayOrgId || payload.org,
        metadata: {
          jwtPayload: payload,
        },
      };

    } catch (error) {
      return {
        isValid: false,
        error: 'Invalid JWT token',
        errorCode: 'JWT_INVALID',
      };
    }
  }

  async validateOAuth2(
    authConfig: GatewayAuth,
    headers: Record<string, string>
  ): Promise<AuthenticationResult> {
    const authHeader = headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        isValid: false,
        error: 'OAuth2 Bearer token required',
        errorCode: 'BEARER_TOKEN_MISSING',
      };
    }

    const token = authHeader.substring(7);

    // Validate against OAuthAccessToken table via SHA-256 hash lookup.
    //
    // CRITICAL: the lookup MUST be scoped to the current gateway.
    // An access token is issued by the MCP OAuth 2.1 server bound
    // to a specific (clientId, gatewayId, userId) triple; if the
    // lookup omits gatewayId, a valid token issued for gateway A
    // can be presented to gateway B and pass the isValid=true
    // branch — cross-gateway token replay. The MCP OAuth server
    // stores the gatewayId on every issued token row, so the
    // filter is a single column add on the WHERE clause.
    try {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const oauthToken = await this.oauthAccessTokenRepository?.findOne({
        where: {
          tokenHash,
          tokenType: 'access',
          isRevoked: false,
          gatewayId: authConfig.gatewayId,
        },
      });

      if (!oauthToken) {
        // Fallback: try legacy bearer token validation (ApiKey-based)
        return this.validateBearerToken(authConfig, headers);
      }

      // Defence in depth — even though the WHERE above already
      // pinned gatewayId, also require the organizationId to
      // match the gateway's owning org. A stale token with a
      // gatewayId that survived a cross-tenant gateway rename
      // would otherwise get through.
      if (oauthToken.organizationId !== authConfig.gateway?.organizationId &&
          authConfig.gateway?.organizationId !== undefined) {
        return {
          isValid: false,
          error: 'OAuth2 token not bound to this gateway',
          errorCode: 'OAUTH2_TOKEN_WRONG_GATEWAY',
        };
      }

      if (oauthToken.expiresAt < new Date()) {
        return {
          isValid: false,
          error: 'OAuth2 access token expired',
          errorCode: 'OAUTH2_TOKEN_EXPIRED',
        };
      }

      return {
        isValid: true,
        userId: oauthToken.userId || undefined,
        organizationId: oauthToken.organizationId,
        scopes: oauthToken.scope ? oauthToken.scope.split(' ') : [],
        metadata: {
          authMethod: 'oauth2',
          clientId: oauthToken.clientId,
          tokenId: oauthToken.id,
        },
      };
    } catch {
      // If OAuth token table doesn't exist yet, fall back to bearer token validation
      return this.validateBearerToken(authConfig, headers);
    }
  }

  async validateCustomAuth(
    authConfig: GatewayAuth,
    headers: Record<string, string>,
    query: Record<string, string>,
    body?: any
  ): Promise<AuthenticationResult> {
    // Custom auth logic would be implemented based on the configuration
    // This is a placeholder implementation
    const customToken = headers[authConfig.configuration.headerName?.toLowerCase()] ||
                       query[authConfig.configuration.queryName];

    if (!customToken) {
      return {
        isValid: false,
        error: 'Custom authentication token required',
        errorCode: 'CUSTOM_AUTH_MISSING',
      };
    }

    // Validate custom token format or value
    if (authConfig.configuration.validTokens?.includes(customToken)) {
      return {
        isValid: true,
        userId: 'custom-user',
        scopes: authConfig.configuration.defaultScopes || [],
      };
    }

    return {
      isValid: false,
      error: 'Invalid custom authentication token',
      errorCode: 'CUSTOM_AUTH_INVALID',
    };
  }

  // ── Delegations to gateway-auth-utils ──
  validateKeyFormat = validateKeyFormat;
  isIpInRanges = isIpInRanges;
  isIpInCIDR = isIpInCIDR;
  validateAuthConfiguration = validateAuthConfiguration;

}
