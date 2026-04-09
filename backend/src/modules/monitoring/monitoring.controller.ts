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
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { MonitoringService, SystemMetrics, Alert } from './monitoring.service';

/**
 * Gate platform-wide metrics endpoints (`/metrics`, `/metrics/history`,
 * `/metrics/prometheus`) behind a static bearer token loaded from the
 * `PLATFORM_METRICS_TOKEN` env var. These endpoints return GLOBAL
 * platform statistics — total uptime, cross-tenant request counts,
 * memory pressure, system health — which a regular JWT-authenticated
 * tenant user has no business seeing. Prior to this gate, any user
 * with a valid JWT could enumerate the platform's aggregate traffic
 * shape and the Prometheus endpoint was fully public.
 *
 * Usage: set PLATFORM_METRICS_TOKEN=<long random string> in the
 * platform operator's deployment env and configure Prometheus to
 * scrape with `authorization: Bearer <that token>`. If the env var
 * is unset, the endpoints refuse every request — fail closed.
 */
function requirePlatformMetricsToken(authHeader: string | undefined): void {
  const expected = process.env.PLATFORM_METRICS_TOKEN;
  if (!expected) {
    // No token configured → refuse every request. Fail-closed is
    // the only safe default for a global-metrics endpoint: the old
    // behaviour of "no config means public" leaked the endpoint on
    // every unconfigured deployment.
    throw new UnauthorizedException('Platform metrics endpoint is disabled on this instance');
  }
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!bearer) {
    throw new UnauthorizedException('Platform metrics endpoint requires a Bearer token');
  }
  // Constant-time comparison — a timing side channel on a shared
  // static secret is the entire point of the attack surface here.
  const a = Buffer.from(bearer);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    throw new UnauthorizedException('Invalid platform metrics token');
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  if (mismatch !== 0) {
    throw new UnauthorizedException('Invalid platform metrics token');
  }
}

@Controller('monitoring')
export class MonitoringController {
  private readonly logger = new Logger(MonitoringController.name);

  constructor(private readonly monitoringService: MonitoringService) {}

  // Liveness probe — kept public for K8s readiness/liveness checks.
  // Returns only the top-level status ('healthy' / 'degraded' /
  // 'unhealthy') — the component breakdown is admin-only via the
  // detailed endpoint below. A leaked "which component is degraded"
  // line is a useful signal to an attacker that the DB or Redis is
  // under stress.
  @Get('/health')
  async getHealth() {
    const full = await this.monitoringService.getSystemHealth();
    return { status: full.status };
  }

  // Detailed health (admin bearer token required).
  @Get('/health/details')
  async getHealthDetails(@Request() req) {
    requirePlatformMetricsToken(req.headers?.authorization);
    return this.monitoringService.getSystemHealth();
  }

  // Latest Metrics — platform-admin token required (global data).
  @Get('/metrics')
  async getMetrics(@Request() req) {
    requirePlatformMetricsToken(req.headers?.authorization);
    const data = await this.monitoringService.getLatestMetrics();
    return { success: true, data, message: 'Latest metrics retrieved successfully' };
  }

  // Historical Metrics — platform-admin token required (global data).
  @Get('/metrics/history')
  async getMetricsHistory(
    @Query('hours') hours: number = 1,
    @Request() req
  ) {
    requirePlatformMetricsToken(req.headers?.authorization);
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
    // Thread the caller's current org through so the service can
    // refuse cross-tenant resolves. Without it, any authenticated
    // user could POST this endpoint with another org's alertId and
    // silently clear their alerts.
    const callerOrgId = req.user?.currentOrganizationId || null;
    const success = await this.monitoringService.resolveAlert(alertId, req.user.id, callerOrgId);

    if (!success) {
      throw new HttpException('Alert not found', HttpStatus.NOT_FOUND);
    }

    return { success: true, data: null, message: 'Alert resolved successfully' };
  }

  // Prometheus Metrics Export — platform-admin token required.
  // Prior to this gate, this endpoint was fully public and let
  // anyone scrape the platform's aggregate traffic shape, memory
  // pressure, session counts, etc. Prometheus scrapers should
  // authenticate with `authorization: Bearer <PLATFORM_METRICS_TOKEN>`.
  @Get('/metrics/prometheus')
  @Header('Content-Type', 'text/plain')
  async getPrometheusMetrics(@Request() req) {
    requirePlatformMetricsToken(req.headers?.authorization);
    return this.monitoringService.getPrometheusMetrics();
  }

  // Real-time Statistics — only returns org-scoped alert counts.
  // Previously this endpoint dumped the entire `metrics.protocols`,
  // `metrics.performance`, and `metrics.security` global objects
  // alongside the org-scoped alert list, which leaked cross-tenant
  // request totals, tool counts, and PII-filtering stats. The
  // global metrics live behind /metrics + a platform token now;
  // regular tenants only get to see their own alert rollup.
  @Get('/stats/live')
  @UseGuards(JwtAuthGuard)
  async getLiveStats(@Request() req) {
    const organizationId = req.user?.currentOrganizationId;
    const alerts = await this.monitoringService.getActiveAlerts(organizationId);

    const data = {
      timestamp: new Date().toISOString(),
      summary: {
        activeAlerts: alerts.length,
        criticalAlerts: alerts.filter((a) => a.severity === 'critical').length,
        warningAlerts: alerts.filter((a) => a.severity === 'warning').length,
      },
    };
    return { success: true, data, message: 'Live stats retrieved successfully' };
  }

  // Enterprise Features Dashboard — no longer leaks global metric
  // fields. Returns only org-scoped alert rollup + static compliance
  // capability flags. Previously this endpoint mixed global
  // `metrics.application.apis / tools / protocols / security` into
  // a per-tenant dashboard, which exposed cross-tenant counts to
  // every tenant.
  @Get('/enterprise/dashboard')
  @UseGuards(JwtAuthGuard)
  async getEnterpriseDashboard(@Request() req) {
    const organizationId = req.user?.currentOrganizationId;
    const alerts = await this.monitoringService.getActiveAlerts(organizationId);

    const data = {
      organization: {
        id: organizationId,
      },
      compliance: {
        piiFiltering: { enabled: true },
        securityScanning: { enabled: true },
        auditLogging: { enabled: true, retentionDays: 90 },
      },
      alerts: {
        total: alerts.length,
        critical: alerts.filter((a) => a.severity === 'critical').length,
        warning: alerts.filter((a) => a.severity === 'warning').length,
      },
      sla: {
        availabilityTarget: 99.9,
        responseTimeTarget: 1000,
      },
    };
    return { success: true, data, message: 'Enterprise dashboard retrieved successfully' };
  }
}