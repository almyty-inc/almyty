import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Gateway } from './gateway.entity';

export enum GatewayAuthType {
  NONE = 'none',
  API_KEY = 'api_key',
  BEARER_TOKEN = 'bearer_token',
  BASIC_AUTH = 'basic_auth',
  OAUTH2 = 'oauth2',
  JWT = 'jwt',
  CUSTOM = 'custom',
}

@Entity('gateway_auth')
export class GatewayAuth {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  gatewayId: string;

  @Column({
    type: 'varchar',
    default: GatewayAuthType.API_KEY,
  })
  type: GatewayAuthType;

  @Column({ default: true })
  isRequired: boolean;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'json' })
  configuration: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  validationRules: {
    keyFormat?: string; // Regex pattern
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

  @Column({ type: 'json', nullable: true })
  errorResponses: {
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

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Gateway, gateway => gateway.authConfigs, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'gatewayId' })
  gateway: Gateway;

  // Methods
  validateRequest(headers: Record<string, string>, query: Record<string, string>, body?: any): {
    isValid: boolean;
    userId?: string;
    scopes?: string[];
    error?: string;
  } {
    if (!this.isActive || !this.isRequired || this.type === GatewayAuthType.NONE) {
      return { isValid: true };
    }

    try {
      switch (this.type) {
        case GatewayAuthType.API_KEY:
          return this.validateApiKey(headers, query);
        
        case GatewayAuthType.BEARER_TOKEN:
          return this.validateBearerToken(headers);
        
        case GatewayAuthType.BASIC_AUTH:
          return this.validateBasicAuth(headers);
        
        case GatewayAuthType.JWT:
          return this.validateJWT(headers);
        
        case GatewayAuthType.OAUTH2:
          return this.validateOAuth2(headers);
        
        default:
          return {
            isValid: false,
            error: 'Unsupported authentication type',
          };
      }
    } catch (error) {
      return {
        isValid: false,
        error: `Authentication error: ${error.message}`,
      };
    }
  }

  private validateApiKey(headers: Record<string, string>, query: Record<string, string>): any {
    const keyHeader = this.configuration.keyHeader || 'x-api-key';
    const keyQuery = this.configuration.keyQuery || 'api_key';
    
    const apiKey = headers[keyHeader.toLowerCase()] || query[keyQuery];
    
    if (!apiKey) {
      return {
        isValid: false,
        error: 'API key is required',
      };
    }

    // Validate key format
    if (this.validationRules?.keyFormat) {
      const regex = new RegExp(this.validationRules.keyFormat);
      if (!regex.test(apiKey)) {
        return {
          isValid: false,
          error: 'Invalid API key format',
        };
      }
    }

    // In a real implementation, you'd validate against the database
    return {
      isValid: true,
      userId: 'extracted-from-key',
      scopes: this.configuration.defaultScopes || [],
    };
  }

  private validateBearerToken(headers: Record<string, string>): any {
    const authHeader = headers.authorization || headers.Authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        isValid: false,
        error: 'Bearer token is required',
      };
    }

    const token = authHeader.substring(7);
    
    if (!token) {
      return {
        isValid: false,
        error: 'Invalid bearer token',
      };
    }

    // In a real implementation, you'd validate the token
    return {
      isValid: true,
      userId: 'extracted-from-token',
      scopes: [],
    };
  }

  private validateBasicAuth(headers: Record<string, string>): any {
    const authHeader = headers.authorization || headers.Authorization;
    
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return {
        isValid: false,
        error: 'Basic authentication is required',
      };
    }

    try {
      const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf-8');
      const [username, password] = credentials.split(':');
      
      if (!username || !password) {
        return {
          isValid: false,
          error: 'Invalid basic auth credentials',
        };
      }

      // In a real implementation, you'd validate against the database
      return {
        isValid: true,
        userId: username,
        scopes: [],
      };
    } catch (error) {
      return {
        isValid: false,
        error: 'Invalid basic auth format',
      };
    }
  }

  private validateJWT(headers: Record<string, string>): any {
    const authHeader = headers.authorization || headers.Authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        isValid: false,
        error: 'JWT token is required',
      };
    }

    const token = authHeader.substring(7);
    
    // In a real implementation, you'd verify the JWT signature
    try {
      // Simplified JWT validation - just decode without verification
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      
      return {
        isValid: true,
        userId: payload.sub || payload.userId,
        scopes: payload.scopes || payload.scope?.split(' ') || [],
      };
    } catch (error) {
      return {
        isValid: false,
        error: 'Invalid JWT token',
      };
    }
  }

  private validateOAuth2(headers: Record<string, string>): any {
    // OAuth2 validation would involve checking with the authorization server
    return this.validateBearerToken(headers);
  }

  getErrorResponse(type: 'unauthorized' | 'forbidden' | 'invalid'): any {
    const defaultResponses = {
      unauthorized: { code: 401, message: 'Unauthorized' },
      forbidden: { code: 403, message: 'Forbidden' },
      invalid: { code: 400, message: 'Invalid authentication' },
    };

    return this.errorResponses?.[type] || defaultResponses[type];
  }
}