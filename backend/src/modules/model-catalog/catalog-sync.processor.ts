import { InjectQueue, OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { Job, Queue } from 'bull';

import { ModelCatalogService } from './model-catalog.service';
import { BootSyncResult, CatalogWarmupService } from './catalog-warmup.service';
import { ModelChangeNoticesService } from './notices/model-change-notices.service';

export const MODEL_CATALOG_SYNC_QUEUE = 'model-catalog-sync';
export const MODEL_CATALOG_BACKFILL_JOB = 'backfill';
export const MODEL_CATALOG_SWEEP_JOB = 'sweep';
export const MODEL_CHANGE_DIGEST_JOB = 'model-change-digest';

/** Stable id so replicas booting together queue the backfill once. */
const BACKFILL_JOB_ID = 'model-catalog-backfill';
/** Stable id for the repeatable sweep, so a changed cron replaces the old schedule. */
const SWEEP_JOB_ID = 'model-catalog-sweep';
/** Every six hours, off the hour. */
const DEFAULT_SWEEP_CRON = '17 */6 * * *';
/** Stable id for the daily email of model changes. */
const DIGEST_JOB_ID = 'model-change-digest';
/** Once a day, 08:00 UTC. */
/**
 * Every hour: each person gets theirs when it is 08:00 where they are
 * (ModelChangeNoticesService.sendDigest reads their time zone).
 */
const DEFAULT_DIGEST_CRON = '0 * * * *';

/**
 * Keeps every organization's model list in step with what its providers
 * serve.
 *
 * At boot, a one-shot job checks the key of every active provider that
 * has never been synced and imports its list (CatalogWarmupService: a
 * stable job id so replicas queue it once, and a Postgres advisory lock
 * so only one instance runs it). After that a repeatable sweep lists
 * every active provider again (MODEL_CATALOG_SYNC_CRON, default every six
 * hours; `off` disables it), so new models appear and retired ones are
 * marked unavailable on their own. Connecting a provider, changing it and
 * every passing key check sync it too. Both jobs are off under
 * NODE_ENV=test and when MODEL_CATALOG_BACKFILL=off.
 */
@Processor(MODEL_CATALOG_SYNC_QUEUE)
export class CatalogSyncProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogSyncProcessor.name);

  constructor(
    @InjectQueue(MODEL_CATALOG_SYNC_QUEUE) private readonly queue: Queue,
    private readonly catalog: ModelCatalogService,
    private readonly warmup: CatalogWarmupService,
    @Optional() private readonly notices?: ModelChangeNoticesService,
  ) {}

  isEnabled(): boolean {
    return process.env.NODE_ENV !== 'test' && process.env.MODEL_CATALOG_BACKFILL?.trim().toLowerCase() !== 'off';
  }

  /** The sweep's schedule, or undefined when it is switched off. */
  sweepCron(): string | undefined {
    const raw = process.env.MODEL_CATALOG_SYNC_CRON?.trim();
    if (raw && raw.toLowerCase() === 'off') return undefined;
    return raw && raw.length > 0 ? raw : DEFAULT_SWEEP_CRON;
  }

  /** How often the daily model-change email looks for people whose 08:00 it is (MODEL_CHANGE_DIGEST_CRON), or undefined when it is off. */
  digestCron(): string | undefined {
    const raw = process.env.MODEL_CHANGE_DIGEST_CRON?.trim();
    if (raw && raw.toLowerCase() === 'off') return undefined;
    return raw && raw.length > 0 ? raw : DEFAULT_DIGEST_CRON;
  }

  async onApplicationBootstrap(): Promise<void> {
    // The digest mails what syncs recorded, whoever ran them, so it does
    // not follow MODEL_CATALOG_BACKFILL.
    if (process.env.NODE_ENV !== 'test') {
      await this.scheduleRepeatable(DIGEST_JOB_ID, MODEL_CHANGE_DIGEST_JOB, this.digestCron(), 'Model change digest');
    }
    if (!this.isEnabled()) {
      this.logger.log('Model catalog backfill disabled (NODE_ENV=test or MODEL_CATALOG_BACKFILL=off)');
      return;
    }
    // Readiness first, on this instance and without the queue: it is
    // database work only, and a queued job can be taken by a replica of
    // the previous release still draining during a rolling deploy.
    void this.reconcile('boot');
    try {
      await this.queue.add(
        MODEL_CATALOG_BACKFILL_JOB,
        { reason: 'bootstrap' },
        { jobId: BACKFILL_JOB_ID, removeOnComplete: true, removeOnFail: true },
      );
      this.logger.log('Model catalog backfill queued');
    } catch (error: any) {
      // Best-effort: a Redis hiccup at bootstrap must not take the API down.
      this.logger.error(`Failed to queue model catalog backfill: ${error.message}`);
    }
    await this.scheduleSweep();
  }

  private async scheduleSweep(): Promise<void> {
    const cron = this.sweepCron();
    try {
      // A repeatable job is keyed by its repeat options: evict one left
      // behind by an earlier cron (or by switching the sweep off).
      for (const repeatable of await this.queue.getRepeatableJobs()) {
        if (repeatable.id === SWEEP_JOB_ID && repeatable.cron !== cron) {
          await this.queue.removeRepeatableByKey(repeatable.key);
        }
      }
      if (!cron) {
        this.logger.log('Model catalog sweep disabled (MODEL_CATALOG_SYNC_CRON=off)');
        return;
      }
      await this.queue.add(MODEL_CATALOG_SWEEP_JOB, {}, { jobId: SWEEP_JOB_ID, repeat: { cron }, removeOnComplete: true, removeOnFail: true });
      this.logger.log(`Model catalog sweep scheduled: "${cron}"`);
    } catch (error: any) {
      this.logger.error(`Failed to schedule the model catalog sweep: ${error.message}`);
    }
  }

  /** Schedule (or unschedule) a repeatable job by its stable id. Never throws. */
  private async scheduleRepeatable(jobId: string, name: string, cron: string | undefined, label: string): Promise<void> {
    try {
      for (const repeatable of await this.queue.getRepeatableJobs()) {
        if (repeatable.id === jobId && repeatable.cron !== cron) await this.queue.removeRepeatableByKey(repeatable.key);
      }
      if (!cron) {
        this.logger.log(`${label} disabled`);
        return;
      }
      await this.queue.add(name, {}, { jobId, repeat: { cron }, removeOnComplete: true, removeOnFail: true });
      this.logger.log(`${label} scheduled: "${cron}"`);
    } catch (error: any) {
      this.logger.error(`Failed to schedule ${label.toLowerCase()}: ${error.message}`);
    }
  }

  @Process(MODEL_CHANGE_DIGEST_JOB)
  async handleDigest(_job?: Job): Promise<{ rows: number; emails: number }> {
    if (!this.notices) return { rows: 0, emails: 0 };
    const result = await this.notices.sendDigest();
    if (result.rows > 0) this.logger.log(`Model change digest: ${result.rows} change(s), ${result.emails} email(s)`);
    return result;
  }

  @Process(MODEL_CATALOG_BACKFILL_JOB)
  async handleBackfill(_job?: Job): Promise<BootSyncResult> {
    return this.warmup.syncNeverSynced('boot');
  }

  @Process(MODEL_CATALOG_SWEEP_JOB)
  async handleSweep(_job?: Job): Promise<{ providers: number; synced: number; failed: number; keyRejected: number; neverSynced: BootSyncResult }> {
    // Providers still never synced (down at boot, or added while the key
    // check could not pass) get their key check and list first.
    await this.reconcile('sweep');
    const neverSynced = await this.warmup.syncNeverSynced('sweep');
    const result = await this.catalog.syncEveryProvider();
    this.logger.log(
      `Model catalog sweep: ${result.synced} of ${result.providers} provider(s) synced, ${result.failed} failed (${result.keyRejected} refused the key)`,
    );
    return { ...result, neverSynced };
  }

  /**
   * Mark the waiting cards of every provider whose key check has passed
   * (ModelCatalogService.reconcileReadiness). Never throws.
   */
  async reconcile(reason: 'boot' | 'sweep'): Promise<number> {
    try {
      const changed = await this.catalog.reconcileReadiness();
      if (changed > 0) this.logger.log(`Model catalog ${reason}: ${changed} model(s) usable under providers whose key check had passed`);
      return changed;
    } catch (error: any) {
      this.logger.warn(`Model catalog ${reason} readiness pass failed: ${error?.message ?? error}`);
      return 0;
    }
  }

  @OnQueueFailed()
  onFailed(job: Job, error: Error): void {
    this.logger.error(`Model catalog sync job ${job?.id} failed: ${error.message}`);
  }
}
