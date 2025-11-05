import {
  Plugin,
  PluginHookType,
  PluginContext,
  PluginResult,
} from '../types/plugin.types';

interface SecurityThreat {
  type: 'sql_injection' | 'xss' | 'command_injection' | 'path_traversal' | 'suspicious_pattern';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  location: string;
  pattern: string;
}

export class SecurityScannerPlugin {
  private readonly securityPatterns = {
    sqlInjection: [
      /(\s|^)(union|select|insert|update|delete|drop|exec|execute)\s+/i,
      /(\s|^)(or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+/i,
      /'(\s|;|--|#|\*|\/\*)/i,
    ],
    xss: [
      /<script[^>]*>.*?<\/script>/gi,
      /javascript:/gi,
      /on\w+\s*=/gi,
      /<iframe[^>]*>.*?<\/iframe>/gi,
    ],
    commandInjection: [
      /[;&|`](\s)*(rm|cat|ls|pwd|whoami|id|ps|kill|nc|netcat)/i,
      /\$\(.*\)/g,
      /`.*`/g,
    ],
    pathTraversal: [
      /\.\.[\/\\]/g,
      /%2e%2e[\/\\]/gi,
      /\.\.%2f/gi,
    ],
  };

  getPluginDefinition(): Omit<Plugin, 'id' | 'metadata'> {
    return {
      name: 'Security Scanner',
      version: '1.0.0',
      description: 'Advanced security scanning for requests, responses, and tool parameters',
      author: 'apifai',
      isActive: true,
      configuration: {
        enabled: true,
        priority: 95, // Very high priority for security
        settings: {
          scanRequests: true,
          scanResponses: true,
          scanToolParameters: true,
          scanApiCalls: true,
          blockOnThreat: true,
          logThreats: true,
          alertOnCritical: true,
          whitelistPatterns: [],
          customPatterns: [],
          severityThreshold: 'medium', // Block medium and above
        },
      },
      capabilities: {
        hooks: [
          PluginHookType.PRE_REQUEST,
          PluginHookType.POST_RESPONSE,
          PluginHookType.PRE_TOOL_EXECUTION,
          PluginHookType.PRE_API_CALL,
          PluginHookType.DATA_VALIDATE,
        ],
        protocols: ['mcp', 'utcp', 'a2a', 'http'],
        dataFormats: ['json', 'xml', 'yaml'],
        operations: ['read', 'validate'],
      },
      hooks: [
        {
          type: PluginHookType.PRE_REQUEST,
          handler: 'scanRequest',
          async: false,
          timeout: 5000,
        },
        {
          type: PluginHookType.POST_RESPONSE,
          handler: 'scanResponse',
          async: false,
          timeout: 5000,
        },
        {
          type: PluginHookType.PRE_TOOL_EXECUTION,
          handler: 'scanToolParameters',
          async: false,
          timeout: 3000,
        },
        {
          type: PluginHookType.DATA_VALIDATE,
          handler: 'scanData',
          async: false,
          timeout: 3000,
        },
      ],
    };
  }

  async scanRequest(context: PluginContext, settings: any): Promise<PluginResult> {
    if (!settings.scanRequests) {
      return {
        success: true,
        data: context.data,
        metadata: {
          executionTime: 0,
          modifications: [],
        },
      };
    }

    return this.performSecurityScan(context, settings, 'request');
  }

  async scanResponse(context: PluginContext, settings: any): Promise<PluginResult> {
    if (!settings.scanResponses) {
      return {
        success: true,
        data: context.data,
        metadata: {
          executionTime: 0,
          modifications: [],
        },
      };
    }

    return this.performSecurityScan(context, settings, 'response');
  }

  async scanToolParameters(context: PluginContext, settings: any): Promise<PluginResult> {
    if (!settings.scanToolParameters) {
      return {
        success: true,
        data: context.data,
        metadata: {
          executionTime: 0,
          modifications: [],
        },
      };
    }

    return this.performSecurityScan(context, settings, 'tool_parameters');
  }

  async scanData(context: PluginContext, settings: any): Promise<PluginResult> {
    return this.performSecurityScan(context, settings, 'data');
  }

  private async performSecurityScan(
    context: PluginContext,
    settings: any,
    scanType: string,
  ): Promise<PluginResult> {
    const startTime = Date.now();
    const threats: SecurityThreat[] = [];
    const modifications: string[] = [];

    try {
      // Convert data to scannable string
      const dataToScan = typeof context.data === 'string' 
        ? context.data 
        : JSON.stringify(context.data);

      // Scan for SQL injection
      for (const pattern of this.securityPatterns.sqlInjection) {
        const matches = dataToScan.match(pattern);
        if (matches) {
          threats.push({
            type: 'sql_injection',
            severity: 'high',
            description: 'Potential SQL injection detected',
            location: scanType,
            pattern: pattern.toString(),
          });
        }
      }

      // Scan for XSS
      for (const pattern of this.securityPatterns.xss) {
        const matches = dataToScan.match(pattern);
        if (matches) {
          threats.push({
            type: 'xss',
            severity: 'high',
            description: 'Potential XSS attack detected',
            location: scanType,
            pattern: pattern.toString(),
          });
        }
      }

      // Scan for command injection
      for (const pattern of this.securityPatterns.commandInjection) {
        const matches = dataToScan.match(pattern);
        if (matches) {
          threats.push({
            type: 'command_injection',
            severity: 'critical',
            description: 'Potential command injection detected',
            location: scanType,
            pattern: pattern.toString(),
          });
        }
      }

      // Scan for path traversal
      for (const pattern of this.securityPatterns.pathTraversal) {
        const matches = dataToScan.match(pattern);
        if (matches) {
          threats.push({
            type: 'path_traversal',
            severity: 'medium',
            description: 'Potential path traversal detected',
            location: scanType,
            pattern: pattern.toString(),
          });
        }
      }

      // Check custom patterns
      for (const customPattern of settings.customPatterns || []) {
        try {
          const regex = new RegExp(customPattern.pattern, customPattern.flags || 'gi');
          const matches = dataToScan.match(regex);
          if (matches) {
            threats.push({
              type: 'suspicious_pattern',
              severity: customPattern.severity || 'medium',
              description: customPattern.description || 'Custom security pattern matched',
              location: scanType,
              pattern: customPattern.pattern,
            });
          }
        } catch (error) {
          // Invalid regex - skip
        }
      }

      // Evaluate threats
      const criticalThreats = threats.filter(t => t.severity === 'critical');
      const highThreats = threats.filter(t => t.severity === 'high');
      const shouldBlock = settings.blockOnThreat && 
        (criticalThreats.length > 0 || 
         (settings.severityThreshold === 'high' && highThreats.length > 0) ||
         (settings.severityThreshold === 'medium' && threats.length > 0));

      if (settings.logThreats && threats.length > 0) {
        modifications.push(`Security scan detected ${threats.length} threats`);
        console.log(JSON.stringify({
          type: 'security_scan',
          timestamp: new Date().toISOString(),
          organizationId: context.organizationId,
          requestId: context.requestId,
          scanType,
          threats,
        }));
      }

      if (shouldBlock) {
        return {
          success: false,
          data: context.data,
          error: {
            code: 'SECURITY_THREAT_DETECTED',
            message: `Security threat detected: ${threats.map(t => t.description).join(', ')}`,
            details: {
              threats,
              scanType,
              blocked: true,
            },
          },
          metadata: {
            executionTime: Date.now() - startTime,
            modifications,
          },
          nextAction: 'stop',
        };
      }

      return {
        success: true,
        data: context.data,
        metadata: {
          executionTime: Date.now() - startTime,
          modifications,
          warnings: threats.length > 0 ? [`${threats.length} security threats detected but not blocked`] : [],
          logs: threats.length > 0 ? [
            {
              level: 'warn',
              message: `Security scan detected ${threats.length} threats`,
              timestamp: new Date().toISOString(),
            },
          ] : [],
        },
      };

    } catch (error) {
      return {
        success: false,
        data: context.data,
        error: {
          code: 'SECURITY_SCAN_ERROR',
          message: error.message,
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
      };
    }
  }
}