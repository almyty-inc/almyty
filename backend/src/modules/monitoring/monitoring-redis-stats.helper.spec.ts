import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MonitoringRedisStatsHelper } from './monitoring-redis-stats.helper';
import { UsageMetric } from '../../entities/usage-metric.entity';

describe('MonitoringRedisStatsHelper (Postgres-backed)', () => {
  let helper: MonitoringRedisStatsHelper;
  let query: jest.Mock;

  beforeEach(async () => {
    query = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonitoringRedisStatsHelper,
        {
          provide: getRepositoryToken(UsageMetric),
          useValue: { query },
        },
      ],
    }).compile();
    helper = module.get(MonitoringRedisStatsHelper);
  });

  describe('getRequestStats', () => {
    it('aggregates totals, derives failed, and computes a per-second rate', async () => {
      // Default window is 300s; total 600 -> rate 2/s.
      query.mockResolvedValue([{ total: '600', successful: '570' }]);

      const stats = await helper.getRequestStats();

      expect(stats).toEqual({ total: 600, successful: 570, failed: 30, rate: 2 });
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/type = 'request_count'/);
      expect(params[0]).toBeInstanceOf(Date);
    });

    it('clamps failed at zero and never returns NaN on empty/garbage rows', async () => {
      query.mockResolvedValue([{ total: null, successful: undefined }]);
      await expect(helper.getRequestStats()).resolves.toEqual({
        total: 0,
        successful: 0,
        failed: 0,
        rate: 0,
      });
    });

    it('falls back to the zero shape when the query throws', async () => {
      query.mockRejectedValue(new Error('db down'));
      await expect(helper.getRequestStats()).resolves.toEqual({
        total: 0,
        successful: 0,
        failed: 0,
        rate: 0,
      });
    });
  });

  describe('getSecurityStats', () => {
    it('maps rate-limit, auth-failure, threat, and PII counts', async () => {
      query.mockResolvedValue([
        { rate_limited: '7', unauthorized: '3', threats: '12', pii: '40' },
      ]);

      await expect(helper.getSecurityStats()).resolves.toEqual({
        threatsBlocked: 12,
        piiFiltered: 40,
        rateLimitsApplied: 7,
        authFailures: 3,
      });
    });

    it('falls back to zeros on error', async () => {
      query.mockRejectedValue(new Error('boom'));
      await expect(helper.getSecurityStats()).resolves.toEqual({
        threatsBlocked: 0,
        piiFiltered: 0,
        rateLimitsApplied: 0,
        authFailures: 0,
      });
    });
  });

  describe('getPerformanceStats', () => {
    it('maps latency percentiles and computes error rate from request counts', async () => {
      query
        .mockResolvedValueOnce([{ avg: '120.5', p95: '480', p99: '900' }])
        .mockResolvedValueOnce([{ total: '200', errored: '10' }]);

      const stats = await helper.getPerformanceStats();

      expect(stats).toEqual({
        averageResponseTime: 120.5,
        p95ResponseTime: 480,
        p99ResponseTime: 900,
        cacheHitRate: 0,
        errorRate: 0.05,
      });
    });

    it('returns errorRate 0 when there is no traffic', async () => {
      query
        .mockResolvedValueOnce([{ avg: null, p95: null, p99: null }])
        .mockResolvedValueOnce([{ total: '0', errored: '0' }]);

      await expect(helper.getPerformanceStats()).resolves.toEqual({
        averageResponseTime: 0,
        p95ResponseTime: 0,
        p99ResponseTime: 0,
        cacheHitRate: 0,
        errorRate: 0,
      });
    });

    it('falls back to zeros when a query throws', async () => {
      query.mockRejectedValue(new Error('nope'));
      await expect(helper.getPerformanceStats()).resolves.toEqual({
        averageResponseTime: 0,
        p95ResponseTime: 0,
        p99ResponseTime: 0,
        cacheHitRate: 0,
        errorRate: 0,
      });
    });
  });

  describe('getProtocolStats', () => {
    it('returns the zero-valued protocol shape without touching the DB', async () => {
      await expect(helper.getProtocolStats()).resolves.toEqual({
        mcp: { sessions: 0, toolCalls: 0, responseTime: 0, errorRate: 0 },
        utcp: { manuals: 0, directCalls: 0, proxyExecutions: 0 },
        a2a: { activeAgents: 0, messages: 0, workflows: 0 },
      });
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('window configuration', () => {
    it('honours MONITORING_STATS_WINDOW_SECONDS for the rate denominator', async () => {
      const prev = process.env.MONITORING_STATS_WINDOW_SECONDS;
      process.env.MONITORING_STATS_WINDOW_SECONDS = '60';
      try {
        const mod = await Test.createTestingModule({
          providers: [
            MonitoringRedisStatsHelper,
            { provide: getRepositoryToken(UsageMetric), useValue: { query } },
          ],
        }).compile();
        const h = mod.get(MonitoringRedisStatsHelper);
        query.mockResolvedValue([{ total: '120', successful: '120' }]);
        const stats = await h.getRequestStats();
        expect(stats.rate).toBe(2); // 120 / 60s
      } finally {
        if (prev === undefined) delete process.env.MONITORING_STATS_WINDOW_SECONDS;
        else process.env.MONITORING_STATS_WINDOW_SECONDS = prev;
      }
    });
  });
});
