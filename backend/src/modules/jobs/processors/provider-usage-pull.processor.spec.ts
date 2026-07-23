import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  ProviderUsagePullProcessor,
  PROVIDER_USAGE_PULL_QUEUE,
  PROVIDER_USAGE_PULL_JOB,
} from './provider-usage-pull.processor';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { ProviderUsageService } from '../../provider-usage/provider-usage.service';

describe('ProviderUsagePullProcessor', () => {
  let processor: ProviderUsagePullProcessor;
  let queue: {
    add: jest.Mock;
    getRepeatableJobs: jest.Mock;
    removeRepeatableByKey: jest.Mock;
  };
  let providerRepository: { find: jest.Mock };
  let usageService: { syncOrganization: jest.Mock };

  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  beforeEach(async () => {
    delete process.env.PROVIDER_USAGE_PULL_CRON;
    delete process.env.PROVIDER_USAGE_PULL_LOOKBACK_DAYS;

    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
    };
    providerRepository = { find: jest.fn().mockResolvedValue([]) };
    usageService = {
      syncOrganization: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderUsagePullProcessor,
        { provide: getQueueToken(PROVIDER_USAGE_PULL_QUEUE), useValue: queue },
        { provide: getRepositoryToken(LlmProvider), useValue: providerRepository },
        { provide: ProviderUsageService, useValue: usageService },
      ],
    }).compile();

    processor = module.get(ProviderUsagePullProcessor);
  });

  describe('scheduling (onApplicationBootstrap)', () => {
    it('stays disabled under NODE_ENV=test (jest) even with a default cron', async () => {
      expect(process.env.NODE_ENV).toBe('test');

      await processor.onApplicationBootstrap();

      expect(processor.isEnabled()).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
      expect(queue.getRepeatableJobs).not.toHaveBeenCalled();
    });

    it('is disabled when PROVIDER_USAGE_PULL_CRON=off', async () => {
      process.env.NODE_ENV = 'development';
      process.env.PROVIDER_USAGE_PULL_CRON = 'off';

      await processor.onApplicationBootstrap();

      expect(processor.isEnabled()).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('registers a daily repeatable job by default outside tests', async () => {
      process.env.NODE_ENV = 'development';

      await processor.onApplicationBootstrap();

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        PROVIDER_USAGE_PULL_JOB,
        {},
        expect.objectContaining({ repeat: { cron: '0 3 * * *' } }),
      );
    });

    it('honors a custom cron from PROVIDER_USAGE_PULL_CRON', async () => {
      process.env.NODE_ENV = 'development';
      process.env.PROVIDER_USAGE_PULL_CRON = '0 */6 * * *';

      await processor.onApplicationBootstrap();

      expect(queue.add).toHaveBeenCalledWith(
        PROVIDER_USAGE_PULL_JOB,
        {},
        expect.objectContaining({ repeat: { cron: '0 */6 * * *' } }),
      );
    });

    it('evicts a stale repeatable registration when the cron changed', async () => {
      process.env.NODE_ENV = 'development';
      process.env.PROVIDER_USAGE_PULL_CRON = '0 */6 * * *';
      queue.getRepeatableJobs.mockResolvedValue([
        { id: 'provider-usage-pull', cron: '0 3 * * *', key: 'stale-key' },
      ]);

      await processor.onApplicationBootstrap();

      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('stale-key');
      expect(queue.add).toHaveBeenCalledWith(
        PROVIDER_USAGE_PULL_JOB,
        {},
        expect.objectContaining({ repeat: { cron: '0 */6 * * *' } }),
      );
    });

    it('survives a scheduling failure without throwing', async () => {
      process.env.NODE_ENV = 'development';
      queue.getRepeatableJobs.mockRejectedValue(new Error('redis down'));

      await expect(
        processor.onApplicationBootstrap(),
      ).resolves.toBeUndefined();
    });
  });

  describe('handlePull', () => {
    it('is a no-op when no provider has a usage API key', async () => {
      providerRepository.find.mockResolvedValue([
        { organizationId: 'org-1', configuration: { apiKey: 'sk-inference' } },
        { organizationId: 'org-2', configuration: {} },
        { organizationId: 'org-3', configuration: { usageApiKey: '' } },
      ]);

      const result = await processor.handlePull();

      expect(usageService.syncOrganization).not.toHaveBeenCalled();
      expect(result).toEqual({ organizations: 0, synced: 0 });
    });

    it('syncs only orgs that have a usage-key-configured provider, once per org', async () => {
      providerRepository.find.mockResolvedValue([
        { organizationId: 'org-1', configuration: { usageApiKey: 'sk-admin-1' } },
        // Second provider in the same org must not double-sync it.
        { organizationId: 'org-1', configuration: { usageApiKey: 'sk-admin-1b' } },
        { organizationId: 'org-2', configuration: { apiKey: 'sk-inference' } },
        { organizationId: 'org-3', configuration: { usageApiKey: 'sk-admin-3' } },
      ]);
      usageService.syncOrganization.mockResolvedValue([
        { llmProviderId: 'p', providerType: 'openai', supported: true, written: 3 },
      ]);

      const result = await processor.handlePull();

      expect(usageService.syncOrganization).toHaveBeenCalledTimes(2);
      const orgArgs = usageService.syncOrganization.mock.calls.map((c) => c[0]);
      expect(new Set(orgArgs)).toEqual(new Set(['org-1', 'org-3']));
      expect(usageService.syncOrganization).not.toHaveBeenCalledWith(
        'org-2',
        expect.anything(),
        expect.anything(),
      );
      expect(result.organizations).toBe(2);
      expect(result.synced).toBe(2);
    });

    it('passes a look-back window (from < to) honoring PROVIDER_USAGE_PULL_LOOKBACK_DAYS', async () => {
      process.env.PROVIDER_USAGE_PULL_LOOKBACK_DAYS = '5';
      providerRepository.find.mockResolvedValue([
        { organizationId: 'org-1', configuration: { usageApiKey: 'sk-admin-1' } },
      ]);

      await processor.handlePull();

      const [, from, to] = usageService.syncOrganization.mock.calls[0];
      expect(from).toBeInstanceOf(Date);
      expect(to).toBeInstanceOf(Date);
      const spanDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
      expect(Math.round(spanDays)).toBe(5);
    });

    it('keeps sweeping past a failing org', async () => {
      providerRepository.find.mockResolvedValue([
        { organizationId: 'org-1', configuration: { usageApiKey: 'sk-admin-1' } },
        { organizationId: 'org-2', configuration: { usageApiKey: 'sk-admin-2' } },
      ]);
      usageService.syncOrganization
        .mockRejectedValueOnce(new Error('provider 500'))
        .mockResolvedValueOnce([
          { llmProviderId: 'p', providerType: 'openai', supported: true, written: 2 },
        ]);

      const result = await processor.handlePull();

      expect(usageService.syncOrganization).toHaveBeenCalledTimes(2);
      expect(result.organizations).toBe(2);
      // Only the org that didn't throw counted a written snapshot set.
      expect(result.synced).toBe(1);
    });
  });
});
