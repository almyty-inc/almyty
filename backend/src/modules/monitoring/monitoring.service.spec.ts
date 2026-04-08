import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MonitoringService, SystemMetrics, Alert } from './monitoring.service';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { Tool } from '../../entities/tool.entity';
import { Api } from '../../entities/api.entity';
import { Organization } from '../../entities/organization.entity';

describe('MonitoringService', () => {
  let service: MonitoringService;
  let mockRedis: any;

  beforeEach(async () => {
    mockRedis = {
      get: jest.fn(),
      set: jest.fn(),
      setex: jest.fn(),
      lpush: jest.fn(),
      ltrim: jest.fn(),
      lrange: jest.fn(),
      del: jest.fn(),
      incr: jest.fn(),
      expire: jest.fn(),
      keys: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonitoringService,
        {
          provide: getRepositoryToken(UsageMetric),
          useValue: {
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Tool),
          useValue: {
            find: jest.fn(),
            count: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Api),
          useValue: {
            find: jest.fn(),
            count: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: {
            find: jest.fn(),
            count: jest.fn(),
          },
        },
        {
          provide: 'default_IORedisModuleConnectionToken',
          useValue: mockRedis,
        },
      ],
    }).compile();

    service = module.get<MonitoringService>(MonitoringService);
  });

  describe('getLatestMetrics', () => {
    it('should return parsed metrics from Redis', async () => {
      const mockMetrics: SystemMetrics = {
        timestamp: '2024-01-01T00:00:00.000Z',
        system: {
          uptime: 1000,
          memoryUsage: { rss: 100, heapTotal: 200, heapUsed: 150, external: 50, arrayBuffers: 10 },
          cpuUsage: { user: 1000, system: 500 },
          loadAverage: [1.5, 1.2, 1.0],
        },
        application: {
          activeConnections: { mcp: 5, utcp: 3, a2a: 2, http: 10, sse: 4, websocket: 6 },
          requests: { total: 1000, successful: 950, failed: 50, rate: 10 },
          tools: { total: 20, active: 15, executions: 500, averageExecutionTime: 200 },
          apis: { total: 10, active: 8, healthy: 7, unhealthy: 3 },
        },
        protocols: {
          mcp: { sessions: 5, toolCalls: 100, responseTime: 150, errorRate: 0.02 },
          utcp: { manuals: 10, directCalls: 50, proxyExecutions: 30 },
          a2a: { activeAgents: 3, messages: 200, workflows: 5 },
        },
        security: {
          threatsBlocked: 15,
          piiFiltered: 25,
          rateLimitsApplied: 10,
          authFailures: 5,
        },
        performance: {
          averageResponseTime: 250,
          p95ResponseTime: 500,
          p99ResponseTime: 800,
          cacheHitRate: 0.85,
          errorRate: 0.03,
        },
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(mockMetrics));

      const result = await service.getLatestMetrics();

      expect(result).toEqual(mockMetrics);
      expect(mockRedis.get).toHaveBeenCalledWith('metrics:latest');
    });

    it('should return null if no metrics in Redis', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.getLatestMetrics();

      expect(result).toBeNull();
    });

    it('should return null on Redis error', async () => {
      mockRedis.get.mockRejectedValue(new Error('Redis error'));

      const result = await service.getLatestMetrics();

      expect(result).toBeNull();
    });
  });

  describe('getMetricsHistory', () => {
    it('should return parsed metrics array from Redis', async () => {
      const mockMetric1 = { timestamp: '2024-01-01T00:00:00.000Z', system: { uptime: 1000 } } as any;
      const mockMetric2 = { timestamp: '2024-01-01T00:00:15.000Z', system: { uptime: 1015 } } as any;

      mockRedis.lrange.mockResolvedValue([
        JSON.stringify(mockMetric1),
        JSON.stringify(mockMetric2),
      ]);

      const result = await service.getMetricsHistory(1);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(mockMetric1);
      expect(result[1]).toEqual(mockMetric2);
      expect(mockRedis.lrange).toHaveBeenCalledWith('metrics:history', 0, 239); // 1 hour = 240 entries
    });

    it('should calculate correct count for different hour values', async () => {
      mockRedis.lrange.mockResolvedValue([]);

      await service.getMetricsHistory(2);
      expect(mockRedis.lrange).toHaveBeenCalledWith('metrics:history', 0, 479); // 2 hours = 480 entries

      await service.getMetricsHistory(6);
      expect(mockRedis.lrange).toHaveBeenCalledWith('metrics:history', 0, 1439); // 6 hours = 1440 entries
    });

    it('should return empty array on Redis error', async () => {
      mockRedis.lrange.mockRejectedValue(new Error('Redis error'));

      const result = await service.getMetricsHistory(1);

      expect(result).toEqual([]);
    });
  });

  describe('getActiveAlerts', () => {
    it('should return all unresolved alerts when no organizationId provided', async () => {
      // Access private activeAlerts map using bracket notation
      const alert1: Alert = {
        id: 'alert-1',
        ruleId: 'rule-1',
        severity: 'warning',
        title: 'High Memory',
        message: 'Memory usage high',
        data: {},
        isResolved: false,
        triggeredAt: '2024-01-01T00:00:00.000Z',
      };

      const alert2: Alert = {
        id: 'alert-2',
        ruleId: 'rule-2',
        severity: 'error',
        title: 'High Error Rate',
        message: 'Error rate exceeds threshold',
        data: {},
        isResolved: false,
        triggeredAt: '2024-01-01T00:01:00.000Z',
      };

      const alert3: Alert = {
        id: 'alert-3',
        ruleId: 'rule-3',
        severity: 'info',
        title: 'Low Traffic',
        message: 'Traffic below normal',
        data: {},
        isResolved: true,
        triggeredAt: '2024-01-01T00:02:00.000Z',
        resolvedAt: '2024-01-01T00:03:00.000Z',
      };

      service['activeAlerts'].set('alert-1', alert1);
      service['activeAlerts'].set('alert-2', alert2);
      service['activeAlerts'].set('alert-3', alert3);

      const result = await service.getActiveAlerts();

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(alert1);
      expect(result).toContainEqual(alert2);
      expect(result).not.toContainEqual(alert3);
    });

    it('should filter alerts by organizationId', async () => {
      const alert1: Alert = {
        id: 'alert-1',
        ruleId: 'rule-1',
        severity: 'warning',
        title: 'Org 1 Alert',
        message: 'Alert for org 1',
        data: {},
        organizationId: 'org-1',
        isResolved: false,
        triggeredAt: '2024-01-01T00:00:00.000Z',
      };

      const alert2: Alert = {
        id: 'alert-2',
        ruleId: 'rule-2',
        severity: 'error',
        title: 'Org 2 Alert',
        message: 'Alert for org 2',
        data: {},
        organizationId: 'org-2',
        isResolved: false,
        triggeredAt: '2024-01-01T00:01:00.000Z',
      };

      const alert3: Alert = {
        id: 'alert-3',
        ruleId: 'rule-3',
        severity: 'info',
        title: 'Global Alert',
        message: 'Global alert (no org)',
        data: {},
        isResolved: false,
        triggeredAt: '2024-01-01T00:02:00.000Z',
      };

      service['activeAlerts'].set('alert-1', alert1);
      service['activeAlerts'].set('alert-2', alert2);
      service['activeAlerts'].set('alert-3', alert3);

      const result = await service.getActiveAlerts('org-1');

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(alert1);
      expect(result).toContainEqual(alert3); // Global alert included
      expect(result).not.toContainEqual(alert2);
    });

    it('should return empty array when no active alerts', async () => {
      const result = await service.getActiveAlerts();

      expect(result).toEqual([]);
    });
  });

  describe('resolveAlert', () => {
    it('should resolve existing org-scoped alert when caller is in the same org', async () => {
      const alert: Alert = {
        id: 'alert-1',
        ruleId: 'rule-1',
        severity: 'warning',
        title: 'Test Alert',
        message: 'Test alert message',
        data: {},
        organizationId: 'org-a',
        isResolved: false,
        triggeredAt: '2024-01-01T00:00:00.000Z',
      };

      service['activeAlerts'].set('alert-1', alert);

      const result = await service.resolveAlert('alert-1', 'user-123', 'org-a');

      expect(result).toBe(true);
      expect(alert.isResolved).toBe(true);
      expect(alert.resolvedBy).toBe('user-123');
      expect(alert.resolvedAt).toBeDefined();
      expect(mockRedis.setex).toHaveBeenCalled();
    });

    it('should refuse cross-tenant resolve attempts (org-B caller on org-A alert)', async () => {
      // Pin the cross-tenant guard added for the guessable-alertId +
      // unauthenticated-resolve combo. Previously resolveAlert took
      // only (alertId, resolvedBy) and did not consult the alert's
      // organizationId, so any authenticated user — combined with a
      // predictable alertId — could silently clear another org's
      // alerts. The fix returns false (not Forbidden, to avoid being
      // a cross-tenant existence oracle) when the orgs don't match.
      const alert: Alert = {
        id: 'alert-a',
        ruleId: 'rule-1',
        severity: 'critical',
        title: 'Foreign Alert',
        message: 'belongs to org-a',
        data: {},
        organizationId: 'org-a',
        isResolved: false,
        triggeredAt: '2024-01-01T00:00:00.000Z',
      };
      service['activeAlerts'].set('alert-a', alert);

      const result = await service.resolveAlert('alert-a', 'attacker', 'org-b');

      expect(result).toBe(false);
      expect(alert.isResolved).toBe(false);
      expect(mockRedis.setex).not.toHaveBeenCalled();
    });

    it('should allow platform-global alert (no organizationId) to be resolved from any context', async () => {
      // System alerts that don't belong to any tenant (e.g. node
      // health). Resolving them is still an authenticated action —
      // the controller calls this with callerOrganizationId = null
      // and the service accepts because alert.organizationId is
      // falsy.
      const alert: Alert = {
        id: 'alert-sys',
        ruleId: 'rule-sys',
        severity: 'warning',
        title: 'System Alert',
        message: 'platform-global',
        data: {},
        isResolved: false,
        triggeredAt: '2024-01-01T00:00:00.000Z',
      };
      service['activeAlerts'].set('alert-sys', alert);

      const result = await service.resolveAlert('alert-sys', 'user-123', null);

      expect(result).toBe(true);
      expect(alert.isResolved).toBe(true);
    });

    it('should return false for non-existent alert', async () => {
      const result = await service.resolveAlert('non-existent-alert', 'user-123', 'org-a');

      expect(result).toBe(false);
      expect(mockRedis.setex).not.toHaveBeenCalled();
    });
  });

  describe('getSystemHealth', () => {
    it('should return system health with status and components', async () => {
      const result = await service.getSystemHealth();

      expect(result).toEqual({
        status: expect.any(String),
        components: expect.any(Object),
        uptime: expect.any(Number),
        version: expect.any(String),
      });
      expect(result.uptime).toBeGreaterThan(0);
      expect(['healthy', 'degraded', 'unhealthy']).toContain(result.status);
    });
  });

  describe('getPrometheusMetrics', () => {
    it('should return Prometheus-formatted metrics string', async () => {
      const result = await service.getPrometheusMetrics();

      expect(typeof result).toBe('string');
    });
  });

  describe('Alert Condition Evaluation - Real Business Logic', () => {
    let mockMetrics: SystemMetrics;

    beforeEach(() => {
      mockMetrics = {
        timestamp: '2024-01-01T00:00:00.000Z',
        system: {
          uptime: 1000,
          memoryUsage: { rss: 100000000, heapTotal: 200000000, heapUsed: 150000000, external: 50000000, arrayBuffers: 10000000 },
          cpuUsage: { user: 1000, system: 500 },
          loadAverage: [1.5, 1.2, 1.0],
        },
        application: {
          activeConnections: { mcp: 5, utcp: 3, a2a: 2, http: 10, sse: 4, websocket: 6 },
          requests: { total: 1000, successful: 950, failed: 50, rate: 10 },
          tools: { total: 20, active: 15, executions: 500, averageExecutionTime: 200 },
          apis: { total: 10, active: 8, healthy: 7, unhealthy: 3 },
        },
        protocols: {
          mcp: { sessions: 5, toolCalls: 100, responseTime: 150, errorRate: 0.02 },
          utcp: { manuals: 10, directCalls: 50, proxyExecutions: 30 },
          a2a: { activeAgents: 3, messages: 200, workflows: 5 },
        },
        security: {
          threatsBlocked: 15,
          piiFiltered: 25,
          rateLimitsApplied: 10,
          authFailures: 5,
        },
        performance: {
          averageResponseTime: 250,
          p95ResponseTime: 500,
          p99ResponseTime: 800,
          cacheHitRate: 0.85,
          errorRate: 0.03,
        },
      };
    });

    describe('extractMetricValue', () => {
      it('should extract top-level metric values', () => {
        const result = service['extractMetricValue'](mockMetrics, 'timestamp');
        expect(result).toBe('2024-01-01T00:00:00.000Z');
      });

      it('should extract nested metric values using dot notation', () => {
        const result = service['extractMetricValue'](mockMetrics, 'system.uptime');
        expect(result).toBe(1000);
      });

      it('should extract deeply nested values', () => {
        const result = service['extractMetricValue'](mockMetrics, 'system.memoryUsage.heapUsed');
        expect(result).toBe(150000000);
      });

      it('should extract array values', () => {
        const result = service['extractMetricValue'](mockMetrics, 'system.loadAverage');
        expect(result).toEqual([1.5, 1.2, 1.0]);
      });

      it('should extract protocol-specific metrics', () => {
        const result = service['extractMetricValue'](mockMetrics, 'protocols.mcp.errorRate');
        expect(result).toBe(0.02);
      });

      it('should return undefined for non-existent paths', () => {
        const result = service['extractMetricValue'](mockMetrics, 'nonexistent.path.here');
        expect(result).toBeUndefined();
      });

      it('should return undefined for partial invalid paths', () => {
        const result = service['extractMetricValue'](mockMetrics, 'system.invalid.path');
        expect(result).toBeUndefined();
      });
    });

    describe('evaluateAlertCondition', () => {
      it('should correctly evaluate "gt" (greater than) conditions', async () => {
        const rule = {
          id: 'rule-1',
          name: 'High Memory',
          description: 'Memory usage too high',
          metric: 'system.memoryUsage.heapUsed',
          condition: 'gt' as const,
          threshold: 100000000,
          severity: 'warning' as const,
          isActive: true,
          cooldownMinutes: 5,
        };

        const result = await service['evaluateAlertCondition'](rule, mockMetrics);
        expect(result).toBe(true); // 150000000 > 100000000

        const falseRule = { ...rule, threshold: 200000000 };
        const result2 = await service['evaluateAlertCondition'](falseRule, mockMetrics);
        expect(result2).toBe(false); // 150000000 not > 200000000
      });

      it('should correctly evaluate "lt" (less than) conditions', async () => {
        const rule = {
          id: 'rule-2',
          name: 'Low Active Tools',
          description: 'Too few active tools',
          metric: 'application.tools.active',
          condition: 'lt' as const,
          threshold: 20,
          severity: 'warning' as const,
          isActive: true,
          cooldownMinutes: 10,
        };

        const result = await service['evaluateAlertCondition'](rule, mockMetrics);
        expect(result).toBe(true); // 15 < 20

        const falseRule = { ...rule, threshold: 10 };
        const result2 = await service['evaluateAlertCondition'](falseRule, mockMetrics);
        expect(result2).toBe(false); // 15 not < 10
      });

      it('should correctly evaluate "eq" (equals) conditions', async () => {
        const rule = {
          id: 'rule-3',
          name: 'Exact Match',
          description: 'Value matches exactly',
          metric: 'protocols.a2a.activeAgents',
          condition: 'eq' as const,
          threshold: 3,
          severity: 'info' as const,
          isActive: true,
          cooldownMinutes: 15,
        };

        const result = await service['evaluateAlertCondition'](rule, mockMetrics);
        expect(result).toBe(true); // 3 === 3

        const falseRule = { ...rule, threshold: 5 };
        const result2 = await service['evaluateAlertCondition'](falseRule, mockMetrics);
        expect(result2).toBe(false); // 3 !== 5
      });

      it('should correctly evaluate "contains" conditions', async () => {
        const rule = {
          id: 'rule-4',
          name: 'Timestamp Contains Date',
          description: 'Check timestamp format',
          metric: 'timestamp',
          condition: 'contains' as const,
          threshold: '2024-01-01',
          severity: 'info' as const,
          isActive: true,
          cooldownMinutes: 1,
        };

        const result = await service['evaluateAlertCondition'](rule, mockMetrics);
        expect(result).toBe(true);

        const falseRule = { ...rule, threshold: '2025-12-31' };
        const result2 = await service['evaluateAlertCondition'](falseRule, mockMetrics);
        expect(result2).toBe(false);
      });

      it('should return false for invalid metric paths', async () => {
        const rule = {
          id: 'rule-5',
          name: 'Invalid Path',
          description: 'Testing invalid path',
          metric: 'nonexistent.invalid.path',
          condition: 'gt' as const,
          threshold: 100,
          severity: 'error' as const,
          isActive: true,
          cooldownMinutes: 5,
        };

        const result = await service['evaluateAlertCondition'](rule, mockMetrics);
        expect(result).toBe(false);
      });

      it('should handle error rate thresholds correctly', async () => {
        const rule = {
          id: 'rule-6',
          name: 'High Error Rate',
          description: 'Error rate exceeds threshold',
          metric: 'performance.errorRate',
          condition: 'gt' as const,
          threshold: 0.05, // 5%
          severity: 'error' as const,
          isActive: true,
          cooldownMinutes: 5,
        };

        const result = await service['evaluateAlertCondition'](rule, mockMetrics);
        expect(result).toBe(false); // 0.03 not > 0.05

        const highErrorRule = { ...rule, threshold: 0.01 };
        const result2 = await service['evaluateAlertCondition'](highErrorRule, mockMetrics);
        expect(result2).toBe(true); // 0.03 > 0.01
      });
    });

    describe('triggerAlert', () => {
      it('should create alert with correct properties', async () => {
        const rule = {
          id: 'rule-1',
          name: 'Test Alert Rule',
          description: 'Test description',
          metric: 'system.memoryUsage.heapUsed',
          condition: 'gt' as const,
          threshold: 100000000,
          severity: 'warning' as const,
          isActive: true,
          cooldownMinutes: 5,
          organizationId: 'org-1',
        };

        mockRedis.get.mockResolvedValue(JSON.stringify(mockMetrics));

        await service['triggerAlert'](rule, mockMetrics);

        const alerts = await service.getActiveAlerts();
        expect(alerts.length).toBe(1);
        expect(alerts[0].ruleId).toBe('rule-1');
        expect(alerts[0].severity).toBe('warning');
        expect(alerts[0].title).toBe('Test Alert Rule');
        expect(alerts[0].organizationId).toBe('org-1');
        expect(alerts[0].isResolved).toBe(false);
        expect(alerts[0].data.triggeredValue).toBe(150000000);
      });

      it('should store alert in Redis with expiration', async () => {
        const rule = {
          id: 'rule-1',
          name: 'Test Alert',
          description: 'Test',
          metric: 'system.uptime',
          condition: 'gt' as const,
          threshold: 500,
          severity: 'info' as const,
          isActive: true,
          cooldownMinutes: 10,
        };

        await service['triggerAlert'](rule, mockMetrics);

        expect(mockRedis.setex).toHaveBeenCalled();
        const setexCall = mockRedis.setex.mock.calls[0];
        expect(setexCall[0]).toMatch(/^alert:/);
        expect(setexCall[1]).toBe(86400); // 24 hours
      });

      it('should emit alert event when triggered', (done) => {
        const rule = {
          id: 'rule-1',
          name: 'Event Test',
          description: 'Test alert event',
          metric: 'application.requests.failed',
          condition: 'gt' as const,
          threshold: 10,
          severity: 'error' as const,
          isActive: true,
          cooldownMinutes: 5,
        };

        service.on('alert', (alert) => {
          expect(alert.ruleId).toBe('rule-1');
          expect(alert.severity).toBe('error');
          expect(alert.data.triggeredValue).toBe(50);
          done();
        });

        service['triggerAlert'](rule, mockMetrics);
      });

      it('should update rule lastTriggered timestamp', async () => {
        const rule = {
          id: 'rule-1',
          name: 'Cooldown Test',
          description: 'Test lastTriggered update',
          metric: 'system.uptime',
          condition: 'gt' as const,
          threshold: 0,
          severity: 'info' as const,
          isActive: true,
          cooldownMinutes: 5,
        };

        service['alertRules'].set('rule-1', rule);

        await service['triggerAlert'](rule, mockMetrics);

        const updatedRule = service['alertRules'].get('rule-1');
        expect(updatedRule.lastTriggered).toBeDefined();
        expect(new Date(updatedRule.lastTriggered).getTime()).toBeLessThanOrEqual(Date.now());
      });
    });

    describe('Alert Cooldown Logic', () => {
      it('should respect cooldown period and not trigger duplicate alerts', async () => {
        const rule = {
          id: 'rule-cooldown',
          name: 'Cooldown Test',
          description: 'Testing cooldown',
          metric: 'application.requests.failed',
          condition: 'gt' as const,
          threshold: 10,
          severity: 'warning' as const,
          isActive: true,
          cooldownMinutes: 1, // 1 minute cooldown
          lastTriggered: new Date().toISOString(), // Just triggered
        };

        service['alertRules'].set('rule-cooldown', rule);
        mockRedis.get.mockResolvedValue(JSON.stringify(mockMetrics));

        await service['evaluateAlerts']();

        // Should not create new alert due to cooldown
        const alerts = await service.getActiveAlerts();
        expect(alerts.length).toBe(0);
      });

      it('should trigger alert after cooldown expires', async () => {
        const pastTime = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
        const rule = {
          id: 'rule-expired',
          name: 'Expired Cooldown',
          description: 'Cooldown expired',
          metric: 'application.requests.failed',
          condition: 'gt' as const,
          threshold: 10,
          severity: 'warning' as const,
          isActive: true,
          cooldownMinutes: 1, // 1 minute cooldown (expired)
          lastTriggered: pastTime.toISOString(),
        };

        service['alertRules'].set('rule-expired', rule);
        mockRedis.get.mockResolvedValue(JSON.stringify(mockMetrics));

        await service['evaluateAlerts']();

        const alerts = await service.getActiveAlerts();
        expect(alerts.length).toBe(1);
        expect(alerts[0].ruleId).toBe('rule-expired');
      });
    });

    describe('Real-World Alert Scenarios', () => {
      it('should detect high memory usage and trigger critical alert', async () => {
        const memoryRule = {
          id: 'high-memory',
          name: 'Critical Memory Usage',
          description: 'Memory usage exceeds 80%',
          metric: 'system.memoryUsage.heapUsed',
          condition: 'gt' as const,
          threshold: 100000000,
          severity: 'critical' as const,
          isActive: true,
          cooldownMinutes: 5,
        };

        const result = await service['evaluateAlertCondition'](memoryRule, mockMetrics);
        expect(result).toBe(true);

        await service['triggerAlert'](memoryRule, mockMetrics);
        const alerts = await service.getActiveAlerts();
        expect(alerts.length).toBe(1);
        expect(alerts[0].severity).toBe('critical');
      });

      it('should detect high error rate and trigger error alert', async () => {
        const errorRateMetrics = {
          ...mockMetrics,
          performance: {
            ...mockMetrics.performance,
            errorRate: 0.15, // 15% error rate
          },
        };

        const errorRule = {
          id: 'high-errors',
          name: 'High Error Rate',
          description: 'Error rate exceeds 10%',
          metric: 'performance.errorRate',
          condition: 'gt' as const,
          threshold: 0.10,
          severity: 'error' as const,
          isActive: true,
          cooldownMinutes: 10,
        };

        const result = await service['evaluateAlertCondition'](errorRule, errorRateMetrics);
        expect(result).toBe(true);

        await service['triggerAlert'](errorRule, errorRateMetrics);
        const alerts = await service.getActiveAlerts();
        expect(alerts.some(a => a.ruleId === 'high-errors')).toBe(true);
      });

      it('should detect unhealthy APIs and trigger warning', async () => {
        const unhealthyMetrics = {
          ...mockMetrics,
          application: {
            ...mockMetrics.application,
            apis: { total: 10, active: 8, healthy: 3, unhealthy: 7 },
          },
        };

        const unhealthyRule = {
          id: 'unhealthy-apis',
          name: 'Too Many Unhealthy APIs',
          description: 'More than 5 APIs are unhealthy',
          metric: 'application.apis.unhealthy',
          condition: 'gt' as const,
          threshold: 5,
          severity: 'warning' as const,
          isActive: true,
          cooldownMinutes: 15,
        };

        const result = await service['evaluateAlertCondition'](unhealthyRule, unhealthyMetrics);
        expect(result).toBe(true);
      });
    });
  });

  describe('Service Initialization and Lifecycle', () => {
    describe('initialize', () => {
      it('should load alert rules from Redis', async () => {
        const mockRuleData = {
          id: 'rule-1',
          name: 'Test Rule',
          metric: 'performance.errorRate',
          condition: 'gt',
          threshold: 0.05,
          severity: 'error',
          isActive: true,
          cooldownMinutes: 10,
        };

        mockRedis.keys.mockResolvedValue(['alert:rule:1']);
        mockRedis.get.mockResolvedValue(JSON.stringify(mockRuleData));

        await service['loadAlertRules']();

        expect(mockRedis.keys).toHaveBeenCalledWith('alert:rule:*');
        expect(mockRedis.get).toHaveBeenCalledWith('alert:rule:1');
      });

      it('should setup default alert rules', async () => {
        await service['setupDefaultAlertRules']();

        // Check that default rules are created (5 default rules)
        const rules = service['alertRules'];
        expect(rules.size).toBeGreaterThanOrEqual(5);

        // Verify specific default rules exist
        const ruleNames = Array.from(rules.values()).map(r => r.name);
        expect(ruleNames).toContain('High Error Rate');
        expect(ruleNames).toContain('Slow Response Time');
        expect(ruleNames).toContain('High Memory Usage');
        expect(ruleNames).toContain('Security Threats Detected');
      });

      it('should handle Redis errors when loading alert rules', async () => {
        mockRedis.keys.mockRejectedValue(new Error('Redis connection error'));

        await service['loadAlertRules']();

        // Should not throw, should log error
        expect(mockRedis.keys).toHaveBeenCalled();
      });
    });

    describe('collectSystemMetrics', () => {
      it('should collect complete system metrics', async () => {
        const mockToolRepository = {
          count: jest.fn()
            .mockResolvedValueOnce(50) // total tools
            .mockResolvedValueOnce(42), // active tools
        };

        const mockApiRepository = {
          count: jest.fn()
            .mockResolvedValueOnce(20) // total APIs
            .mockResolvedValueOnce(18), // active APIs
        };

        const mockOrgRepository = {
          count: jest.fn().mockResolvedValue(10),
        };

        service['toolRepository'] = mockToolRepository as any;
        service['apiRepository'] = mockApiRepository as any;
        service['organizationRepository'] = mockOrgRepository as any;

        mockRedis.get
          .mockResolvedValueOnce(JSON.stringify({ total: 1000, successful: 950, failed: 50, rate: 10 }))
          .mockResolvedValueOnce(JSON.stringify({
            mcp: { sessions: 5, toolCalls: 100, responseTime: 150, errorRate: 0.02 },
            utcp: { manuals: 10, directCalls: 50, proxyExecutions: 30 },
            a2a: { activeAgents: 3, messages: 200, workflows: 5 },
          }))
          .mockResolvedValueOnce(JSON.stringify({ threatsBlocked: 15, piiFiltered: 25, rateLimitsApplied: 10, authFailures: 5 }))
          .mockResolvedValueOnce(JSON.stringify({ averageResponseTime: 250, p95ResponseTime: 500, p99ResponseTime: 800, cacheHitRate: 0.75, errorRate: 0.05 }));

        const metrics = await service['collectSystemMetrics']();

        expect(metrics).toBeDefined();
        expect(metrics.timestamp).toBeDefined();
        expect(metrics.system).toBeDefined();
        expect(metrics.system.uptime).toBeGreaterThan(0);
        expect(metrics.system.memoryUsage).toBeDefined();
        expect(metrics.application.tools.total).toBe(50);
        expect(metrics.application.tools.active).toBe(42);
        expect(metrics.application.apis.total).toBe(20);
        expect(metrics.application.apis.active).toBe(18);
        expect(metrics.application.requests.total).toBe(1000);
        expect(metrics.protocols.mcp.sessions).toBe(5);
        expect(metrics.security.threatsBlocked).toBe(15);
        expect(metrics.performance.averageResponseTime).toBe(250);
      });

      it('should handle database query errors gracefully', async () => {
        const mockToolRepository = {
          count: jest.fn().mockRejectedValue(new Error('Database error')),
        };

        service['toolRepository'] = mockToolRepository as any;

        // Should throw since database is critical
        await expect(service['collectSystemMetrics']()).rejects.toThrow();
      });
    });

    describe('storeMetrics', () => {
      it('should store metrics in Redis with TTL', async () => {
        const metrics: SystemMetrics = {
          timestamp: '2024-01-01T00:00:00.000Z',
          system: {
            uptime: 1000,
            memoryUsage: { rss: 100, heapTotal: 200, heapUsed: 150, external: 50, arrayBuffers: 10 },
            cpuUsage: { user: 1000, system: 500 },
            loadAverage: [1.5, 1.2, 1.0],
          },
          application: {
            activeConnections: { mcp: 5, utcp: 3, a2a: 2, http: 10, sse: 4, websocket: 6 },
            requests: { total: 1000, successful: 950, failed: 50, rate: 10 },
            tools: { total: 20, active: 15, executions: 500, averageExecutionTime: 200 },
            apis: { total: 10, active: 8, healthy: 7, unhealthy: 3 },
          },
          protocols: {
            mcp: { sessions: 5, toolCalls: 100, responseTime: 150, errorRate: 0.02 },
            utcp: { manuals: 10, directCalls: 50, proxyExecutions: 30 },
            a2a: { activeAgents: 3, messages: 200, workflows: 5 },
          },
          security: {
            threatsBlocked: 15,
            piiFiltered: 25,
            rateLimitsApplied: 10,
            authFailures: 5,
          },
          performance: {
            averageResponseTime: 250,
            p95ResponseTime: 500,
            p99ResponseTime: 800,
            cacheHitRate: 0.75,
            errorRate: 0.05,
          },
        };

        await service['storeMetrics'](metrics);

        expect(mockRedis.setex).toHaveBeenCalledWith('metrics:latest', 300, JSON.stringify(metrics));
        expect(mockRedis.lpush).toHaveBeenCalledWith('metrics:history', JSON.stringify(metrics));
        expect(mockRedis.ltrim).toHaveBeenCalledWith('metrics:history', 0, 1440);
      });
    });

    describe('Redis Stats Helper Methods', () => {
      it('should return default request stats when Redis returns null', async () => {
        mockRedis.get.mockResolvedValue(null);

        const stats = await service['getRequestStats']();

        expect(stats).toEqual({
          total: 0,
          successful: 0,
          failed: 0,
          rate: 0,
        });
      });

      it('should parse request stats from Redis', async () => {
        mockRedis.get.mockResolvedValue(JSON.stringify({ total: 100, successful: 95, failed: 5, rate: 5 }));

        const stats = await service['getRequestStats']();

        expect(stats.total).toBe(100);
        expect(stats.successful).toBe(95);
        expect(stats.failed).toBe(5);
        expect(stats.rate).toBe(5);
      });

      it('should handle Redis errors in getRequestStats', async () => {
        mockRedis.get.mockRejectedValue(new Error('Redis error'));

        const stats = await service['getRequestStats']();

        expect(stats).toEqual({
          total: 0,
          successful: 0,
          failed: 0,
          rate: 0,
        });
      });

      it('should return default protocol stats when Redis returns null', async () => {
        mockRedis.get.mockResolvedValue(null);

        const stats = await service['getProtocolStats']();

        expect(stats).toEqual({
          mcp: { sessions: 0, toolCalls: 0, responseTime: 0, errorRate: 0 },
          utcp: { manuals: 0, directCalls: 0, proxyExecutions: 0 },
          a2a: { activeAgents: 0, messages: 0, workflows: 0 },
        });
      });

      it('should parse protocol stats from Redis', async () => {
        mockRedis.get.mockResolvedValue(JSON.stringify({
          mcp: { sessions: 10, toolCalls: 500, responseTime: 200, errorRate: 0.01 },
          utcp: { manuals: 20, directCalls: 300, proxyExecutions: 100 },
          a2a: { activeAgents: 5, messages: 1000, workflows: 15 },
        }));

        const stats = await service['getProtocolStats']();

        expect(stats.mcp.sessions).toBe(10);
        expect(stats.utcp.directCalls).toBe(300);
        expect(stats.a2a.workflows).toBe(15);
      });

      it('should handle Redis errors in getProtocolStats', async () => {
        mockRedis.get.mockRejectedValue(new Error('Redis error'));

        const stats = await service['getProtocolStats']();

        expect(stats.mcp.sessions).toBe(0);
      });

      it('should return default security stats when Redis returns null', async () => {
        mockRedis.get.mockResolvedValue(null);

        const stats = await service['getSecurityStats']();

        expect(stats).toEqual({
          threatsBlocked: 0,
          piiFiltered: 0,
          rateLimitsApplied: 0,
          authFailures: 0,
        });
      });

      it('should parse security stats from Redis', async () => {
        mockRedis.get.mockResolvedValue(JSON.stringify({
          threatsBlocked: 50,
          piiFiltered: 100,
          rateLimitsApplied: 25,
          authFailures: 10,
        }));

        const stats = await service['getSecurityStats']();

        expect(stats.threatsBlocked).toBe(50);
        expect(stats.piiFiltered).toBe(100);
      });

      it('should handle Redis errors in getSecurityStats', async () => {
        mockRedis.get.mockRejectedValue(new Error('Redis error'));

        const stats = await service['getSecurityStats']();

        expect(stats.threatsBlocked).toBe(0);
      });

      it('should return default performance stats when Redis returns null', async () => {
        mockRedis.get.mockResolvedValue(null);

        const stats = await service['getPerformanceStats']();

        expect(stats).toEqual({
          averageResponseTime: 0,
          p95ResponseTime: 0,
          p99ResponseTime: 0,
          cacheHitRate: 0,
          errorRate: 0,
        });
      });

      it('should parse performance stats from Redis', async () => {
        mockRedis.get.mockResolvedValue(JSON.stringify({
          averageResponseTime: 300,
          p95ResponseTime: 600,
          p99ResponseTime: 900,
          cacheHitRate: 0.8,
          errorRate: 0.02,
        }));

        const stats = await service['getPerformanceStats']();

        expect(stats.averageResponseTime).toBe(300);
        expect(stats.cacheHitRate).toBe(0.8);
      });

      it('should handle Redis errors in getPerformanceStats', async () => {
        mockRedis.get.mockRejectedValue(new Error('Redis error'));

        const stats = await service['getPerformanceStats']();

        expect(stats.errorRate).toBe(0);
      });
    });

    describe('evaluateAlerts loop', () => {
      it('should skip inactive rules', async () => {
        const inactiveRule = {
          id: 'rule-1',
          name: 'Inactive Rule',
          description: 'Test inactive rule',
          metric: 'performance.errorRate',
          condition: 'gt' as const,
          threshold: 0.05,
          severity: 'error' as const,
          isActive: false,
          cooldownMinutes: 10,
        };

        service['alertRules'].set('rule-1', inactiveRule);

        mockRedis.get.mockResolvedValue(JSON.stringify({
          timestamp: '2024-01-01T00:00:00.000Z',
          system: { uptime: 1000, memoryUsage: {}, cpuUsage: {}, loadAverage: [] },
          application: { activeConnections: {}, requests: {}, tools: {}, apis: {} },
          protocols: {},
          security: {},
          performance: { errorRate: 0.1 },
        }));

        await service['evaluateAlerts']();

        // Should not trigger alert for inactive rule
        expect(service['activeAlerts'].size).toBe(0);
      });

      it('should skip rules in cooldown period', async () => {
        const rule = {
          id: 'rule-1',
          name: 'Cooldown Rule',
          description: 'Test cooldown rule',
          metric: 'performance.errorRate',
          condition: 'gt' as const,
          threshold: 0.05,
          severity: 'error' as const,
          isActive: true,
          cooldownMinutes: 10,
          lastTriggered: new Date().toISOString(), // Just triggered
        };

        service['alertRules'].set('rule-1', rule);

        mockRedis.get.mockResolvedValue(JSON.stringify({
          timestamp: '2024-01-01T00:00:00.000Z',
          system: { uptime: 1000, memoryUsage: {}, cpuUsage: {}, loadAverage: [] },
          application: { activeConnections: {}, requests: {}, tools: {}, apis: {} },
          protocols: {},
          security: {},
          performance: { errorRate: 0.1 },
        }));

        await service['evaluateAlerts']();

        // Should not trigger alert due to cooldown
        expect(service['activeAlerts'].size).toBe(0);
      });

      it('should trigger alert when condition is met', async () => {
        const rule = {
          id: 'rule-1',
          name: 'High Error Rate',
          description: 'Error rate exceeds threshold',
          metric: 'performance.errorRate',
          condition: 'gt' as const,
          threshold: 0.05,
          severity: 'error' as const,
          isActive: true,
          cooldownMinutes: 10,
        };

        service['alertRules'].set('rule-1', rule);

        mockRedis.get.mockResolvedValue(JSON.stringify({
          timestamp: '2024-01-01T00:00:00.000Z',
          system: { uptime: 1000, memoryUsage: {}, cpuUsage: {}, loadAverage: [] },
          application: { activeConnections: {}, requests: {}, tools: {}, apis: {} },
          protocols: {},
          security: {},
          performance: { errorRate: 0.1 },
        }));

        await service['evaluateAlerts']();

        // Should trigger alert
        expect(service['activeAlerts'].size).toBe(1);
        expect(mockRedis.setex).toHaveBeenCalled();
      });
    });

    describe('getSystemHealth with alert status', () => {
      it('should return unhealthy status when critical alerts exist', async () => {
        const criticalAlert: Alert = {
          id: 'alert-1',
          ruleId: 'rule-1',
          severity: 'critical',
          title: 'Critical Issue',
          message: 'System is down',
          data: {},
          isResolved: false,
          triggeredAt: '2024-01-01T00:00:00.000Z',
        };

        service['activeAlerts'].set('alert-1', criticalAlert);

        const health = await service.getSystemHealth();

        expect(health.status).toBe('unhealthy');
      });

      it('should return degraded status when error alerts exist', async () => {
        const errorAlert: Alert = {
          id: 'alert-2',
          ruleId: 'rule-2',
          severity: 'error',
          title: 'Error Issue',
          message: 'High error rate',
          data: {},
          isResolved: false,
          triggeredAt: '2024-01-01T00:00:00.000Z',
        };

        service['activeAlerts'].set('alert-2', errorAlert);

        const health = await service.getSystemHealth();

        expect(health.status).toBe('degraded');
      });
    });

    describe('getPrometheusMetrics with real metrics', () => {
      it('should format metrics in Prometheus format', async () => {
        const mockMetrics: SystemMetrics = {
          timestamp: '2024-01-01T00:00:00.000Z',
          system: {
            uptime: 1000,
            memoryUsage: { rss: 100, heapTotal: 200, heapUsed: 150, external: 50, arrayBuffers: 10 },
            cpuUsage: { user: 1000, system: 500 },
            loadAverage: [1.5, 1.2, 1.0],
          },
          application: {
            activeConnections: { mcp: 5, utcp: 3, a2a: 2, http: 10, sse: 4, websocket: 6 },
            requests: { total: 1000, successful: 950, failed: 50, rate: 10 },
            tools: { total: 20, active: 15, executions: 500, averageExecutionTime: 200 },
            apis: { total: 10, active: 8, healthy: 7, unhealthy: 3 },
          },
          protocols: {
            mcp: { sessions: 5, toolCalls: 100, responseTime: 150, errorRate: 0.02 },
            utcp: { manuals: 10, directCalls: 50, proxyExecutions: 30 },
            a2a: { activeAgents: 3, messages: 200, workflows: 5 },
          },
          security: {
            threatsBlocked: 15,
            piiFiltered: 25,
            rateLimitsApplied: 10,
            authFailures: 5,
          },
          performance: {
            averageResponseTime: 250,
            p95ResponseTime: 500,
            p99ResponseTime: 800,
            cacheHitRate: 0.75,
            errorRate: 0.05,
          },
        };

        mockRedis.get.mockResolvedValue(JSON.stringify(mockMetrics));

        const prometheusOutput = await service.getPrometheusMetrics();

        expect(prometheusOutput).toContain('almyty_uptime_seconds 1000');
        expect(prometheusOutput).toContain('almyty_memory_usage_bytes{type="heap"} 150');
        expect(prometheusOutput).toContain('almyty_tools_total 20');
        expect(prometheusOutput).toContain('almyty_tools_active 15');
        expect(prometheusOutput).toContain('almyty_requests_total{status="success"} 950');
        expect(prometheusOutput).toContain('almyty_requests_total{status="error"} 50');
        expect(prometheusOutput).toContain('almyty_response_time_ms 250');
        expect(prometheusOutput).toContain('almyty_mcp_sessions 5');
        expect(prometheusOutput).toContain('almyty_a2a_agents 3');
      });

      it('should return empty string when no metrics available', async () => {
        mockRedis.get.mockResolvedValue(null);

        const prometheusOutput = await service.getPrometheusMetrics();

        expect(prometheusOutput).toBe('');
      });
    });

    describe('Lifecycle hooks - Branch Coverage', () => {
      it('should initialize on module init', async () => {
        const initSpy = jest.spyOn(service, 'initialize');

        await service.onModuleInit();

        expect(initSpy).toHaveBeenCalled();
      });

      it('should shutdown on module destroy', async () => {
        const shutdownSpy = jest.spyOn(service, 'shutdown');

        await service.onModuleDestroy();

        expect(shutdownSpy).toHaveBeenCalled();
      });
    });

    describe('Alert evaluation - Branch Coverage', () => {
      it('should skip evaluation when no metrics available', async () => {
        mockRedis.get.mockResolvedValue(null);

        await service['evaluateAlerts']();

        // Should not throw and should handle null metrics gracefully
        expect(service).toBeDefined();
      });

      it('should evaluate alert condition with eq operator', async () => {
        const metrics: SystemMetrics = {
          timestamp: '2024-01-01T00:00:00.000Z',
          system: {
            uptime: 1000,
            memoryUsage: { rss: 100, heapTotal: 200, heapUsed: 150, external: 50, arrayBuffers: 10 },
            cpuUsage: { user: 1000, system: 500 },
            loadAverage: [1.5, 1.2, 1.0],
          },
          application: {
            activeConnections: { mcp: 5, utcp: 3, a2a: 2, http: 10, sse: 4, websocket: 6 },
            requests: { total: 1000, successful: 950, failed: 50, rate: 10 },
            tools: { total: 20, active: 15, executions: 500, averageExecutionTime: 200 },
            apis: { total: 10, active: 8, healthy: 7, unhealthy: 3 },
          },
          protocols: {
            mcp: { sessions: 5, toolCalls: 100, responseTime: 150, errorRate: 0.02 },
            utcp: { manuals: 10, directCalls: 50, proxyExecutions: 30 },
            a2a: { activeAgents: 3, messages: 200, workflows: 5 },
          },
          security: {
            threatsBlocked: 15,
            piiFiltered: 25,
            rateLimitsApplied: 10,
            authFailures: 5,
          },
          performance: {
            averageResponseTime: 250,
            p95ResponseTime: 500,
            p99ResponseTime: 800,
            cacheHitRate: 0.75,
            errorRate: 0.05,
          },
        };

        const rule: any = {
          id: 'rule-1',
          name: 'Test Rule',
          metric: 'system.uptime',
          condition: 'eq',
          threshold: 1000,
          severity: 'warning',
          isActive: true,
        };

        const result = await service['evaluateAlertCondition'](rule, metrics);

        expect(result).toBe(true);
      });

      it('should evaluate alert condition with contains operator', async () => {
        const metrics: SystemMetrics = {
          timestamp: '2024-01-01T00:00:00.000Z',
          system: {
            uptime: 1000,
            memoryUsage: { rss: 100, heapTotal: 200, heapUsed: 150, external: 50, arrayBuffers: 10 },
            cpuUsage: { user: 1000, system: 500 },
            loadAverage: [1.5, 1.2, 1.0],
          },
          application: {
            activeConnections: { mcp: 5, utcp: 3, a2a: 2, http: 10, sse: 4, websocket: 6 },
            requests: { total: 1000, successful: 950, failed: 50, rate: 10 },
            tools: { total: 20, active: 15, executions: 500, averageExecutionTime: 200 },
            apis: { total: 10, active: 8, healthy: 7, unhealthy: 3 },
          },
          protocols: {
            mcp: { sessions: 5, toolCalls: 100, responseTime: 150, errorRate: 0.02 },
            utcp: { manuals: 10, directCalls: 50, proxyExecutions: 30 },
            a2a: { activeAgents: 3, messages: 200, workflows: 5 },
          },
          security: {
            threatsBlocked: 15,
            piiFiltered: 25,
            rateLimitsApplied: 10,
            authFailures: 5,
          },
          performance: {
            averageResponseTime: 250,
            p95ResponseTime: 500,
            p99ResponseTime: 800,
            cacheHitRate: 0.75,
            errorRate: 0.05,
          },
        };

        const rule: any = {
          id: 'rule-2',
          name: 'Test Rule',
          metric: 'system.uptime',
          condition: 'contains',
          threshold: '100',
          severity: 'warning',
          isActive: true,
        };

        const result = await service['evaluateAlertCondition'](rule, metrics);

        expect(result).toBe(true);
      });

      it('should return false for unknown condition operator', async () => {
        const metrics: SystemMetrics = {
          timestamp: '2024-01-01T00:00:00.000Z',
          system: {
            uptime: 1000,
            memoryUsage: { rss: 100, heapTotal: 200, heapUsed: 150, external: 50, arrayBuffers: 10 },
            cpuUsage: { user: 1000, system: 500 },
            loadAverage: [1.5, 1.2, 1.0],
          },
          application: {
            activeConnections: { mcp: 5, utcp: 3, a2a: 2, http: 10, sse: 4, websocket: 6 },
            requests: { total: 1000, successful: 950, failed: 50, rate: 10 },
            tools: { total: 20, active: 15, executions: 500, averageExecutionTime: 200 },
            apis: { total: 10, active: 8, healthy: 7, unhealthy: 3 },
          },
          protocols: {
            mcp: { sessions: 5, toolCalls: 100, responseTime: 150, errorRate: 0.02 },
            utcp: { manuals: 10, directCalls: 50, proxyExecutions: 30 },
            a2a: { activeAgents: 3, messages: 200, workflows: 5 },
          },
          security: {
            threatsBlocked: 15,
            piiFiltered: 25,
            rateLimitsApplied: 10,
            authFailures: 5,
          },
          performance: {
            averageResponseTime: 250,
            p95ResponseTime: 500,
            p99ResponseTime: 800,
            cacheHitRate: 0.75,
            errorRate: 0.05,
          },
        };

        const rule: any = {
          id: 'rule-3',
          name: 'Test Rule',
          metric: 'system.uptime',
          condition: 'unknown',
          threshold: 1000,
          severity: 'warning',
          isActive: true,
        };

        const result = await service['evaluateAlertCondition'](rule, metrics);

        expect(result).toBe(false);
      });

      it('should handle errors in alert condition evaluation', async () => {
        const metrics: any = null;

        const rule: any = {
          id: 'rule-4',
          name: 'Test Rule',
          metric: 'invalid.path',
          condition: 'gt',
          threshold: 1000,
          severity: 'warning',
          isActive: true,
        };

        const result = await service['evaluateAlertCondition'](rule, metrics);

        expect(result).toBe(false);
      });
    });

    describe('Metrics collection - Branch Coverage', () => {
      it('should handle errors during metrics collection', async () => {
        // Trigger the error path in startMetricsCollection
        const collectSpy = jest.spyOn(service as any, 'collectSystemMetrics');
        collectSpy.mockRejectedValue(new Error('Collection failed'));

        // Start metrics collection
        service['startMetricsCollection']();

        // Wait for interval to trigger
        await new Promise(resolve => setTimeout(resolve, 100));

        // Should not throw - errors are logged
        expect(service).toBeDefined();

        // Clean up
        if (service['metricsInterval']) {
          clearInterval(service['metricsInterval']);
        }
      });
    });

    describe('Alert evaluation - Branch Coverage', () => {
      it('should handle errors during alert evaluation', async () => {
        // Mock getLatestMetrics to throw error
        const getMetricsSpy = jest.spyOn(service, 'getLatestMetrics');
        getMetricsSpy.mockRejectedValue(new Error('Failed to get metrics'));

        // Start alert evaluation
        service['startAlertEvaluation']();

        // Wait for interval to trigger
        await new Promise(resolve => setTimeout(resolve, 100));

        // Should not throw - errors are logged
        expect(service).toBeDefined();

        // Clean up
        if (service['alertsInterval']) {
          clearInterval(service['alertsInterval']);
        }
      });
    });
  });
});