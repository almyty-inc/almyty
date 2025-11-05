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
        // No auth required
        return { isValid: true };
      }

      // Try each auth method until one succeeds or all fail
      let lastError = 'No valid authentication provided';
      let lastErrorCode = 'NO_AUTH';

      for (const authConfig of authConfigs) {
        if (!authConfig.isRequired) {
          continue;
        }

        const result = await this.validateAuthConfig(authConfig, headers, query, body, clientIp);
        
        if (result.isValid) {
          // Authentication successful
          return result;
        }

        // Store last error for reporting
        if (result.error) {
          lastError = result.error;
          lastErrorCode = result.errorCode || 'AUTH_FAILED';
        }
      }

      // All auth methods failed
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

    // Hash the provided API key and look it up in database
    const keyHash = this.hashKey(apiKey);
    const apiKeyRecord = await this.apiKeyRepository.findOne({
      where: { keyHash, isActive: true },
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

    // Hash the provided token and look it up in database (assuming it's an API key)
    const tokenHash = this.hashKey(token);
    const apiKeyRecord = await this.apiKeyRepository.findOne({
      where: { keyHash: tokenHash, isActive: true },
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

      return {
        isValid: true,
        userId: user.id,
        user,
        scopes: authConfig.configuration.defaultScopes || [],
        roles: user.organizationMemberships?.map(m => m.role) || [],
        organizationId: user.organizationMemberships?.[0]?.organizationId,
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
      const jwtSecret = authConfig.configuration.secret || process.env.JWT_SECRET;
      const payload = this.jwtService.verify(token, { secret: jwtSecret });
      
      // Get user if userId is in payload
      let user: User | null = null;
      if (payload.sub || payload.userId) {
        user = await this.userRepository.findOne({
          where: { id: payload.sub || payload.userId },
          relations: ['organizationMemberships'],
        });
      }

      return {
        isValid: true,
        userId: payload.sub || payload.userId,
        user,
        scopes: payload.scopes || payload.scope?.split(' ') || [],
        roles: payload.roles || user?.organizationMemberships?.map(m => m.role) || [],
        organizationId: payload.org || user?.organizationMemberships?.[0]?.organizationId,
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
    // OAuth2 validation would typically involve introspecting the token with the authorization server
    // For now, we'll treat it like a bearer token
    return this.validateBearerToken(authConfig, headers);
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

    // Check format
    if (validationRules.keyFormat) {
      const regex = new RegExp(validationRules.keyFormat);
      if (!regex.test(key)) {
        return false;
      }
    }

    return true;
  }

  private isIpInRanges(ip: string, ranges: string[]): boolean {
    // Simple IP range checking - in production you'd use a library like 'ip-range-check'
    return ranges.some(range => {
      if (range.includes('/')) {
        // CIDR notation
        return this.isIpInCIDR(ip, range);
      } else {
        // Single IP or wildcard
        return ip === range || range === '*';
      }
    });
  }

  private isIpInCIDR(ip: string, cidr: string): boolean {
    // Basic CIDR check - in production use a proper library
    const [rangeIp, prefixLength] = cidr.split('/');
    
    if (!prefixLength) {
      return ip === rangeIp;
    }

    // This is a simplified implementation
    const ipParts = ip.split('.').map(Number);
    const rangeIpParts = rangeIp.split('.').map(Number);
    const prefix = parseInt(prefixLength);

    const ipBinary = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
    const rangeIpBinary = ((rangeIpParts[0] << 24) | (rangeIpParts[1] << 16) | (rangeIpParts[2] << 8) | rangeIpParts[3]) >>> 0;
    const mask = (-1 << (32 - prefix)) >>> 0;

    return (ipBinary & mask) === (rangeIpBinary & mask);
  }

  private validateAuthConfiguration(type: GatewayAuthType, configuration: Record<string, any>): void {
    switch (type) {
      case GatewayAuthType.API_KEY:
        if (!configuration.keyHeader && !configuration.keyQuery) {
          throw new BadRequestException('API key auth requires keyHeader or keyQuery configuration');
        }
        break;

      case GatewayAuthType.JWT:
        if (!configuration.secret && !process.env.JWT_SECRET) {
          throw new BadRequestException('JWT auth requires secret configuration');
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
    expiresAt?: Date
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
      isActive: true,
    });

    const savedApiKey = await this.apiKeyRepository.save(apiKey);
    
    // Return the key only once for the user to save (add as non-entity property)
    (savedApiKey as any).key = key;
    return savedApiKey;
  }

  private hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  private generateSecureKey(): string {
    return `gw_${crypto.randomBytes(32).toString('base64url')}`;
  }
}