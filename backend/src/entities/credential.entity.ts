import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { Api } from './api.entity';
import * as crypto from 'crypto';

export enum CredentialType {
  API_KEY = 'api_key',
  BEARER_TOKEN = 'bearer_token',
  BASIC_AUTH = 'basic_auth',
  OAUTH2 = 'oauth2',
  JWT = 'jwt',
  CUSTOM = 'custom',
}

@Entity('credentials')
export class Credential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column()
  apiId: string;

  @Column({
    type: 'varchar',
    default: 'api_key',
  })
  type: CredentialType;

  @Column({ type: 'json' })
  config: Record<string, any>; // Encrypted credential data

  @Column({ nullable: true })
  keyName: string; // Header name or parameter name for API keys

  @Column({ nullable: true })
  keyLocation: string; // 'header', 'query', 'body'

  @Column({ default: true })
  isActive: boolean;

  @Column({ nullable: true })
  expiresAt: Date;

  @Column({ nullable: true })
  lastUsedAt: Date;

  @Column({ type: 'json', nullable: true })
  scopes: string[]; // For OAuth2

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Api, api => api.credentials, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'apiId' })
  api: Api;

  @BeforeInsert()
  @BeforeUpdate()
  encryptSensitiveData() {
    if (this.config && typeof this.config === 'object') {
      // In a real implementation, you'd encrypt sensitive fields
      // For now, we'll just flag sensitive data
      this.config = this.maskSensitiveFields(this.config);
    }
  }

  private maskSensitiveFields(config: Record<string, any>): Record<string, any> {
    const sensitiveFields = ['password', 'secret', 'token', 'key', 'client_secret'];
    const masked = { ...config };

    for (const field of sensitiveFields) {
      if (masked[field]) {
        // In production, encrypt instead of masking
        masked[field] = this.encryptValue(masked[field]);
      }
    }

    return masked;
  }

  private encryptValue(value: string): string {
    // Simplified encryption - in production, use proper encryption
    const key = process.env.ENCRYPTION_KEY || 'default-key';
    const cipher = crypto.createCipher('aes-256-cbc', key);
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `encrypted:${encrypted}`;
  }

  private decryptValue(encryptedValue: string): string {
    if (!encryptedValue.startsWith('encrypted:')) {
      return encryptedValue;
    }

    const encrypted = encryptedValue.replace('encrypted:', '');
    const key = process.env.ENCRYPTION_KEY || 'default-key';
    const decipher = crypto.createDecipher('aes-256-cbc', key);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // Methods
  isExpired(): boolean {
    return this.expiresAt ? new Date() > this.expiresAt : false;
  }

  isValid(): boolean {
    return this.isActive && !this.isExpired();
  }

  getAuthHeaders(): Record<string, string> {
    if (!this.isValid()) return {};

    const decryptedConfig = this.getDecryptedConfig();

    switch (this.type) {
      case CredentialType.API_KEY:
        if (this.keyLocation === 'header') {
          return {
            [this.keyName || 'X-API-Key']: decryptedConfig.apiKey,
          };
        }
        break;

      case CredentialType.BEARER_TOKEN:
        return {
          Authorization: `Bearer ${decryptedConfig.token}`,
        };

      case CredentialType.BASIC_AUTH:
        const auth = Buffer.from(
          `${decryptedConfig.username}:${decryptedConfig.password}`
        ).toString('base64');
        return {
          Authorization: `Basic ${auth}`,
        };

      case CredentialType.JWT:
        return {
          Authorization: `Bearer ${decryptedConfig.token}`,
        };

      default:
        return {};
    }

    return {};
  }

  getQueryParams(): Record<string, string> {
    if (!this.isValid()) return {};

    const decryptedConfig = this.getDecryptedConfig();

    if (this.type === CredentialType.API_KEY && this.keyLocation === 'query') {
      return {
        [this.keyName || 'api_key']: decryptedConfig.apiKey,
      };
    }

    return {};
  }

  private getDecryptedConfig(): Record<string, any> {
    const decrypted = { ...this.config };

    for (const [key, value] of Object.entries(decrypted)) {
      if (typeof value === 'string' && value.startsWith('encrypted:')) {
        decrypted[key] = this.decryptValue(value);
      }
    }

    return decrypted;
  }

  updateLastUsed() {
    this.lastUsedAt = new Date();
  }

  testConnection(): boolean {
    // This would implement actual credential testing
    // For now, just check if config is present
    return this.isValid() && Object.keys(this.config).length > 0;
  }
}