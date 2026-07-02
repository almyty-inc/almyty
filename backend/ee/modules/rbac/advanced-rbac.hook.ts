import { Injectable } from '@nestjs/common';

import {
  AdvancedRbacHook,
  RbacHookDecision,
} from '../../../src/common/ee-hooks/ee-hooks';
import { LicenseService } from '../../../src/modules/licensing/license.service';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';

import { CustomRoleService } from './custom-role.service';
import { EvaluationContext } from './policy-evaluator.service';

/**
 * EE (advanced_rbac): runtime bridge bound to the core
 * `ADVANCED_RBAC_HOOK` token, consulted by the core RolesGuard:
 *
 *  - `hasPermission` — additive custom-role grants: can ALLOW what the
 *    built-in role/permission checks would deny.
 *  - `evaluateAccess` — ABAC deny-overrides: an applicable `deny` policy
 *    rejects the request even when built-ins pass. A `default` (no
 *    applicable policy) maps to 'abstain' so ABAC never fails-closed on
 *    orgs that only use it as an extra deny layer.
 *
 * Entitlement is checked per call: unlicensed → no grants, always abstain
 * — exactly the community behavior.
 */
@Injectable()
export class AdvancedRbacHookImpl implements AdvancedRbacHook {
  constructor(
    private readonly customRoles: CustomRoleService,
    private readonly license: LicenseService,
  ) {}

  async hasPermission(
    organizationId: string,
    userId: string,
    permission: string,
  ): Promise<boolean> {
    if (!this.license.has(EE_ENTITLEMENTS.ADVANCED_RBAC)) return false;
    return this.customRoles.hasPermission(organizationId, userId, permission);
  }

  async evaluateAccess(
    organizationId: string,
    action: string,
    ctx: EvaluationContext,
  ): Promise<RbacHookDecision> {
    if (!this.license.has(EE_ENTITLEMENTS.ADVANCED_RBAC)) {
      return { effect: 'abstain' };
    }
    const decision = await this.customRoles.evaluateAccess(organizationId, action, ctx);
    if (decision.effect === 'deny') {
      return { effect: 'deny', reason: decision.reason };
    }
    if (decision.effect === 'allow') {
      return { effect: 'allow', reason: decision.reason };
    }
    // 'default' — no applicable policy.
    return { effect: 'abstain', reason: decision.reason };
  }
}
