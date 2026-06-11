import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsageMetric } from '../../entities/usage-metric.entity';

/**
 * Statistics getters backing the live monitoring loop.
 *
 * These used to read `stats:*` Redis keys that nothing ever wrote, so every
 * request / latency / security figure was permanently zero. They now
 * aggregate the `usage_metrics` table (written by RequestLoggingInterceptor)
 * over a short rolling window so the dashboard reflects real traffic.
 *
 * Every getter is defensive: it parses with `Number(x) || 0` and falls back
 * to a zero-valued shape on any query error, so a transient DB blip degrades
 * to "no data" rather than crashing the metrics collector.
 *
 * (Name kept as `RedisStats` to avoid churn across the module wiring; the
 * source of truth is Postgres, not Redis.)
 */
@Injectable()
export class MonitoringRedisStatsHelper {
  private readonly logger = new Logger(MonitoringRedisStatsHelper.name);

  /**
   * Rolling window (seconds) over which "current" stats are computed.
   * Configurable via MONITORING_STATS_WINDOW_SECONDS; defaults to 5 minutes.
   */
  private readonly windowSeconds: number;

  constructor(
    @InjectRepository(UsageMetric)
    private readonly usageMetricRepository: Repository<UsageMetric>,
  ) {
    const raw = Number(process.env.MONITORING_STATS_WINDOW_SECONDS);
    this.windowSeconds = Number.isFinite(raw) && raw > 0 ? raw : 300;
  }

  private windowStart(): Date {
    return new Date(Date.now() - this.windowSeconds * 1000);
  }

  private num(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  async getRequestStats(): Promise<{
    total: number;
    successful: number;
    failed: number;
    rate: number;
  }> {
    const zero = { total: 0, successful: 0, failed: 0, rate: 0 };
    try {
      const rows = await this.usageMetricRepository.query(
        `SELECT
           COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE status = 'success')::bigint AS successful
         FROM usage_metrics
         WHERE type = 'request_count' AND timestamp >= $1`,
        [this.windowStart()],
      );
      const row = Array.isArray(rows) ? rows[0] : undefined;
      const total = this.num(row?.total);
      const successful = this.num(row?.successful);
      return {
        total,
        successful,
        failed: Math.max(0, total - successful),
        rate: total / this.windowSeconds,
      };
    } catch (err: any) {
      this.logger.warn(`getRequestStats failed: ${err?.message}`);
      return zero;
    }
  }

  async getProtocolStats(): Promise<any> {
    const zero = {
      mcp: { sessions: 0, toolCalls: 0, responseTime: 0, errorRate: 0 },
      utcp: { manuals: 0, directCalls: 0, proxyExecutions: 0 },
      a2a: { activeAgents: 0, messages: 0, workflows: 0 },
    };
    try {
      const since = this.windowStart();
      // Semantic counters emitted by the protocol controllers, plus mcp
      // latency/error rate from request_logs (the only place per-protocol
      // response time and status live). proxyExecutions has no distinct
      // source in this codebase, so it stays an honest 0.
      const [counters, mcpReq] = await Promise.all([
        this.usageMetricRepository.query(
          `SELECT
             COUNT(*) FILTER (WHERE type = 'mcp_session')      AS mcp_sessions,
             COUNT(*) FILTER (WHERE type = 'mcp_tool_call')    AS mcp_tool_calls,
             COUNT(*) FILTER (WHERE type = 'utcp_manual')      AS utcp_manuals,
             COUNT(*) FILTER (WHERE type = 'utcp_direct_call') AS utcp_direct_calls,
             COUNT(*) FILTER (WHERE type = 'a2a_message')      AS a2a_messages,
             COUNT(*) FILTER (WHERE type = 'a2a_workflow')     AS a2a_workflows,
             COUNT(DISTINCT (dimensions->>'agentId'))
               FILTER (WHERE type IN ('a2a_message', 'a2a_workflow')) AS a2a_active_agents
           FROM usage_metrics
           WHERE timestamp >= $1
             AND type IN ('mcp_session','mcp_tool_call','utcp_manual',
                          'utcp_direct_call','a2a_message','a2a_workflow')`,
          [since],
        ),
        this.usageMetricRepository.query(
          `SELECT
             AVG("responseTime") AS avg_rt,
             COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE "statusCode" >= 400)::bigint AS errors
           FROM request_logs
           WHERE timestamp >= $1 AND metadata->>'protocol' = 'mcp'`,
          [since],
        ),
      ]);
      const c = Array.isArray(counters) ? counters[0] : undefined;
      const m = Array.isArray(mcpReq) ? mcpReq[0] : undefined;
      const mcpTotal = this.num(m?.total);
      return {
        mcp: {
          sessions: this.num(c?.mcp_sessions),
          toolCalls: this.num(c?.mcp_tool_calls),
          responseTime: this.num(m?.avg_rt),
          errorRate: mcpTotal > 0 ? this.num(m?.errors) / mcpTotal : 0,
        },
        utcp: {
          manuals: this.num(c?.utcp_manuals),
          directCalls: this.num(c?.utcp_direct_calls),
          proxyExecutions: 0,
        },
        a2a: {
          activeAgents: this.num(c?.a2a_active_agents),
          messages: this.num(c?.a2a_messages),
          workflows: this.num(c?.a2a_workflows),
        },
      };
    } catch (err: any) {
      this.logger.warn(`getProtocolStats failed: ${err?.message}`);
      return zero;
    }
  }

  async getSecurityStats(): Promise<{
    threatsBlocked: number;
    piiFiltered: number;
    rateLimitsApplied: number;
    authFailures: number;
  }> {
    const zero = {
      threatsBlocked: 0,
      piiFiltered: 0,
      rateLimitsApplied: 0,
      authFailures: 0,
    };
    try {
      const rows = await this.usageMetricRepository.query(
        `SELECT
           COUNT(*) FILTER (WHERE type = 'request_count' AND status = 'rate_limited')::bigint AS rate_limited,
           COUNT(*) FILTER (WHERE type = 'request_count' AND status = 'unauthorized')::bigint AS unauthorized,
           COALESCE(SUM(value) FILTER (WHERE type = 'security_threat_blocked'), 0) AS threats,
           COALESCE(SUM(value) FILTER (WHERE type = 'pii_filtered'), 0) AS pii
         FROM usage_metrics
         WHERE timestamp >= $1
           AND type IN ('request_count', 'security_threat_blocked', 'pii_filtered')`,
        [this.windowStart()],
      );
      const row = Array.isArray(rows) ? rows[0] : undefined;
      return {
        // threatsBlocked / piiFiltered are emitted by PluginManager when the
        // security scanner blocks a threat / the PII filter redacts a value.
        threatsBlocked: this.num(row?.threats),
        piiFiltered: this.num(row?.pii),
        rateLimitsApplied: this.num(row?.rate_limited),
        authFailures: this.num(row?.unauthorized),
      };
    } catch (err: any) {
      this.logger.warn(`getSecurityStats failed: ${err?.message}`);
      return zero;
    }
  }

  async getPerformanceStats(): Promise<{
    averageResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    cacheHitRate: number;
    errorRate: number;
  }> {
    const zero = {
      averageResponseTime: 0,
      p95ResponseTime: 0,
      p99ResponseTime: 0,
      cacheHitRate: 0,
      errorRate: 0,
    };
    try {
      const since = this.windowStart();
      const [latencyRows, errorRows] = await Promise.all([
        this.usageMetricRepository.query(
          `SELECT
             AVG(value) AS avg,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY value) AS p99
           FROM usage_metrics
           WHERE type = 'response_time' AND timestamp >= $1`,
          [since],
        ),
        this.usageMetricRepository.query(
          `SELECT
             COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE status <> 'success')::bigint AS errored
           FROM usage_metrics
           WHERE type = 'request_count' AND timestamp >= $1`,
          [since],
        ),
      ]);
      const lat = Array.isArray(latencyRows) ? latencyRows[0] : undefined;
      const err = Array.isArray(errorRows) ? errorRows[0] : undefined;
      const total = this.num(err?.total);
      const errored = this.num(err?.errored);
      return {
        averageResponseTime: this.num(lat?.avg),
        p95ResponseTime: this.num(lat?.p95),
        p99ResponseTime: this.num(lat?.p99),
        // No cache instrumentation yet — leave at 0 rather than guess.
        cacheHitRate: 0,
        errorRate: total > 0 ? errored / total : 0,
      };
    } catch (e: any) {
      this.logger.warn(`getPerformanceStats failed: ${e?.message}`);
      return zero;
    }
  }
}
