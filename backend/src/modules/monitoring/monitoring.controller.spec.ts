import { Test, TestingModule } from '@nestjs/testing';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';

describe('MonitoringController', () => {
  let controller: MonitoringController;
  let monitoringService: jest.Mocked<MonitoringService>;

  beforeEach(async () => {
    const mockMonitoringService = {
      getSystemHealth: jest.fn(),
      getLatestMetrics: jest.fn(),
      getMetricsHistory: jest.fn(),
      getActiveAlerts: jest.fn(),
      resolveAlert: jest.fn(),
      getPrometheusMetrics: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MonitoringController],
      providers: [
        {
          provide: MonitoringService,
          useValue: mockMonitoringService,
        },
      ],
    }).compile();

    controller = module.get<MonitoringController>(MonitoringController);
    monitoringService = module.get(MonitoringService);
  });

  describe('basic functionality', () => {
    it('should be defined', () => {
      expect(controller).toBeDefined();
    });

    it('should have getHealth method', () => {
      expect(controller.getHealth).toBeDefined();
    });

    it('should have getMetrics method', () => {
      expect(controller.getMetrics).toBeDefined();
    });

    it('should have getMetricsHistory method', () => {
      expect(controller.getMetricsHistory).toBeDefined();
    });

    it('should have getAlerts method', () => {
      expect(controller.getAlerts).toBeDefined();
    });

    it('should have resolveAlert method', () => {
      expect(controller.resolveAlert).toBeDefined();
    });
  });

  describe('getHealth', () => {
    it('should return system health status', async () => {
      const mockHealth = {
        status: 'healthy' as 'healthy',
        components: {
          database: { status: 'healthy' as 'healthy' },
          redis: { status: 'healthy' as 'healthy' },
        },
        uptime: 123456,
        version: '1.0.0',
      };

      monitoringService.getSystemHealth.mockResolvedValue(mockHealth);

      const result = await controller.getHealth();

      expect(result).toBe(mockHealth);
      expect(monitoringService.getSystemHealth).toHaveBeenCalled();
    });
  });

  describe('getMetrics', () => {
    it('should return latest metrics', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockMetrics = {
        timestamp: new Date(),
        cpu: 45.5,
        memory: 60.2,
        requests: 1000,
      };

      monitoringService.getLatestMetrics.mockResolvedValue(mockMetrics as any);

      const result = await controller.getMetrics(mockRequest as any);

      expect(result).toEqual({ success: true, data: mockMetrics, message: 'Latest metrics retrieved successfully' });
      expect(monitoringService.getLatestMetrics).toHaveBeenCalled();
    });
  });

  describe('getMetricsHistory', () => {
    it('should return metrics history', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockHistory = [
        { timestamp: new Date(), cpu: 45, memory: 60 },
        { timestamp: new Date(), cpu: 50, memory: 65 },
      ];

      monitoringService.getMetricsHistory.mockResolvedValue(mockHistory as any);

      const result = await controller.getMetricsHistory(24, mockRequest as any);

      expect(result).toEqual({ success: true, data: mockHistory, message: 'Metrics history retrieved successfully' });
      expect(monitoringService.getMetricsHistory).toHaveBeenCalledWith(24);
    });
  });

  describe('getAlerts', () => {
    it('should return active alerts', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockAlerts = [
        { id: 'alert-1', severity: 'high', message: 'High CPU usage' },
        { id: 'alert-2', severity: 'medium', message: 'Memory threshold exceeded' },
      ];

      monitoringService.getActiveAlerts.mockResolvedValue(mockAlerts as any);

      const result = await controller.getAlerts(mockRequest as any);

      expect(result).toEqual({ success: true, data: mockAlerts, message: 'Active alerts retrieved successfully' });
      expect(monitoringService.getActiveAlerts).toHaveBeenCalled();
    });
  });

  describe('resolveAlert', () => {
    it('should resolve an alert and thread currentOrganizationId into the service', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-a' } };

      monitoringService.resolveAlert.mockResolvedValue(true);

      const result = await controller.resolveAlert('alert-1', mockRequest as any);

      expect(result).toEqual({
        success: true,
        data: null,
        message: 'Alert resolved successfully',
      });
      // Controller must pass the caller's current org so the service
      // can refuse cross-tenant resolves.
      expect(monitoringService.resolveAlert).toHaveBeenCalledWith('alert-1', 'user-1', 'org-a');
    });

    it('should pass null org for callers with no current org (system users)', async () => {
      const mockRequest = { user: { id: 'user-1' } };

      monitoringService.resolveAlert.mockResolvedValue(true);

      await controller.resolveAlert('alert-1', mockRequest as any);

      expect(monitoringService.resolveAlert).toHaveBeenCalledWith('alert-1', 'user-1', null);
    });

    it('should throw error if alert not found', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-a' } };

      monitoringService.resolveAlert.mockResolvedValue(false);

      await expect(controller.resolveAlert('alert-1', mockRequest as any))
        .rejects
        .toThrow('Alert not found');
    });
  });

  describe('getPrometheusMetrics', () => {
    it('should return Prometheus formatted metrics', async () => {
      const mockMetrics = '# HELP requests_total Total requests\nrequests_total 1000\n';

      monitoringService.getPrometheusMetrics.mockResolvedValue(mockMetrics);

      const result = await controller.getPrometheusMetrics();

      expect(result).toBe(mockMetrics);
      expect(monitoringService.getPrometheusMetrics).toHaveBeenCalled();
    });
  });

  describe('getLiveStats', () => {
    it('should return live statistics', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockMetrics = {
        timestamp: new Date(),
        application: {
          requests: { total: 1000 },
          tools: { active: 5 },
        },
        protocols: { mcp: { sessions: 3 } },
        performance: { avgResponseTime: 150 },
        security: { piiFiltered: 10, threatsBlocked: 2 },
      };
      const mockAlerts = [
        { id: 'alert-1', severity: 'critical' },
        { id: 'alert-2', severity: 'warning' },
      ];

      monitoringService.getLatestMetrics.mockResolvedValue(mockMetrics as any);
      monitoringService.getActiveAlerts.mockResolvedValue(mockAlerts as any);

      const result = await controller.getLiveStats(mockRequest as any);

      expect(result).toEqual({
        success: true,
        data: {
          timestamp: expect.any(String),
          summary: {
            totalRequests: 1000,
            activeTools: 5,
            activeSessions: 3,
            activeAlerts: 2,
          },
          protocols: mockMetrics.protocols,
          performance: mockMetrics.performance,
          security: mockMetrics.security,
        },
        message: 'Live stats retrieved successfully',
      });
    });
  });

  describe('getEnterpriseDashboard', () => {
    it('should return enterprise dashboard data', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockMetrics = {
        timestamp: new Date(),
        application: {
          apis: { total: 10, active: 8 },
          tools: { total: 50, active: 45 },
        },
        protocols: { mcp: { sessions: 5 }, utcp: { sessions: 3 } },
        system: { uptime: 86400 },
        security: { piiFiltered: 100, threatsBlocked: 5 },
        performance: { averageResponseTime: 250 },
      };
      const mockAlerts = [
        { id: 'alert-1', severity: 'critical' },
        { id: 'alert-2', severity: 'warning' },
        { id: 'alert-3', severity: 'warning' },
      ];

      monitoringService.getLatestMetrics.mockResolvedValue(mockMetrics as any);
      monitoringService.getActiveAlerts.mockResolvedValue(mockAlerts as any);

      const result = await controller.getEnterpriseDashboard(mockRequest as any);

      expect(result).toEqual({
        success: true,
        data: {
          organization: {
            id: 'org-1',
            metrics: {
              apis: mockMetrics.application.apis,
              tools: mockMetrics.application.tools,
              protocols: mockMetrics.protocols,
            },
          },
          compliance: {
            piiFiltering: {
              enabled: true,
              instancesFiltered: 100,
            },
            securityScanning: {
              enabled: true,
              threatsBlocked: 5,
            },
            auditLogging: {
              enabled: true,
              retentionDays: 90,
            },
          },
          alerts: {
            total: 3,
            critical: 1,
            warning: 2,
          },
          sla: expect.any(Object),
        },
        message: 'Enterprise dashboard retrieved successfully',
      });
    });

    it('should handle null metrics with default values', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };

      monitoringService.getLatestMetrics.mockResolvedValue(null);
      monitoringService.getActiveAlerts.mockResolvedValue([]);

      const result = await controller.getEnterpriseDashboard(mockRequest as any);

      expect(result.success).toBe(true);
      expect(result.data.organization.metrics.apis).toEqual({});
      expect(result.data.organization.metrics.tools).toEqual({});
      expect(result.data.compliance.piiFiltering.instancesFiltered).toBe(0);
      expect(result.data.compliance.securityScanning.threatsBlocked).toBe(0);
      expect(result.data.sla.uptime).toBe(0);
      expect(result.data.sla.currentResponseTime).toBe(0);
    });

    it('should handle partial metrics data', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockMetrics = {
        timestamp: new Date(),
        application: {
          apis: {},
          tools: {},
        },
        protocols: {},
        system: {},
        security: {},
        performance: {},
      };

      monitoringService.getLatestMetrics.mockResolvedValue(mockMetrics as any);
      monitoringService.getActiveAlerts.mockResolvedValue([]);

      const result = await controller.getEnterpriseDashboard(mockRequest as any);

      expect(result).toBeDefined();
      expect(result.data.compliance.piiFiltering.instancesFiltered).toBe(0);
      expect(result.data.compliance.securityScanning.threatsBlocked).toBe(0);
    });
  });

  describe('getLiveStats - edge cases', () => {
    it('should handle null metrics with default values', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };

      monitoringService.getLatestMetrics.mockResolvedValue(null);
      monitoringService.getActiveAlerts.mockResolvedValue([]);

      const result = await controller.getLiveStats(mockRequest as any);

      expect(result.success).toBe(true);
      expect(result.data.summary.totalRequests).toBe(0);
      expect(result.data.summary.activeTools).toBe(0);
      expect(result.data.summary.activeSessions).toBe(0);
      expect(result.data.summary.activeAlerts).toBe(0);
    });

    it('should handle partial metrics data', async () => {
      const mockRequest = { user: { currentOrganizationId: 'org-1' } };
      const mockMetrics = {
        timestamp: new Date(),
        application: {
          requests: {},
          tools: {},
        },
        protocols: {
          mcp: {},
        },
      };

      monitoringService.getLatestMetrics.mockResolvedValue(mockMetrics as any);
      monitoringService.getActiveAlerts.mockResolvedValue([]);

      const result = await controller.getLiveStats(mockRequest as any);

      expect(result).toBeDefined();
      expect(result.data.summary.totalRequests).toBe(0);
      expect(result.data.summary.activeTools).toBe(0);
    });

    it('should handle missing user context', async () => {
      const mockRequest = { user: {} };

      monitoringService.getLatestMetrics.mockResolvedValue(null);
      monitoringService.getActiveAlerts.mockResolvedValue([]);

      const result = await controller.getLiveStats(mockRequest as any);

      expect(result).toBeDefined();
      expect(monitoringService.getActiveAlerts).toHaveBeenCalledWith(undefined);
    });
  });

  describe('getAlerts - edge cases', () => {
    it('should handle missing organization context', async () => {
      const mockRequest = { user: {} };

      monitoringService.getActiveAlerts.mockResolvedValue([]);

      const result = await controller.getAlerts(mockRequest as any);

      expect(result).toEqual({ success: true, data: [], message: 'Active alerts retrieved successfully' });
      expect(monitoringService.getActiveAlerts).toHaveBeenCalledWith(undefined);
    });
  });
});