import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto';

import { OrgKmsConfig } from '../../entities/org-kms-config.entity';
import {
  decryptField as platformDecryptField,
  encryptField as platformEncryptField,
  registerEnvelopeUnwrapHook,
} from '../../common/security/field-crypto';
import { OrgLicenseResolver } from '../licensing/org-license.resolver';
import { EE_ENTITLEMENTS } from '../licensing/license.constants';
import { KmsClientFactory } from './kms.service';

/**
 * Ciphertext prefix distinguishing customer-managed (envelope) values from the
 * platform-managed field-crypto format (`encrypted:gcm:...`). Routing on the
 * prefix means a single column can hold a mix of both — e.g. rows written
 * before a CMK was configured stay decryptable via the platform path.
 *
 *   format: `encrypted:kms:<iv-hex>:<authTag-hex>:<ct-hex>`
 */
const KMS_PREFIX = 'encrypted:kms:';

/**
 * How long an unwrapped DEK is cached in-process, in milliseconds. KMS
 * `Decrypt` is a network call charged per request; caching the plaintext DEK
 * for a short window bounds both latency and cost while keeping the key
 * material out of the database. The cache is process-local and never persisted.
 */
const DEK_CACHE_TTL_MS = 5 * 60_000;

interface DekCacheEntry {
  dek: Buffer;
  expiresAt: number;
}

/**
 * Envelope encryption for org-scoped secrets under a customer-managed CMK.
 *
 * The platform-managed path (existing `field-crypto`) is the DEFAULT and is
 * completely unchanged. The customer-managed path is engaged for an org ONLY
 * when ALL of the following hold:
 *   1. the org has the `byo_kms` entitlement (resolved per-org via license), AND
 *   2. an `OrgKmsConfig` row exists with `enabled = true` and a `wrappedDek`.
 *
 * When engaged, `encryptForOrg` derives the org's DEK (unwrapping the stored
 * wrapped DEK via KMS `Decrypt`), encrypts the field with AES-256-GCM under
 * that DEK, and tags the ciphertext with the `encrypted:kms:` prefix.
 *
 * `decryptForOrg` routes on the stored prefix, NOT on the org's current
 * config: a `encrypted:kms:` value is always unwrapped via KMS, and any other
 * value goes to the platform path. This guarantees existing/non-KMS data keeps
 * decrypting exactly as before and is never silently misread.
 */
@Injectable()
export class EnvelopeCryptoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnvelopeCryptoService.name);

  /** Unwrapped-DEK cache, keyed by organizationId. Plaintext, in-memory only. */
  private readonly dekCache = new Map<string, DekCacheEntry>();

  constructor(
    @InjectRepository(OrgKmsConfig)
    private readonly kmsConfigRepo: Repository<OrgKmsConfig>,
    private readonly orgLicenseResolver: OrgLicenseResolver,
    private readonly kmsClientFactory: KmsClientFactory,
  ) {}

  /**
   * Register the synchronous unwrap hook so entity methods (which can't inject
   * services) can decrypt `encrypted:kms:` values from the warmed DEK cache.
   */
  onModuleInit(): void {
    registerEnvelopeUnwrapHook((organizationId, value) =>
      this.decryptCached(organizationId, value),
    );
  }

  onModuleDestroy(): void {
    registerEnvelopeUnwrapHook(null);
  }

  /** True if a value is stored in the customer-managed envelope format. */
  static isEnvelope(value: string): boolean {
    return typeof value === 'string' && value.startsWith(KMS_PREFIX);
  }

  /**
   * Encrypt a secret for an org. Uses the customer's CMK-wrapped DEK when the
   * org is entitled AND has an enabled KMS config; otherwise falls through to
   * the unchanged platform-managed field-crypto path.
   */
  async encryptForOrg(organizationId: string, plaintext: string): Promise<string> {
    const dek = await this.resolveActiveDek(organizationId);
    if (!dek) {
      // No CMK in play — behave EXACTLY as today.
      return platformEncryptField(plaintext);
    }
    return this.gcmEncrypt(dek, plaintext);
  }

  /**
   * Decrypt a secret. Routing is driven by the stored ciphertext prefix so
   * platform-encrypted and plaintext (not-yet-migrated) values always take the
   * unchanged platform path, regardless of the org's current KMS config.
   */
  async decryptForOrg(organizationId: string, value: string): Promise<string> {
    if (!EnvelopeCryptoService.isEnvelope(value)) {
      // Platform-managed or plaintext — unchanged behavior.
      return platformDecryptField(value);
    }

    // Customer-managed value: we MUST unwrap the DEK via KMS. If that fails we
    // surface the error rather than returning ciphertext or plaintext.
    const dek = await this.loadDek(organizationId);
    if (!dek) {
      throw new Error(
        `Cannot decrypt customer-managed secret for org ${organizationId}: ` +
          `no KMS config / wrapped DEK available`,
      );
    }
    return this.gcmDecrypt(dek, value);
  }

  /** Invalidate the cached plaintext DEK for an org (e.g. after CMK rotation). */
  invalidate(organizationId: string): void {
    this.dekCache.delete(organizationId);
  }

  /**
   * Prime the in-process DEK cache for an org so subsequent SYNCHRONOUS reads
   * (entity methods routing `encrypted:kms:` through the registered unwrap hook)
   * can unwrap without a network round-trip. No-op for orgs without an enabled
   * CMK — those never produce kms values, so the sync path never needs a DEK.
   * Call this from an async service method right before handing an entity to
   * sync consumers (provider helpers, getAuthHeaders, etc.).
   */
  async warmOrg(organizationId: string): Promise<void> {
    if (!organizationId) return;
    try {
      await this.loadDek(organizationId);
    } catch (err) {
      // A failure to warm is not fatal here — if the org actually has kms
      // values, the sync read will surface a clear error. Non-kms orgs are
      // unaffected.
      this.logger.warn(
        `warmOrg failed for ${organizationId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Synchronously decrypt an `encrypted:kms:` value using the ALREADY-CACHED
   * DEK for the org. Backs the registered unwrap hook. Throws if the DEK is not
   * cached (caller forgot to `warmOrg`) — we never silently fall back, since
   * that would risk leaking ciphertext downstream.
   */
  decryptCached(organizationId: string, value: string): string {
    const cached = this.dekCache.get(organizationId);
    if (!cached || cached.expiresAt <= Date.now()) {
      throw new Error(
        `No warmed DEK for org ${organizationId} while decrypting a ` +
          `customer-managed value. Call warmOrg() before sync reads.`,
      );
    }
    return this.gcmDecrypt(cached.dek, value);
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Return the DEK to encrypt NEW values with for this org, or null to signal
   * "use the platform path". Null unless the org is both entitled and has an
   * enabled config with a wrapped DEK.
   */
  private async resolveActiveDek(organizationId: string): Promise<Buffer | null> {
    if (!organizationId) return null;

    const entitled = await this.orgLicenseResolver.hasForOrg(
      organizationId,
      EE_ENTITLEMENTS.BYO_KMS,
    );
    if (!entitled) return null;

    return this.loadDek(organizationId);
  }

  /**
   * Load and cache the org's plaintext DEK by unwrapping the stored wrapped DEK
   * via KMS `Decrypt`. Returns null when the org has no enabled config / no
   * wrapped DEK. Throws if KMS decryption itself fails — callers decide whether
   * that is fatal (it always is on the decrypt path).
   */
  private async loadDek(organizationId: string): Promise<Buffer | null> {
    const now = Date.now();
    const cached = this.dekCache.get(organizationId);
    if (cached && cached.expiresAt > now) {
      return cached.dek;
    }

    const config = await this.kmsConfigRepo.findOne({
      where: { organizationId },
    });
    if (!config || !config.enabled || !config.wrappedDek || !config.cmkArn) {
      return null;
    }

    const dek = await this.unwrapDek(config);
    this.dekCache.set(organizationId, {
      dek,
      expiresAt: now + DEK_CACHE_TTL_MS,
    });
    return dek;
  }

  /** Unwrap (KMS `Decrypt`) a stored wrapped DEK into the raw 32-byte key. */
  private async unwrapDek(config: OrgKmsConfig): Promise<Buffer> {
    const plaintext = await this.kmsClientFactory.decrypt(
      { keyArn: config.cmkArn as string, region: config.awsRegion },
      Buffer.from(config.wrappedDek as string, 'base64'),
    );
    if (!plaintext || plaintext.length !== 32) {
      throw new Error(
        `KMS returned an unexpected DEK length (${plaintext?.length ?? 0} bytes) ` +
          `for org ${config.organizationId}`,
      );
    }
    return plaintext;
  }

  private gcmEncrypt(key: Buffer, plaintext: string): string {
    const iv = randomBytes(12); // 96-bit IV, GCM standard
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    let ct = cipher.update(plaintext, 'utf8', 'hex');
    ct += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return `${KMS_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct}`;
  }

  private gcmDecrypt(key: Buffer, value: string): string {
    // value = encrypted:kms:<iv>:<tag>:<ct>
    const rest = value.slice(KMS_PREFIX.length);
    const parts = rest.split(':');
    if (parts.length !== 3) {
      throw new Error(
        'Malformed envelope value: expected `encrypted:kms:<iv>:<authTag>:<ct>`',
      );
    }
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let pt = decipher.update(parts[2], 'hex', 'utf8');
    pt += decipher.final('utf8');
    return pt;
  }
}
