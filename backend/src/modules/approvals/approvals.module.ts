import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApprovalRequest } from '../../entities/approval-request.entity';
import { AgentRun } from '../../entities/agent-run.entity';

import { AuthorizationModule } from '../../common/authorization/authorization.module';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([ApprovalRequest, AgentRun]),
    AuthorizationModule,
  ],
  providers: [ApprovalsService],
  controllers: [ApprovalsController],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
