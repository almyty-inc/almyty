import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RetentionPolicy } from '../../entities/retention-policy.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { Gateway } from '../../entities/gateway.entity';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { RetentionService } from './retention.service';
import { RetentionSweepService } from './retention-sweep.service';
import { RetentionController } from './retention.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RetentionPolicy,
      AgentRun,
      Conversation,
      Message,
      RequestLog,
      UsageMetric,
      AuditLog,
      Gateway,
    ]),
    AuditLogModule,
  ],
  providers: [RetentionService, RetentionSweepService],
  controllers: [RetentionController],
  exports: [RetentionService],
})
export class RetentionModule {}
