import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';

import { OrgKmsConfig, RetiredDek } from '../../entities/org-kms-config.entity';
import { KmsClientFactory } from './kms.service';
import { EnvelopeCryptoService, keyIdOf } from './envelope-crypto.service';

export interface KmsConfigView {
  organizationId: string;
  enabled: boolean;
  cmkArn: string | null;
  awsRegion: string | null;
  /** True once a DEK has been wrapped under the CMK. Never exposes the DEK. */
  provisioned: boolean;
  /**
   * Id of the DEK new values are sealed under, or null when none is attached.
   * A fingerprint of a blob already at rest, not key material.
   */
  activeKeyId: string | null;
  /** Ids of the DEKs this org has rotated away from, oldest first. */
  retiredKeyIds: string[];
  updatedAt: Date | null;
}

/**
 * Admin-facing lifecycle for a customer's BYO-KMS configuration: attach a CMK,
 * rotate to a new DEK (optionally under a new CMK), enable or disable the
 * envelope path, and read back status. Every method here is reached through
 * routes gated by `@RequiresEntitlement('byo_kms')`.
 *
 * Attaching and rotating are separate operations on purpose. Both mint a NEW
 * random 256-bit DEK and wrap it with the customer's CMK via KMS `Encrypt`,
 * storing only the wrapped blob — but a rotation additionally has to keep the
 * outgoing wrapped DEK, because the values already sealed under it name it and
 * are unwrapped with it. `attachCmk` refuses an org that already has a key
 * rather than quietly doing a rotation's job without a rotation's care.
 */
@Injectable()
export class KmsProvisioningService {
  private readonly logger = new Logger(KmsProvisioningService.name);

  constructor(
    @InjectRepository(OrgKmsConfig)
    private readonly repo: Repository<OrgKmsConfig>,
    private readonly kmsClientFactory: KmsClientFactory,
    private readonly envelopeCrypto: EnvelopeCryptoService,
  ) {}

  async getConfig(organizationId: string): Promise<KmsConfigView> {
    const config = await this.repo.findOne({ where: { organizationId } });
    return this.toView(organizationId, config);
  }

  /**
   * Attach the CMK for an org for the first time. Generates a fresh DEK, wraps
   * it with the CMK via KMS `Encrypt`, and persists the wrapped blob. A failing
   * `Encrypt` (bad ARN, denied, wrong region) propagates so the caller gets a
   * clear error instead of a half-written config.
   *
   * Refuses an org that already has a wrapped DEK: replacing one is a rotation,
   * and a rotation has to retain the key it replaces. `rotateCmk` does that.
   */
  async attachCmk(
    organizationId: string,
    input: { cmkArn: string; awsRegion?: string | null; enabled?: boolean },
  ): Promise<KmsConfigView> {
    const existing = await this.repo.findOne({ where: { organizationId } });
    if (existing?.wrappedDek) {
      throw new ConflictException(
        'This organization already has a customer-managed key attached. ' +
          'Rotate it instead.',
      );
    }

    const region = input.awsRegion ?? null;

    // Mint a fresh 256-bit DEK and wrap it with the customer's CMK. We verify
    // the CMK is usable BEFORE writing anything.
    const wrapped = await this.wrapFreshDek(input.cmkArn, region);

    const config = existing ?? this.repo.create({ organizationId });
    config.cmkArn = input.cmkArn;
    config.awsRegion = region;
    config.wrappedDek = wrapped;
    config.enabled = input.enabled ?? true;
    config.retiredDeks = config.retiredDeks ?? [];

    const saved = await this.repo.save(config);
    this.envelopeCrypto.invalidate(organizationId);
    this.logger.log(
      `Attached a customer-managed key for org ${organizationId} ` +
        `(key ${keyIdOf(wrapped)})`,
    );
    return this.toView(organizationId, saved);
  }

  /**
   * Rotate the org onto a fresh DEK, optionally under a different CMK.
   *
   * The outgoing wrapped DEK moves to `retiredDeks` in the SAME row update
   * that installs the new one, so there is no moment at which a wrapped DEK
   * is neither active nor retained. Values sealed under the outgoing key
   * carry its id and keep decrypting with it; nothing is re-encrypted and
   * nothing becomes unreadable.
   *
   * Omitting `cmkArn` rotates the DEK under the CMK already configured.
   */
  async rotateCmk(
    organizationId: string,
    input: { cmkArn?: string | null; awsRegion?: string | null } = {},
  ): Promise<KmsConfigView> {
    const config = await this.repo.findOne({ where: { organizationId } });
    if (!config) {
      throw new NotFoundException('No KMS configuration for this organization');
    }
    if (!config.wrappedDek || !config.cmkArn) {
      throw new ConflictException(
        'This organization has no customer-managed key to rotate. Attach one first.',
      );
    }

    // A new ARN brings its own region (derived from the ARN when not given);
    // rotating under the same CMK keeps the region already configured.
    const targetArn = input.cmkArn ?? config.cmkArn;
    const targetRegion = input.cmkArn
      ? (input.awsRegion ?? null)
      : (input.awsRegion ?? config.awsRegion);

    // Verify the target CMK can wrap before anything is written.
    const wrapped = await this.wrapFreshDek(targetArn, targetRegion);

    const retiring: RetiredDek = {
      keyId: keyIdOf(config.wrappedDek),
      wrappedDek: config.wrappedDek,
      cmkArn: config.cmkArn,
      awsRegion: config.awsRegion,
      retiredAt: new Date().toISOString(),
    };

    const retired = [...(config.retiredDeks ?? [])];
    if (!retired.some((r) => keyIdOf(r.wrappedDek) === retiring.keyId)) {
      retired.push(retiring);
    }

    config.retiredDeks = retired;
    config.cmkArn = targetArn;
    config.awsRegion = targetRegion;
    config.wrappedDek = wrapped;

    const saved = await this.repo.save(config);
    this.envelopeCrypto.invalidate(organizationId);
    this.logger.log(
      `Rotated the customer-managed key for org ${organizationId}: ` +
        `${retiring.keyId} retired, ${keyIdOf(wrapped)} active`,
    );
    return this.toView(organizationId, saved);
  }

  /**
   * Enable/disable the envelope path without discarding any wrapped DEK.
   *
   * Only writes are affected: while disabled, new secrets take the
   * platform-managed path, and the values already sealed under the org's keys
   * stay readable through those keys. Nothing is orphaned by disabling, and
   * re-enabling resumes sealing under the same active key.
   */
  async setEnabled(
    organizationId: string,
    enabled: boolean,
  ): Promise<KmsConfigView> {
    const config = await this.repo.findOne({ where: { organizationId } });
    if (!config) {
      throw new NotFoundException('No KMS configuration for this organization');
    }
    config.enabled = enabled;
    const saved = await this.repo.save(config);
    this.envelopeCrypto.invalidate(organizationId);
    return this.toView(organizationId, saved);
  }

  /** Mint a random 256-bit DEK and return it wrapped by the given CMK, base64. */
  private async wrapFreshDek(
    cmkArn: string,
    region: string | null,
  ): Promise<string> {
    const dek = randomBytes(32);
    const wrapped = await this.kmsClientFactory.encrypt(
      { keyArn: cmkArn, region },
      dek,
    );
    return wrapped.toString('base64');
  }

  private toView(
    organizationId: string,
    config: OrgKmsConfig | null,
  ): KmsConfigView {
    return {
      organizationId,
      enabled: config?.enabled ?? false,
      cmkArn: config?.cmkArn ?? null,
      awsRegion: config?.awsRegion ?? null,
      provisioned: Boolean(config?.wrappedDek),
      activeKeyId: config?.wrappedDek ? keyIdOf(config.wrappedDek) : null,
      retiredKeyIds: (config?.retiredDeks ?? []).map((r) =>
        keyIdOf(r.wrappedDek),
      ),
      updatedAt: config?.updatedAt ?? null,
    };
  }
}
