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
  createHash,
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
 *   format: `encrypted:kms:<keyId-hex>:<iv-hex>:<authTag-hex>:<ct-hex>`
 *
 * The key id names the DEK the value was sealed with, so a value is matched to
 * the key that sealed it rather than to whichever DEK the org's config happens
 * to hold when it is read. That is what makes a CMK rotation cheap: the
 * outgoing wrapped DEK is kept, the values sealed under it keep naming it, and
 * nothing has to be re-encrypted for them to stay readable.
 */
const KMS_PREFIX = 'encrypted:kms:';

/** Number of `:`-separated fields an envelope value carries after the prefix. */
const ENVELOPE_FIELDS = 4;

/**
 * How long an unwrapped DEK is cached in-process, in milliseconds. KMS
 * `Decrypt` is a network call charged per request; caching the plaintext DEK
 * for a short window bounds both latency and cost while keeping the key
 * material out of the database. The cache is process-local and never persisted.
 */
const DEK_CACHE_TTL_MS = 5 * 60_000;

/**
 * How many times a load of the ACTIVE DEK will start over because the wrapped
 * blob changed under it. A rotation lands once; anything past this is a
 * configuration being rewritten in a loop, and picking a key out of it would
 * be a guess.
 */
const MAX_DEK_LOAD_ATTEMPTS = 3;

/**
 * How many leading bytes of a wrapped DEK's sha256 name it in ciphertext.
 *
 * Eight is generous. Key ids are only ever compared within one organization,
 * so a collision needs two of that org's own wrapped blobs to agree on 64
 * bits: at ten thousand rotations the chance is still under 1 in 10^11, and
 * an org reaching ten thousand rotations is already implausible. A collision
 * would also be inert rather than dangerous — the wrong DEK fails the value's
 * GCM tag and the read throws, so no value is ever decrypted with a key that
 * did not seal it.
 */
const KEY_ID_BYTES = 8;

/**
 * Which wrapped DEK a cached key came from. Not a secret: it fingerprints
 * the wrapped blob, which is already at rest in the config row, never the
 * plaintext key.
 */
function fingerprintOf(wrappedDek: string): string {
  return createHash('sha256').update(wrappedDek).digest('hex');
}

/**
 * The identifier a wrapped DEK is known by in ciphertext: the leading bytes of
 * its fingerprint. Always computed from the blob, never read back from a
 * stored field, so a key id cannot be made to point at a blob other than the
 * one it was derived from.
 */
export function keyIdOf(wrappedDek: string): string {
  return fingerprintOf(wrappedDek).slice(0, KEY_ID_BYTES * 2);
}

function cacheKeyFor(organizationId: string, keyId: string): string {
  return `${organizationId}::${keyId}`;
}

/**
 * Split an envelope value into its `<keyId>:<iv>:<authTag>:<ct>` fields. A
 * value that does not carry exactly those four is refused rather than
 * interpreted: guessing which field is which would mean decrypting with
 * something other than the key the value names.
 */
function envelopeFields(value: string): string[] {
  const parts = value.slice(KMS_PREFIX.length).split(':');
  if (parts.length !== ENVELOPE_FIELDS) {
    throw new Error(
      'Malformed envelope value: expected ' +
        '`encrypted:kms:<keyId>:<iv>:<authTag>:<ct>`',
    );
  }
  return parts;
}

/** The key id a sealed value names. */
function keyIdFromValue(value: string): string {
  return envelopeFields(value)[0];
}

interface DekCacheEntry {
  dek: Buffer;
  /** The wrapped blob this key was unwrapped from. */
  fingerprint: string;
  expiresAt: number;
}

/** A DEK together with the id that values sealed under it carry. */
interface ActiveDek {
  dek: Buffer;
  keyId: string;
}

/** A wrapped DEK and the CMK reference needed to unwrap it. */
interface WrappedDekRef {
  keyId: string;
  wrappedDek: string;
  cmkArn: string;
  awsRegion: string | null;
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
 * When engaged, `encryptForOrg` derives the org's active DEK (unwrapping the
 * stored wrapped DEK via KMS `Decrypt`), encrypts the field with AES-256-GCM
 * under that DEK, and tags the ciphertext with the `encrypted:kms:` prefix and
 * the key's id.
 *
 * `decryptForOrg` routes on the stored prefix, NOT on the org's current
 * config: a `encrypted:kms:` value is always unwrapped via KMS, and any other
 * value goes to the platform path. This guarantees existing/non-KMS data keeps
 * decrypting exactly as before and is never silently misread.
 *
 * Within the customer-managed path the stored value keeps deciding, too: the
 * key id in the ciphertext picks the DEK, so a value sealed before a rotation
 * is unwrapped with the DEK that sealed it. An id with no wrapped DEK behind
 * it is an error, never a fallback to whichever key is current.
 */
@Injectable()
export class EnvelopeCryptoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnvelopeCryptoService.name);

  /**
   * Unwrapped-DEK cache, keyed by organization AND key id. Plaintext, in-memory
   * only. An org holds one entry per key it is currently reading values under,
   * so warming a retired key does not evict the active one or vice versa.
   */
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
    const active = await this.resolveActiveDek(organizationId);
    if (!active) {
      // No CMK in play — behave EXACTLY as today.
      return platformEncryptField(plaintext);
    }
    return this.gcmEncrypt(active, plaintext);
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

    // Customer-managed value: we MUST unwrap the DEK the value names, via KMS.
    // If that fails we surface the error rather than returning ciphertext or
    // plaintext, and rather than retrying under a different key.
    const dek = await this.loadDekById(organizationId, keyIdFromValue(value));
    return this.gcmDecrypt(dek, value);
  }

  /**
   * Drop this process's cached plaintext DEKs for an org, e.g. right after
   * a rotation. A local courtesy only, and deliberately not load-bearing:
   * it reaches neither the other replicas nor a request already inside a
   * KMS call, so correctness rests on the active-DEK load keying its cache
   * to the wrapped blob the config actually holds.
   */
  invalidate(organizationId: string): void {
    const prefix = `${organizationId}::`;
    for (const key of this.dekCache.keys()) {
      if (key.startsWith(prefix)) this.dekCache.delete(key);
    }
  }

  /**
   * Prime the in-process DEK cache for an org so subsequent SYNCHRONOUS reads
   * (entity methods routing `encrypted:kms:` through the registered unwrap hook)
   * can unwrap without a network round-trip. No-op for orgs that have never had
   * a CMK — those never produce kms values, so the sync path never needs a DEK.
   * Call this from an async service method right before handing an entity to
   * sync consumers (provider helpers, getAuthHeaders, etc.).
   *
   * Every DEK the org can unwrap is warmed, not just the active one: a secret
   * sealed before a rotation names a retired key, and a sync read has no way to
   * fetch it on demand.
   */
  async warmOrg(organizationId: string): Promise<void> {
    if (!organizationId) return;
    let refs: WrappedDekRef[] = [];
    try {
      refs = await this.wrappedDeksFor(organizationId);
    } catch (err) {
      this.logger.warn(
        `warmOrg failed for ${organizationId}: ${(err as Error).message}`,
      );
      return;
    }
    for (const ref of refs) {
      try {
        await this.dekFor(organizationId, ref);
      } catch (err) {
        // A failure to warm one key is not fatal here — if the org actually
        // has values under it, the sync read will surface a clear error, and
        // the org's other keys are still worth warming. Non-kms orgs are
        // unaffected.
        this.logger.warn(
          `warmOrg failed for ${organizationId} key ${ref.keyId}: ` +
            `${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Synchronously decrypt an `encrypted:kms:` value using the ALREADY-CACHED
   * DEK the value names. Backs the registered unwrap hook. Throws if that DEK
   * is not cached (caller forgot to `warmOrg`) — we never silently fall back,
   * since that would risk leaking ciphertext downstream, and never substitute
   * another of the org's keys.
   */
  decryptCached(organizationId: string, value: string): string {
    const keyId = keyIdFromValue(value);
    const cached = this.dekCache.get(cacheKeyFor(organizationId, keyId));
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
   * Return the DEK to seal NEW values for this org with, or null to signal
   * "use the platform path". Null unless the org is both entitled and has an
   * enabled config with a wrapped DEK.
   */
  private async resolveActiveDek(organizationId: string): Promise<ActiveDek | null> {
    if (!organizationId) return null;

    const entitled = await this.orgLicenseResolver.hasForOrg(
      organizationId,
      EE_ENTITLEMENTS.BYO_KMS,
    );
    if (!entitled) return null;

    return this.loadActiveDek(organizationId);
  }

  /**
   * Load and cache the org's ACTIVE plaintext DEK — the one new values are
   * sealed under — by unwrapping the stored wrapped DEK via KMS `Decrypt`.
   * Returns null when the org has no enabled config / no wrapped DEK. Throws if
   * KMS decryption itself fails.
   *
   * The entry is bound to the wrapped DEK it came from, not just to the
   * org, because `invalidate()` cannot be relied on to clear it.
   * `invalidate()` is a process-local `Map` sweep: every OTHER replica
   * would keep treating a superseded DEK as active for the rest of the
   * TTL, and even on one replica the invalidate is lost whenever a
   * request is already inside the KMS call — there is nothing cached to
   * delete yet, and the request then caches the key it has just
   * unwrapped. So the config row (a cheap indexed read, against a KMS
   * call charged per request) is read first and the entry keyed on the
   * blob's fingerprint: a rotation cannot be masked by a cache entry,
   * and one that lands inside the unwrap is caught by re-reading the row
   * before the key is used.
   *
   * What that protects is narrower than it once was. A value sealed under a
   * superseded DEK is no longer lost — it names its key and the wrapped blob
   * is retained — so this is about keeping `retiredDeks` an accurate history
   * of which key was active when, and refusing to guess at a configuration
   * being rewritten underneath us.
   */
  private async loadActiveDek(
    organizationId: string,
    attempt = 0,
  ): Promise<ActiveDek | null> {
    const config = await this.kmsConfigRepo.findOne({
      where: { organizationId },
    });
    if (!config || !config.enabled || !config.wrappedDek || !config.cmkArn) {
      // Nothing to seal new values with. Cached DEKs stay: an entry is
      // addressed by key id, which names one immutable wrapped blob, so it can
      // only ever be used to READ values already sealed under that key. An org
      // whose envelope path is switched off still has to be able to read them.
      return null;
    }

    const fingerprint = fingerprintOf(config.wrappedDek);
    const keyId = keyIdOf(config.wrappedDek);
    const cached = this.cachedDek(organizationId, keyId, fingerprint);
    if (cached) return { dek: cached, keyId };

    const dek = await this.unwrapDek(organizationId, {
      keyId,
      wrappedDek: config.wrappedDek,
      cmkArn: config.cmkArn,
      awsRegion: config.awsRegion,
    });

    // The unwrap is a network call of tens of milliseconds. A rotation
    // committed inside it makes this DEK the retired one, so new values must
    // not be sealed under it: confirm the row still holds the blob that was
    // unwrapped, and start over if it does not.
    const current = await this.kmsConfigRepo.findOne({
      where: { organizationId },
    });
    if (!current?.wrappedDek || fingerprintOf(current.wrappedDek) !== fingerprint) {
      if (attempt + 1 >= MAX_DEK_LOAD_ATTEMPTS) {
        throw new Error(
          `The KMS configuration for org ${organizationId} kept changing while ` +
            `its DEK was being unwrapped; refusing to use a superseded key`,
        );
      }
      return this.loadActiveDek(organizationId, attempt + 1);
    }

    this.cacheDek(organizationId, keyId, fingerprint, dek);
    return { dek, keyId };
  }

  /**
   * The DEK a specific key id names. A key id is the fingerprint of one
   * wrapped blob, so what it names never changes: unlike the active-key path
   * there is no rotation to race here and no re-read guarding against one.
   */
  private async loadDekById(
    organizationId: string,
    keyId: string,
  ): Promise<Buffer> {
    const refs = await this.wrappedDeksFor(organizationId);
    const ref = refs.find((r) => r.keyId === keyId);
    if (!ref) {
      throw new Error(
        `Cannot decrypt customer-managed secret for org ${organizationId}: ` +
          `no wrapped DEK is stored for key id ${keyId}`,
      );
    }
    return this.dekFor(organizationId, ref);
  }

  /**
   * Every wrapped DEK the org can unwrap — the active one first, then each
   * retired one, newest last.
   *
   * The active DEK is listed regardless of `enabled`. Disabling stops new
   * values being sealed under the CMK; it does not make the values already
   * sealed under it unreadable, and re-enabling does not have to recover
   * anything. Entitlement is likewise not consulted: it governs which path
   * writes take, and a value already written has to stay readable either way.
   *
   * Every `keyId` here is recomputed from its blob rather than read out of the
   * row, so the id a value names can only ever resolve to the blob it was
   * derived from.
   */
  private async wrappedDeksFor(organizationId: string): Promise<WrappedDekRef[]> {
    const config = await this.kmsConfigRepo.findOne({
      where: { organizationId },
    });
    if (!config) return [];

    const refs: WrappedDekRef[] = [];
    if (config.wrappedDek && config.cmkArn) {
      refs.push({
        keyId: keyIdOf(config.wrappedDek),
        wrappedDek: config.wrappedDek,
        cmkArn: config.cmkArn,
        awsRegion: config.awsRegion,
      });
    }
    for (const retired of config.retiredDeks ?? []) {
      if (!retired?.wrappedDek || !retired.cmkArn) continue;
      refs.push({
        keyId: keyIdOf(retired.wrappedDek),
        wrappedDek: retired.wrappedDek,
        cmkArn: retired.cmkArn,
        awsRegion: retired.awsRegion ?? null,
      });
    }
    return refs;
  }

  /** Unwrap one wrapped DEK, reusing a live cache entry for it when there is one. */
  private async dekFor(
    organizationId: string,
    ref: WrappedDekRef,
  ): Promise<Buffer> {
    const fingerprint = fingerprintOf(ref.wrappedDek);
    const cached = this.cachedDek(organizationId, ref.keyId, fingerprint);
    if (cached) return cached;

    const dek = await this.unwrapDek(organizationId, ref);
    this.cacheDek(organizationId, ref.keyId, fingerprint, dek);
    return dek;
  }

  /**
   * A live cached DEK for this (org, key id), but only if it was unwrapped from
   * the blob we are asking about.
   */
  private cachedDek(
    organizationId: string,
    keyId: string,
    fingerprint: string,
  ): Buffer | null {
    const cached = this.dekCache.get(cacheKeyFor(organizationId, keyId));
    if (cached && cached.fingerprint === fingerprint && cached.expiresAt > Date.now()) {
      return cached.dek;
    }
    return null;
  }

  private cacheDek(
    organizationId: string,
    keyId: string,
    fingerprint: string,
    dek: Buffer,
  ): void {
    this.dekCache.set(cacheKeyFor(organizationId, keyId), {
      dek,
      fingerprint,
      expiresAt: Date.now() + DEK_CACHE_TTL_MS,
    });
  }

  /** Unwrap (KMS `Decrypt`) a stored wrapped DEK into the raw 32-byte key. */
  private async unwrapDek(
    organizationId: string,
    ref: WrappedDekRef,
  ): Promise<Buffer> {
    const plaintext = await this.kmsClientFactory.decrypt(
      { keyArn: ref.cmkArn, region: ref.awsRegion },
      Buffer.from(ref.wrappedDek, 'base64'),
    );
    if (!plaintext || plaintext.length !== 32) {
      throw new Error(
        `KMS returned an unexpected DEK length (${plaintext?.length ?? 0} bytes) ` +
          `for org ${organizationId}`,
      );
    }
    return plaintext;
  }

  private gcmEncrypt(active: ActiveDek, plaintext: string): string {
    const iv = randomBytes(12); // 96-bit IV, GCM standard
    const cipher = createCipheriv('aes-256-gcm', active.dek, iv);
    let ct = cipher.update(plaintext, 'utf8', 'hex');
    ct += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return (
      `${KMS_PREFIX}${active.keyId}:${iv.toString('hex')}:` +
      `${tag.toString('hex')}:${ct}`
    );
  }

  private gcmDecrypt(key: Buffer, value: string): string {
    // value = encrypted:kms:<keyId>:<iv>:<tag>:<ct>
    const [, ivHex, tagHex, ct] = envelopeFields(value);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let pt = decipher.update(ct, 'hex', 'utf8');
    pt += decipher.final('utf8');
    return pt;
  }
}
