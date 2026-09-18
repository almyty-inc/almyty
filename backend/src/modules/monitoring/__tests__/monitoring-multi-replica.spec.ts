import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { MonitoringService, Alert } from '../monitoring.service';
import { MonitoringRedisStatsHelper } from '../monitoring-redis-stats.helper';
import { DEFAULT_ALERT_RULES } from '../default-alert-rules';
import { UsageMetric } from '../../../entities/usage-metric.entity';
import { Tool } from '../../../entities/tool.entity';
import { Api } from '../../../entities/api.entity';
import { Organization } from '../../../entities/organization.entity';

/**
 * Monitoring across replicas.
 *
 * Both sweeps are armed from onModuleInit on every replica with no
 * lease, and they read and write shared Redis keys: the collection
 * sweep pushed N samples per window into one `metrics:history` list
 * trimmed to 1440 entries (so "24 hours at 15-second resolution" was
 * 24/N hours), and the alert sweep kept its cooldown and its alert
 * registry in per-process Maps, so one breach paged N times and
 * resolving an alert only worked on the pod that minted it.
 */
describe('MonitoringService - one cluster, N replicas', () => {
  let service: MonitoringService;
  let redis: any;

  const rule = {
    id: 'rule-1',
    name: 'High Error Rate',
    description: 'Error rate exceeds 5%',
    metric: 'performance.errorRate',
    condition: 'gt' as const,
    threshold: 0.05,
    severity: 'error' as const,
    isActive: true,
    cooldownMinutes: 10,
  };

  const metrics: any = {
    timestamp: '2024-01-01T00:00:00.000Z',
    instance: 'pod-a',
    system: { uptime: 1, memoryUsage: {}, cpuUsage: {}, loadAverage: [0, 0, 0] },
    application: {
      activeConnections: {},
      requests: { total: 1, successful: 1, failed: 0, rate: 0 },
      tools: {},
      apis: {},
    },
    protocols: {},
    security: {},
    performance: { errorRate: 0.5 },
  };

  const countingRepo = () => ({ count: jest.fn().mockResolvedValue(0), find: jest.fn(), query: jest.fn().mockResolvedValue([]) });

  beforeEach(async () => {
    redis = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
      setex: jest.fn(),
      lpush: jest.fn(),
      ltrim: jest.fn(),
      lrange: jest.fn().mockResolvedValue([]),
      del: jest.fn(),
      incr: jest.fn(),
      expire: jest.fn(),
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
      smembers: jest.fn().mockResolvedValue([]),
      mget: jest.fn().mockResolvedValue([]),
      keys: jest.fn().mockResolvedValue([]),
      ping: jest.fn().mockResolvedValue('PONG'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonitoringService,
        MonitoringRedisStatsHelper,
        { provide: getRepositoryToken(UsageMetric), useValue: countingRepo() },
        { provide: getRepositoryToken(Tool), useValue: countingRepo() },
        { provide: getRepositoryToken(Api), useValue: countingRepo() },
        { provide: getRepositoryToken(Organization), useValue: countingRepo() },
        { provide: 'default_IORedisModuleConnectionToken', useValue: redis },
      ],
    }).compile();

    service = module.get(MonitoringService);
  });

  describe('metrics collection lease', () => {
    it('samples and stores the window it wins, tagged with the replica', async () => {
      const sample = await service.collectOnce();

      expect(redis.set).toHaveBeenCalledWith(
        'metrics:collect:lock',
        expect.any(String),
        'EX',
        expect.any(Number),
        'NX',
      );
      expect(sample).not.toBeNull();
      expect(sample!.instance).toEqual(expect.any(String));
      expect(sample!.instance.length).toBeGreaterThan(0);
      expect(redis.lpush).toHaveBeenCalledWith('metrics:history', expect.any(String));
    });

    it('writes nothing for a window another replica already took', async () => {
      redis.set.mockResolvedValue(null);

      const sample = await service.collectOnce();

      expect(sample).toBeNull();
      expect(redis.lpush).not.toHaveBeenCalled();
      expect(redis.setex).not.toHaveBeenCalled();
    });

    it('holds the lease for less than the collection interval, so a dead holder costs one window', async () => {
      await service.collectOnce();

      const ttlSeconds = redis.set.mock.calls[0][3];
      expect(ttlSeconds).toBeLessThan(15);
      expect(ttlSeconds).toBeGreaterThan(0);
    });
  });

  describe('alert cooldown', () => {
    it('mints one alert for a breach and claims the rule cooldown', async () => {
      await service['triggerAlert'](rule, metrics);

      expect(redis.set).toHaveBeenCalledWith(
        'monitoring:alert-cooldown:rule-1',
        expect.stringMatching(/^alert_/),
        'EX',
        600,
        'NX',
      );
      expect(await service.getActiveAlerts()).toHaveLength(1);
    });

    it('stands down when another replica holds the cooldown', async () => {
      redis.set.mockResolvedValue(null);

      await service['triggerAlert'](rule, metrics);

      expect(await service.getActiveAlerts()).toHaveLength(0);
      expect(redis.setex).not.toHaveBeenCalled();
    });

    it('gives every replica the same id for the same default rule', async () => {
      await service['setupDefaultAlertRules']();
      const first = Array.from(service['alertRules'].keys()).sort();

      const second: TestingModule = await Test.createTestingModule({
        providers: [
          MonitoringService,
          MonitoringRedisStatsHelper,
          { provide: getRepositoryToken(UsageMetric), useValue: countingRepo() },
          { provide: getRepositoryToken(Tool), useValue: countingRepo() },
          { provide: getRepositoryToken(Api), useValue: countingRepo() },
          { provide: getRepositoryToken(Organization), useValue: countingRepo() },
          { provide: 'default_IORedisModuleConnectionToken', useValue: redis },
        ],
      }).compile();
      const other = second.get(MonitoringService);
      await other['setupDefaultAlertRules']();

      expect(first).toHaveLength(DEFAULT_ALERT_RULES.length);
      expect(Array.from(other['alertRules'].keys()).sort()).toEqual(first);
    });
  });

  describe('alerts another replica minted', () => {
    const remote: Alert = {
      id: 'alert_remote',
      ruleId: 'rule-1',
      severity: 'error',
      title: 'High Error Rate',
      message: 'from another pod',
      data: {},
      organizationId: 'org-1',
      isResolved: false,
      triggeredAt: '2024-01-01T00:00:00.000Z',
    };

    it('lists them', async () => {
      redis.smembers.mockResolvedValue(['alert_remote']);
      redis.mget.mockResolvedValue([JSON.stringify(remote)]);

      const alerts = await service.getActiveAlerts('org-1');

      expect(alerts.map((a) => a.id)).toEqual(['alert_remote']);
    });

    it('resolves them, and takes them out of the shared index', async () => {
      redis.get.mockResolvedValue(JSON.stringify(remote));

      const resolved = await service.resolveAlert('alert_remote', 'user-1', 'org-1');

      expect(resolved).toBe(true);
      expect(redis.srem).toHaveBeenCalledWith('monitoring:alerts:active', 'alert_remote');
    });

    it('still refuses a cross-tenant resolve of one', async () => {
      redis.get.mockResolvedValue(JSON.stringify(remote));

      expect(await service.resolveAlert('alert_remote', 'user-1', 'org-b')).toBe(false);
      expect(redis.setex).not.toHaveBeenCalled();
    });

    it('drops an index entry whose alert has expired rather than reporting it', async () => {
      redis.smembers.mockResolvedValue(['alert_gone']);
      redis.mget.mockResolvedValue([null]);

      expect(await service.getActiveAlerts()).toEqual([]);
      expect(redis.srem).toHaveBeenCalledWith('monitoring:alerts:active', 'alert_gone');
    });
  });
});
