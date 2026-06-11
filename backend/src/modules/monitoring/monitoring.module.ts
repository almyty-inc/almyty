import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { MonitoringRedisStatsHelper } from './monitoring-redis-stats.helper';
import { MetricsRetentionService } from './metrics-retention.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsExportHelper } from './analytics-export.helper';
import { AnalyticsSummariesHelper } from './analytics-summaries.helper';

import { UsageMetric } from '../../entities/usage-metric.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { Tool } from '../../entities/tool.entity';
import { Api } from '../../entities/api.entity';
import { Organization } from '../../entities/organization.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { AgentRun } from '../../entities/agent-run.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UsageMetric,
      RequestLog,
      ToolExecution,
      Conversation,
      Message,
      Tool,
      Api,
      Organization,
      AuditLog,
      AgentRun,
    ]),
  ],
  controllers: [MonitoringController, AnalyticsController],
  providers: [MonitoringService, AnalyticsService, MonitoringRedisStatsHelper, MetricsRetentionService, AnalyticsExportHelper, AnalyticsSummariesHelper],
  exports: [MonitoringService, AnalyticsService],
})
export class MonitoringModule {}
