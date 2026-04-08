import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

import { UsageMetric } from '../../entities/usage-metric.entity';
import { Tool, ToolStatus } from '../../entities/tool.entity';
import { Api, ApiStatus } from '../../entities/api.entity';
import { Organization } from '../../entities/organization.entity';

export interface SystemMetrics {
  timestamp: string;
  system: {
    uptime: number;
    memoryUsage: NodeJS.MemoryUsage;
    cpuUsage: NodeJS.CpuUsage;
    loadAverage: number[];
  };
  application: {
    activeConnections: {
      mcp: number;
      utcp: number;
      a2a: number;
      http: number;
      sse: number;
      websocket: number;
    };
    requests: {
      total: number;
      successful: number;
      failed: number;
      rate: number; // per second
    };
    tools: {
      total: number;
      active: number;
      executions: number;
      averageExecutionTime: number;
    };
    apis: {
      total: number;
      active: number;
      healthy: number;
      unhealthy: number;
    };
  };
  protocols: {
    mcp: {
      sessions: number;
      toolCalls: number;
      responseTime: number;
      errorRate: number;
    };
    utcp: {
      manuals: number;
      directCalls: number;
      proxyExecutions: number;
    };
    a2a: {
      activeAgents: number;
      messages: number;
      workflows: number;
    };
  };
  security: {
    threatsBlocked: number;
    piiFiltered: number;
    rateLimitsApplied: number;
    authFailures: number;
  };
  performance: {
    averageResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    cacheHitRate: number;
    errorRate: number;
  };
}

interface AlertRule {
  id: string;
  name: string;
  description: string;
  metric: string; // JSONPath to metric
  condition: 'gt' | 'lt' | 'eq' | 'contains';
  threshold: any;
  severity: 'info' | 'warning' | 'error' | 'critical';
  organizationId?: string;
  isActive: boolean;
  cooldownMinutes: number; // Prevent alert spam
  lastTriggered?: string;
}

export interface Alert {
  id: string;
  ruleId: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  message: string;
  data: any;
  organizationId?: string;
  isResolved: boolean;
  triggeredAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

@Injectable()
export class MonitoringService extends EventEmitter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitoringService.name);
  private readonly alertRules = new Map<string, AlertRule>();
  private readonly activeAlerts = new Map<string, Alert>();
  private metricsInterval?: NodeJS.Timeout;
  private alertsInterval?: NodeJS.Timeout;

  constructor(
    @InjectRepository(UsageMetric)
    private usageMetricRepository: Repository<UsageMetric>,
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(Api)
    private apiRepository: Repository<Api>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRedis() private readonly redis: Redis.Redis,
  ) {
    super();
  }

  async onModuleInit() {
    await this.initialize();
  }

  async onModuleDestroy() {
    await this.shutdown();
  }

  // Service Initialization
  async initialize(): Promise<void> {
    this.logger.log('Initializing Monitoring Service');

    // Load alert rules from Redis
    await this.loadAlertRules();

    // Setup default alert rules
    await this.setupDefaultAlertRules();

    // Start metrics collection
    this.startMetricsCollection();

    // Start alert evaluation
    this.startAlertEvaluation();

    this.logger.log('Monitoring Service initialized');
  }

  // Metrics Collection
  private startMetricsCollection(): void {
    this.metricsInterval = setInterval(async () => {
      try {
        const metrics = await this.collectSystemMetrics();
        await this.storeMetrics(metrics);
        this.emit('metricsCollected', metrics);
      } catch (error) {
        this.logger.error(`Failed to collect metrics: ${error.message}`);
      }
    }, 15000); // Every 15 seconds
    // .unref() so the metrics poll doesn't keep the event loop
    // alive during graceful shutdown or in test runs.
    this.metricsInterval.unref?.();
  }

  private async collectSystemMetrics(): Promise<SystemMetrics> {
    // System metrics
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const loadAverage = process.platform === 'linux' ? require('os').loadavg() : [0, 0, 0];

    // Application metrics from database
    const [totalTools, activeTools] = await Promise.all([
      this.toolRepository.count(),
      this.toolRepository.count({ where: { status: ToolStatus.ACTIVE } }),
    ]);

    const [totalApis, activeApis] = await Promise.all([
      this.apiRepository.count(),
      this.apiRepository.count({ where: { status: ApiStatus.ACTIVE } }),
    ]);

    const totalOrganizations = await this.organizationRepository.count({ where: { isActive: true } });

    // Get metrics from Redis
    const requestStats = await this.getRequestStats();
    const protocolStats = await this.getProtocolStats();
    const securityStats = await this.getSecurityStats();
    const performanceStats = await this.getPerformanceStats();

    const metrics: SystemMetrics = {
      timestamp: new Date().toISOString(),
      system: {
        uptime: process.uptime(),
        memoryUsage,
        cpuUsage,
        loadAverage,
      },
      application: {
        activeConnections: {
          mcp: 0, // Would get from MCP service
          utcp: 0, // Would get from UTCP service
          a2a: 0, // Would get from A2A service
          http: 0,
          sse: 0,
          websocket: 0,
        },
        requests: requestStats,
        tools: {
          total: totalTools,
          active: activeTools,
          executions: requestStats.total,
          averageExecutionTime: performanceStats.averageResponseTime,
        },
        apis: {
          total: totalApis,
          active: activeApis,
          healthy: activeApis, // Simplified
          unhealthy: totalApis - activeApis,
        },
      },
      protocols: protocolStats,
      security: securityStats,
      performance: performanceStats,
    };

    return metrics;
  }

  private async getRequestStats(): Promise<any> {
    try {
      const stats = await this.redis.get('stats:requests');
      return stats ? JSON.parse(stats) : {
        total: 0,
        successful: 0,
        failed: 0,
        rate: 0,
      };
    } catch (error) {
      return { total: 0, successful: 0, failed: 0, rate: 0 };
    }
  }

  private async getProtocolStats(): Promise<any> {
    try {
      const stats = await this.redis.get('stats:protocols');
      return stats ? JSON.parse(stats) : {
        mcp: { sessions: 0, toolCalls: 0, responseTime: 0, errorRate: 0 },
        utcp: { manuals: 0, directCalls: 0, proxyExecutions: 0 },
        a2a: { activeAgents: 0, messages: 0, workflows: 0 },
      };
    } catch (error) {
      return {
        mcp: { sessions: 0, toolCalls: 0, responseTime: 0, errorRate: 0 },
        utcp: { manuals: 0, directCalls: 0, proxyExecutions: 0 },
        a2a: { activeAgents: 0, messages: 0, workflows: 0 },
      };
    }
  }

  private async getSecurityStats(): Promise<any> {
    try {
      const stats = await this.redis.get('stats:security');
      return stats ? JSON.parse(stats) : {
        threatsBlocked: 0,
        piiFiltered: 0,
        rateLimitsApplied: 0,
        authFailures: 0,
      };
    } catch (error) {
      return {
        threatsBlocked: 0,
        piiFiltered: 0,
        rateLimitsApplied: 0,
        authFailures: 0,
      };
    }
  }

  private async getPerformanceStats(): Promise<any> {
    try {
      const stats = await this.redis.get('stats:performance');
      return stats ? JSON.parse(stats) : {
        averageResponseTime: 0,
        p95ResponseTime: 0,
        p99ResponseTime: 0,
        cacheHitRate: 0,
        errorRate: 0,
      };
    } catch (error) {
      return {
        averageResponseTime: 0,
        p95ResponseTime: 0,
        p99ResponseTime: 0,
        cacheHitRate: 0,
        errorRate: 0,
      };
    }
  }

  private async storeMetrics(metrics: SystemMetrics): Promise<void> {
    // Store in Redis with TTL
    await this.redis.setex('metrics:latest', 300, JSON.stringify(metrics)); // 5 minutes

    // Store historical data
    await this.redis.lpush('metrics:history', JSON.stringify(metrics));
    await this.redis.ltrim('metrics:history', 0, 1440); // Keep 24 hours (every 15 seconds)
  }

  // Alert System
  private startAlertEvaluation(): void {
    this.alertsInterval = setInterval(async () => {
      try {
        await this.evaluateAlerts();
      } catch (error) {
        this.logger.error(`Failed to evaluate alerts: ${error.message}`);
      }
    }, 30000); // Every 30 seconds
    this.alertsInterval.unref?.();
  }

  private async evaluateAlerts(): Promise<void> {
    const metrics = await this.getLatestMetrics();
    if (!metrics) {
      return;
    }

    for (const rule of this.alertRules.values()) {
      if (!rule.isActive) {
        continue;
      }

      // Check cooldown
      if (rule.lastTriggered) {
        const lastTriggeredTime = new Date(rule.lastTriggered).getTime();
        const cooldownMs = rule.cooldownMinutes * 60 * 1000;
        if (Date.now() - lastTriggeredTime < cooldownMs) {
          continue;
        }
      }

      // Evaluate condition
      const shouldAlert = await this.evaluateAlertCondition(rule, metrics);
      if (shouldAlert) {
        await this.triggerAlert(rule, metrics);
      }
    }
  }

  private async evaluateAlertCondition(rule: AlertRule, metrics: SystemMetrics): Promise<boolean> {
    try {
      // Extract metric value using JSONPath-like syntax (simplified)
      const value = this.extractMetricValue(metrics, rule.metric);
      
      switch (rule.condition) {
        case 'gt':
          return value > rule.threshold;
        case 'lt':
          return value < rule.threshold;
        case 'eq':
          return value === rule.threshold;
        case 'contains':
          return String(value).includes(String(rule.threshold));
        default:
          return false;
      }
    } catch (error) {
      this.logger.error(`Failed to evaluate alert condition: ${error.message}`);
      return false;
    }
  }

  private extractMetricValue(metrics: SystemMetrics, path: string): any {
    // Simple JSONPath extraction
    const parts = path.split('.');
    let value: any = metrics;
    
    for (const part of parts) {
      if (value && typeof value === 'object') {
        value = value[part];
      } else {
        return undefined;
      }
    }
    
    return value;
  }

  private async triggerAlert(rule: AlertRule, metrics: SystemMetrics): Promise<void> {
    // Unguessable alert id. The previous shape was
    // `alert_${Date.now()}_${Math.random()...}` — enumerable because
    // the timestamp prefix is predictable and the random suffix is
    // non-cryptographic. alertId is exposed via
    // POST /monitoring/alerts/:alertId/resolve (see controller) so a
    // weak id directly feeds cross-tenant resolve attacks.
    const alertId = `alert_${crypto.randomBytes(16).toString('hex')}`;
    
    const alert: Alert = {
      id: alertId,
      ruleId: rule.id,
      severity: rule.severity,
      title: rule.name,
      message: `${rule.description} - Current value: ${this.extractMetricValue(metrics, rule.metric)}`,
      data: {
        rule,
        metrics,
        triggeredValue: this.extractMetricValue(metrics, rule.metric),
      },
      organizationId: rule.organizationId,
      isResolved: false,
      triggeredAt: new Date().toISOString(),
    };

    this.activeAlerts.set(alertId, alert);
    
    // Update rule last triggered
    rule.lastTriggered = new Date().toISOString();
    this.alertRules.set(rule.id, rule);

    // Store alert in Redis
    await this.redis.setex(`alert:${alertId}`, 86400, JSON.stringify(alert));

    // Emit alert event
    this.emit('alert', alert);

    this.logger.warn(`Alert triggered: ${rule.name} (${rule.severity})`);
  }

  // Setup Default Alert Rules
  private async setupDefaultAlertRules(): Promise<void> {
    const defaultRules: Omit<AlertRule, 'id'>[] = [
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
        isActive: false, // Disabled by default
        cooldownMinutes: 60,
      },
    ];

    for (const ruleData of defaultRules) {
      const ruleId = `rule_${crypto.randomBytes(16).toString('hex')}`;
      const rule: AlertRule = { ...ruleData, id: ruleId };
      this.alertRules.set(ruleId, rule);
    }

    this.logger.log(`Setup ${defaultRules.length} default alert rules`);
  }

  private async loadAlertRules(): Promise<void> {
    try {
      const ruleKeys = await this.redis.keys('alert:rule:*');
      for (const key of ruleKeys) {
        const ruleData = await this.redis.get(key);
        if (ruleData) {
          const rule: AlertRule = JSON.parse(ruleData);
          this.alertRules.set(rule.id, rule);
        }
      }
      this.logger.log(`Loaded ${this.alertRules.size} alert rules from Redis`);
    } catch (error) {
      this.logger.error(`Failed to load alert rules: ${error.message}`);
    }
  }

  // Public API
  async getLatestMetrics(): Promise<SystemMetrics | null> {
    try {
      const data = await this.redis.get('metrics:latest');
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.error(`Failed to get latest metrics: ${error.message}`);
      return null;
    }
  }

  async getMetricsHistory(hours: number = 1): Promise<SystemMetrics[]> {
    try {
      const count = Math.floor((hours * 60 * 60) / 15); // 15-second intervals
      const data = await this.redis.lrange('metrics:history', 0, count - 1);
      return data.map(item => JSON.parse(item));
    } catch (error) {
      this.logger.error(`Failed to get metrics history: ${error.message}`);
      return [];
    }
  }

  async getActiveAlerts(organizationId?: string): Promise<Alert[]> {
    const alerts = Array.from(this.activeAlerts.values())
      .filter(alert => !alert.isResolved);
    
    if (organizationId) {
      return alerts.filter(alert => 
        alert.organizationId === organizationId || !alert.organizationId
      );
    }

    return alerts;
  }

  async resolveAlert(
    alertId: string,
    resolvedBy: string,
    /**
     * The caller's current organization id. REQUIRED whenever the
     * alert being resolved is scoped to a specific org — every
     * tenant-scoped alert must only be resolvable from within that
     * tenant. Pass `null` only from system/internal callers that
     * operate on platform-global alerts (alerts with no
     * organizationId set, e.g. system health rules).
     */
    callerOrganizationId: string | null,
  ): Promise<boolean> {
    const alert = this.activeAlerts.get(alertId);
    if (!alert) {
      return false;
    }

    // Cross-tenant guard: if the alert belongs to an org, the caller
    // must be acting in that same org. Previously this check didn't
    // exist and resolveAlert took only (alertId, resolvedBy), so any
    // authenticated user — combined with a guessable/leaked alertId
    // (which we also just hardened) — could mark any other org's
    // alerts as resolved. Respond with "not found" instead of
    // Forbidden to avoid turning this into a cross-tenant existence
    // oracle.
    if (alert.organizationId && alert.organizationId !== callerOrganizationId) {
      return false;
    }

    alert.isResolved = true;
    alert.resolvedAt = new Date().toISOString();
    alert.resolvedBy = resolvedBy;

    // Update in Redis
    await this.redis.setex(`alert:${alertId}`, 86400, JSON.stringify(alert));

    this.logger.log(`Alert resolved: ${alertId} by ${resolvedBy}`);
    return true;
  }

  // Health Checks
  async getSystemHealth(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    components: Record<string, {
      status: 'healthy' | 'degraded' | 'unhealthy';
      message?: string;
      responseTime?: number;
    }>;
    uptime: number;
    version: string;
  }> {
    const metrics = await this.getLatestMetrics();
    const alerts = await this.getActiveAlerts();
    
    const criticalAlerts = alerts.filter(a => a.severity === 'critical');
    const errorAlerts = alerts.filter(a => a.severity === 'error');

    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    if (criticalAlerts.length > 0) {
      overallStatus = 'unhealthy';
    } else if (errorAlerts.length > 0) {
      overallStatus = 'degraded';
    }

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

  // Prometheus Metrics Export
  async getPrometheusMetrics(): Promise<string> {
    const metrics = await this.getLatestMetrics();
    if (!metrics) {
      return '';
    }

    const prometheusMetrics = [
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

    return prometheusMetrics.join('\n') + '\n';
  }

  // Cleanup
  async shutdown(): Promise<void> {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    
    if (this.alertsInterval) {
      clearInterval(this.alertsInterval);
    }

    this.logger.log('Monitoring Service shutdown complete');
  }
}