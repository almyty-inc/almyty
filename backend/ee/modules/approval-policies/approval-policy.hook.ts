import { Injectable } from '@nestjs/common';

import {
  ApprovalPolicyApproval,
  ApprovalPolicyHook,
  ApprovalPolicyProgress,
  ApprovalPolicyRef,
} from '../../../src/common/ee-hooks/ee-hooks';
import { LicenseService } from '../../../src/modules/licensing/license.service';
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
    private readonly license: LicenseService,
  ) {}

  async resolveForContext(
    organizationId: string,
    ctx: Record<string, unknown>,
  ): Promise<ApprovalPolicyRef | null> {
    if (!this.license.has(EE_ENTITLEMENTS.APPROVAL_POLICY)) return null;
    const policy = await this.policies.resolveForContext(organizationId, ctx as ApprovalContext);
    return policy ? { id: policy.id, name: policy.name } : null;
  }

  async scoreProgress(
    organizationId: string,
    policyId: string,
    approvals: ApprovalPolicyApproval[],
  ): Promise<ApprovalPolicyProgress | null> {
    if (!this.license.has(EE_ENTITLEMENTS.APPROVAL_POLICY)) return null;
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
