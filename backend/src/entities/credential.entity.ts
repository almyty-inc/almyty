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
  /**
   * Credentials used by canonical memory backends. The `config`
   * column carries backend-specific fields (`apiKey`, `baseUrl`,
   * `engine`, `bearer`, `project`, `location`) and is consumed
   * by `BackendCredentialsResolver`.
   */
  MEMORY_BACKEND = 'memory_backend',
}

@Entity('credentials')
@VersionedEntity()
export class Credential {
  private static _encryptionWarned = false;

  private static getEncryptionKey(): Buffer {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
      // Hard-fail in production: a hardcoded fallback would let anyone
      // with read access to the source code decrypt every credential.
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'ENCRYPTION_KEY environment variable is required in production. ' +
            'Refusing to fall back to a default key — this would compromise every stored credential.',
        );
      }
      // Dev/test only: warn once and use a deterministic key.
      if (!Credential._encryptionWarned) {
        console.warn('[SECURITY WARNING] ENCRYPTION_KEY environment variable not set. Using default key (dev/test only). Set ENCRYPTION_KEY in production!');
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
   *
   * Legacy CBC payloads (`encrypted:<iv>:<ct>` with no `gcm` tag) are
   * transparently decrypted and re-encrypted with GCM, so any save() call
   * incrementally migrates the row off the unauthenticated cipher.
   */
  encryptSensitiveData(): void {
    if (this.config && typeof this.config === 'object') {
      const sensitiveFields = ['password', 'secret', 'token', 'key', 'client_secret', 'apiKey', 'accessToken', 'refreshToken', 'headerValue', 'clientSecret', 'bearer', 'serviceAccountJson'];
      const encrypted = { ...this.config };

      for (const field of sensitiveFields) {
        const value = encrypted[field];
        if (!value || typeof value !== 'string') continue;

        if (!value.startsWith('encrypted:')) {
          // Plain text → encrypt with GCM.
          encrypted[field] = this.encryptValue(value);
          continue;
        }

        if (value.startsWith('encrypted:gcm:')) {
          // Already on the new format, leave it alone.
          continue;
        }

        // Legacy CBC payload — decrypt and re-encrypt with GCM. If
        // decryption fails (corrupt row, key changed), leave the field
        // untouched rather than corrupting it further.
        try {
          const plain = this.decryptValue(value);
          encrypted[field] = this.encryptValue(plain);
        } catch {
          // Best-effort migration; leave legacy value as-is.
        }
      }

      this.config = encrypted;
    }
  }

  /**
   * Encrypt a credential value with AES-256-GCM (authenticated).
   *
   * Format: `encrypted:gcm:<iv-hex>:<authTag-hex>:<ciphertext-hex>`
   *
   * History note: an earlier version used AES-256-CBC and stored values
   * as `encrypted:<iv>:<ciphertext>`. CBC is unauthenticated — an attacker
   * with write access to the DB column could bit-flip the ciphertext to
   * produce arbitrary plaintext shifts (and rely on padding-oracle leaks
   * if any error message differs). GCM provides authenticated encryption
   * so any tampering causes decryption to throw.
   *
   * `decryptValue` still understands the legacy CBC format so existing
   * rows keep working. New writes always use GCM. A future migration can
   * re-encrypt the legacy rows once everyone has upgraded.
   */
  private encryptValue(value: string): string {
    const key = Credential.getEncryptionKey();
    const iv = crypto.randomBytes(12); // 96-bit IV is the GCM standard
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `encrypted:gcm:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  private decryptValue(encryptedValue: string): string {
    if (!encryptedValue.startsWith('encrypted:')) {
      return encryptedValue;
    }

    const parts = encryptedValue.split(':');
    // A malformed `encrypted:` payload (missing fields) used to be
    // silently returned as-is, which then got handed downstream as a
    // literal string ("encrypted:foo") and sent over the wire as the
    // actual auth value. Fail loudly instead.
    if (parts.length < 3) {
      throw new Error('Malformed encrypted credential value: expected `encrypted:[gcm:]<iv>:<...>`');
    }

    const key = Credential.getEncryptionKey();

    // ── New format: encrypted:gcm:<iv>:<authTag>:<ciphertext> ──
    if (parts[1] === 'gcm') {
      if (parts.length !== 5) {
        throw new Error(
          'Malformed encrypted credential value: expected `encrypted:gcm:<iv>:<authTag>:<ciphertext>`',
        );
      }
      const iv = Buffer.from(parts[2], 'hex');
      const authTag = Buffer.from(parts[3], 'hex');
      const ciphertext = parts[4];
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    }

    // ── Legacy format: encrypted:<iv>:<ciphertext> (AES-256-CBC) ──
    // Read-only support so existing rows keep working until they're
    // re-encrypted on next write. Do NOT add new code that produces
    // this format — encryptValue() always emits GCM now.
    const ivHex = parts[1];
    const encrypted = parts.slice(2).join(':');
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

      case CredentialType.JWT: {
        // Default: send `Authorization: Bearer <token>`. If a non-Authorization
        // custom header is configured (e.g. `X-Auth-Token`), send the raw token
        // as that header's value. Previously the branch was on whether
        // headerName was set at all — so explicitly setting headerName to
        // 'Authorization' silently dropped the `Bearer ` prefix.
        const headerName = decryptedConfig.headerName || 'Authorization';
        const useBearerPrefix = headerName === 'Authorization';
        return {
          [headerName]: useBearerPrefix
            ? `Bearer ${decryptedConfig.token}`
            : decryptedConfig.token,
        };
      }

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