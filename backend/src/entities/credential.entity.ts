import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { VersionedEntity } from 'typeorm-versions';
import { Api } from './api.entity';
import { Organization } from './organization.entity';
import * as crypto from 'crypto';

const { createHash } = crypto;

export enum CredentialType {
  API_KEY = 'api_key',
  BEARER_TOKEN = 'bearer_token',
  BASIC_AUTH = 'basic_auth',
  OAUTH2 = 'oauth2',
  JWT = 'jwt',
  CUSTOM = 'custom',
  AWS_SIGV4 = 'aws_sigv4',
  GOOGLE_SERVICE_ACCOUNT = 'google_service_account',
  MTLS = 'mtls',
}

@Entity('credentials')
@VersionedEntity()
export class Credential {
  private static _encryptionWarned = false;

  private static getEncryptionKey(): Buffer {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
      // Only warn once
      if (!Credential._encryptionWarned) {
        console.warn('[SECURITY WARNING] ENCRYPTION_KEY environment variable not set. Using default key. Set ENCRYPTION_KEY in production!');
        Credential._encryptionWarned = true;
      }
    }
    return createHash('sha256').update(key || 'default-encryption-key-change-me!').digest();
  }

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ nullable: true })
  apiId: string;

  @Column()
  organizationId: string;

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

  @Column({ type: 'json', nullable: true })
  usedBy: { type: string; id: string; name?: string }[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Api, api => api.credentials, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'apiId' })
  api: Api;

  @ManyToOne(() => Organization, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  /**
   * Encrypt sensitive fields in config before storing.
   * Call this explicitly from the service layer before saving.
   */
  encryptSensitiveData(): void {
    if (this.config && typeof this.config === 'object') {
      const sensitiveFields = ['password', 'secret', 'token', 'key', 'client_secret', 'apiKey', 'accessToken', 'refreshToken', 'headerValue', 'clientSecret'];
      const encrypted = { ...this.config };

      for (const field of sensitiveFields) {
        if (encrypted[field] && typeof encrypted[field] === 'string' && !encrypted[field].startsWith('encrypted:')) {
          encrypted[field] = this.encryptValue(encrypted[field]);
        }
      }

      this.config = encrypted;
    }
  }

  private encryptValue(value: string): string {
    const key = Credential.getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `encrypted:${iv.toString('hex')}:${encrypted}`;
  }

  private decryptValue(encryptedValue: string): string {
    if (!encryptedValue.startsWith('encrypted:')) {
      return encryptedValue;
    }

    const parts = encryptedValue.split(':');
    if (parts.length < 3) return encryptedValue;

    const ivHex = parts[1];
    const encrypted = parts.slice(2).join(':');
    const key = Credential.getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
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
          [decryptedConfig.headerName || 'Authorization']: decryptedConfig.headerName
            ? decryptedConfig.token
            : `Bearer ${decryptedConfig.token}`,
        };

      case CredentialType.OAUTH2: {
        const tokenType = decryptedConfig.tokenType || 'Bearer';
        const accessToken = decryptedConfig.accessToken;
        if (accessToken) {
          return { Authorization: `${tokenType} ${accessToken}` };
        }
        return {};
      }

      case CredentialType.AWS_SIGV4:
        // SigV4 headers are computed per-request, not static. Return empty — signing happens in executor.
        return {};

      case CredentialType.GOOGLE_SERVICE_ACCOUNT: {
        const decrypted = this.getDecryptedConfig();
        if (decrypted.accessToken) {
          return { Authorization: `Bearer ${decrypted.accessToken}` };
        }
        return {};
      }

      case CredentialType.MTLS:
        // mTLS uses client certificates, not headers
        return {};

      case CredentialType.CUSTOM:
        if (decryptedConfig.headerName && decryptedConfig.headerValue) {
          return {
            [decryptedConfig.headerName]: decryptedConfig.headerValue,
          };
        }
        return {};

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

  getDecryptedConfig(): Record<string, any> {
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