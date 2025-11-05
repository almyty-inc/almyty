import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';

import { UsageMetric } from '../../entities/usage-metric.entity';
import { Tool } from '../../entities/tool.entity';
import { Api } from '../../entities/api.entity';
import { Organization } from '../../entities/organization.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UsageMetric,
      Tool,
      Api,
      Organization,
    ]),
  ],
  controllers: [MonitoringController],
  providers: [MonitoringService],
  exports: [MonitoringService],
})
export class MonitoringModule {}