import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApprovalPolicy } from '../../../src/entities/approval-policy.entity';
import { APPROVAL_POLICY_HOOK } from '../../../src/common/ee-hooks/ee-hooks';

import { ApprovalPolicyService } from './approval-policy.service';
import { ApprovalPolicyEvaluator } from './approval-policy.evaluator';
import { ApprovalPolicyHookImpl } from './approval-policy.hook';
import { ApprovalPoliciesController } from './approval-policies.controller';

/**
 * EE (approval_policy): multi-step / conditional / quorum policy engine
 * layered on the OSS approvals module. Controller-gated by
 * `EntitlementGuard`.
 *
 * `@Global()` so the `APPROVAL_POLICY_HOOK` binding is resolvable by the
 * core ApprovalsService's `@Optional()` injection without the core
 * importing anything from `ee/`.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ApprovalPolicy])],
  providers: [
    ApprovalPolicyService,
    ApprovalPolicyEvaluator,
    ApprovalPolicyHookImpl,
    { provide: APPROVAL_POLICY_HOOK, useExisting: ApprovalPolicyHookImpl },
  ],
  controllers: [ApprovalPoliciesController],
  exports: [ApprovalPolicyService, ApprovalPolicyEvaluator, APPROVAL_POLICY_HOOK],
})
export class ApprovalPoliciesModule {}