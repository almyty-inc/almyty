import { InjectQueue, OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Queue } from 'bull';
import { Repository } from 'typeorm';

import { LlmProvider } from '../../../entities/llm-provider.entity';
import { ProviderUsageService } from '../../provider-usage/provider-usage.service';

export const PROVIDER_USAGE_PULL_QUEUE = 'provider-usage-pull';
export const PROVIDER_USAGE_PULL_JOB = 'pull';

/**
 * Stable jobId for the repeatable registration so restarts don't stack
 * duplicate schedules, and so a changed cron can evict the stale one.
 */
const REPEAT_JOB_ID = 'provider-usage-pull';

/** Daily at 03:00 UTC — the default when PROVIDER_USAGE_PULL_CRON is unset. */
const DEFAULT_CRON = '0 3 * * *';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Scheduled external usage/cost pull (P7). The on-demand sync
 * (POST /provider-usage/sync -> syncOrganization) is complemented here by
 * a repeatable job that periodically re-pulls provider-actual usage so the
 * Cost tab / reconciliation stays fresh without a human clicking sync.
 *
 * Only orgs that have at least one provider with an admin-scoped
 * `configuration.usageApiKey` are swept — a usage pull without that key
 * would 401 against every provider usage endpoint, so orgs/providers
 * without one are skipped entirely (no network call, no 401 spam). The
 * per-provider capability gate + missing-key short-circuit inside
 * ProviderUsageService.fetchProviderUsage is the second line of defence.
 *
 * Scheduling defaults to daily (DEFAULT_CRON). Override the cadence with
 * PROVIDER_USAGE_PULL_CRON (standard 5-field cron), or disable it with
 * PROVIDER_USAGE_PULL_CRON=off. It is always disabled under NODE_ENV=test.
 * The look-back window (PROVIDER_USAGE_PULL_LOOKBACK_DAYS, default 2) is
 * intentionally a little wider than the interval so late-arriving provider
 * usage data still lands; snapshot upserts are idempotent per day bucket.
 */
@Processor(PROVIDER_USAGE_PULL_QUEUE)
export class ProviderUsagePullProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProviderUsagePullProcessor.name);

  constructor(
    @InjectQueue(PROVIDER_USAGE_PULL_QUEUE) private readonly queue: Queue,
    @InjectRepository(LlmProvider)
    private readonly providerRepository: Repository<LlmProvider>,
    private readonly providerUsageService: ProviderUsageService,
  ) {}

  /** The configured cron, or undefined when the sweep is disabled. */
  cron(): string | undefined {
    const raw = process.env.PROVIDER_USAGE_PULL_CRON?.trim();
    if (raw && raw.toLowerCase() === 'off') return undefined;
    return raw && raw.length > 0 ? raw : DEFAULT_CRON;
  }

  /** Disabled in tests, and when the cron is explicitly turned off. */
  isEnabled(): boolean {
    return process.env.NODE_ENV !== 'test' && this.cron() !== undefined;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log(
        'Scheduled provider usage pull disabled (NODE_ENV=test or PROVIDER_USAGE_PULL_CRON=off)',
      );
      return;
    }

    const cron = this.cron() as string;

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
        PROVIDER_USAGE_PULL_JOB,
        {},
        {
          jobId: REPEAT_JOB_ID,
          repeat: { cron },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      this.logger.log(`Scheduled provider usage pull registered: "${cron}"`);
    } catch (error: any) {
      // Scheduling is best-effort — a Redis hiccup at bootstrap must
      // not take the API down.
      this.logger.error(
        `Failed to schedule provider usage pull: ${error.message}`,
      );
    }
  }

  private lookbackDays(): number {
    const raw = Number(process.env.PROVIDER_USAGE_PULL_LOOKBACK_DAYS);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
  }

  @Process(PROVIDER_USAGE_PULL_JOB)
  async handlePull(
    _job?: Job,
  ): Promise<{ organizations: number; synced: number }> {
    // Only sweep orgs that actually have a usage key configured on at
    // least one provider. A pull for an org without one would 401 on
    // every provider usage endpoint, so skip it before we make any
    // network call.
    const providers = await this.providerRepository.find({
      select: ['organizationId', 'configuration'],
    });

    const orgIds = new Set<string>();
    for (const p of providers) {
      const key = p.configuration?.usageApiKey;
      if (typeof key === 'string' && key.length > 0) {
        orgIds.add(p.organizationId);
      }
    }

    if (orgIds.size === 0) {
      this.logger.log(
        'Scheduled provider usage pull: no orgs with a usage API key — nothing to do',
      );
      return { organizations: 0, synced: 0 };
    }

    const to = new Date();
    const from = new Date(to.getTime() - this.lookbackDays() * DAY_MS);

    let synced = 0;
    // Sequential on purpose: each org's sync fans out to provider admin
    // APIs, so we pace org-by-org rather than a parallel burst.
    for (const organizationId of orgIds) {
      try {
        const results = await this.providerUsageService.syncOrganization(
          organizationId,
          from,
          to,
        );
        synced += results.filter((r) => r.written > 0).length;
      } catch (error: any) {
        // One org's failure must not abort the rest of the sweep.
        this.logger.warn(
          `Usage pull failed for org ${organizationId}: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `Scheduled provider usage pull done: ${orgIds.size} org(s), ${synced} provider snapshot set(s) written`,
    );
    return { organizations: orgIds.size, synced };
  }

  @OnQueueFailed()
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `Scheduled provider usage pull job ${job?.id} failed: ${error.message}`,
    );
  }
}
