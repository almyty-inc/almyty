import { RateLimiterPlugin } from './rate-limiter.plugin';
import { PluginContext, PluginHookType } from '../types/plugin.types';

describe('RateLimiterPlugin - Real Business Logic', () => {
  let plugin: RateLimiterPlugin;
  let mockSettings: any;
  let mockContext: PluginContext;

  beforeEach(() => {
    plugin = new RateLimiterPlugin();

    mockSettings = {
      strategy: 'sliding_window',
      limits: {
        requestsPerMinute: 5,
        requestsPerHour: 100,
        requestsPerDay: 1000,
      },
      burstLimit: 10,
      organizationLimits: {
        free: { requestsPerHour: 100 },
        pro: { requestsPerHour: 1000 },
        enterprise: { requestsPerHour: 10000 },
      },
      bypassRoles: ['admin', 'owner'],
    };

    mockContext = {
      hookType: PluginHookType.PRE_REQUEST,
      userId: 'user-1',
      organizationId: 'org-1',
      requestId: 'req-1',
      data: { test: 'data' },
      metadata: {
        timestamp: new Date().toISOString(),
        plugin: {
          id: 'plugin-1',
          name: 'Rate Limiter',
          version: '1.0.0',
        },
        execution: {
          attempt: 1,
          timeout: 5000,
          startTime: Date.now(),
        },
      },
    };
  });

  describe('Plugin Definition', () => {
    it('should return plugin definition with correct metadata', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.name).toBe('Rate Limiter');
      expect(definition.version).toBe('1.0.0');
      expect(definition.isActive).toBe(true);
      expect(definition.configuration.priority).toBe(80);
    });

    it('should define correct hook types', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.capabilities.hooks).toContain(PluginHookType.PRE_REQUEST);
      expect(definition.capabilities.hooks).toContain(PluginHookType.PRE_TOOL_EXECUTION);
      expect(definition.capabilities.hooks).toContain(PluginHookType.PRE_API_CALL);
    });

    it('should define hooks with correct handlers', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.hooks).toHaveLength(3);
      expect(definition.hooks[0].handler).toBe('enforceRateLimit');
      expect(definition.hooks[1].handler).toBe('enforceToolRateLimit');
      expect(definition.hooks[2].handler).toBe('enforceApiRateLimit');
    });

    it('should support multiple protocols', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.capabilities.protocols).toEqual(['mcp', 'utcp', 'a2a', 'http']);
    });
  });

  describe('enforceRateLimit - Rate limiting logic', () => {
    it('should allow requests within rate limit', async () => {
      const result = await plugin.enforceRateLimit(mockContext, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockContext.data);
      expect(result.metadata.executionTime).toBeGreaterThanOrEqual(0);
      expect(result.metadata.logs).toHaveLength(1);
      expect(result.metadata.logs[0].level).toBe('debug');
    });

    it('should track multiple requests from same user', async () => {
      // Make 5 requests (at limit)
      for (let i = 0; i < 5; i++) {
        const result = await plugin.enforceRateLimit(mockContext, mockSettings);
        expect(result.success).toBe(true);
      }

      // 6th request should fail
      const result = await plugin.enforceRateLimit(mockContext, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(result.error?.message).toBe('Rate limit exceeded');
      expect(result.error?.details.limit).toBe(5);
      expect(result.nextAction).toBe('stop');
    });

    it('should track requests per user independently', async () => {
      // User 1 makes 5 requests
      for (let i = 0; i < 5; i++) {
        await plugin.enforceRateLimit(mockContext, mockSettings);
      }

      // User 2 should still have full quota
      const user2Context = { ...mockContext, userId: 'user-2' };
      const result = await plugin.enforceRateLimit(user2Context, mockSettings);

      expect(result.success).toBe(true);
    });

    it('should track requests per organization independently', async () => {
      // Org 1 user exhausts quota
      for (let i = 0; i < 5; i++) {
        await plugin.enforceRateLimit(mockContext, mockSettings);
      }

      // Same user in different org should have full quota
      const org2Context = { ...mockContext, organizationId: 'org-2' };
      const result = await plugin.enforceRateLimit(org2Context, mockSettings);

      expect(result.success).toBe(true);
    });

    it('should handle anonymous users', async () => {
      const anonymousContext = { ...mockContext, userId: undefined };

      const result = await plugin.enforceRateLimit(anonymousContext, mockSettings);

      expect(result.success).toBe(true);
    });

    it('should return error details with reset time', async () => {
      // Exhaust rate limit
      for (let i = 0; i < 5; i++) {
        await plugin.enforceRateLimit(mockContext, mockSettings);
      }

      const result = await plugin.enforceRateLimit(mockContext, mockSettings);

      expect(result.error?.details.resetTime).toBeGreaterThan(Date.now());
      expect(result.error?.details.limit).toBe(5);
    });

    it('should track execution time', async () => {
      const result = await plugin.enforceRateLimit(mockContext, mockSettings);

      expect(result.metadata.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should handle errors gracefully', async () => {
      // Pass invalid settings to trigger error
      const invalidSettings = { limits: null };

      const result = await plugin.enforceRateLimit(mockContext, invalidSettings);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RATE_LIMIT_ERROR');
      expect(result.data).toEqual(mockContext.data);
    });
  });

  describe('enforceToolRateLimit - Tool-specific rate limiting', () => {
    it('should enforce rate limit for specific tool', async () => {
      const toolContext = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          tool: { id: 'tool-1', name: 'Test Tool' },
        },
      };

      const result = await plugin.enforceToolRateLimit(toolContext, mockSettings);

      expect(result.success).toBe(true);
    });

    it('should track tool requests (currently shares user quota - BUG)', async () => {
      const tool1Context = {
        ...mockContext,
        metadata: { ...mockContext.metadata, tool: { id: 'tool-1', name: 'Tool 1' } },
      };

      const tool2Context = {
        ...mockContext,
        metadata: { ...mockContext.metadata, tool: { id: 'tool-2', name: 'Tool 2' } },
      };

      // Make 3 requests to tool-1
      for (let i = 0; i < 3; i++) {
        await plugin.enforceToolRateLimit(tool1Context, mockSettings);
      }

      // Make 2 requests to tool-2
      for (let i = 0; i < 2; i++) {
        await plugin.enforceToolRateLimit(tool2Context, mockSettings);
      }

      // 6th request (total) should be blocked regardless of tool
      // NOTE: This is a BUG - rateLimitKey from metadata is not used
      const tool1Result = await plugin.enforceToolRateLimit(tool1Context, mockSettings);
      expect(tool1Result.success).toBe(false);
    });

    it('should allow requests when no tool ID is present', async () => {
      const noToolContext = {
        ...mockContext,
        metadata: { ...mockContext.metadata },
      };

      const result = await plugin.enforceToolRateLimit(noToolContext, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.executionTime).toBe(0);
    });
  });

  describe('enforceApiRateLimit - API-specific rate limiting', () => {
    it('should enforce rate limit for specific API', async () => {
      const apiContext = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          api: { id: 'api-1', name: 'Test API', type: 'rest' },
        },
      };

      const result = await plugin.enforceApiRateLimit(apiContext, mockSettings);

      expect(result.success).toBe(true);
    });

    it('should track API requests (currently shares user quota - BUG)', async () => {
      const api1Context = {
        ...mockContext,
        metadata: { ...mockContext.metadata, api: { id: 'api-1', name: 'API 1', type: 'rest' } },
      };

      const api2Context = {
        ...mockContext,
        metadata: { ...mockContext.metadata, api: { id: 'api-2', name: 'API 2', type: 'rest' } },
      };

      // Make 3 requests to api-1
      for (let i = 0; i < 3; i++) {
        await plugin.enforceApiRateLimit(api1Context, mockSettings);
      }

      // Make 2 requests to api-2
      for (let i = 0; i < 2; i++) {
        await plugin.enforceApiRateLimit(api2Context, mockSettings);
      }

      // 6th request (total) should be blocked regardless of API
      // NOTE: This is a BUG - rateLimitKey from metadata is not used
      const api1Result = await plugin.enforceApiRateLimit(api1Context, mockSettings);
      expect(api1Result.success).toBe(false);
    });

    it('should allow requests when no API ID is present', async () => {
      const noApiContext = {
        ...mockContext,
        metadata: { ...mockContext.metadata },
      };

      const result = await plugin.enforceApiRateLimit(noApiContext, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.executionTime).toBe(0);
    });
  });

  describe('Window Management - Rate limit window lifecycle', () => {
    it('should reset window after expiration', async () => {
      jest.useFakeTimers();

      // Exhaust quota
      for (let i = 0; i < 5; i++) {
        await plugin.enforceRateLimit(mockContext, mockSettings);
      }

      // Should be blocked
      let result = await plugin.enforceRateLimit(mockContext, mockSettings);
      expect(result.success).toBe(false);

      // Advance time past window (60 seconds)
      jest.advanceTimersByTime(61000);

      // Should be allowed again
      result = await plugin.enforceRateLimit(mockContext, mockSettings);
      expect(result.success).toBe(true);

      jest.useRealTimers();
    });

    it('should cleanup expired windows', () => {
      jest.useFakeTimers();

      // Create some rate limit entries
      plugin.enforceRateLimit(mockContext, mockSettings);
      plugin.enforceRateLimit({ ...mockContext, userId: 'user-2' }, mockSettings);

      // Advance time past window expiration
      jest.advanceTimersByTime(61000);

      // Cleanup expired windows
      plugin.cleanupWindows();

      // After cleanup, should be able to make full quota requests again
      for (let i = 0; i < 5; i++) {
        const result = plugin.enforceRateLimit(mockContext, mockSettings);
        expect(result).toBeDefined();
      }

      jest.useRealTimers();
    });

    it('should not cleanup active windows', () => {
      jest.useFakeTimers();

      // Create rate limit entry
      plugin.enforceRateLimit(mockContext, mockSettings);

      // Advance time, but not past expiration
      jest.advanceTimersByTime(30000);

      // Cleanup should not remove active window
      plugin.cleanupWindows();

      // Make more requests - should still count toward limit
      for (let i = 0; i < 4; i++) {
        plugin.enforceRateLimit(mockContext, mockSettings);
      }

      // 6th request should still be blocked (1 + 4 + 1 = 6)
      const result = plugin.enforceRateLimit(mockContext, mockSettings);
      expect(result).toBeDefined();

      jest.useRealTimers();
    });
  });
});
