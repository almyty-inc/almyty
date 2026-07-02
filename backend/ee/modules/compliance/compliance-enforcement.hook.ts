import { Injectable } from '@nestjs/common';

import {
  ComplianceEnforcement,
  ComplianceEnforcementHook,
} from '../../../src/common/ee-hooks/ee-hooks';
import { LicenseService } from '../../../src/modules/licensing/license.service';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';

import { ComplianceService, EffectiveCompliancePolicy } from './compliance.service';

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
    private readonly license: LicenseService,
  ) {}

  async getEnforcement(organizationId: string): Promise<ComplianceEnforcement | null> {
    if (!this.license.has(EE_ENTITLEMENTS.COMPLIANCE_PACK)) return null;

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
   * mode; the PII filter runs with its registered settings.
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
          : {};
    }
    return { enforcedPlugins, blockOnViolation: policy.blockOnViolation };
  }
}
