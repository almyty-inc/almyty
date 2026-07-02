import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  ProviderHealthProcessor,
  PROVIDER_HEALTH_QUEUE,
  PROVIDER_HEALTH_JOB,
} from './provider-health.processor';
import { LlmProvider, LlmProviderStatus } from '../../../entities/llm-provider.entity';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';

describe('ProviderHealthProcessor', () => {
  let processor: ProviderHealthProcessor;
  let queue: { add: jest.Mock; getRepeatableJobs: jest.Mock; removeRepeatableByKey: jest.Mock };
  let providerRepository: { find: jest.Mock };
  let llmProvidersService: { performHealthCheck: jest.Mock };

  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  beforeEach(async () => {
    delete process.env.PROVIDER_HEALTH_RECHECK_CRON;
    // No artificial pacing inside unit tests.
    process.env.PROVIDER_HEALTH_RECHECK_DELAY_MS = '0';

    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
    };
    providerRepository = { find: jest.fn().mockResolvedValue([]) };
    llmProvidersService = {
      performHealthCheck: jest.fn().mockResolvedValue({ isHealthy: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderHealthProcessor,
        { provide: getQueueToken(PROVIDER_HEALTH_QUEUE), useValue: queue },
        { provide: getRepositoryToken(LlmProvider), useValue: providerRepository },
        { provide: LlmProvidersService, useValue: llmProvidersService },
      ],
    }).compile();

    processor = module.get(ProviderHealthProcessor);
  });

  describe('scheduling (onApplicationBootstrap)', () => {
    it('is disabled by default: no cron env means nothing is scheduled', async () => {
      await processor.onApplicationBootstrap();

      expect(processor.isEnabled()).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
      expect(queue.getRepeatableJobs).not.toHaveBeenCalled();
    });

    it('stays disabled under NODE_ENV=test even when the cron env is set', async () => {
      process.env.PROVIDER_HEALTH_RECHECK_CRON = '0 * * * *';
      // Jest runs with NODE_ENV=test.
      expect(process.env.NODE_ENV).toBe('test');

      await processor.onApplicationBootstrap();

      expect(processor.isEnabled()).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('registers a repeatable job when the cron env is set outside tests', async () => {
      process.env.NODE_ENV = 'development';
      process.env.PROVIDER_HEALTH_RECHECK_CRON = '0 * * * *';

      await processor.onApplicationBootstrap();

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        PROVIDER_HEALTH_JOB,
        {},
        expect.objectContaining({ repeat: { cron: '0 * * * *' } }),
      );
    });

    it('evicts a stale repeatable registration when the cron changed', async () => {
      process.env.NODE_ENV = 'development';
      process.env.PROVIDER_HEALTH_RECHECK_CRON = '*/30 * * * *';
      queue.getRepeatableJobs.mockResolvedValue([
        { id: 'provider-health-recheck', cron: '0 * * * *', key: 'stale-key' },
      ]);

      await processor.onApplicationBootstrap();

      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('stale-key');
      expect(queue.add).toHaveBeenCalledWith(
        PROVIDER_HEALTH_JOB,
        {},
        expect.objectContaining({ repeat: { cron: '*/30 * * * *' } }),
      );
    });

    it('survives a scheduling failure without throwing', async () => {
      process.env.NODE_ENV = 'development';
      process.env.PROVIDER_HEALTH_RECHECK_CRON = '0 * * * *';
      queue.getRepeatableJobs.mockRejectedValue(new Error('redis down'));

      await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });

  describe('handleRecheck', () => {
    const activeProviders = [
      { id: 'p1', organizationId: 'org-1', name: 'openai prod' },
      { id: 'p2', organizationId: 'org-2', name: 'anthropic prod' },
      { id: 'p3', organizationId: 'org-1', name: 'groq dev' },
    ];

    it('re-probes every active provider via the existing health-check path', async () => {
      providerRepository.find.mockResolvedValue(activeProviders);

      const result = await processor.handleRecheck();

      expect(providerRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: LlmProviderStatus.ACTIVE },
        }),
      );
      expect(llmProvidersService.performHealthCheck).toHaveBeenCalledTimes(3);
      expect(llmProvidersService.performHealthCheck).toHaveBeenNthCalledWith(1, 'p1', 'org-1');
      expect(llmProvidersService.performHealthCheck).toHaveBeenNthCalledWith(2, 'p2', 'org-2');
      expect(llmProvidersService.performHealthCheck).toHaveBeenNthCalledWith(3, 'p3', 'org-1');
      expect(result).toEqual({ checked: 3, unhealthy: 0 });
    });

    it('runs the probes sequentially, never as a parallel fan-out', async () => {
      providerRepository.find.mockResolvedValue(activeProviders);

      let inFlight = 0;
      let maxInFlight = 0;
      llmProvidersService.performHealthCheck.mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        return { isHealthy: true };
      });

      await processor.handleRecheck();

      expect(maxInFlight).toBe(1);
    });

    it('counts unhealthy providers and keeps sweeping past failures', async () => {
      providerRepository.find.mockResolvedValue(activeProviders);
      llmProvidersService.performHealthCheck
        .mockResolvedValueOnce({ isHealthy: false, error: 'invalid key' })
        .mockRejectedValueOnce(new Error('network exploded'))
        .mockResolvedValueOnce({ isHealthy: true });

      const result = await processor.handleRecheck();

      expect(llmProvidersService.performHealthCheck).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ checked: 3, unhealthy: 2 });
    });

    it('is a no-op when there are no active providers', async () => {
      providerRepository.find.mockResolvedValue([]);

      const result = await processor.handleRecheck();

      expect(llmProvidersService.performHealthCheck).not.toHaveBeenCalled();
      expect(result).toEqual({ checked: 0, unhealthy: 0 });
    });
  });
});
