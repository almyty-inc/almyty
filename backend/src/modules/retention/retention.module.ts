import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RetentionPolicy } from '../../entities/retention-policy.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Notification } from '../../entities/notification.entity';
import { AgentChannel } from '../../entities/agent-channel.entity';
import { ChannelEvent } from '../../entities/channel-event.entity';
import { RunnerUsageInterval } from '../../entities/runner-usage-interval.entity';

import { FilesModule } from '../files/files.module';
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
      // Both of these were injected @Optional() into the sweep and left
      // out here, so their repositories resolved to undefined and the
      // sweep clauses could never run -- two tables still growing
      // forever behind a fix that reads as done. The spec builds the
      // service directly with mock repos, so it could not see this.
      ToolExecution,
      Notification,
      AgentChannel,
      // Stored widget replies and channel deliveries: visitor words that
      // an app's retention period must reach as well as its conversations.
      ChannelEvent,
      // Hosted usage records, kept for the install's window or the policy's.
      RunnerUsageInterval,
    ]),
    AuditLogModule,
    // Files people sent in a swept conversation go with it (FilesService).
    FilesModule,
  ],
  providers: [RetentionService, RetentionSweepService],
  controllers: [RetentionController],
  exports: [RetentionService],
})
export class RetentionModule {}
