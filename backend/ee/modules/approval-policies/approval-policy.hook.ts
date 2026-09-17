import { Injectable } from '@nestjs/common';

import {
  ApprovalPolicyApproval,
  ApprovalPolicyHook,
  ApprovalPolicyProgress,
  ApprovalPolicyRef,
} from '../../../src/common/ee-hooks/ee-hooks';
import { OrgLicenseResolver } from '../../../src/modules/licensing/org-license.resolver';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';

import { ApprovalPolicyService } from './approval-policy.service';
import { ApprovalContext } from './approval-policy.evaluator';

/**
 * EE (approval_policy): runtime bridge bound to the core
 * `APPROVAL_POLICY_HOOK` token. The core ApprovalsService consults it on
 * create (which policy governs the request) and on approve (has the
 * policy's steps/quorum been satisfied).
 *
 * Entitlement is checked per call: unlicensed → both methods return null,
 * which the core treats as "OSS single-gate flow". A policy deleted after
 * the request was created also scores null (single gate), never a lockout.
 */
@Injectable()
export class ApprovalPolicyHookImpl implements ApprovalPolicyHook {
  constructor(
    private readonly policies: ApprovalPolicyService,
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

  async resolveForContext(
    organizationId: string,
    ctx: Record<string, unknown>,
  ): Promise<ApprovalPolicyRef | null> {
    if (!(await this.licensed(organizationId, EE_ENTITLEMENTS.APPROVAL_POLICY))) return null;
    const policy = await this.policies.resolveForContext(organizationId, ctx as ApprovalContext);
    return policy ? { id: policy.id, name: policy.name } : null;
  }

  async scoreProgress(
    organizationId: string,
    policyId: string,
    approvals: ApprovalPolicyApproval[],
  ): Promise<ApprovalPolicyProgress | null> {
    if (!(await this.licensed(organizationId, EE_ENTITLEMENTS.APPROVAL_POLICY))) return null;
    try {
      const policy = await this.policies.get(organizationId, policyId);
      return this.policies.scoreProgress(policy, approvals);
    } catch {
      // Policy deleted (or otherwise unavailable) since the request was
      // created — degrade to the OSS single gate rather than dead-locking
      // the pending approval.
      return null;
    }
  }
}
