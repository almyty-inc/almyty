import { Injectable } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';

/**
 * Redis-backed statistics getters with safe defaults. Each getter
 * reads a single key (`stats:requests`, `stats:protocols`, etc.) and
 * falls back to a zero-valued shape on any miss / Redis error so
 * the monitoring loop never crashes on a transient connection blip.
 */
@Injectable()
export class MonitoringRedisStatsHelper {
  constructor(@InjectRedis() private readonly redis: Redis.Redis) {}

  async getRequestStats(): Promise<any> {
    try {
      const stats = await this.redis.get('stats:requests');
      return stats ? JSON.parse(stats) : { total: 0, successful: 0, failed: 0, rate: 0 };
    } catch {
      return { total: 0, successful: 0, failed: 0, rate: 0 };
    }
  }

  async getProtocolStats(): Promise<any> {
    try {
      const stats = await this.redis.get('stats:protocols');
      return stats
        ? JSON.parse(stats)
        : {
            mcp: { sessions: 0, toolCalls: 0, responseTime: 0, errorRate: 0 },
            utcp: { manuals: 0, directCalls: 0, proxyExecutions: 0 },
            a2a: { activeAgents: 0, messages: 0, workflows: 0 },
          };
    } catch {
      return {
        mcp: { sessions: 0, toolCalls: 0, responseTime: 0, errorRate: 0 },
        utcp: { manuals: 0, directCalls: 0, proxyExecutions: 0 },
        a2a: { activeAgents: 0, messages: 0, workflows: 0 },
      };
    }
  }

  async getSecurityStats(): Promise<any> {
    try {
      const stats = await this.redis.get('stats:security');
      return stats
        ? JSON.parse(stats)
        : { threatsBlocked: 0, piiFiltered: 0, rateLimitsApplied: 0, authFailures: 0 };
    } catch {
      return { threatsBlocked: 0, piiFiltered: 0, rateLimitsApplied: 0, authFailures: 0 };
    }
  }

  async getPerformanceStats(): Promise<any> {
    try {
      const stats = await this.redis.get('stats:performance');
      return stats
        ? JSON.parse(stats)
        : {
            averageResponseTime: 0,
            p95ResponseTime: 0,
            p99ResponseTime: 0,
            cacheHitRate: 0,
            errorRate: 0,
          };
    } catch {
      return {
        averageResponseTime: 0,
        p95ResponseTime: 0,
        p99ResponseTime: 0,
        cacheHitRate: 0,
        errorRate: 0,
      };
    }
  }
}
