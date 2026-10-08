import { hasEffectiveMembership } from '../../common/authorization/membership';
import { CompanySigninService } from './company-signin.service';
import { prepareManagedUsers } from './gateway-managed-users';
import { Injectable, Logger, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import passport = require('passport');
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { endpointVisibility, endpointTeamId, hasEndpointAccessScope } from './gateway-access';
import * as crypto from 'crypto';

import { GatewayAuth, GatewayAuthType } from '../../entities/gateway-auth.entity';
import { Gateway } from '../../entities/gateway.entity';
import { User } from '../../entities/user.entity';
import { ApiKey } from '../../entities/api-key.entity';

import { GatewayAuthValidators } from './gateway-auth-validators.helper';
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
  /**
   * Which gateway_auths row decided this outcome — the config that
   * accepted the request, or on a refusal the one whose rejection is
   * being reported. A gateway commonly has several required configs and
   * only the last error used to survive, so a support ticket ("my key
   * stopped working") had no way to say *which* of the gateway's auth
   * methods refused. Never forwarded to the client; it goes to the log
   * line and `request_logs.metadata`.
   */
  authConfigId?: string;
  /** Auth type of `authConfigId` (api_key, oauth2, jwt, ...). */
  authConfigType?: string;
  /** How many required configs were tried before giving up. */
  triedConfigCount?: number;
  metadata?: Record<string, any>;
}

/** Config keys on a gateway auth row that are credentials, not settings. */
const AUTH_SECRET_KEYS = ['secret', 'clientSecret', 'privateKey', 'password', 'token'];

/** Replace secret values with a presence flag the UI can still render. */
export function maskAuthSecrets(configuration: any): any {
  if (!configuration || typeof configuration !== 'object') return configuration;
  const masked: Record<string, any> = { ...configuration };
  for (const key of AUTH_SECRET_KEYS) {
    if (masked[key] !== undefined && masked[key] !== null && masked[key] !== '') masked[key] = '••••••••';
  }
  if (Array.isArray(masked.users)) masked.users = masked.users.map(({ password, passwordHash, ...user }: any) => ({ ...user, hasPassword: !!passwordHash }));
  return masked;
}

@Injectable()
export class GatewayAuthService {
  private readonly logger = new Logger(GatewayAuthService.name);

  constructor(
    @InjectRepository(GatewayAuth)
    private gatewayAuthRepository: Repository<GatewayAuth>,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(ApiKey)
    private apiKeyRepository: Repository<ApiKey>,
    private readonly validators: GatewayAuthValidators,
    @Optional() private readonly accessPolicy?: AccessPolicyService,
    @Optional() private readonly companySignin?: CompanySigninService,
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

      if (createGatewayAuthDto.type === GatewayAuthType.BASIC_AUTH) createGatewayAuthDto.configuration = await prepareManagedUsers(createGatewayAuthDto.configuration);
      // Validate configuration based on auth type
      this.validators.validateAuthConfiguration(createGatewayAuthDto.type, createGatewayAuthDto.configuration);

      // Reject a second active config of the same type. createGateway
      // auto-provisions an API_KEY config; calling this endpoint with
      // {type: api_key} after that would otherwise silently add a
      // duplicate row and leak two identical entries into the UTCP
      // discovery descriptor (and any other consumer that lists
      // active gateway auths).
      const existing = await this.gatewayAuthRepository.findOne({
        where: { gatewayId, type: createGatewayAuthDto.type, isActive: true },
      });
      if (existing) {
        throw new BadRequestException(
          `Gateway already has an active ${createGatewayAuthDto.type} auth config (id=${existing.id}). Update or delete it first.`,
        );
      }

      const gatewayAuth = this.gatewayAuthRepository.create({
        gatewayId,
        ...createGatewayAuthDto,
        id: crypto.randomUUID(),
        isRequired: createGatewayAuthDto.isRequired !== false,
        isActive: createGatewayAuthDto.isActive !== false,
      });

      if (gatewayAuth.type === GatewayAuthType.COMPANY_SIGNIN) {
        if (!this.companySignin) throw new BadRequestException('Company sign-in unavailable');
        gatewayAuth.configuration = await this.companySignin.prepare(gateway, gatewayAuth.id, gatewayAuth.configuration);
      }
      const savedAuth = await this.gatewayAuthRepository.save(gatewayAuth);

      this.logger.log(`Gateway auth created for gateway ${gatewayId} with type ${createGatewayAuthDto.type}`);

      return { ...savedAuth, configuration: maskAuthSecrets(savedAuth.configuration) } as GatewayAuth;

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
        relations: { gateway: true },
      });

      if (!gatewayAuth || gatewayAuth.gateway.organizationId !== organizationId) {
        throw new NotFoundException('Gateway auth not found');
      }

      if (updateGatewayAuthDto.configuration && gatewayAuth.type === GatewayAuthType.COMPANY_SIGNIN) {
        if (!this.companySignin) throw new BadRequestException('Company sign-in unavailable');
        updateGatewayAuthDto.configuration = await this.companySignin.prepare(gatewayAuth.gateway, gatewayAuth.id, updateGatewayAuthDto.configuration, gatewayAuth.configuration);
      }
      if (updateGatewayAuthDto.configuration && gatewayAuth.type === GatewayAuthType.BASIC_AUTH) updateGatewayAuthDto.configuration = await prepareManagedUsers(updateGatewayAuthDto.configuration, gatewayAuth.configuration);
      // Validate configuration if updated
      if (updateGatewayAuthDto.configuration) {
        this.validators.validateAuthConfiguration(gatewayAuth.type, updateGatewayAuthDto.configuration);
      }

      Object.assign(gatewayAuth, updateGatewayAuthDto);

      const updatedAuth = await this.gatewayAuthRepository.save(gatewayAuth);

      this.logger.log(`Gateway auth ${authId} updated`);

      return { ...updatedAuth, configuration: maskAuthSecrets(updatedAuth.configuration) } as GatewayAuth;

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

    const rows = await this.gatewayAuthRepository.find({
      where: { gatewayId },
      order: { createdAt: 'ASC' },
    });

    // configuration.secret is the gateway's JWT signing key, stored in
    // plaintext, and this route is open to `member`. Returning it let any
    // member mint gateway JWTs with any claims they liked -- a complete
    // bypass of gateway authentication for every consumer. The sibling
    // API-key route already uses an explicit select; this one returned
    // the row as stored.
    return rows.map((row) => ({
      ...row,
      configuration: maskAuthSecrets(row.configuration),
    })) as typeof rows;
  }

  async deleteGatewayAuth(authId: string, organizationId: string, gatewayId?: string): Promise<void> {
    const gatewayAuth = await this.gatewayAuthRepository.findOne({
      where: { id: authId },
      relations: { gateway: true },
    });

    if (!gatewayAuth || gatewayAuth.gateway.organizationId !== organizationId) {
      throw new NotFoundException('Gateway auth not found');
    }

    if (gatewayId !== undefined && gatewayAuth.gatewayId !== gatewayId) throw new NotFoundException('Gateway auth not found');
    await this.gatewayAuthRepository.remove(gatewayAuth);
    if (gatewayAuth.type === GatewayAuthType.COMPANY_SIGNIN) await this.companySignin?.release(gatewayAuth);

    this.logger.log(`Gateway auth ${authId} deleted`);
  }

  async authenticateRequest(
    gatewayId: string,
    headers: Record<string, string>,
    query: Record<string, string>,
    body?: any,
    clientIp?: string,
    preloadedAuthConfigs?: GatewayAuth[],
    request?: any
  ): Promise<AuthenticationResult> {
    try {
      const gateway = preloadedAuthConfigs?.find(c => c.gateway)?.gateway ?? await this.gatewayRepository.findOne({ where: { id: gatewayId } });
      if (!gateway) return { isValid: false, errorCode: 'GATEWAY_NOT_FOUND', error: 'Gateway not found' };
      if (hasEndpointAccessScope(gateway) && gateway.accessScope === 'external_open') return { isValid: true, organizationId: gateway.organizationId };
      if (hasEndpointAccessScope(gateway) && !gateway.isSystem && gateway.accessScope && gateway.accessScope !== 'external_protected') return this.authenticateMember(gateway, request ?? { headers, cookies: {} });
      // Get all active auth configs for the gateway.
      //
      // `gateway` is loaded because validateOAuth2 compares the access
      // token's organizationId against the gateway's owning org. Without
      // the relation that comparison had nothing to compare against.
      //
      // The resolver reaches here holding the same rows off the gateway's
      // `authConfigs` relation (with the inverse side attached); when it
      // hands them over this query is skipped entirely. Every other caller
      // omits the argument and the query runs as before.
      const authConfigs =
        preloadedAuthConfigs ??
        (await this.gatewayAuthRepository.find({
          where: { gatewayId, isActive: true },
          relations: { gateway: true },
          order: { createdAt: 'ASC' },
        }));

      if (authConfigs.length === 0) {
        // No auth configs = deny by default. Gateways must have explicit auth configured.
        return {
          isValid: false,
          error: 'Gateway has no authentication configured. Contact the gateway owner.',
          errorCode: 'NO_AUTH_CONFIGURED',
        };
      }

      // Separate required and optional auth configs
      const requiredConfigs = authConfigs.filter(c => c.isActive && c.isRequired && (gateway.accessScope !== 'external_protected' || gateway.isSystem || [GatewayAuthType.API_KEY, GatewayAuthType.BASIC_AUTH, GatewayAuthType.COMPANY_SIGNIN, GatewayAuthType.JWT].includes(c.type)));

      // If all configs are optional (type=none or isRequired=false), check if any is type NONE
      if (requiredConfigs.length === 0) {
        const hasNoneType = gateway.accessScope !== 'external_protected' && authConfigs.some(c => c.type === GatewayAuthType.NONE);
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

      // Try each required auth method — any one succeeding is enough.
      // Which config decided is carried out with the result: keeping only
      // `lastError` answered "it was refused" but never "by what", which
      // is the first question on an auth support ticket.
      let lastError = 'No valid authentication provided';
      let lastErrorCode = 'NO_AUTH';
      let decidingConfigId: string | undefined;
      let decidingConfigType: string | undefined;

      for (const authConfig of requiredConfigs) {
        const result = await this.validators.validateAuthConfig(authConfig, headers, query, body, clientIp);

        if (result.isValid) {
          return {
            ...result,
            authConfigId: result.authConfigId ?? authConfig.id,
            authConfigType: result.authConfigType ?? authConfig.type,
            triedConfigCount: requiredConfigs.length,
          };
        }

        if (result.error) {
          lastError = result.error;
          lastErrorCode = result.errorCode || 'AUTH_FAILED';
          decidingConfigId = authConfig.id;
          decidingConfigType = authConfig.type;
        }
      }

      // All required auth methods failed
      this.logger.warn(
        `Gateway ${gatewayId} auth refused: ${lastErrorCode} by config ` +
          `${decidingConfigId ?? 'none'} (${decidingConfigType ?? 'n/a'}) ` +
          `after ${requiredConfigs.length} required config(s)`,
      );
      return {
        isValid: false,
        error: lastError,
        errorCode: lastErrorCode,
        authConfigId: decidingConfigId,
        authConfigType: decidingConfigType,
        triedConfigCount: requiredConfigs.length,
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

  private async authenticateMember(gateway: Gateway, request: any): Promise<AuthenticationResult> {
    return new Promise(resolve => {
      passport.authenticate('jwt', { session: false }, async (error: any, user: User | false) => {
        try {
          let identity: AuthenticationResult;
          if (!error && user && hasEffectiveMembership(user.organizationMemberships, gateway.organizationId)) identity = { isValid: true, user, userId: user.id, organizationId: gateway.organizationId };
          else {
            const oauth = await this.validators.validateOAuth2({ gatewayId: gateway.id, gateway, configuration: {} } as GatewayAuth, request.headers ?? {});
            if (!oauth.isValid || oauth.metadata?.authMethod !== 'oauth2' || !oauth.userId) return resolve({ isValid: false, error: 'Sign in to almyty to use this endpoint', errorCode: 'SESSION_MISSING' });
            identity = oauth;
          }
          const allowed = await this.accessPolicy?.canAccess({ id: identity.userId }, { organizationId: gateway.organizationId, visibility: endpointVisibility(gateway), teamId: endpointTeamId(gateway), ownerUserId: gateway.ownerUserId }, 'use');
          resolve(allowed?.allowed ? identity : { isValid: false, error: 'You cannot use this endpoint', errorCode: 'ENDPOINT_SCOPE_REFUSED' });
        } catch { resolve({ isValid: false, error: 'You cannot use this endpoint', errorCode: 'ENDPOINT_SCOPE_REFUSED' }); }
      })(request, {}, () => resolve({ isValid: false, errorCode: 'SESSION_MISSING' }));
    });
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
      select: { id: true, name: true, keyPrefix: true, scopes: true, isActive: true, expiresAt: true, lastUsedAt: true, createdAt: true, gatewayId: true },
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

  // ── Delegations to GatewayAuthValidators ──
  validateAuthConfig(...args: Parameters<GatewayAuthValidators['validateAuthConfig']>) { return this.validators.validateAuthConfig(...args); }
  validateApiKey(...args: Parameters<GatewayAuthValidators['validateApiKey']>) { return this.validators.validateApiKey(...args); }
  validateBearerToken(...args: Parameters<GatewayAuthValidators['validateBearerToken']>) { return this.validators.validateBearerToken(...args); }
  validateBasicAuth(...args: Parameters<GatewayAuthValidators['validateBasicAuth']>) { return this.validators.validateBasicAuth(...args); }
  validateJWT(...args: Parameters<GatewayAuthValidators['validateJWT']>) { return this.validators.validateJWT(...args); }
  validateOAuth2(...args: Parameters<GatewayAuthValidators['validateOAuth2']>) { return this.validators.validateOAuth2(...args); }
  validateCustomAuth(...args: Parameters<GatewayAuthValidators['validateCustomAuth']>) { return this.validators.validateCustomAuth(...args); }
  validateKeyFormat(...args: Parameters<GatewayAuthValidators['validateKeyFormat']>) { return this.validators.validateKeyFormat(...args); }
  isIpInRanges(...args: Parameters<GatewayAuthValidators['isIpInRanges']>) { return this.validators.isIpInRanges(...args); }
  isIpInCIDR(...args: Parameters<GatewayAuthValidators['isIpInCIDR']>) { return this.validators.isIpInCIDR(...args); }
  validateAuthConfiguration(...args: Parameters<GatewayAuthValidators['validateAuthConfiguration']>) { return this.validators.validateAuthConfiguration(...args); }
}
