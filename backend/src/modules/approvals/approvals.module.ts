import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApprovalRequest } from '../../entities/approval-request.entity';
import { ApprovalPolicyApprovalRecord } from '../../entities/approval-policy-approval.entity';
import { ApprovalPolicy } from '../../entities/approval-policy.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Tool } from '../../entities/tool.entity';

import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';
import { AmountRulesService } from './amount-rules.service';
import { AmountRulesController } from './amount-rules.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([ApprovalRequest, ApprovalPolicyApprovalRecord, AgentRun, ApprovalPolicy, Tool]),
    AuthorizationModule,
  ],
  providers: [ApprovalsService, AmountRulesService],
  controllers: [ApprovalsController, AmountRulesController],
  exports: [ApprovalsService, AmountRulesService],
})
export class ApprovalsModule {}
