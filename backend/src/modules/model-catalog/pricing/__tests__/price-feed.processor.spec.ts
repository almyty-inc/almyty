import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';

import {
  MODEL_PRICE_FEED_JOB,
  MODEL_PRICE_FEED_QUEUE,
  PriceFeedProcessor,
} from '../price-feed.processor';
import { PriceFeedService } from '../price-feed.service';

describe('PriceFeedProcessor', () => {
  let processor: PriceFeedProcessor;
  let queue: {
    add: jest.Mock;
    getRepeatableJobs: jest.Mock;
    removeRepeatableByKey: jest.Mock;
  };
  let priceFeed: {
    refresh: jest.Mock;
    applyToCatalog: jest.Mock;
    hasData: jest.Mock;
    isDisabled: jest.Mock;
  };

  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  beforeEach(async () => {
    delete process.env.MODEL_PRICE_FEED_CRON;
    delete process.env.MODEL_PRICE_FEED_DISABLED;

    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
    };
    priceFeed = {
      refresh: jest.fn().mockResolvedValue({ litellm: 10, openrouter: 5, fetchedAt: new Date() }),
      applyToCatalog: jest.fn().mockResolvedValue({ priced: 3, unpriced: 1, flagged: 0 }),
      hasData: jest.fn().mockReturnValue(true),
      isDisabled: jest.fn().mockReturnValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PriceFeedProcessor,
        { provide: getQueueToken(MODEL_PRICE_FEED_QUEUE), useValue: queue },
        { provide: PriceFeedService, useValue: priceFeed },
      ],
    }).compile();

    processor = module.get(PriceFeedProcessor);
  });

  describe('scheduling (onApplicationBootstrap)', () => {
    it('stays disabled under NODE_ENV=test even with the default cron', async () => {
      expect(process.env.NODE_ENV).toBe('test');

      await processor.onApplicationBootstrap();

      expect(processor.isEnabled()).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
      expect(queue.getRepeatableJobs).not.toHaveBeenCalled();
    });

    it('is disabled when MODEL_PRICE_FEED_CRON=off', async () => {
      process.env.NODE_ENV = 'development';
      process.env.MODEL_PRICE_FEED_CRON = 'off';

      await processor.onApplicationBootstrap();

      expect(processor.cron()).toBeUndefined();
      expect(processor.isEnabled()).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('is disabled when the feed itself is disabled', async () => {
      process.env.NODE_ENV = 'development';
      priceFeed.isDisabled.mockReturnValue(true);

      await processor.onApplicationBootstrap();

      expect(processor.isEnabled()).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('registers a daily 04:00 repeatable job by default outside tests', async () => {
      process.env.NODE_ENV = 'development';

      await processor.onApplicationBootstrap();

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        MODEL_PRICE_FEED_JOB,
        {},
        expect.objectContaining({ jobId: 'model-price-feed', repeat: { cron: '0 4 * * *' } }),
      );
    });

    it('honors a custom cron from MODEL_PRICE_FEED_CRON', async () => {
      process.env.NODE_ENV = 'development';
      process.env.MODEL_PRICE_FEED_CRON = '0 */12 * * *';

      await processor.onApplicationBootstrap();

      expect(queue.add).toHaveBeenCalledWith(
        MODEL_PRICE_FEED_JOB,
        {},
        expect.objectContaining({ repeat: { cron: '0 */12 * * *' } }),
      );
    });

    it('evicts a stale repeatable registration when the cron changed', async () => {
      process.env.NODE_ENV = 'development';
      process.env.MODEL_PRICE_FEED_CRON = '0 */12 * * *';
      queue.getRepeatableJobs.mockResolvedValue([
        { id: 'model-price-feed', cron: '0 4 * * *', key: 'stale-key' },
        { id: 'provider-usage-pull', cron: '0 3 * * *', key: 'other-key' },
      ]);

      await processor.onApplicationBootstrap();

      expect(queue.removeRepeatableByKey).toHaveBeenCalledTimes(1);
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('stale-key');
    });

    it('queues one immediate refresh when the cache is empty', async () => {
      process.env.NODE_ENV = 'development';
      priceFeed.hasData.mockReturnValue(false);

      await processor.onApplicationBootstrap();

      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenLastCalledWith(
        MODEL_PRICE_FEED_JOB,
        { reason: 'bootstrap' },
        expect.objectContaining({ jobId: 'model-price-feed-bootstrap' }),
      );
      expect(queue.add.mock.calls[1][2].repeat).toBeUndefined();
    });

    it('does not queue an immediate refresh when prices are already loaded', async () => {
      process.env.NODE_ENV = 'development';
      priceFeed.hasData.mockReturnValue(true);

      await processor.onApplicationBootstrap();

      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('survives a scheduling failure without throwing', async () => {
      process.env.NODE_ENV = 'development';
      queue.getRepeatableJobs.mockRejectedValue(new Error('redis down'));

      await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('handleRefresh', () => {
    it('refreshes the feed, then applies it to every card', async () => {
      const result = await processor.handleRefresh();

      expect(priceFeed.refresh).toHaveBeenCalledTimes(1);
      expect(priceFeed.applyToCatalog).toHaveBeenCalledTimes(1);
      expect(priceFeed.applyToCatalog).toHaveBeenCalledWith();
      expect(priceFeed.refresh.mock.invocationCallOrder[0]).toBeLessThan(
        priceFeed.applyToCatalog.mock.invocationCallOrder[0],
      );
      expect(result).toEqual({ priced: 3, unpriced: 1, flagged: 0 });
    });

    it('does not touch the catalog when the refresh fails', async () => {
      priceFeed.refresh.mockRejectedValue(new Error('both sources down'));

      await expect(processor.handleRefresh()).rejects.toThrow('both sources down');
      expect(priceFeed.applyToCatalog).not.toHaveBeenCalled();
    });
  });
});
