import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { EntitlementSnapshot, LicenseService } from './license.service';

interface CacheEntry {
  snapshot: EntitlementSnapshot;
  expiresAt: number;
}

/** How long a resolved per-org snapshot is cached, in milliseconds. */
const ORG_ENTITLEMENT_TTL_MS = 30_000;

/**
 * Per-org entitlement resolution. Billing is org-scoped: a paying org's signed
 * license token is stored at `organization.billingInfo.licenseToken`. This
 * resolver bridges that stored token to the process-global `LicenseService` so
 * guards and the entitlements endpoint reflect the REQUESTING org's plan, not
 * whatever token happens to be in the deployment's env.
 *
 * Cycle-safety: this injects the `Organization` REPOSITORY (a data dependency
 * registered via `TypeOrmModule.forFeature([Organization])` in the licensing
 * module), NOT `OrganizationsModule` or `BillingModule`. The token is passed as
 * a plain string INTO `LicenseService.resolveToken(...)`, so licensing never
 * imports organizations/billing — no new module import edge, no require cycle.
 */
@Injectable()
export class OrgLicenseResolver {
  private readonly logger = new Logger(OrgLicenseResolver.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    private readonly licenseService: LicenseService,
  ) {}

  /**
   * Resolve the entitlement snapshot for an org from its stored license token,
   * with a ~30s per-org cache. On any lookup error, or when the org has no
   * stored token, `resolveToken` naturally falls back to the global env token
   * then the community set.
   */
  async entitlementsForOrg(organizationId: string): Promise<EntitlementSnapshot> {
    if (!organizationId) {
      return this.licenseService.resolveToken(null);
    }

    const now = Date.now();
    const cached = this.cache.get(organizationId);
    if (cached && cached.expiresAt > now) {
      return cached.snapshot;
    }

    let token: string | null = null;
    try {
      const org = await this.orgRepo.findOne({ where: { id: organizationId } });
      token = (org?.billingInfo?.licenseToken as string | undefined) ?? null;
    } catch (err) {
      this.logger.warn(
        `Failed to load org ${organizationId} for entitlement resolution — ` +
          `falling back to global/community: ${(err as Error).message}`,
      );
    }

    const snapshot = this.licenseService.resolveToken(token);
    this.cache.set(organizationId, {
      snapshot,
      expiresAt: now + ORG_ENTITLEMENT_TTL_MS,
    });
    return snapshot;
  }

  /** True if the org's resolved entitlements grant the given feature. */
  async hasForOrg(organizationId: string, entitlement: string): Promise<boolean> {
    const snapshot = await this.entitlementsForOrg(organizationId);
    return snapshot.entitlements.includes(entitlement);
  }

  /** Drop the cached snapshot for an org (e.g. right after a plan change). */
  invalidate(organizationId: string): void {
    this.cache.delete(organizationId);
  }
}
