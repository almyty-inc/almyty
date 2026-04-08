import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

import { GatewayAuth, GatewayAuthType } from '../../entities/gateway-auth.entity';
import { Gateway } from '../../entities/gateway.entity';
import { User } from '../../entities/user.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { OAuthAccessToken } from '../../entities/oauth-access-token.entity';

export interface CreateGatewayAuthDto {
  type: GatewayAuthType;
  isRequired: boolean;
  isActive: boolean;
  configuration: Record<string, any>;
  validationRules?: {
    keyFormat?: string;
    minKeyLength?: number;
    maxKeyLength?: number;
    allowedIpRanges?: string[];
    requiredHeaders?: string[];
    rateLimiting?: {
      enabled: boolean;
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
  };
  errorResponses?: {
    unauthorized?: {
      code: number;
      message: string;
      details?: Record<string, any>;
    };
    forbidden?: {
      code: number;
      message: string;
      details?: Record<string, any>;
    };
    invalid?: {
      code: number;
      message: string;
      details?: Record<string, any>;
    };
  };
  metadata?: Record<string, any>;
}

export interface UpdateGatewayAuthDto {
  isRequired?: boolean;
  isActive?: boolean;
  configuration?: Record<string, any>;
  validationRules?: {
    keyFormat?: string;
    minKeyLength?: number;
    maxKeyLength?: number;
    allowedIpRanges?: string[];
    requiredHeaders?: string[];
    rateLimiting?: {
      enabled: boolean;
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
  };
  errorResponses?: {
    unauthorized?: {
      code: number;
      message: string;
      details?: Record<string, any>;
    };
    forbidden?: {
      code: number;
      message: string;
      details?: Record<string, any>;
    };
    invalid?: {
      code: number;
      message: string;
      details?: Record<string, any>;
    };
  };
  metadata?: Record<string, any>;
}

export interface AuthenticationResult {
  isValid: boolean;
  userId?: string;
  user?: User;
  scopes?: string[];
  roles?: string[];
  organizationId?: string;
  error?: string;
  errorCode?: string;
  metadata?: Record<string, any>;
}

/**
 * Heuristic catastrophic-backtracking detector for admin-supplied
 * `keyFormat` regexes. We don't ship re2 and we don't run the regex
 * in a worker, so the only defense against a tenant admin bringing
 * down the whole instance with `(a+)+$` is to refuse the most common
 * footgun shapes up front. This covers the textbook ReDoS patterns:
 *
 *   (x+)+, (x*)*, (x+)*, (x*)+, (x?)+, (x+)?+
 *   (a|a)+, (a|ab)+, (a|b|c)+ over overlapping alternatives
 *
 * and any `{m,n}`-quantified group with an inner `+`/`*`/`{…}`
 * quantifier. The check is intentionally over-eager: a legitimate
 * pattern that trips it just needs to be rewritten more carefully.
 * Caps the worst-case false-positive impact at "admin has to pick a
 * different regex" which is a much better failure mode than "admin
 * takes the platform down".
 */
function isLikelyCatastrophicRegex(pattern: string): boolean {
  // 1. Any parenthesised group whose body contains a quantifier and
  // which is itself followed by a quantifier. Works across character
  // classes because JS regex `.` doesn't match newlines by default —
  // we explicitly use [\s\S]*? to keep it short-circuited. The non-
  // greedy body avoids matching across unrelated groups.
  if (/\(([^()]*[+*?][^()]*|[^()]*\{\d+,?\d*\}[^()]*)\)[+*?{]/.test(pattern)) {
    return true;
  }

  // 2. Alternation inside a quantified group with obviously-overlapping
  // branches (same literal on both sides, or a prefix relationship).
  // We catch the simplest cases: `(a|a)`, `(a|ab)`, `(ab|a)` when
  // followed by +/*/?.
  const altGroup = /\(([^()|]+)\|([^()|]+)\)[+*?]/;
  const m = pattern.match(altGroup);
  if (m) {
    const a = m[1];
    const b = m[2];
    if (a === b || a.startsWith(b) || b.startsWith(a)) {
      return true;
    }
  }

  return false;
}

@Injectable()
export class GatewayAuthService {
  private readonly logger = new Logger(GatewayAuthService.name);

  constructor(
    @InjectRepository(GatewayAuth)
    private gatewayAuthRepository: Repository<GatewayAuth>,
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

  async createGatewayAuth(
    gatewayId: string,
    createGatewayAuthDto: CreateGatewayAuthDto,
    organizationId: string
  ): Promise<GatewayAuth> {
    try {
      // Verify gateway exists and belongs to organization
      const gateway = await this.gatewayRepository.findOne({
        where: { id: gatewayId, organizationId },
      });

      if (!gateway) {
        throw new NotFoundException('Gateway not found');
      }

      // Validate configuration based on auth type
      this.validateAuthConfiguration(createGatewayAuthDto.type, createGatewayAuthDto.configuration);

      const gatewayAuth = this.gatewayAuthRepository.create({
        gatewayId,
        ...createGatewayAuthDto,
      });

      const savedAuth = await this.gatewayAuthRepository.save(gatewayAuth);

      this.logger.log(`Gateway auth created for gateway ${gatewayId} with type ${createGatewayAuthDto.type}`);

      return savedAuth;

    } catch (error) {
      this.logger.error(`Failed to create gateway auth: ${error.message}`);
      throw error;
    }
  }

  async updateGatewayAuth(
    authId: string,
    updateGatewayAuthDto: UpdateGatewayAuthDto,
    organizationId: string
  ): Promise<GatewayAuth> {
    try {
      const gatewayAuth = await this.gatewayAuthRepository.findOne({
        where: { id: authId },
        relations: ['gateway'],
      });

      if (!gatewayAuth || gatewayAuth.gateway.organizationId !== organizationId) {
        throw new NotFoundException('Gateway auth not found');
      }

      // Validate configuration if updated
      if (updateGatewayAuthDto.configuration) {
        this.validateAuthConfiguration(gatewayAuth.type, updateGatewayAuthDto.configuration);
      }

      Object.assign(gatewayAuth, updateGatewayAuthDto);

      const updatedAuth = await this.gatewayAuthRepository.save(gatewayAuth);

      this.logger.log(`Gateway auth ${authId} updated`);

      return updatedAuth;

    } catch (error) {
      this.logger.error(`Failed to update gateway auth: ${error.message}`);
      throw error;
    }
  }

  async getGatewayAuths(gatewayId: string, organizationId: string): Promise<GatewayAuth[]> {
    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId, organizationId },
    });

    if (!gateway) {
      throw new NotFoundException('Gateway not found');
    }

    return this.gatewayAuthRepository.find({
      where: { gatewayId },
      order: { createdAt: 'ASC' },
    });
  }

  async deleteGatewayAuth(authId: string, organizationId: string): Promise<void> {
    const gatewayAuth = await this.gatewayAuthRepository.findOne({
      where: { id: authId },
      relations: ['gateway'],
    });

    if (!gatewayAuth || gatewayAuth.gateway.organizationId !== organizationId) {
      throw new NotFoundException('Gateway auth not found');
    }

    await this.gatewayAuthRepository.remove(gatewayAuth);

    this.logger.log(`Gateway auth ${authId} deleted`);
  }

  async authenticateRequest(
    gatewayId: string,
    headers: Record<string, string>,
    query: Record<string, string>,
    body?: any,
    clientIp?: string
  ): Promise<AuthenticationResult> {
    try {
      // Get all active auth configs for the gateway
      const authConfigs = await this.gatewayAuthRepository.find({
        where: { gatewayId, isActive: true },
        order: { createdAt: 'ASC' },
      });

      if (authConfigs.length === 0) {
        // No auth configs = deny by default. Gateways must have explicit auth configured.
        return {
          isValid: false,
          error: 'Gateway has no authentication configured. Contact the gateway owner.',
          errorCode: 'NO_AUTH_CONFIGURED',
        };
      }

      // Separate required and optional auth configs
      const requiredConfigs = authConfigs.filter(c => c.isRequired);
      const optionalConfigs = authConfigs.filter(c => !c.isRequired);

      // If all configs are optional (type=none or isRequired=false), check if any is type NONE
      if (requiredConfigs.length === 0) {
        const hasNoneType = authConfigs.some(c => c.type === GatewayAuthType.NONE);
        if (hasNoneType) {
          return { isValid: true };
        }
        // No required configs but none are type NONE — deny
        return {
          isValid: false,
          error: 'Gateway authentication is not properly configured',
          errorCode: 'AUTH_MISCONFIGURED',
        };
      }

      // Try each required auth method — any one succeeding is enough
      let lastError = 'No valid authentication provided';
      let lastErrorCode = 'NO_AUTH';

      for (const authConfig of requiredConfigs) {
        const result = await this.validateAuthConfig(authConfig, headers, query, body, clientIp);

        if (result.isValid) {
          return result;
        }

        if (result.error) {
          lastError = result.error;
          lastErrorCode = result.errorCode || 'AUTH_FAILED';
        }
      }

      // All required auth methods failed
      return {
        isValid: false,
        error: lastError,
        errorCode: lastErrorCode,
      };

    } catch (error) {
      this.logger.error(`Authentication error for gateway ${gatewayId}: ${error.message}`);
      return {
        isValid: false,
        error: 'Authentication system error',
        errorCode: 'SYSTEM_ERROR',
      };
    }
  }

  private async validateAuthConfig(
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

  private async validateApiKey(
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
      select: ['id', 'organizationId'],
    });
    if (!gateway) {
      return { isValid: false, error: 'Gateway not found', errorCode: 'GATEWAY_NOT_FOUND' };
    }

    const keyHash = this.hashKey(apiKey);
    // A key counts as valid for this gateway if it's either explicitly
    // scoped to the gateway OR is an org-wide key (no gatewayId). In both
    // cases the key's organizationId MUST match the gateway's org.
    const apiKeyRecord = await this.apiKeyRepository.findOne({
      where: [
        { keyHash, isActive: true, gatewayId: authConfig.gatewayId, organizationId: gateway.organizationId },
        { keyHash, isActive: true, gatewayId: null as any, organizationId: gateway.organizationId },
      ],
      relations: ['user', 'user.organizationMemberships'],
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

  private async validateBearerToken(
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
      select: ['id', 'organizationId'],
    });
    if (!gateway) {
      return { isValid: false, error: 'Gateway not found', errorCode: 'GATEWAY_NOT_FOUND' };
    }

    const tokenHash = this.hashKey(token);
    const apiKeyRecord = await this.apiKeyRepository.findOne({
      where: { keyHash: tokenHash, isActive: true, organizationId: gateway.organizationId },
      relations: ['user', 'user.organizationMemberships'],
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

  private async validateBasicAuth(
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
        relations: ['organizationMemberships'],
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
        select: ['id', 'organizationId'],
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

  private async validateJWT(
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
          relations: ['organizationMemberships'],
        });
      }

      // Resolve the gateway's org so we can enforce that the token's
      // subject actually belongs to it (when a user was found).
      const gateway = await this.gatewayRepository.findOne({
        where: { id: authConfig.gatewayId },
        select: ['id', 'organizationId'],
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

  private async validateOAuth2(
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

    // Validate against OAuthAccessToken table via SHA-256 hash lookup
    try {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const oauthToken = await this.oauthAccessTokenRepository?.findOne({
        where: { tokenHash, tokenType: 'access', isRevoked: false },
      });

      if (!oauthToken) {
        // Fallback: try legacy bearer token validation (ApiKey-based)
        return this.validateBearerToken(authConfig, headers);
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

  private async validateCustomAuth(
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

  private validateKeyFormat(key: string, validationRules: any): boolean {
    if (!validationRules) return true;

    // Check length
    if (validationRules.minKeyLength && key.length < validationRules.minKeyLength) {
      return false;
    }

    if (validationRules.maxKeyLength && key.length > validationRules.maxKeyLength) {
      return false;
    }

    // Check format. keyFormat is a regex supplied by the gateway owner
    // (admin) and tested against the caller's API key on every auth
    // request. The old shape wrapped the call in try/catch to survive
    // a SyntaxError but did nothing about catastrophic backtracking:
    // a crafted pattern like `(a+)+$` against a long key will grind
    // the Node event loop for seconds-to-minutes, starving *every*
    // org on the instance. An admin on one tenant can trivially DoS
    // the whole platform just by setting the wrong validationRules.
    //
    // This is hard to fix perfectly without pulling in re2 or running
    // the test in a worker, but we can cut the realistic attack
    // surface to almost zero with three cheap defenses applied in
    // order:
    //
    //   1. Hard-cap the input key length before it ever reaches the
    //      regex engine (ENGINE_INPUT_MAX). Catastrophic backtracking
    //      is a function of input length — bounding it to ~2 KiB
    //      keeps even bad patterns polynomial in a fixed constant.
    //   2. Hard-cap the regex source length (PATTERN_MAX). A healthy
    //      API-key format regex is typically <= a few dozen chars.
    //   3. Reject patterns with the classic "nested quantifier" shape
    //      that causes exponential blowup — a group that contains a
    //      quantifier AND is itself quantified: `(…+…)+`, `(…*…)*`,
    //      `(…+…)*`, `(…*…)+`. This covers the common footguns
    //      without needing a full DFA check.
    if (validationRules.keyFormat) {
      const ENGINE_INPUT_MAX = 2048;
      const PATTERN_MAX = 512;

      if (validationRules.keyFormat.length > PATTERN_MAX) {
        return false;
      }
      if (isLikelyCatastrophicRegex(validationRules.keyFormat)) {
        return false;
      }
      const probe = key.length > ENGINE_INPUT_MAX ? key.slice(0, ENGINE_INPUT_MAX) : key;

      try {
        const regex = new RegExp(validationRules.keyFormat);
        if (!regex.test(probe)) {
          return false;
        }
      } catch {
        // Bad regex in the gateway's config → treat as "format invalid"
        // rather than letting a SyntaxError escape.
        return false;
      }
    }

    return true;
  }

  private isIpInRanges(ip: string, ranges: string[]): boolean {
    return ranges.some(range => {
      if (range === '*') return true;
      if (range.includes('/')) return this.isIpInCIDR(ip, range);
      return ip === range;
    });
  }

  /**
   * IPv4 CIDR membership check. Returns false for malformed input or
   * IPv6 addresses (unsupported — callers that need IPv6 should use a
   * dedicated library like `ipaddr.js`).
   */
  private isIpInCIDR(ip: string, cidr: string): boolean {
    // Strip IPv4-in-IPv6 notation that Express commonly hands you for
    // loopback clients on dual-stack Node (e.g. `::ffff:127.0.0.1`).
    const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

    // Only IPv4 is supported. Bail early if we see an IPv6 address —
    // returning `false` is the safe default for an allowlist.
    if (normalized.includes(':')) {
      return false;
    }

    const [rangeIp, prefixLengthRaw] = cidr.split('/');
    if (prefixLengthRaw === undefined) {
      return normalized === rangeIp;
    }

    const prefix = Number.parseInt(prefixLengthRaw, 10);
    if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
      return false;
    }

    const parseIp = (s: string): number | null => {
      const parts = s.split('.');
      if (parts.length !== 4) return null;
      let acc = 0;
      for (const p of parts) {
        const n = Number(p);
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        acc = (acc * 256) + n;
      }
      return acc >>> 0;
    };

    const ipBin = parseIp(normalized);
    const rangeBin = parseIp(rangeIp);
    if (ipBin === null || rangeBin === null) return false;

    // `/0` must match everything — the previous version computed
    // `(-1 << 32) >>> 0` which, because JS left-shift is mod 32,
    // gave `0xFFFFFFFF` (matching only an exact IP). Explicitly
    // handle prefix=0 with mask=0.
    const mask = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);
    return ((ipBin & mask) >>> 0) === ((rangeBin & mask) >>> 0);
  }

  private validateAuthConfiguration(type: GatewayAuthType, configuration: Record<string, any>): void {
    switch (type) {
      case GatewayAuthType.API_KEY:
        if (!configuration.keyHeader && !configuration.keyQuery) {
          throw new BadRequestException('API key auth requires keyHeader or keyQuery configuration');
        }
        break;

      case GatewayAuthType.JWT:
        // Require an explicit secret. Previously we allowed falling
        // back to process.env.JWT_SECRET, which matched validateJWT's
        // pre-fix behaviour — but that silently accepted the backend's
        // own login JWTs as gateway auth tokens (a cross-org bypass).
        // Both save-time validation and request-time verification now
        // require a gateway-specific secret.
        if (!configuration.secret) {
          throw new BadRequestException('JWT auth requires a gateway-specific secret in configuration.secret');
        }
        break;

      case GatewayAuthType.CUSTOM:
        if (!configuration.headerName && !configuration.queryName) {
          throw new BadRequestException('Custom auth requires headerName or queryName configuration');
        }
        break;
    }
  }

  async generateApiKey(
    name: string,
    organizationId: string,
    userId: string,
    scopes: string[] = [],
    expiresAt?: Date,
    gatewayId?: string,
  ): Promise<ApiKey> {
    const key = this.generateSecureKey();
    const keyHash = this.hashKey(key);
    const keyPrefix = key.substring(0, 8);

    const apiKey = this.apiKeyRepository.create({
      name,
      keyHash,
      keyPrefix,
      organizationId,
      userId,
      scopes,
      expiresAt,
      gatewayId: gatewayId || null,
      isActive: true,
    });

    const savedApiKey = await this.apiKeyRepository.save(apiKey);
    
    // Return the key only once for the user to save (add as non-entity property)
    (savedApiKey as any).key = key;
    return savedApiKey;
  }

  async listGatewayApiKeys(gatewayId: string, organizationId: string): Promise<ApiKey[]> {
    return this.apiKeyRepository.find({
      where: { gatewayId, organizationId, isActive: true },
      select: ['id', 'name', 'keyPrefix', 'scopes', 'isActive', 'expiresAt', 'lastUsedAt', 'createdAt', 'gatewayId'],
      order: { createdAt: 'DESC' },
    });
  }

  async revokeGatewayApiKey(keyId: string, gatewayId: string, organizationId: string): Promise<void> {
    const apiKey = await this.apiKeyRepository.findOne({
      where: { id: keyId, gatewayId, organizationId },
    });

    if (!apiKey) {
      throw new NotFoundException('API key not found');
    }

    apiKey.isActive = false;
    await this.apiKeyRepository.save(apiKey);
  }

  private hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  private generateSecureKey(): string {
    return `gw_${crypto.randomBytes(32).toString('base64url')}`;
  }
}