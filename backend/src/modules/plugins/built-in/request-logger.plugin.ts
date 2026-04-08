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
      author: 'almyty',
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

  /**
   * Redaction works on the parsed object (walks the graph and replaces
   * sensitive values in place on a CLONE) rather than on the serialised
   * JSON string. The previous string-regex approach had three real bugs:
   *
   *  - Only string-VALUED fields were redacted. A numeric
   *    `"token": 12345`, object `"secret": {...}`, or null credential
   *    passed through unchanged.
   *  - The field name had to match exactly. `"passwordHash"`,
   *    `"accessToken"`, `"refreshToken"`, `"x-api-key"`,
   *    `"authorization"`, etc. were all missed.
   *  - The sanitized output was a STRING (the regex-replaced bodyStr)
   *    even when the input was a structured object, so the logged
   *    `body` field had an inconsistent shape.
   */
  private sanitizeBody(body: any, settings: any): any {
    if (!settings.logBody) {
      return '[BODY LOGGING DISABLED]';
    }

    if (body == null) {
      return body;
    }

    // Clone + redact first, THEN serialise for size check. That way the
    // redaction runs against the real structure, not a stringified view.
    let value: any = body;
    if (settings.redactSensitiveData && typeof body === 'object') {
      value = this.redactObject(body, new WeakSet());
    }

    let bodyStr: string;
    try {
      bodyStr = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      // Circular reference or a value that can't be stringified. Log a
      // placeholder rather than failing the whole plugin chain — this
      // is a logging plugin, it must never break the main request.
      bodyStr = '[unserialisable body]';
    }

    if (bodyStr.length > settings.maxBodySize) {
      return bodyStr.substring(0, settings.maxBodySize) + '...[TRUNCATED]';
    }

    // When redaction is enabled we return the REDACTED value (not the
    // serialised form) so structured loggers can preserve the shape.
    return settings.redactSensitiveData ? value : body;
  }

  /**
   * Recursively walk an object and redact any value whose key looks
   * sensitive. Operates on a clone (never mutates the caller's object
   * — that's important because this plugin runs as `postResponse` and
   * the same data is flowing through the real response pipeline).
   */
  private redactObject(input: any, seen: WeakSet<object>): any {
    if (input == null || typeof input !== 'object') return input;
    if (seen.has(input)) return '[Circular]';
    seen.add(input);

    if (Array.isArray(input)) {
      return input.map((v) => this.redactObject(v, seen));
    }

    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(input)) {
      if (this.isSensitiveKey(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      // `Authorization` headers carry `Bearer <token>` — redact the
      // bearer portion while keeping the scheme visible for debugging.
      if (typeof value === 'string' && /^bearer\s+/i.test(value)) {
        out[key] = 'Bearer [REDACTED]';
        continue;
      }
      out[key] = this.redactObject(value, seen);
    }
    return out;
  }

  private isSensitiveKey(key: string): boolean {
    const lower = key.toLowerCase();
    // Substring match catches password, passwordHash, user_password,
    // accessToken, refreshToken, apiKey, api-key, x-api-key,
    // client_secret, authorization, etc.
    return (
      lower.includes('password') ||
      lower.includes('token') ||
      lower.includes('secret') ||
      lower.includes('apikey') ||
      lower.includes('api_key') ||
      lower.includes('api-key') ||
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'cookie' ||
      lower === 'set-cookie' ||
      lower.includes('credential')
    );
  }
}