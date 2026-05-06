import type { SystemMetrics, Alert } from './monitoring.service';

/**
 * Format the latest metrics snapshot as a Prometheus exposition string.
 * Returns empty string if no metrics are available.
 */
export function formatPrometheusMetrics(metrics: SystemMetrics | null): string {
  if (!metrics) return '';

  const lines = [
    `# HELP almyty_uptime_seconds Total uptime in seconds`,
    `# TYPE almyty_uptime_seconds counter`,
    `almyty_uptime_seconds ${metrics.system.uptime}`,
    ``,
    `# HELP almyty_memory_usage_bytes Memory usage in bytes`,
    `# TYPE almyty_memory_usage_bytes gauge`,
    `almyty_memory_usage_bytes{type="heap"} ${metrics.system.memoryUsage.heapUsed}`,
    `almyty_memory_usage_bytes{type="heap_total"} ${metrics.system.memoryUsage.heapTotal}`,
    ``,
    `# HELP almyty_tools_total Total number of tools`,
    `# TYPE almyty_tools_total gauge`,
    `almyty_tools_total ${metrics.application.tools.total}`,
    ``,
    `# HELP almyty_tools_active Active tools`,
    `# TYPE almyty_tools_active gauge`,
    `almyty_tools_active ${metrics.application.tools.active}`,
    ``,
    `# HELP almyty_requests_total Total requests processed`,
    `# TYPE almyty_requests_total counter`,
    `almyty_requests_total{status="success"} ${metrics.application.requests.successful}`,
    `almyty_requests_total{status="error"} ${metrics.application.requests.failed}`,
    ``,
    `# HELP almyty_response_time_ms Average response time in milliseconds`,
    `# TYPE almyty_response_time_ms gauge`,
    `almyty_response_time_ms ${metrics.performance.averageResponseTime}`,
    ``,
    `# HELP almyty_mcp_sessions Active MCP sessions`,
    `# TYPE almyty_mcp_sessions gauge`,
    `almyty_mcp_sessions ${metrics.protocols.mcp.sessions}`,
    ``,
    `# HELP almyty_a2a_agents Active A2A agents`,
    `# TYPE almyty_a2a_agents gauge`,
    `almyty_a2a_agents ${metrics.protocols.a2a.activeAgents}`,
  ];

  return lines.join('\n') + '\n';
}

/**
 * Compute system health rollup from metrics + active alerts.
 */
export function computeSystemHealth(_metrics: SystemMetrics | null, alerts: Alert[]) {
  const criticalAlerts = alerts.filter(a => a.severity === 'critical');
  const errorAlerts = alerts.filter(a => a.severity === 'error');

  let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (criticalAlerts.length > 0) overallStatus = 'unhealthy';
  else if (errorAlerts.length > 0) overallStatus = 'degraded';

  const components = {
    database: { status: 'healthy' as const },
    redis: { status: 'healthy' as const },
    mcp: { status: 'healthy' as const },
    utcp: { status: 'healthy' as const },
    a2a: { status: 'healthy' as const },
    plugins: { status: 'healthy' as const },
  };

  return {
    status: overallStatus,
    components,
    uptime: process.uptime(),
    version: '1.0.0',
  };
}
