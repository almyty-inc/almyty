import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { MetricsRecorderService } from './metrics-recorder.service';

/**
 * Global so any protocol controller can inject MetricsRecorderService to emit
 * semantic usage_metrics rows without each feature module re-declaring the
 * UsageMetric repository.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([UsageMetric])],
  providers: [MetricsRecorderService],
  exports: [MetricsRecorderService],
})
export class MetricsModule {}
