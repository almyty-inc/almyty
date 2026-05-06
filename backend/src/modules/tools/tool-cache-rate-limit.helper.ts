import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';

import { Tool } from '../../entities/tool.entity';
import { hashCacheObject } from './tool-execution-utils';
import { ToolExecutionOptions, ToolExecutionResult } from './tool-execution.types';

/**
 * Redis-backed cache + rate-limit checks extracted from
 * ToolExecutorService. Both fail open (return null / `{ limited:
 * false }`) on Redis errors so a transient connection blip can't
 * take the executor down.
 */
@Injectable()
export class ToolCacheRateLimitHelper {
  private readonly logger = new Logger(ToolCacheRateLimitHelper.name);

  constructor(@InjectRedis() private readonly redis: Redis.Redis) {}

  async getCachedResult(
    tool: Tool,
    parameters: Record<string, any>,
  ): Promise<ToolExecutionResult | null> {
    try {
      const cacheKey = this.generateCacheKey(tool.id, parameters);
      const cached = await this.redis.get(cacheKey);
      return cached ? JSON.parse(cached) : null;
    } catch (error: any) {
      this.logger.warn(`Cache retrieval failed: ${error.message}`);
      return null;
    }
  }

  async cacheResult(
    tool: Tool,
    parameters: Record<string, any>,
    result: ToolExecutionResult,
  ): Promise<void> {
    try {
      const cacheConfig = tool.configuration?.cache;
      if (!cacheConfig?.enabled) return;
      const cacheKey = this.generateCacheKey(tool.id, parameters);
      const ttl = cacheConfig.ttl || 300;
      await this.redis.setex(cacheKey, ttl, JSON.stringify(result));
    } catch (error: any) {
      this.logger.warn(`Cache storage failed: ${error.message}`);
    }
  }

  generateCacheKey(toolId: string, parameters: Record<string, any>): string {
    return `tool_cache:${toolId}:${hashCacheObject(parameters)}`;
  }

  async checkRateLimit(
    tool: Tool,
    options: ToolExecutionOptions,
  ): Promise<{ limited: boolean; message?: string }> {
    try {
      const rateLimitConfig = tool.configuration?.rateLimit;
      if (!rateLimitConfig) return { limited: false };

      const { userId } = options;
      const toolId = tool.id;

      if (rateLimitConfig.requestsPerMinute) {
        const minuteKey = `rate_limit:${toolId}:${userId}:minute:${Math.floor(
          Date.now() / 60000,
        )}`;
        const currentMinuteCount = await this.redis.incr(minuteKey);
        await this.redis.expire(minuteKey, 60);
        if (currentMinuteCount > rateLimitConfig.requestsPerMinute) {
          return {
            limited: true,
            message: `Exceeded ${rateLimitConfig.requestsPerMinute} requests per minute`,
          };
        }
      }

      if (rateLimitConfig.requestsPerHour) {
        const hourKey = `rate_limit:${toolId}:${userId}:hour:${Math.floor(
          Date.now() / 3600000,
        )}`;
        const currentHourCount = await this.redis.incr(hourKey);
        await this.redis.expire(hourKey, 3600);
        if (currentHourCount > rateLimitConfig.requestsPerHour) {
          return {
            limited: true,
            message: `Exceeded ${rateLimitConfig.requestsPerHour} requests per hour`,
          };
        }
      }

      return { limited: false };
    } catch (error: any) {
      // Fail open on Redis outage — a rate-limiter dependency failure
      // should not take the platform down.
      this.logger.warn(`Rate limiting check failed, allowing request: ${error.message}`);
      return { limited: false };
    }
  }
}
