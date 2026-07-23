import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';

import { OrgKmsConfig } from '../../entities/org-kms-config.entity';
import { KmsClientFactory } from './kms.service';
import { EnvelopeCryptoService } from './envelope-crypto.service';

export interface KmsConfigView {
  organizationId: string;
  enabled: boolean;
  cmkArn: string | null;
  awsRegion: string | null;
  /** True once a DEK has been wrapped under the CMK. Never exposes the DEK. */
  provisioned: boolean;
  updatedAt: Date | null;
}

/**
 * Admin-facing lifecycle for a customer's BYO-KMS configuration: attach a CMK
 * (generating + wrapping a fresh DEK), rotate the wrapped DEK, disable, and
 * read back status. Every method here is reached through routes gated by
 * `@RequiresEntitlement('byo_kms')`.
 *
 * Provisioning generates a NEW random 256-bit DEK and wraps it with the
 * customer's CMK via KMS `Encrypt`. Only the wrapped blob is stored. Because a
 * new DEK is minted, this path applies to values encrypted AFTER cutover;
 * older platform-encrypted values remain readable via the platform path
 * (prefix-routed in `EnvelopeCryptoService`). A full re-encryption of existing
 * secrets under the new DEK is intentionally out of scope for this change.
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
   * Attach (or replace) the CMK for an org. Generates a fresh DEK, wraps it
   * with the CMK via KMS `Encrypt`, and persists the wrapped blob. A failing
   * `Encrypt` (bad ARN, denied, wrong region) propagates so the caller gets a
   * clear error instead of a half-written config.
   */
  async setCmk(
    organizationId: string,
    input: { cmkArn: string; awsRegion?: string | null; enabled?: boolean },
  ): Promise<KmsConfigView> {
    const region = input.awsRegion ?? null;

    // Mint a fresh 256-bit DEK and wrap it with the customer's CMK. We verify
    // the CMK is usable BEFORE writing anything.
    const dek = randomBytes(32);
    const wrapped = await this.kmsClientFactory.encrypt(
      { keyArn: input.cmkArn, region },
      dek,
    );

    let config = await this.repo.findOne({ where: { organizationId } });
    if (!config) {
      config = this.repo.create({ organizationId });
    }
    config.cmkArn = input.cmkArn;
    config.awsRegion = region;
    config.wrappedDek = wrapped.toString('base64');
    config.enabled = input.enabled ?? true;

    const saved = await this.repo.save(config);
    // Drop any stale cached DEK so the new one takes effect immediately.
    this.envelopeCrypto.invalidate(organizationId);
    return this.toView(organizationId, saved);
  }

  /** Enable/disable the envelope path without discarding the wrapped DEK. */
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
      updatedAt: config?.updatedAt ?? null,
    };
  }
}
