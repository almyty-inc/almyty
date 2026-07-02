import { InjectQueue, OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Queue } from 'bull';
import { Repository } from 'typeorm';

import { LlmProvider, LlmProviderStatus } from '../../../entities/llm-provider.entity';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';

export const PROVIDER_HEALTH_QUEUE = 'provider-health';
export const PROVIDER_HEALTH_JOB = 'recheck';

/**
 * Stable jobId for the repeatable registration so restarts don't stack
 * duplicate schedules, and so a changed cron can evict the stale one.
 */
const REPEAT_JOB_ID = 'provider-health-recheck';

/**
 * Periodic provider key-health re-check (P1 T1.7).
 *
 * Providers get a health check on create/update, but a key that is
 * revoked (or a vendor outage) afterwards is only discovered when a
 * real request fails. This processor re-probes every ACTIVE provider
 * on a schedule through the existing health-check path
 * (LlmProvidersService.performHealthCheck), which already updates
 * isHealthy / lastHealthCheckAt / lastError on the row.
 *
 * Scheduling is opt-in: set PROVIDER_HEALTH_RECHECK_CRON (standard
 * 5-field cron, e.g. "0 * * * *" for hourly). When the env var is
 * unset — or NODE_ENV=test — nothing is registered and the queue
 * stays idle. Each health check is a real (tiny) LLM call that
 * spends tenant credits, so the probe loop is deliberately
 * sequential with a small delay between providers
 * (PROVIDER_HEALTH_RECHECK_DELAY_MS, default 500) rather than a
 * parallel burst against every vendor at once.
 */
@Processor(PROVIDER_HEALTH_QUEUE)
export class ProviderHealthProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProviderHealthProcessor.name);

  constructor(
    @InjectQueue(PROVIDER_HEALTH_QUEUE) private readonly queue: Queue,
    @InjectRepository(LlmProvider)
    private readonly providerRepository: Repository<LlmProvider>,
    private readonly llmProvidersService: LlmProvidersService,
  ) {}

  /** Disabled unless a cron is configured, and always in tests. */
  isEnabled(): boolean {
    return (
      process.env.NODE_ENV !== 'test' &&
      typeof process.env.PROVIDER_HEALTH_RECHECK_CRON === 'string' &&
      process.env.PROVIDER_HEALTH_RECHECK_CRON.trim().length > 0
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log(
        'Provider health re-check disabled (PROVIDER_HEALTH_RECHECK_CRON not set)',
      );
      return;
    }

    const cron = process.env.PROVIDER_HEALTH_RECHECK_CRON.trim();

    try {
      // Evict a stale registration whose cron differs from the current
      // env (repeatable jobs are keyed by their repeat options, so a
      // changed cron would otherwise leave the old schedule running).
      const existing = await this.queue.getRepeatableJobs();
      for (const repeatable of existing) {
        if (repeatable.id === REPEAT_JOB_ID && repeatable.cron !== cron) {
          await this.queue.removeRepeatableByKey(repeatable.key);
        }
      }

      await this.queue.add(
        PROVIDER_HEALTH_JOB,
        {},
        {
          jobId: REPEAT_JOB_ID,
          repeat: { cron },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      this.logger.log(`Provider health re-check scheduled: "${cron}"`);
    } catch (error: any) {
      // Scheduling is best-effort — a Redis hiccup at bootstrap must
      // not take the API down.
      this.logger.error(
        `Failed to schedule provider health re-check: ${error.message}`,
      );
    }
  }

  @Process(PROVIDER_HEALTH_JOB)
  async handleRecheck(_job?: Job): Promise<{ checked: number; unhealthy: number }> {
    const providers = await this.providerRepository.find({
      where: { status: LlmProviderStatus.ACTIVE },
      select: ['id', 'organizationId', 'name'],
      order: { createdAt: 'ASC' },
    });

    let checked = 0;
    let unhealthy = 0;

    // Sequential on purpose (see class docstring): one provider at a
    // time with a small delay, never a parallel fan-out.
    for (const provider of providers) {
      try {
        const result = await this.llmProvidersService.performHealthCheck(
          provider.id,
          provider.organizationId,
        );
        if (!result.isHealthy) {
          unhealthy++;
          this.logger.warn(
            `Provider ${provider.id} (${provider.name}) unhealthy: ${result.error ?? 'unknown'}`,
          );
        }
      } catch (error: any) {
        // performHealthCheck reports failures in its return value; a
        // throw here is unexpected, but one bad provider must not
        // abort the rest of the sweep.
        unhealthy++;
        this.logger.warn(
          `Health re-check threw for provider ${provider.id}: ${error.message}`,
        );
      }
      checked++;

      if (checked < providers.length) {
        await this.delay(this.recheckDelayMs());
      }
    }

    this.logger.log(
      `Provider health re-check done: ${checked} checked, ${unhealthy} unhealthy`,
    );
    return { checked, unhealthy };
  }

  @OnQueueFailed()
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `Provider health re-check job ${job?.id} failed: ${error.message}`,
    );
  }

  private recheckDelayMs(): number {
    const raw = Number(process.env.PROVIDER_HEALTH_RECHECK_DELAY_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 500;
  }

  private delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
