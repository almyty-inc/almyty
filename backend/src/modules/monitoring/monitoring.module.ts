import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

import { UsageMetric } from '../../entities/usage-metric.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { LlmSession } from '../../entities/llm-session.entity';
import { LlmMessage } from '../../entities/llm-message.entity';
import { Tool } from '../../entities/tool.entity';
import { Api } from '../../entities/api.entity';
import { Organization } from '../../entities/organization.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UsageMetric,
      RequestLog,
      ToolExecution,
      LlmSession,
      LlmMessage,
      Tool,
      Api,
      Organization,
    ]),
  ],
  controllers: [MonitoringController, AnalyticsController],
  providers: [MonitoringService, AnalyticsService],
  exports: [MonitoringService, AnalyticsService],
})
export class MonitoringModule {}
