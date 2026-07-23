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
import { compileSafeRegex, boundRegexInput } from '../../common/security/regex-safety';

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
  metadata?: Record<string, any>;
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
    private readonly validators: GatewayAuthValidators,
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
        relations: { gateway: true },
      });

      if (!gatewayAuth || gatewayAuth.gateway.organizationId !== organizationId) {
        throw new NotFoundException('Gateway auth not found');
      }

      // Validate configuration if updated
      if (updateGatewayAuthDto.configuration) {
        this.validators.validateAuthConfiguration(gatewayAuth.type, updateGatewayAuthDto.configuration);
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
      relations: { gateway: true },
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
        const result = await this.validators.validateAuthConfig(authConfig, headers, query, body, clientIp);

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