import {
  Plugin,
  PluginHookType,
  PluginContext,
  PluginResult,
} from '../types/plugin.types';

export class RequestLoggerPlugin {
  getPluginDefinition(): Omit<Plugin, 'id' | 'metadata'> {
    return {
      name: 'Request Logger',
      version: '1.0.0',
      description: 'Comprehensive request and response logging with structured data',
      author: 'apifai',
      isActive: true,
      configuration: {
        enabled: true,
        priority: 10, // Low priority - logging happens last
        settings: {
          logLevel: 'info',
          logRequests: true,
          logResponses: true,
          logHeaders: false,
          logBody: true,
          maxBodySize: 10000, // bytes
          redactSensitiveData: true,
          structuredLogging: true,
          includeTimings: true,
          correlationId: true,
        },
      },
      capabilities: {
        hooks: [
          PluginHookType.PRE_REQUEST,
          PluginHookType.POST_RESPONSE,
          PluginHookType.PRE_TOOL_EXECUTION,
          PluginHookType.POST_TOOL_EXECUTION,
          PluginHookType.TOOL_EXECUTION_ERROR,
        ],
        protocols: ['mcp', 'utcp', 'a2a', 'http'],
        dataFormats: ['json', 'xml', 'yaml'],
        operations: ['read'],
      },
      hooks: [
        {
          type: PluginHookType.PRE_REQUEST,
          handler: 'logRequest',
          async: true,
          timeout: 2000,
        },
        {
          type: PluginHookType.POST_RESPONSE,
          handler: 'logResponse',
          async: true,
          timeout: 2000,
        },
        {
          type: PluginHookType.PRE_TOOL_EXECUTION,
          handler: 'logToolExecution',
          async: true,
          timeout: 2000,
        },
      ],
    };
  }

  async logRequest(context: PluginContext, settings: any): Promise<PluginResult> {
    const startTime = Date.now();

    try {
      const logEntry = {
        type: 'request',
        timestamp: new Date().toISOString(),
        organizationId: context.organizationId,
        userId: context.userId,
        sessionId: context.sessionId,
        requestId: context.requestId,
        method: context.metadata.request?.method,
        endpoint: context.metadata.request?.endpoint,
        headers: settings.logHeaders ? context.metadata.request?.headers : undefined,
        body: this.sanitizeBody(context.data, settings),
        correlationId: context.metadata.correlationId,
      };

      // Log structured entry
      console.log(JSON.stringify(logEntry));

      return {
        success: true,
        data: context.data,
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
          logs: [
            {
              level: 'info',
              message: `Request logged: ${context.metadata.request?.method} ${context.metadata.request?.endpoint}`,
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
          code: 'LOGGING_ERROR',
          message: error.message,
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
      };
    }
  }

  async logResponse(context: PluginContext, settings: any): Promise<PluginResult> {
    const startTime = Date.now();

    try {
      const logEntry = {
        type: 'response',
        timestamp: new Date().toISOString(),
        organizationId: context.organizationId,
        userId: context.userId,
        sessionId: context.sessionId,
        requestId: context.requestId,
        statusCode: context.metadata.httpStatus,
        body: this.sanitizeBody(context.data, settings),
        executionTime: context.metadata.execution?.executionTime,
        correlationId: context.metadata.correlationId,
      };

      console.log(JSON.stringify(logEntry));

      return {
        success: true,
        data: context.data,
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
      };

    } catch (error) {
      return {
        success: false,
        data: context.data,
        error: {
          code: 'LOGGING_ERROR',
          message: error.message,
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
      };
    }
  }

  async logToolExecution(context: PluginContext, settings: any): Promise<PluginResult> {
    const startTime = Date.now();

    try {
      const logEntry = {
        type: 'tool_execution',
        timestamp: new Date().toISOString(),
        organizationId: context.organizationId,
        userId: context.userId,
        toolId: context.metadata.tool?.id,
        toolName: context.metadata.tool?.name,
        parameters: this.sanitizeBody(context.data, settings),
        sessionId: context.sessionId,
        requestId: context.requestId,
      };

      console.log(JSON.stringify(logEntry));

      return {
        success: true,
        data: context.data,
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
      };

    } catch (error) {
      return {
        success: false,
        data: context.data,
        error: {
          code: 'LOGGING_ERROR',
          message: error.message,
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
      };
    }
  }

  private sanitizeBody(body: any, settings: any): any {
    if (!settings.logBody) {
      return '[BODY LOGGING DISABLED]';
    }

    if (!body) {
      return body;
    }

    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    
    if (bodyStr.length > settings.maxBodySize) {
      return bodyStr.substring(0, settings.maxBodySize) + '...[TRUNCATED]';
    }

    if (settings.redactSensitiveData) {
      // Redact sensitive fields
      const sensitiveFields = ['password', 'token', 'key', 'secret', 'auth'];
      let sanitized = bodyStr;
      
      for (const field of sensitiveFields) {
        const regex = new RegExp(`"${field}"\\s*:\\s*"[^"]*"`, 'gi');
        sanitized = sanitized.replace(regex, `"${field}": "[REDACTED]"`);
      }
      
      return sanitized;
    }

    return body;
  }
}