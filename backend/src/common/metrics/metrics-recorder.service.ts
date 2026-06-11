import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  UsageMetric,
  MetricType,
  MetricStatus,
} from '../../entities/usage-metric.entity';

export interface MetricRecordOptions {
  value?: number;
  status?: MetricStatus;
  organizationId?: string | null;
  userId?: string | null;
  gatewayId?: string | null;
  toolId?: string | null;
  dimensions?: Record<string, any>;
}

/**
 * Single fire-and-forget writer for semantic usage_metrics rows.
 *
 * Protocol controllers (MCP / UTCP / A2A) call this to record real
 * activity — sessions, tool calls, manuals, messages, workflows — that the
 * monitoring dashboard aggregates over a rolling window. Centralising the
 * write keeps the controllers to a one-liner and the row shape consistent.
 *
 * The repository is an @Optional() injection so any DB-less context (unit
 * tests constructing a service with `new`) works unchanged: recording then
 * silently no-ops. Writes never block or throw into the caller.
 */
@Injectable()
export class MetricsRecorderService {
  private readonly logger = new Logger(MetricsRecorderService.name);

  constructor(
    @Optional()
    @InjectRepository(UsageMetric)
    private readonly repo?: Repository<UsageMetric>,
  ) {}

  record(type: MetricType, opts: MetricRecordOptions = {}): void {
    if (!this.repo) return;
    try {
      const metric = new UsageMetric();
      metric.type = type;
      metric.value = opts.value ?? 1;
      metric.status = opts.status ?? MetricStatus.SUCCESS;
      metric.organizationId = opts.organizationId ?? null;
      metric.userId = opts.userId ?? null;
      metric.gatewayId = opts.gatewayId ?? null;
      metric.toolId = opts.toolId ?? null;
      if (opts.dimensions) metric.dimensions = opts.dimensions;
      metric.timestamp = new Date();
      this.repo
        .save(metric)
        .catch((err) =>
          this.logger.warn(`Failed to record ${type} metric: ${err.message}`),
        );
    } catch (err: any) {
      this.logger.warn(`Failed to build ${type} metric: ${err?.message}`);
    }
  }
}
