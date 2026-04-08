import {
  Plugin,
  PluginHookType,
  PluginContext,
  PluginResult,
} from '../types/plugin.types';
import { compileSafeRegex, boundRegexInput } from '../../../common/security/regex-safety';

type ThreatSeverity = 'low' | 'medium' | 'high' | 'critical';

interface SecurityThreat {
  type: 'sql_injection' | 'xss' | 'command_injection' | 'path_traversal' | 'suspicious_pattern';
  severity: ThreatSeverity;
  description: string;
  location: string;
  pattern: string;
}

/** Numeric rank for severities — lets us compare against a threshold. */
const SEVERITY_RANK: Record<ThreatSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Per-custom-pattern wall-clock budget for the match() call. */
const CUSTOM_PATTERN_BUDGET_MS = 50;

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
      author: 'almyty',
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
      // Convert data to scannable string. safeStringify handles circular
      // references (plain JSON.stringify throws, which used to crash the
      // scanner entirely for any data graph with a back-reference).
      const dataToScan = typeof context.data === 'string'
        ? context.data
        : this.safeStringify(context.data);

      // Pre-compile the whitelist once so we can suppress threats whose
      // match text has been explicitly approved. The `whitelistPatterns`
      // setting was documented on the plugin definition but the
      // previous shape never consulted it.
      //
      // Semantic: a threat is skipped only when EVERY match substring
      // is whitelisted. A single unwhitelisted match is enough to
      // still raise the threat, so a partial allow-list can't erase
      // an attacker's novel payload simply because one of its
      // fragments is on the safe list.
      const whitelistRegexes = this.compileWhitelist(settings);
      const isWhitelisted = (value: string) =>
        whitelistRegexes.some(w => w.test(value));
      const allWhitelisted = (matches: string[]) =>
        whitelistRegexes.length > 0 && matches.every(isWhitelisted);

      // Helper so every category can share the same match-push shape.
      const scan = (
        patterns: RegExp[],
        type: SecurityThreat['type'],
        severity: ThreatSeverity,
        description: string,
      ) => {
        for (const pattern of patterns) {
          const matches = dataToScan.match(pattern);
          if (!matches) continue;
          if (allWhitelisted(matches)) continue;
          threats.push({
            type,
            severity,
            description,
            location: scanType,
            pattern: pattern.toString(),
          });
        }
      };

      scan(this.securityPatterns.sqlInjection,    'sql_injection',     'high',     'Potential SQL injection detected');
      scan(this.securityPatterns.xss,             'xss',               'high',     'Potential XSS attack detected');
      scan(this.securityPatterns.commandInjection, 'command_injection', 'critical', 'Potential command injection detected');
      scan(this.securityPatterns.pathTraversal,   'path_traversal',    'medium',   'Potential path traversal detected');

      // Custom patterns, routed through the shared regex-safety helper.
      // compileSafeRegex rejects catastrophic-backtracking shapes
      // BEFORE the engine runs (the previous shape only had a post-match
      // wall-clock budget, which meant the first slow pattern could
      // still hang the scanner for the duration of its match). The
      // input is also bounded by boundRegexInput so even a pattern
      // that slips through the heuristic has a fixed-size haystack.
      // The post-match budget stays as a final belt-and-braces guard.
      const boundedScan = boundRegexInput(dataToScan);
      for (const customPattern of settings.customPatterns || []) {
        const compiled = compileSafeRegex(customPattern.pattern, {
          flags: customPattern.flags || 'gi',
        });
        if (!compiled.regex) {
          continue;
        }

        const started = Date.now();
        let matches: RegExpMatchArray | null = null;
        try {
          matches = boundedScan.match(compiled.regex);
        } catch {
          continue;
        }
        if (Date.now() - started > CUSTOM_PATTERN_BUDGET_MS) {
          // Final fallback: something slow got through anyway. Bail
          // on the rest of the loop.
          break;
        }
        if (!matches) continue;
        if (allWhitelisted(matches)) continue;

        threats.push({
          type: 'suspicious_pattern',
          severity: (customPattern.severity || 'medium') as ThreatSeverity,
          description: customPattern.description || 'Custom security pattern matched',
          location: scanType,
          pattern: customPattern.pattern,
        });
      }

      // Evaluate threats. The previous logic was shaped as three hard-coded
      // branches against `severityThreshold === 'high' | 'medium'`, which
      // meant setting the threshold to `'low'` accidentally made the
      // scanner STRICTER on critical only (the low branch matched nothing,
      // the critical-branch fallback was the only firing condition). Now
      // we compare numeric severity ranks so "block anything at or above
      // the threshold" works for every value the user can set.
      const threshold: ThreatSeverity =
        settings?.severityThreshold && SEVERITY_RANK[settings.severityThreshold as ThreatSeverity]
          ? (settings.severityThreshold as ThreatSeverity)
          : 'medium';
      const thresholdRank = SEVERITY_RANK[threshold];
      const blockingThreats = threats.filter(t => SEVERITY_RANK[t.severity] >= thresholdRank);
      const shouldBlock = settings.blockOnThreat === true && blockingThreats.length > 0;

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

  /**
   * JSON.stringify that doesn't throw on cyclic graphs. The scanner used
   * to call `JSON.stringify(context.data)` directly, which would throw a
   * TypeError on any back-reference and fail the whole scan — a trivial
   * bypass: include a circular ref in the request and the scanner silently
   * errors out.
   */
  private safeStringify(value: any): string {
    const seen = new WeakSet();
    try {
      return JSON.stringify(value, (_key, v) => {
        if (v && typeof v === 'object') {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        return v;
      }) ?? '';
    } catch {
      // Final fallback — a non-stringifiable value (e.g. bigint in older
      // Node) shouldn't bypass scanning entirely; coerce to an empty
      // string so the builtin patterns can't match anything and the
      // rest of the plugin still runs.
      return '';
    }
  }

  /**
   * Compile `settings.whitelistPatterns` into a regex list. Silently
   * drops entries that can't be parsed as a regex. Each entry may be a
   * literal string (matched case-insensitively as-is) or a `{pattern,
   * flags}` object for full regex control.
   *
   * These whitelist patterns are matched against every candidate threat
   * value, so a catastrophic-backtracking whitelist is exactly as bad
   * as a catastrophic-backtracking scan pattern: either one hangs the
   * request. Route both shapes through compileSafeRegex, which refuses
   * the known ReDoS shapes and enforces the shared source-length cap.
   */
  private compileWhitelist(settings: any): RegExp[] {
    const raw = settings?.whitelistPatterns;
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const out: RegExp[] = [];
    for (const entry of raw) {
      if (typeof entry === 'string') {
        const { regex } = compileSafeRegex(entry, { flags: 'i' });
        if (regex) out.push(regex);
      } else if (entry && typeof entry.pattern === 'string') {
        const { regex } = compileSafeRegex(entry.pattern, {
          flags: entry.flags || 'i',
        });
        if (regex) out.push(regex);
      }
    }
    return out;
  }
}