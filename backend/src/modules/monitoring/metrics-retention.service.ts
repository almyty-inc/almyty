import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { UsageMetric } from '../../entities/usage-metric.entity';
import { RequestLog } from '../../entities/request-log.entity';

/**
 * Periodically prunes the high-volume telemetry tables so they don't grow
 * without bound. `usage_metrics` (a row per request, tool call, protocol
 * event, blocked threat, …) and `request_logs` are written on the hot path
 * and were never cleaned up.
 *
 * - Retention is `METRICS_RETENTION_DAYS` (default 90); set <= 0 to disable.
 * - The sweep runs every `METRICS_RETENTION_SWEEP_HOURS` (default 24), with
 *   one delayed run shortly after boot.
 * - Deletes are batched (`ctid` sub-select + LIMIT) so a large backlog never
 *   becomes one table-locking statement; each batch uses the timestamp index.
 * - A Redis NX lock ensures only one replica sweeps per window.
 */
@Injectable()
export class MetricsRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsRetentionService.name);
  private timer?: NodeJS.Timeout;
  private bootTimer?: NodeJS.Timeout;

  private readonly retentionDays: number;
  private readonly sweepIntervalMs: number;
  private readonly batchSize: number;

  private static readonly LOCK_KEY = 'metrics:retention:lock';
  // Tables this service is allowed to prune. Hard-coded (never interpolated
  // from input) since table names can't be parameterised in SQL.
  private static readonly TABLES = ['usage_metrics', 'request_logs'] as const;

  constructor(
    @InjectRepository(UsageMetric)
    private readonly usageMetricRepository: Repository<UsageMetric>,
    @InjectRepository(RequestLog)
    private readonly requestLogRepository: Repository<RequestLog>,
    @InjectRedis() private readonly redis: Redis.Redis,
  ) {
    const days = Number(process.env.METRICS_RETENTION_DAYS ?? 90);
    this.retentionDays = Number.isFinite(days) ? days : 90;

    const hours = Number(process.env.METRICS_RETENTION_SWEEP_HOURS ?? 24);
    this.sweepIntervalMs = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000;

    const batch = Number(process.env.METRICS_RETENTION_BATCH ?? 5000);
    this.batchSize = Number.isFinite(batch) && batch > 0 ? batch : 5000;
  }

  onModuleInit(): void {
    if (this.retentionDays <= 0) {
      this.logger.log('Metrics retention disabled (METRICS_RETENTION_DAYS <= 0)');
      return;
    }
    this.logger.log(
      `Metrics retention enabled: prune > ${this.retentionDays}d every ${
        this.sweepIntervalMs / 3_600_000
      }h`,
    );
    // Delay the first sweep so it never competes with startup work.
    this.bootTimer = setTimeout(() => {
      this.sweep().catch((e) => this.logger.warn(`retention sweep failed: ${e.message}`));
    }, 60_000);
    this.bootTimer.unref?.();

    this.timer = setInterval(() => {
      this.sweep().catch((e) => this.logger.warn(`retention sweep failed: ${e.message}`));
    }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Prune both tables of rows older than the retention window. Returns the
   * per-table deleted counts, or null if disabled or the lock wasn't held.
   */
  async sweep(): Promise<Record<string, number> | null> {
    if (this.retentionDays <= 0) return null;

    // Only one replica sweeps per window.
    const token = randomUUID();
    const acquired = await this.redis.set(
      MetricsRetentionService.LOCK_KEY,
      token,
      'EX',
      3600,
      'NX',
    );
    if (acquired !== 'OK') {
      this.logger.debug('Retention sweep skipped — lock held by another replica');
      return null;
    }

    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000);
    const result: Record<string, number> = {};
    try {
      result.usage_metrics = await this.prune(this.usageMetricRepository, 'usage_metrics', cutoff);
      result.request_logs = await this.prune(this.requestLogRepository, 'request_logs', cutoff);
      const total = result.usage_metrics + result.request_logs;
      if (total > 0) {
        this.logger.log(
          `Retention swept ${total} rows older than ${cutoff.toISOString()} ` +
            `(usage_metrics=${result.usage_metrics}, request_logs=${result.request_logs})`,
        );
      }
      return result;
    } finally {
      // Release the lock only if we still own it (avoid clobbering a later holder).
      await this.redis
        .eval(
          `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
          1,
          MetricsRetentionService.LOCK_KEY,
          token,
        )
        .catch(() => undefined);
    }
  }

  private async prune(
    repo: Repository<any>,
    table: (typeof MetricsRetentionService.TABLES)[number],
    cutoff: Date,
  ): Promise<number> {
    let deleted = 0;
    // Cap iterations so a pathological backlog can't spin forever in one run;
    // the next scheduled sweep continues where this left off.
    for (let i = 0; i < 1000; i++) {
      const rows = await repo.query(
        `DELETE FROM ${table}
         WHERE ctid IN (
           SELECT ctid FROM ${table} WHERE timestamp < $1 LIMIT $2
         )
         RETURNING 1`,
        [cutoff, this.batchSize],
      );
      const n = Array.isArray(rows) ? rows.length : 0;
      deleted += n;
      if (n < this.batchSize) break;
    }
    return deleted;
  }
}
