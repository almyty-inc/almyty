export interface DefaultAlertRule {
  name: string;
  description: string;
  metric: string;
  condition: 'gt' | 'lt' | 'eq' | 'contains';
  threshold: any;
  severity: 'info' | 'warning' | 'error' | 'critical';
  isActive: boolean;
  cooldownMinutes: number;
}

/**
 * Out-of-the-box alert rules seeded into the alert registry on
 * startup. Pulled into its own file so the monitoring service stays
 * focused on the runtime loop.
 */
export const DEFAULT_ALERT_RULES: DefaultAlertRule[] = [
  {
    name: 'High Error Rate',
    description: 'Error rate exceeds 5%',
    metric: 'performance.errorRate',
    condition: 'gt',
    threshold: 0.05,
    severity: 'error',
    isActive: true,
    cooldownMinutes: 10,
  },
  {
    name: 'Slow Response Time',
    description: 'Average response time exceeds 10 seconds',
    metric: 'performance.averageResponseTime',
    condition: 'gt',
    threshold: 10000,
    severity: 'warning',
    isActive: true,
    cooldownMinutes: 5,
  },
  {
    name: 'High Memory Usage',
    description: 'Memory usage exceeds 1GB',
    metric: 'system.memoryUsage.heapUsed',
    condition: 'gt',
    threshold: 1024 * 1024 * 1024,
    severity: 'warning',
    isActive: true,
    cooldownMinutes: 15,
  },
  {
    name: 'Security Threats Detected',
    description: 'Security threats blocked in last hour',
    metric: 'security.threatsBlocked',
    condition: 'gt',
    threshold: 10,
    severity: 'critical',
    isActive: true,
    cooldownMinutes: 30,
  },
  {
    name: 'No Active Sessions',
    description: 'No active MCP sessions',
    metric: 'protocols.mcp.sessions',
    condition: 'eq',
    threshold: 0,
    severity: 'info',
    isActive: false,
    cooldownMinutes: 60,
  },
];
