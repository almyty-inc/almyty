import { Inject, Injectable, Logger, Optional, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import { DataSource, IsNull, Repository } from 'typeorm';

import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { Model } from '../../entities/model.entity';
import { LlmProvidersService } from '../llm-providers/llm-providers.service';
import { usableProviders } from '../llm-providers/private-provider';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { providerListsModels } from '../llm-providers/provider-profile';
import { ModelCatalogService } from './model-catalog.service';

/** The session advisory lock one instance holds while it runs the boot sync. */
export const BOOT_SYNC_LOCK_KEY = 'model-catalog:boot-sync';
/** Redis key per provider: set when a boot or on-load sync claims it, expires after the debounce. */
export const WARM_CLAIM_PREFIX = 'model-catalog:warm:';

export const CATALOG_WARMUP_OPTIONS = Symbol('CATALOG_WARMUP_OPTIONS');

export interface CatalogWarmupOptions {
  /** How many vendors are worked on at once. */
  concurrency: number;
  /** Pause between two providers of the same vendor, so one vendor never sees a burst. */
  vendorGapMs: number;
  /** A provider is checked by a boot or on-load sync at most once in this window, across every instance. */
  debounceMs: number;
  /** How long a page load waits for the sync it started before answering with what is there. */
  loadWaitMs: number;
}

const DEFAULT_OPTIONS: CatalogWarmupOptions = {
  concurrency: 4,
  vendorGapMs: 1_000,
  debounceMs: 10 * 60_000,
  loadWaitMs: 8_000,
};

export type WarmOutcome = 'synced' | 'key_rejected' | 'failed' | 'skipped';

export interface WarmSummary {
  providers: number;
  vendors: number;
  synced: number;
  keyRejected: number;
  failed: number;
  /** Claimed by another boot or on-load sync inside the debounce window. */
  skipped: number;
}

export interface BootSyncResult extends WarmSummary {
  /** False when another instance held the lock, and this one did nothing. */
  ran: boolean;
}

const emptySummary = (): WarmSummary => ({ providers: 0, vendors: 0, synced: 0, keyRejected: 0, failed: 0, skipped: 0 });

/**
 * Brings providers that have never been synced up to the readiness rule
 * (docs/models.md): check the key with a real call, then import what the
 * provider lists, so their models are usable without anyone connecting
 * them again or waiting for the periodic sweep.
 *
 * Two triggers share one path:
 *
 *  - Boot, and before every periodic sweep (CatalogSyncProcessor): every
 *    active provider whose `modelsSyncedAt` is null. The jobs run in the
 *    queue worker, so they never hold up startup, and a Postgres session
 *    advisory lock lets one instance do the work while the others return.
 *  - Page load (GET /models, which both the Models page and the model
 *    picker read): when what the viewer asked for holds no usable model
 *    and the org has providers, those providers are synced, and the page
 *    waits a few seconds for it before answering.
 *
 * Either way a provider is claimed in Redis first (SET NX with a TTL), so
 * it is checked at most once per debounce window across every instance
 * and trigger. Vendors are worked on a few at a time, one provider of a
 * vendor after another with a pause between them.
 *
 * A refused key leaves the provider's models unusable (the health check
 * records it); an outage leaves everything as it was, and the provider,
 * still unsynced, is tried again by the next boot, page load or sweep.
 */
@Injectable()
export class CatalogWarmupService {
  private readonly logger = new Logger(CatalogWarmupService.name);
  private readonly options: CatalogWarmupOptions;

  constructor(
    @InjectRepository(LlmProvider) private readonly providers: Repository<LlmProvider>,
    @InjectRepository(Model) private readonly models: Repository<Model>,
    private readonly catalog: ModelCatalogService,
    @Inject(forwardRef(() => LlmProvidersService)) private readonly llmProviders: LlmProvidersService,
    private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis.Redis,
    @Optional() @Inject(CATALOG_WARMUP_OPTIONS) options?: Partial<CatalogWarmupOptions>,
    @Optional() private readonly accessPolicy?: AccessPolicyService,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  }

  /**
   * Check and sync every active provider that has never been synced.
   * Run by the one-shot job at boot and again before each periodic sweep,
   * so a provider that was down at boot is tried again. Returns
   * `ran: false` when another instance holds the lock. Throws only when
   * the database cannot be reached at all (the job then fails and is
   * logged).
   */
  async syncNeverSynced(reason: 'boot' | 'sweep'): Promise<BootSyncResult> {
    const runner = this.dataSource.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const rows = await runner.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [BOOT_SYNC_LOCK_KEY]);
      locked = rows?.[0]?.locked === true;
      if (!locked) {
        this.logger.log(`Model catalog ${reason} sync: another instance is running it`);
        return { ...emptySummary(), ran: false };
      }
      const pending = await this.providers.find({
        where: { status: LlmProviderStatus.ACTIVE, modelsSyncedAt: IsNull() },
        order: { createdAt: 'ASC' },
      });
      const summary = await this.warmAll(pending, reason, true);
      this.logger.log(
        `Model catalog ${reason} sync: ${summary.providers} never-synced provider(s) across ${summary.vendors} vendor(s): ` +
          `${summary.synced} synced, ${summary.keyRejected} refused the key, ${summary.failed} failed (tried again before the next sweep), ` +
          `${summary.skipped} already claimed`,
      );
      return { ...summary, ran: true };
    } finally {
      if (locked) {
        await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [BOOT_SYNC_LOCK_KEY]).catch(() => undefined);
      }
      await runner.release().catch(() => undefined);
    }
  }

  /**
   * GET /models found nothing usable for the viewer. When the org has
   * providers the viewer may use and none of them has a usable model in
   * scope (one provider when `providerId` is given, the org otherwise),
   * sync them, and wait up to `loadWaitMs` for it. True when a sync
   * finished in that time with something synced, so the caller lists
   * again; the rest carries on in the background. Never rejects.
   */
  async warmOnLoad(organizationId: string, viewerId: string | null, providerId?: string): Promise<boolean> {
    try {
      const where: Record<string, any> = { organizationId, status: LlmProviderStatus.ACTIVE };
      if (providerId) where.id = providerId;
      const providers = await usableProviders(this.accessPolicy, organizationId, viewerId, await this.providers.find({ where, order: { createdAt: 'ASC' } }));
      if (providers.length === 0) return false;
      const cards = await this.models.find({ where: providerId ? { organizationId, providerId } : { organizationId } });
      if (cards.some((c) => c.isSelectable())) return false;

      const run = this.warmAll(providers, 'page load', false);
      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.options.loadWaitMs);
        timer.unref?.();
      });
      const summary = await Promise.race([run, waited]);
      if (timer) clearTimeout(timer);
      return !!summary && summary.synced > 0;
    } catch (error: any) {
      this.logger.warn(`Model catalog on-load sync for org ${organizationId} failed: ${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * Work through `providers`: grouped by vendor, `concurrency` vendors at
   * once, one provider of a vendor at a time with `vendorGapMs` between
   * them. `proceedWithoutClaim`: whether a Redis error counts as claimed
   * (boot, already serialised by the lock) or as taken (page load, which
   * must not fan out when the debounce cannot be kept).
   */
  private async warmAll(providers: LlmProvider[], reason: string, proceedWithoutClaim: boolean): Promise<WarmSummary> {
    const byVendor = new Map<string, LlmProvider[]>();
    for (const p of providers) {
      const group = byVendor.get(p.type) ?? [];
      group.push(p);
      byVendor.set(p.type, group);
    }
    const groups = [...byVendor.values()];
    const summary: WarmSummary = { ...emptySummary(), providers: providers.length, vendors: groups.length };
    let next = 0;
    const worker = async () => {
      while (next < groups.length) {
        const group = groups[next++];
        let called = false;
        for (const provider of group) {
          if (called) await this.pause(this.options.vendorGapMs);
          const outcome = await this.warmProvider(provider, reason, proceedWithoutClaim);
          called = outcome !== 'skipped';
          summary[outcome === 'synced' ? 'synced' : outcome === 'key_rejected' ? 'keyRejected' : outcome === 'failed' ? 'failed' : 'skipped']++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.options.concurrency, groups.length) }, worker));
    return summary;
  }

  /** Check the key, then list. Never throws; logs ids and outcomes only. */
  private async warmProvider(provider: LlmProvider, reason: string, proceedWithoutClaim: boolean): Promise<WarmOutcome> {
    if (!(await this.claim(provider.id, proceedWithoutClaim))) return 'skipped';
    try {
      const check = await this.llmProviders.performHealthCheck(provider.id, provider.organizationId, { syncModels: false });
      if (!check.isHealthy) {
        this.logger.warn(`Model catalog ${reason} sync: provider ${provider.id} (${provider.type}) ${check.keyRejected ? 'refused the key' : 'did not pass the key check'}`);
        return check.keyRejected ? 'key_rejected' : 'failed';
      }
      const result = await this.catalog.syncFromProvider(provider.organizationId, provider.id);
      if (!providerListsModels(provider.type)) {
        // Nothing to list: the check just recorded the model it called.
        await this.catalog.markModelsSynced(provider.organizationId, provider.id);
        return 'synced';
      }
      if (result.created.length + result.skipped + result.reinstated.length === 0) {
        this.logger.warn(`Model catalog ${reason} sync: provider ${provider.id} (${provider.type}) listed no models`);
        return 'failed';
      }
      return 'synced';
    } catch {
      this.logger.warn(`Model catalog ${reason} sync: provider ${provider.id} (${provider.type}) failed to sync`);
      return 'failed';
    }
  }

  private async claim(providerId: string, proceedWithoutClaim: boolean): Promise<boolean> {
    try {
      const reply = await this.redis.set(`${WARM_CLAIM_PREFIX}${providerId}`, String(Date.now()), 'PX', this.options.debounceMs, 'NX');
      return reply === 'OK';
    } catch {
      return proceedWithoutClaim;
    }
  }

  private pause(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
