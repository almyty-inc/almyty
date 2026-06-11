import {
  Plugin,
  PluginHookType,
  PluginContext,
  PluginResult,
} from '../types/plugin.types';
import * as Redis from 'ioredis';

interface RateLimitWindow {
  count: number;
  resetTime: number;
}

export class RateLimiterPlugin {
  // Bounded in-memory store. NOTE: This plugin's counters are per-process,
  // so a user can get N × limit concurrent requests on an N-replica
  // deployment. Redis-backed sharing is the correct fix; for now we at
  // least prevent the map from growing unbounded under key variation
  // (e.g. one entry per tool×org×user combination).
  private readonly windows = new Map<string, RateLimitWindow>();
  private static readonly MAX_WINDOWS = 10_000;

  // Optional Redis client. When present, counters are shared across
  // replicas (atomic INCR + EXPIRE on a fixed minute window); otherwise we
  // fall back to the per-process map. A Redis error at request time also
  // falls back, so a transient blip degrades to local limiting rather than
  // failing the request.
  constructor(private readonly redis?: Redis.Redis) {}

  private static readonly WINDOW_MS = 60_000;

  getPluginDefinition(): Omit<Plugin, 'id' | 'metadata'> {
    return {
      name: 'Rate Limiter',
      version: '1.0.0',
      description: 'Advanced rate limiting with multiple strategies and organization-based quotas',
      author: 'almyty',
      isActive: true,
      configuration: {
        enabled: true,
        priority: 80,
        settings: {
          strategy: 'sliding_window', // 'fixed_window' | 'sliding_window' | 'token_bucket'
          limits: {
            requestsPerMinute: 100,
            requestsPerHour: 1000,
            requestsPerDay: 10000,
          },
          burstLimit: 10,
          organizationLimits: {
            free: { requestsPerHour: 100 },
            pro: { requestsPerHour: 1000 },
            enterprise: { requestsPerHour: 10000 },
          },
          bypassRoles: ['admin', 'owner'],
          customHeaders: {
            remaining: 'X-RateLimit-Remaining',
            reset: 'X-RateLimit-Reset',
            limit: 'X-RateLimit-Limit',
          },
        },
      },
      capabilities: {
        hooks: [
          PluginHookType.PRE_REQUEST,
          PluginHookType.PRE_TOOL_EXECUTION,
          PluginHookType.PRE_API_CALL,
        ],
        protocols: ['mcp', 'utcp', 'a2a', 'http'],
        dataFormats: ['json'],
        operations: ['read'],
      },
      hooks: [
        {
          type: PluginHookType.PRE_REQUEST,
          handler: 'enforceRateLimit',
          async: false,
          timeout: 1000,
        },
        {
          type: PluginHookType.PRE_TOOL_EXECUTION,
          handler: 'enforceToolRateLimit',
          async: false,
          timeout: 1000,
        },
        {
          type: PluginHookType.PRE_API_CALL,
          handler: 'enforceApiRateLimit',
          async: false,
          timeout: 1000,
        },
      ],
    };
  }

  async enforceRateLimit(context: PluginContext, settings: any): Promise<PluginResult> {
    const startTime = Date.now();
    const userId = context.userId || 'anonymous';
    const organizationId = context.organizationId;

    // Without an org, two different orgs' anonymous/system traffic
    // would share the same \`ratelimit:user:anonymous:undefined\` bucket.
    // Fail closed — the caller passed an unauthenticated context.
    if (!organizationId) {
      return {
        success: false,
        data: context.data,
        error: {
          code: 'RATE_LIMIT_NO_ORG',
          message: 'Rate limiter requires an organization context',
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
        nextAction: 'stop',
      };
    }

    // Build rate limit key
    const key = `ratelimit:user:${userId}:${organizationId}`;
    
    try {
      const isAllowed = await this.checkRateLimit(key, settings);
      
      if (!isAllowed) {
        return {
          success: false,
          data: context.data,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Rate limit exceeded',
            details: {
              limit: settings.limits.requestsPerMinute,
              resetTime: this.getResetTime(key),
            },
          },
          metadata: {
            executionTime: Date.now() - startTime,
            modifications: ['Request blocked due to rate limit'],
          },
          nextAction: 'stop',
        };
      }

      return {
        success: true,
        data: context.data,
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
          logs: [
            {
              level: 'debug',
              message: `Rate limit check passed for ${key}`,
              timestamp: new Date().toISOString(),
            },
          ],
        },
      };

    } catch (error) {
      return {
        success: false,
        data: context.data,
        error: {
          code: 'RATE_LIMIT_ERROR',
          message: error.message,
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
      };
    }
  }

  async enforceToolRateLimit(context: PluginContext, settings: any): Promise<PluginResult> {
    const toolId = context.metadata.tool?.id;
    if (!toolId) {
      return {
        success: true,
        data: context.data,
        metadata: {
          executionTime: 0,
          modifications: [],
        },
      };
    }

    const key = `ratelimit:tool:${toolId}:${context.organizationId}`;
    return this.enforceRateLimit(
      { ...context, metadata: { ...context.metadata, rateLimitKey: key } },
      settings
    );
  }

  async enforceApiRateLimit(context: PluginContext, settings: any): Promise<PluginResult> {
    const apiId = context.metadata.api?.id;
    if (!apiId) {
      return {
        success: true,
        data: context.data,
        metadata: {
          executionTime: 0,
          modifications: [],
        },
      };
    }

    const key = `ratelimit:api:${apiId}:${context.organizationId}`;
    return this.enforceRateLimit(
      { ...context, metadata: { ...context.metadata, rateLimitKey: key } },
      settings
    );
  }

  private async checkRateLimit(key: string, settings: any): Promise<boolean> {
    const now = Date.now();
    const windowSizeMs = 60 * 1000; // 1 minute
    const limit = settings.limits.requestsPerMinute;

    // Redis fast-path: shared, atomic fixed-window counter.
    if (this.redis) {
      try {
        const windowId = Math.floor(now / RateLimiterPlugin.WINDOW_MS);
        const redisKey = `${key}:${windowId}`;
        const count = await this.redis.incr(redisKey);
        if (count === 1) {
          // TTL slightly longer than the window absorbs clock skew.
          await this.redis.expire(redisKey, 70);
        }
        return count <= limit;
      } catch {
        // Redis unavailable — fall through to the per-process counter.
      }
    }

    // Get or create window
    let window = this.windows.get(key);
    
    if (!window || now >= window.resetTime) {
      // Reset window
      window = {
        count: 0,
        resetTime: now + windowSizeMs,
      };
    }

    // Check limit
    if (window.count >= limit) {
      return false;
    }

    // Increment counter
    window.count++;
    this.windows.set(key, window);

    // Opportunistically prune expired windows whenever the map grows
    // past the bounded cap. cleanupWindows() already handles the
    // "expired" case; if the cap is still exceeded after cleanup we
    // drop the oldest entry. Without this the map could grow
    // unboundedly under key variation (per-user per-tool per-org).
    if (this.windows.size > RateLimiterPlugin.MAX_WINDOWS) {
      this.cleanupWindows();
      if (this.windows.size > RateLimiterPlugin.MAX_WINDOWS) {
        const firstKey = this.windows.keys().next().value;
        if (firstKey) this.windows.delete(firstKey);
      }
    }

    return true;
  }
  private getResetTime(key: string): number {
    if (this.redis) {
      // Fixed-window boundary (matches the Redis counter's window).
      return (Math.floor(Date.now() / RateLimiterPlugin.WINDOW_MS) + 1) * RateLimiterPlugin.WINDOW_MS;
    }
    const window = this.windows.get(key);
    return window ? window.resetTime : Date.now() + 60000;
  }

  // Cleanup old windows
  cleanupWindows(): void {
    const now = Date.now();
    for (const [key, window] of this.windows.entries()) {
      if (now >= window.resetTime) {
        this.windows.delete(key);
      }
    }
  }
}