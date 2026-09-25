import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';

import { CatalogSyncProcessor, MODEL_CATALOG_BACKFILL_JOB, MODEL_CATALOG_SWEEP_JOB, MODEL_CATALOG_SYNC_QUEUE } from '../catalog-sync.processor';
import { ModelCatalogService } from '../model-catalog.service';
import { CatalogWarmupService } from '../catalog-warmup.service';

describe('CatalogSyncProcessor', () => {
  let processor: CatalogSyncProcessor;
  let queue: { add: jest.Mock; getRepeatableJobs: jest.Mock; removeRepeatableByKey: jest.Mock };
  let catalog: { syncEveryProvider: jest.Mock };
  let warmup: { syncNeverSynced: jest.Mock };
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  beforeEach(async () => {
    delete process.env.MODEL_CATALOG_BACKFILL;
    delete process.env.MODEL_CATALOG_SYNC_CRON;
    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
    };
    catalog = {
      syncEveryProvider: jest.fn().mockResolvedValue({ providers: 3, synced: 2, failed: 1, keyRejected: 1 }),
    };
    warmup = { syncNeverSynced: jest.fn().mockResolvedValue({ ran: true, providers: 3, vendors: 2, synced: 2, keyRejected: 1, failed: 0, skipped: 0 }) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogSyncProcessor,
        { provide: getQueueToken(MODEL_CATALOG_SYNC_QUEUE), useValue: queue },
        { provide: ModelCatalogService, useValue: catalog },
        { provide: CatalogWarmupService, useValue: warmup },
      ],
    }).compile();
    processor = module.get(CatalogSyncProcessor);
  });

  it('stays off under NODE_ENV=test', async () => {
    expect(processor.isEnabled()).toBe(false);
    await processor.onApplicationBootstrap();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('queues one backfill with a stable job id outside test', async () => {
    process.env.NODE_ENV = 'development';
    await processor.onApplicationBootstrap();
    expect(queue.add).toHaveBeenCalledWith(
      MODEL_CATALOG_BACKFILL_JOB,
      { reason: 'bootstrap' },
      expect.objectContaining({ jobId: 'model-catalog-backfill', removeOnComplete: true }),
    );
  });

  it('schedules the periodic sweep, every six hours unless MODEL_CATALOG_SYNC_CRON says otherwise', async () => {
    process.env.NODE_ENV = 'production';
    await processor.onApplicationBootstrap();
    expect(queue.add).toHaveBeenCalledWith(
      MODEL_CATALOG_SWEEP_JOB,
      {},
      expect.objectContaining({ jobId: 'model-catalog-sweep', repeat: { cron: '17 */6 * * *' } }),
    );

    queue.add.mockClear();
    process.env.MODEL_CATALOG_SYNC_CRON = '*/30 * * * *';
    queue.getRepeatableJobs.mockResolvedValue([{ id: 'model-catalog-sweep', cron: '17 */6 * * *', key: 'old' }]);
    await processor.onApplicationBootstrap();
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('old');
    expect(queue.add).toHaveBeenCalledWith(MODEL_CATALOG_SWEEP_JOB, {}, expect.objectContaining({ repeat: { cron: '*/30 * * * *' } }));
  });

  it('MODEL_CATALOG_SYNC_CRON=off removes the sweep and schedules none', async () => {
    process.env.NODE_ENV = 'production';
    process.env.MODEL_CATALOG_SYNC_CRON = 'off';
    queue.getRepeatableJobs.mockResolvedValue([{ id: 'model-catalog-sweep', cron: '17 */6 * * *', key: 'old' }]);
    await processor.onApplicationBootstrap();
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('old');
    expect(queue.add).not.toHaveBeenCalledWith(MODEL_CATALOG_SWEEP_JOB, expect.anything(), expect.anything());
  });

  it('MODEL_CATALOG_BACKFILL=off disables it', async () => {
    process.env.NODE_ENV = 'production';
    process.env.MODEL_CATALOG_BACKFILL = 'off';
    expect(processor.isEnabled()).toBe(false);
    await processor.onApplicationBootstrap();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a queue failure at bootstrap is logged, not thrown', async () => {
    process.env.NODE_ENV = 'production';
    queue.add.mockRejectedValue(new Error('redis down'));
    queue.getRepeatableJobs.mockRejectedValue(new Error('redis down'));
    await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('the jobs run the boot sync and the sweep and return their counts', async () => {
    await expect(processor.handleBackfill()).resolves.toEqual({ ran: true, providers: 3, vendors: 2, synced: 2, keyRejected: 1, failed: 0, skipped: 0 });
    expect(warmup.syncNeverSynced).toHaveBeenCalledWith('boot');
    await expect(processor.handleSweep()).resolves.toEqual({ providers: 3, synced: 2, failed: 1, keyRejected: 1, neverSynced: expect.objectContaining({ ran: true }) });
    expect(warmup.syncNeverSynced).toHaveBeenLastCalledWith('sweep');
    expect(catalog.syncEveryProvider).toHaveBeenCalledTimes(1);
  });
});
