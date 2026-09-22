import { Injectable } from '@nestjs/common';

import {
  ComplianceEnforcement,
  ComplianceEnforcementHook,
} from '../../../src/common/ee-hooks/ee-hooks';
import { OrgLicenseResolver } from '../../../src/modules/licensing/org-license.resolver';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';

import { ComplianceService, EffectiveCompliancePolicy } from './compliance.service';
import { piiCategoriesToSettings } from './pii-categories';

/** How long a resolved org policy is reused before re-reading the DB. */
const CACHE_TTL_MS = 30_000;

/**
 * EE (compliance_pack): runtime bridge bound to the core
 * `COMPLIANCE_ENFORCEMENT_HOOK` token. The core plugin manager consults it
 * per hook execution; when the org's policy enforces pii-filter /
 * security-scanner, those plugins run even if not individually enabled,
 * with the policy's threshold/blocking settings applied.
 *
 * The plugin pipeline is hot, so the resolved policy is cached per org for
 * a short TTL (policy edits take effect within CACHE_TTL_MS). Entitlement
 * is checked per call: unlicensed → null → exact community behavior.
 */
@Injectable()
export class ComplianceEnforcementHookImpl implements ComplianceEnforcementHook {
  private readonly cache = new Map<
    string,
    { at: number; value: ComplianceEnforcement | null }
  >();

  constructor(
    private readonly compliance: ComplianceService,
    private readonly licenses: OrgLicenseResolver,
  ) {}

  /**
   * Per-organization, not per-process.
   *
   * Licensing in this product is org-scoped: tokens are minted per org
   * by billing, EntitlementGuard resolves per org, and
   * /licensing/entitlements answers for the requesting org. This hook
   * checked LicenseService -- the process-global singleton, which is
   * community unless ALMYTY_LICENSE_KEY/TOKEN is in the environment.
   * The deployed API sets only the license SIGNING key, so has()
   * returned false for every entitlement, forever: a Business or
   * Enterprise org could reach the settings screen, configure the
   * feature, be told it saved, and have it do nothing at run time.
   */
  private async licensed(organizationId: string, key: string): Promise<boolean> {
    try {
      return await this.licenses.hasForOrg(organizationId, key);
    } catch {
      return false;
    }
  }

  async getEnforcement(organizationId: string): Promise<ComplianceEnforcement | null> {
    if (!(await this.licensed(organizationId, EE_ENTITLEMENTS.COMPLIANCE_PACK))) return null;

    const hit = this.cache.get(organizationId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const policy = await this.compliance.getEffectivePolicy(organizationId);
    const value = this.toEnforcement(policy);
    this.cache.set(organizationId, { at: Date.now(), value });
    return value;
  }

  /**
   * Map the effective policy onto per-plugin settings overrides, mirroring
   * the mapping ComplianceService.getReport presents as enforced controls:
   * the security scanner gets the policy's severity threshold + blocking
   * mode; the PII filter gets its category selection.
   *
   * The PII arm used to be `{}` -- the policy's piiCategories reached this
   * function and stopped here, so four checkboxes on the settings page
   * changed nothing about what got masked while the report claimed they
   * had. Both sides now call piiCategoriesToSettings().
   */
  private toEnforcement(policy: EffectiveCompliancePolicy): ComplianceEnforcement | null {
    if (!policy.enforcedPlugins?.length) return null;
    const enforcedPlugins: Record<string, Record<string, any>> = {};
    for (const plugin of policy.enforcedPlugins) {
      enforcedPlugins[plugin] =
        plugin === 'security-scanner'
          ? {
              severityThreshold: policy.securityThreshold,
              blockOnThreat: policy.blockOnViolation,
            }
          : piiCategoriesToSettings(policy.piiCategories);
    }
    return { enforcedPlugins, blockOnViolation: policy.blockOnViolation };
  }
}
