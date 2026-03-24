import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Request,
  UseGuards,
  HttpException,
  HttpStatus,
  Logger,
  Header,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MonitoringService, SystemMetrics, Alert } from './monitoring.service';

@Controller('monitoring')
export class MonitoringController {
  private readonly logger = new Logger(MonitoringController.name);

  constructor(private readonly monitoringService: MonitoringService) {}

  // System Health
  @Get('/health')
  async getHealth() {
    return this.monitoringService.getSystemHealth();
  }

  // Latest Metrics
  @Get('/metrics')
  @UseGuards(JwtAuthGuard)
  async getMetrics(@Request() req) {
    const data = await this.monitoringService.getLatestMetrics();
    return { success: true, data, message: 'Latest metrics retrieved successfully' };
  }

  // Historical Metrics
  @Get('/metrics/history')
  @UseGuards(JwtAuthGuard)
  async getMetricsHistory(
    @Query('hours') hours: number = 1,
    @Request() req
  ) {
    const data = await this.monitoringService.getMetricsHistory(hours);
    return { success: true, data, message: 'Metrics history retrieved successfully' };
  }

  // Alerts
  @Get('/alerts')
  @UseGuards(JwtAuthGuard)
  async getAlerts(@Request() req) {
    const organizationId = req.user?.currentOrganizationId;
    const data = await this.monitoringService.getActiveAlerts(organizationId);
    return { success: true, data, message: 'Active alerts retrieved successfully' };
  }

  @Post('/alerts/:alertId/resolve')
  @UseGuards(JwtAuthGuard)
  async resolveAlert(@Param('alertId') alertId: string, @Request() req) {
    const success = await this.monitoringService.resolveAlert(alertId, req.user.id);
    
    if (!success) {
      throw new HttpException('Alert not found', HttpStatus.NOT_FOUND);
    }
    
    return { success: true, data: null, message: 'Alert resolved successfully' };
  }

  // Prometheus Metrics Export
  @Get('/metrics/prometheus')
  @Header('Content-Type', 'text/plain')
  async getPrometheusMetrics() {
    return this.monitoringService.getPrometheusMetrics();
  }

  // Real-time Statistics
  @Get('/stats/live')
  @UseGuards(JwtAuthGuard)
  async getLiveStats(@Request() req) {
    const metrics = await this.monitoringService.getLatestMetrics();
    const alerts = await this.monitoringService.getActiveAlerts(req.user?.currentOrganizationId);

    const data = {
      timestamp: new Date().toISOString(),
      summary: {
        totalRequests: metrics?.application.requests.total || 0,
        activeTools: metrics?.application.tools.active || 0,
        activeSessions: metrics?.protocols.mcp.sessions || 0,
        activeAlerts: alerts.length,
      },
      protocols: metrics?.protocols || {},
      performance: metrics?.performance || {},
      security: metrics?.security || {},
    };
    return { success: true, data, message: 'Live stats retrieved successfully' };
  }

  // Enterprise Features Dashboard
  @Get('/enterprise/dashboard')
  @UseGuards(JwtAuthGuard)
  async getEnterpriseDashboard(@Request() req) {
    const organizationId = req.user?.currentOrganizationId;
    const metrics = await this.monitoringService.getLatestMetrics();
    const alerts = await this.monitoringService.getActiveAlerts(organizationId);

    const data = {
      organization: {
        id: organizationId,
        metrics: {
          apis: metrics?.application.apis || {},
          tools: metrics?.application.tools || {},
          protocols: metrics?.protocols || {},
        },
      },
      compliance: {
        piiFiltering: {
          enabled: true,
          instancesFiltered: metrics?.security.piiFiltered || 0,
        },
        securityScanning: {
          enabled: true,
          threatsBlocked: metrics?.security.threatsBlocked || 0,
        },
        auditLogging: {
          enabled: true,
          retentionDays: 90,
        },
      },
      alerts: {
        total: alerts.length,
        critical: alerts.filter(a => a.severity === 'critical').length,
        warning: alerts.filter(a => a.severity === 'warning').length,
      },
      sla: {
        uptime: ((metrics?.system.uptime || 0) / 86400) * 100, // % of 24 hours
        availabilityTarget: 99.9,
        responseTimeTarget: 1000, // ms
        currentResponseTime: metrics?.performance.averageResponseTime || 0,
      },
    };
    return { success: true, data, message: 'Enterprise dashboard retrieved successfully' };
  }
}