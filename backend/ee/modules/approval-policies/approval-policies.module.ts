import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApprovalPolicy } from '../../../src/entities/approval-policy.entity';

import { ApprovalPolicyService } from './approval-policy.service';
import { ApprovalPolicyEvaluator } from './approval-policy.evaluator';
import { ApprovalPoliciesController } from './approval-policies.controller';

/**
 * EE (approval_policy): multi-step / conditional / quorum policy engine
 * layered on the OSS approvals module. Controller-gated by
 * `EntitlementGuard`; exports the service + evaluator so the approvals
 * runtime can consult a policy when resolving a gate.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ApprovalPolicy])],
  providers: [ApprovalPolicyService, ApprovalPolicyEvaluator],
  controllers: [ApprovalPoliciesController],
  exports: [ApprovalPolicyService, ApprovalPolicyEvaluator],
})
export class ApprovalPoliciesModule {}
