import { RequestLoggerPlugin } from './request-logger.plugin';
import { PluginContext, PluginHookType } from '../types/plugin.types';

describe('RequestLoggerPlugin - Real Business Logic', () => {
  let plugin: RequestLoggerPlugin;
  let mockSettings: any;
  let mockContext: PluginContext;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    plugin = new RequestLoggerPlugin();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

    mockSettings = {
      logLevel: 'info',
      logRequests: true,
      logResponses: true,
      logHeaders: false,
      logBody: true,
      maxBodySize: 10000,
      redactSensitiveData: true,
      structuredLogging: true,
      includeTimings: true,
      correlationId: true,
    };

    mockContext = {
      hookType: PluginHookType.PRE_REQUEST,
      userId: 'user-1',
      organizationId: 'org-1',
      requestId: 'req-1',
      sessionId: 'session-1',
      data: { test: 'data' },
      metadata: {
        timestamp: new Date().toISOString(),
        plugin: {
          id: 'plugin-1',
          name: 'Request Logger',
          version: '1.0.0',
        },
        execution: {
          attempt: 1,
          timeout: 5000,
          startTime: Date.now(),
        },
        correlationId: 'corr-123',
      },
    };
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe('Plugin Definition', () => {
    it('should return plugin definition with correct metadata', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.name).toBe('Request Logger');
      expect(definition.version).toBe('1.0.0');
      expect(definition.isActive).toBe(true);
      expect(definition.configuration.priority).toBe(10); // Low priority
    });

    it('should define correct hook types', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.capabilities.hooks).toContain(PluginHookType.PRE_REQUEST);
      expect(definition.capabilities.hooks).toContain(PluginHookType.POST_RESPONSE);
      expect(definition.capabilities.hooks).toContain(PluginHookType.PRE_TOOL_EXECUTION);
      expect(definition.capabilities.hooks).toContain(PluginHookType.POST_TOOL_EXECUTION);
      expect(definition.capabilities.hooks).toContain(PluginHookType.TOOL_EXECUTION_ERROR);
    });

    it('should define hooks with correct handlers', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.hooks).toHaveLength(3);
      expect(definition.hooks[0].handler).toBe('logRequest');
      expect(definition.hooks[1].handler).toBe('logResponse');
      expect(definition.hooks[2].handler).toBe('logToolExecution');
    });

    it('should mark hooks as async', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.hooks[0].async).toBe(true);
      expect(definition.hooks[1].async).toBe(true);
      expect(definition.hooks[2].async).toBe(true);
    });
  });

  describe('logRequest - Request logging', () => {
    it('should log request with structured data', async () => {
      const contextWithRequest = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          request: {
            method: 'POST',
            endpoint: '/api/test',
            headers: { 'Content-Type': 'application/json' },
          },
        },
      };

      const result = await plugin.logRequest(contextWithRequest, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(contextWithRequest.data);
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);

      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.type).toBe('request');
      expect(loggedData.method).toBe('POST');
      expect(loggedData.endpoint).toBe('/api/test');
      expect(loggedData.organizationId).toBe('org-1');
      expect(loggedData.userId).toBe('user-1');
    });

    it('should include headers when logHeaders is true', async () => {
      const settingsWithHeaders = { ...mockSettings, logHeaders: true };
      const contextWithRequest = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          request: {
            method: 'GET',
            endpoint: '/api/data',
            headers: { Authorization: 'Bearer token123' },
          },
        },
      };

      const result = await plugin.logRequest(contextWithRequest, settingsWithHeaders);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.headers).toEqual({ Authorization: 'Bearer token123' });
    });

    it('should exclude headers when logHeaders is false', async () => {
      const contextWithRequest = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          request: {
            method: 'GET',
            endpoint: '/api/data',
            headers: { Authorization: 'Bearer token123' },
          },
        },
      };

      const result = await plugin.logRequest(contextWithRequest, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.headers).toBeUndefined();
    });

    it('should include correlation ID', async () => {
      const contextWithRequest = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          request: { method: 'GET', endpoint: '/api/test', headers: {} },
          correlationId: 'corr-456',
        },
      };

      const result = await plugin.logRequest(contextWithRequest, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.correlationId).toBe('corr-456');
    });

    it('should track execution time', async () => {
      const result = await plugin.logRequest(mockContext, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should return log entry in metadata', async () => {
      const contextWithRequest = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          request: { method: 'POST', endpoint: '/api/test', headers: {} },
        },
      };

      const result = await plugin.logRequest(contextWithRequest, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.logs).toHaveLength(1);
      expect(result.metadata.logs[0].level).toBe('info');
      expect(result.metadata.logs[0].message).toContain('Request logged');
      expect(result.metadata.logs[0].message).toContain('POST');
    });

    it('should handle errors gracefully', async () => {
      // Pass invalid settings to trigger error
      const result = await plugin.logRequest(mockContext, null);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LOGGING_ERROR');
      expect(result.data).toEqual(mockContext.data);
    });
  });

  describe('logResponse - Response logging', () => {
    it('should log response with status code', async () => {
      const contextWithResponse = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          httpStatus: 200,
          execution: { ...mockContext.metadata.execution, executionTime: 150 },
        },
      };

      const result = await plugin.logResponse(contextWithResponse, mockSettings);

      expect(result.success).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);

      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.type).toBe('response');
      expect(loggedData.statusCode).toBe(200);
      expect(loggedData.executionTime).toBe(150);
    });

    it('should log response with sanitized body', async () => {
      const contextWithBody = {
        ...mockContext,
        data: { result: 'success', password: 'secret123' },
        metadata: {
          ...mockContext.metadata,
          httpStatus: 201,
        },
      };

      const result = await plugin.logResponse(contextWithBody, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.body).toContain('[REDACTED]');
    });

    it('should include session and request IDs', async () => {
      const result = await plugin.logResponse(mockContext, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.sessionId).toBe('session-1');
      expect(loggedData.requestId).toBe('req-1');
    });

    it('should handle errors gracefully', async () => {
      const result = await plugin.logResponse(mockContext, null);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LOGGING_ERROR');
    });
  });

  describe('logToolExecution - Tool execution logging', () => {
    it('should log tool execution details', async () => {
      const contextWithTool = {
        ...mockContext,
        metadata: {
          ...mockContext.metadata,
          tool: {
            id: 'tool-1',
            name: 'Test Tool',
          },
        },
      };

      const result = await plugin.logToolExecution(contextWithTool, mockSettings);

      expect(result.success).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);

      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.type).toBe('tool_execution');
      expect(loggedData.toolId).toBe('tool-1');
      expect(loggedData.toolName).toBe('Test Tool');
    });

    it('should sanitize tool parameters', async () => {
      const contextWithSensitiveData = {
        ...mockContext,
        data: { password: 'secret-pwd', query: 'test' },
        metadata: {
          ...mockContext.metadata,
          tool: { id: 'tool-1', name: 'API Tool' },
        },
      };

      const result = await plugin.logToolExecution(contextWithSensitiveData, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.parameters).toContain('[REDACTED]');
      expect(loggedData.parameters).not.toContain('secret-pwd');
    });

    it('should handle errors gracefully', async () => {
      const result = await plugin.logToolExecution(mockContext, null);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LOGGING_ERROR');
    });
  });

  describe('sanitizeBody - Data sanitization', () => {
    it('should return placeholder when logBody is false', async () => {
      const settingsNoBody = { ...mockSettings, logBody: false };
      const result = await plugin.logRequest(mockContext, settingsNoBody);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.body).toBe('[BODY LOGGING DISABLED]');
    });

    it('should truncate large bodies', async () => {
      const largeData = 'x'.repeat(15000);
      const contextWithLargeBody = {
        ...mockContext,
        data: largeData,
      };

      const result = await plugin.logRequest(contextWithLargeBody, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.body).toContain('[TRUNCATED]');
      expect(loggedData.body.length).toBeLessThan(largeData.length);
    });

    it('should redact password fields', async () => {
      const contextWithPassword = {
        ...mockContext,
        data: { username: 'user', password: 'secret123' },
      };

      const result = await plugin.logRequest(contextWithPassword, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.body).toContain('[REDACTED]');
      expect(loggedData.body).not.toContain('secret123');
    });

    it('should redact token fields', async () => {
      const contextWithToken = {
        ...mockContext,
        data: { token: 'jwt-token-123', data: 'public' },
      };

      const result = await plugin.logRequest(contextWithToken, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.body).toContain('[REDACTED]');
      expect(loggedData.body).not.toContain('jwt-token-123');
    });

    it('should redact secret fields', async () => {
      const contextWithSecret = {
        ...mockContext,
        data: { secret: 'api-secret', key: 'api-key-123' },
      };

      const result = await plugin.logRequest(contextWithSecret, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.body).toContain('[REDACTED]');
      expect(loggedData.body).not.toContain('api-secret');
      expect(loggedData.body).not.toContain('api-key-123');
    });

    it('should not redact when redactSensitiveData is false', async () => {
      const settingsNoRedact = { ...mockSettings, redactSensitiveData: false };
      const contextWithPassword = {
        ...mockContext,
        data: { password: 'visible' },
      };

      const result = await plugin.logRequest(contextWithPassword, settingsNoRedact);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      const bodyData = typeof loggedData.body === 'string' ? JSON.parse(loggedData.body) : loggedData.body;
      expect(bodyData.password).toBe('visible'); // Password should not be redacted
    });

    it('should handle null data', async () => {
      const contextWithNull = {
        ...mockContext,
        data: null,
      };

      const result = await plugin.logRequest(contextWithNull, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.body).toBe(null);
    });

    it('should handle undefined data', async () => {
      const contextWithUndefined = {
        ...mockContext,
        data: undefined,
      };

      const result = await plugin.logRequest(contextWithUndefined, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.body).toBeUndefined();
    });

    it('should handle string data directly', async () => {
      const contextWithString = {
        ...mockContext,
        data: 'Simple string data',
      };

      const result = await plugin.logRequest(contextWithString, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.body).toBe('Simple string data');
    });

    it('should JSON stringify object data', async () => {
      const contextWithObject = {
        ...mockContext,
        data: { name: 'value', nested: { data: 'test' } },
      };

      const result = await plugin.logRequest(contextWithObject, mockSettings);

      expect(result.success).toBe(true);
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(typeof loggedData.body).toBe('string');
      expect(loggedData.body).toContain('name');
      expect(loggedData.body).toContain('value');
    });
  });
});
