import { SecurityScannerPlugin } from './security-scanner.plugin';
import { PluginContext, PluginHookType } from '../types/plugin.types';

describe('SecurityScannerPlugin - Real Business Logic', () => {
  let plugin: SecurityScannerPlugin;
  let mockSettings: any;
  let mockContext: PluginContext;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    plugin = new SecurityScannerPlugin();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

    mockSettings = {
      scanRequests: true,
      scanResponses: true,
      scanToolParameters: true,
      scanApiCalls: true,
      blockOnThreat: true,
      logThreats: true,
      alertOnCritical: true,
      whitelistPatterns: [],
      customPatterns: [],
      severityThreshold: 'medium',
    };

    mockContext = {
      hookType: PluginHookType.PRE_REQUEST,
      userId: 'user-1',
      organizationId: 'org-1',
      requestId: 'req-1',
      data: { test: 'clean data' },
      metadata: {
        timestamp: new Date().toISOString(),
        plugin: {
          id: 'plugin-1',
          name: 'Security Scanner',
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

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe('Plugin Definition', () => {
    it('should return plugin definition with correct metadata', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.name).toBe('Security Scanner');
      expect(definition.version).toBe('1.0.0');
      expect(definition.isActive).toBe(true);
      expect(definition.configuration.priority).toBe(95); // Very high priority
    });

    it('should define correct hook types', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.capabilities.hooks).toContain(PluginHookType.PRE_REQUEST);
      expect(definition.capabilities.hooks).toContain(PluginHookType.POST_RESPONSE);
      expect(definition.capabilities.hooks).toContain(PluginHookType.PRE_TOOL_EXECUTION);
      expect(definition.capabilities.hooks).toContain(PluginHookType.DATA_VALIDATE);
    });

    it('should define hooks with correct handlers', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.hooks).toHaveLength(4);
      expect(definition.hooks[0].handler).toBe('scanRequest');
      expect(definition.hooks[1].handler).toBe('scanResponse');
      expect(definition.hooks[2].handler).toBe('scanToolParameters');
      expect(definition.hooks[3].handler).toBe('scanData');
    });
  });

  describe('SQL Injection Detection', () => {
    it('should detect SQL injection with UNION SELECT', async () => {
      const contextWithSQLi = {
        ...mockContext,
        data: { query: "1' UNION SELECT * FROM users--" },
      };

      const result = await plugin.scanRequest(contextWithSQLi, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SECURITY_THREAT_DETECTED');
      expect(result.error?.message).toContain('SQL injection');
      expect(result.nextAction).toBe('stop');
    });

    it('should detect SQL injection with OR 1=1', async () => {
      const contextWithSQLi = {
        ...mockContext,
        data: { username: "admin' OR '1'='1" },
      };

      const result = await plugin.scanRequest(contextWithSQLi, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats.length).toBeGreaterThan(0);
      expect(result.error?.details.threats[0].type).toBe('sql_injection');
      expect(result.error?.details.threats[0].severity).toBe('high');
    });

    it('should detect SQL injection with comment markers', async () => {
      const contextWithSQLi = {
        ...mockContext,
        data: "SELECT * FROM table WHERE id = '1'--",
      };

      const result = await plugin.scanRequest(contextWithSQLi, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats[0].type).toBe('sql_injection');
    });

    it('should allow clean SQL-like queries', async () => {
      const contextClean = {
        ...mockContext,
        data: { search: 'select a product from our catalog' },
      };

      const result = await plugin.scanRequest(contextClean, mockSettings);

      expect(result.success).toBe(true);
    });
  });

  describe('XSS Detection', () => {
    it('should detect XSS with script tags', async () => {
      const contextWithXSS = {
        ...mockContext,
        data: { comment: '<script>alert("XSS")</script>' },
      };

      const result = await plugin.scanRequest(contextWithXSS, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SECURITY_THREAT_DETECTED');
      expect(result.error?.message).toContain('XSS');
      expect(result.error?.details.threats[0].type).toBe('xss');
    });

    it('should detect XSS with javascript: protocol', async () => {
      const contextWithXSS = {
        ...mockContext,
        data: { link: 'javascript:void(0)' },
      };

      const result = await plugin.scanRequest(contextWithXSS, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats[0].type).toBe('xss');
      expect(result.error?.details.threats[0].severity).toBe('high');
    });

    it('should detect XSS with event handlers', async () => {
      const contextWithXSS = {
        ...mockContext,
        data: '<img src="x" onerror="alert(1)">',
      };

      const result = await plugin.scanRequest(contextWithXSS, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats[0].type).toBe('xss');
    });

    it('should detect XSS with iframe tags', async () => {
      const contextWithXSS = {
        ...mockContext,
        data: '<iframe src="evil.com"></iframe>',
      };

      const result = await plugin.scanRequest(contextWithXSS, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('XSS');
    });
  });

  describe('Command Injection Detection', () => {
    it('should detect command injection with pipe', async () => {
      const contextWithCmdInj = {
        ...mockContext,
        data: { filename: 'file.txt | cat /etc/passwd' },
      };

      const result = await plugin.scanRequest(contextWithCmdInj, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SECURITY_THREAT_DETECTED');
      expect(result.error?.details.threats[0].type).toBe('command_injection');
      expect(result.error?.details.threats[0].severity).toBe('critical');
    });

    it('should detect command injection with semicolon', async () => {
      const contextWithCmdInj = {
        ...mockContext,
        data: 'input.txt; rm -rf /',
      };

      const result = await plugin.scanRequest(contextWithCmdInj, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats[0].severity).toBe('critical');
    });

    it('should detect command injection with backticks', async () => {
      const contextWithCmdInj = {
        ...mockContext,
        data: { cmd: '`whoami`' },
      };

      const result = await plugin.scanRequest(contextWithCmdInj, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats[0].type).toBe('command_injection');
    });

    it('should detect command injection with $() syntax', async () => {
      const contextWithCmdInj = {
        ...mockContext,
        data: 'file$(ls -la)',
      };

      const result = await plugin.scanRequest(contextWithCmdInj, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats[0].type).toBe('command_injection');
    });
  });

  describe('Path Traversal Detection', () => {
    it('should detect path traversal with ../', async () => {
      const contextWithPathTraversal = {
        ...mockContext,
        data: { path: '../../etc/passwd' },
      };

      const result = await plugin.scanRequest(contextWithPathTraversal, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats[0].type).toBe('path_traversal');
      expect(result.error?.details.threats[0].severity).toBe('medium');
    });

    it('should detect path traversal with backslashes', async () => {
      const contextWithPathTraversal = {
        ...mockContext,
        data: '..\\..\\windows\\system32',
      };

      const result = await plugin.scanRequest(contextWithPathTraversal, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats[0].type).toBe('path_traversal');
    });

    it('should detect URL-encoded path traversal', async () => {
      const contextWithPathTraversal = {
        ...mockContext,
        data: { file: '%2e%2e/secret.txt' },
      };

      const result = await plugin.scanRequest(contextWithPathTraversal, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats[0].type).toBe('path_traversal');
    });
  });

  describe('Custom Patterns', () => {
    it('should detect custom security patterns', async () => {
      const settingsWithCustom = {
        ...mockSettings,
        customPatterns: [
          {
            pattern: 'API_KEY_[A-Z0-9]{32}',
            description: 'API key detected',
            severity: 'high',
            flags: 'i',
          },
        ],
      };

      const contextWithApiKey = {
        ...mockContext,
        data: { config: 'API_KEY_ABCDEF1234567890ABCDEF1234567890' },
      };

      const result = await plugin.scanRequest(contextWithApiKey, settingsWithCustom);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats[0].type).toBe('suspicious_pattern');
      expect(result.error?.details.threats[0].description).toBe('API key detected');
      expect(result.error?.details.threats[0].severity).toBe('high');
    });

    it('should handle invalid custom regex gracefully', async () => {
      const settingsWithInvalidRegex = {
        ...mockSettings,
        customPatterns: [
          {
            pattern: '[invalid(regex',
            description: 'Invalid',
            severity: 'low',
          },
        ],
      };

      const result = await plugin.scanRequest(mockContext, settingsWithInvalidRegex);

      expect(result.success).toBe(true); // Should not fail on invalid regex
    });
  });

  describe('Scanning Behavior', () => {
    it('should skip scanning when scanRequests is false', async () => {
      const settingsNoScan = { ...mockSettings, scanRequests: false };
      const contextWithThreat = {
        ...mockContext,
        data: "'; DROP TABLE users--",
      };

      const result = await plugin.scanRequest(contextWithThreat, settingsNoScan);

      expect(result.success).toBe(true);
      expect(result.metadata.executionTime).toBe(0);
    });

    it('should skip scanning responses when scanResponses is false', async () => {
      const settingsNoScan = { ...mockSettings, scanResponses: false };
      const contextWithThreat = {
        ...mockContext,
        data: '<script>alert(1)</script>',
      };

      const result = await plugin.scanResponse(contextWithThreat, settingsNoScan);

      expect(result.success).toBe(true);
      expect(result.metadata.executionTime).toBe(0);
    });

    it('should skip scanning tool parameters when scanToolParameters is false', async () => {
      const settingsNoScan = { ...mockSettings, scanToolParameters: false };
      const contextWithThreat = {
        ...mockContext,
        data: { cmd: '| rm -rf /' },
      };

      const result = await plugin.scanToolParameters(contextWithThreat, settingsNoScan);

      expect(result.success).toBe(true);
      expect(result.metadata.executionTime).toBe(0);
    });

    it('should log threats when logThreats is true', async () => {
      const contextWithThreat = {
        ...mockContext,
        data: '<script>alert(1)</script>',
      };

      await plugin.scanRequest(contextWithThreat, mockSettings);

      expect(consoleLogSpy).toHaveBeenCalled();
      const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(loggedData.type).toBe('security_scan');
      expect(loggedData.threats).toHaveLength(1);
    });

    it('should not log when logThreats is false', async () => {
      const settingsNoLog = { ...mockSettings, logThreats: false };
      const contextWithThreat = {
        ...mockContext,
        data: '<script>alert(1)</script>',
      };

      await plugin.scanRequest(contextWithThreat, settingsNoLog);

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('Blocking Behavior', () => {
    it('should block on critical threats when blockOnThreat is true', async () => {
      const contextWithCritical = {
        ...mockContext,
        data: '| rm -rf /',
      };

      const result = await plugin.scanRequest(contextWithCritical, mockSettings);

      expect(result.success).toBe(false);
      expect(result.nextAction).toBe('stop');
      expect(result.error?.details.blocked).toBe(true);
    });

    it('should not block when blockOnThreat is false', async () => {
      const settingsNoBlock = { ...mockSettings, blockOnThreat: false };
      const contextWithThreat = {
        ...mockContext,
        data: '<script>alert(1)</script>',
      };

      const result = await plugin.scanRequest(contextWithThreat, settingsNoBlock);

      expect(result.success).toBe(true);
      expect(result.metadata.warnings).toHaveLength(1);
      expect(result.metadata.warnings[0]).toContain('security threats detected but not blocked');
    });

    it('should respect severity threshold - high', async () => {
      const settingsHighThreshold = { ...mockSettings, severityThreshold: 'high' };
      const contextWithMediumThreat = {
        ...mockContext,
        data: '../etc/passwd',
      };

      const result = await plugin.scanRequest(contextWithMediumThreat, settingsHighThreshold);

      // Medium threat should not be blocked with high threshold
      expect(result.success).toBe(true);
      expect(result.metadata.warnings).toHaveLength(1);
    });

    it('should respect severity threshold - medium', async () => {
      const settingsMediumThreshold = { ...mockSettings, severityThreshold: 'medium' };
      const contextWithMediumThreat = {
        ...mockContext,
        data: '../etc/passwd',
      };

      const result = await plugin.scanRequest(contextWithMediumThreat, settingsMediumThreshold);

      // Medium threat should be blocked with medium threshold
      expect(result.success).toBe(false);
      expect(result.nextAction).toBe('stop');
    });
  });

  describe('Multiple Threats', () => {
    it('should detect multiple threat types', async () => {
      const contextWithMultiple = {
        ...mockContext,
        data: {
          sql: "' OR 1=1--",
          xss: '<script>alert(1)</script>',
          path: '../../secret',
        },
      };

      const result = await plugin.scanRequest(contextWithMultiple, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats.length).toBeGreaterThan(1);
    });

    it('should list all threat descriptions in error message', async () => {
      const contextWithMultiple = {
        ...mockContext,
        data: "' UNION SELECT * FROM users-- <script>alert(1)</script>",
      };

      const result = await plugin.scanRequest(contextWithMultiple, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats.length).toBeGreaterThan(1);
      expect(result.error?.message).toContain('SQL injection');
      expect(result.error?.message).toContain('XSS');
    });
  });

  describe('Data Type Handling', () => {
    it('should handle string data', async () => {
      const contextWithString = {
        ...mockContext,
        data: '<script>alert(1)</script>',
      };

      const result = await plugin.scanRequest(contextWithString, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats[0].type).toBe('xss');
    });

    it('should handle object data', async () => {
      const contextWithObject = {
        ...mockContext,
        data: {
          nested: { value: '<script>alert(1)</script>' },
        },
      };

      const result = await plugin.scanRequest(contextWithObject, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.threats[0].type).toBe('xss');
    });

    it('should handle clean data', async () => {
      const contextClean = {
        ...mockContext,
        data: { message: 'This is clean text' },
      };

      const result = await plugin.scanRequest(contextClean, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.warnings).toHaveLength(0);
    });
  });

  describe('scanData - Direct data validation', () => {
    it('should scan data directly', async () => {
      const contextWithThreat = {
        ...mockContext,
        data: '<script>alert(1)</script>',
      };

      const result = await plugin.scanData(contextWithThreat, mockSettings);

      expect(result.success).toBe(false);
      expect(result.error?.details.scanType).toBe('data');
    });
  });

  describe('Error Handling', () => {
    it('should safely scan data with a circular reference instead of crashing', async () => {
      // Previously this test pinned the OLD broken behaviour: the scanner
      // called `JSON.stringify(data)` directly, which throws on any cycle,
      // and the whole scan errored out. That was a trivial bypass — an
      // attacker could defeat the scanner by embedding a self-reference
      // in their payload. safeStringify now replaces the cycle with
      // "[Circular]" so the scan runs to completion.
      const circularData: any = { name: 'test' };
      circularData.self = circularData;

      const contextWithCircular = {
        ...mockContext,
        data: circularData,
      };

      const result = await plugin.scanRequest(contextWithCircular, mockSettings);

      expect(result.success).toBe(true);
    });
  });

  describe('Execution Time Tracking', () => {
    it('should track execution time', async () => {
      const result = await plugin.scanRequest(mockContext, mockSettings);

      expect(result.metadata.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should track execution time even on threats', async () => {
      const contextWithThreat = {
        ...mockContext,
        data: '<script>alert(1)</script>',
      };

      const result = await plugin.scanRequest(contextWithThreat, mockSettings);

      expect(result.success).toBe(false);
      expect(result.metadata.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Regression: severityThreshold logic ────────────────────────────
  describe('severityThreshold (regression)', () => {
    it('threshold=low blocks medium+ threats (was previously only critical)', async () => {
      // Pre-fix: `severityThreshold: 'low'` only matched the critical
      // fallback branch because there was no `'low'` comparison in the
      // shouldBlock expression, so a user who set the threshold lower
      // to be MORE strict ended up STRICTER only on critical.
      const ctx = {
        ...mockContext,
        data: { path: '../../etc/passwd' }, // medium (path traversal)
      };
      const settings = { ...mockSettings, severityThreshold: 'low' };

      const result = await plugin.scanRequest(ctx, settings);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SECURITY_THREAT_DETECTED');
    });

    it('threshold=critical does NOT block a high threat', async () => {
      const ctx = {
        ...mockContext,
        data: { query: "' OR '1'='1" }, // high severity sql injection
      };
      const settings = { ...mockSettings, severityThreshold: 'critical' };

      const result = await plugin.scanRequest(ctx, settings);
      expect(result.success).toBe(true);
      expect(result.metadata.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('detected but not blocked')]),
      );
    });

    it('threshold=critical DOES block a critical threat', async () => {
      const ctx = {
        ...mockContext,
        data: 'user; rm -rf /',
      };
      const settings = { ...mockSettings, severityThreshold: 'critical' };

      const result = await plugin.scanRequest(ctx, settings);
      expect(result.success).toBe(false);
    });

    it('invalid threshold value falls back to medium', async () => {
      const ctx = {
        ...mockContext,
        data: { path: '../../etc/passwd' },
      };
      const settings = { ...mockSettings, severityThreshold: 'nonsense' };

      const result = await plugin.scanRequest(ctx, settings);
      expect(result.success).toBe(false); // medium path traversal still blocked
    });
  });

  // ── Regression: whitelistPatterns was dead code ────────────────────
  describe('whitelistPatterns (regression)', () => {
    it('suppresses a threat when every match text is whitelisted', async () => {
      // Path-traversal regex /\.\.[\/\\]/g matches the literal 3-char
      // substring `../`. If every match can be reproduced by a
      // whitelist regex, the threat is skipped.
      const ctx = {
        ...mockContext,
        data: { path: '../../etc/passwd' },
      };
      const settings = {
        ...mockSettings,
        whitelistPatterns: ['^\\.\\./$'], // accepts the exact match text
      };

      const result = await plugin.scanRequest(ctx, settings);
      expect(result.success).toBe(true);
      expect(result.metadata.warnings || []).toEqual([]);
    });

    it('still raises a threat if ANY match is not whitelisted', async () => {
      // `../` is whitelisted but the SQL-injection pattern's match text
      // isn't, so the SQL threat must still surface.
      const ctx = {
        ...mockContext,
        data: "../../etc and ' OR '1'='1",
      };
      const settings = {
        ...mockSettings,
        whitelistPatterns: ['^\\.\\./$'],
      };

      const result = await plugin.scanRequest(ctx, settings);
      expect(result.success).toBe(false);
    });

    it('ignores invalid whitelist entries instead of crashing', async () => {
      const ctx = {
        ...mockContext,
        data: { path: '../../etc/passwd' },
      };
      const settings = {
        ...mockSettings,
        whitelistPatterns: ['(unclosed', { pattern: 42 }, null],
      };

      const result = await plugin.scanRequest(ctx, settings);
      // Scan still runs; threat still detected because nothing whitelisted it.
      expect(result.success).toBe(false);
    });
  });

  // ── Regression: custom pattern ReDoS budget ────────────────────────
  describe('Custom pattern ReDoS defence (regression)', () => {
    it('refuses catastrophic-backtracking shapes up front and still runs the rest of the list', async () => {
      // The contract used to be "first slow pattern eats the budget,
      // second pattern is skipped". That was weak: a single unlucky
      // request could still hang the scanner for the duration of the
      // first match, and a clever attacker could use the bail to
      // suppress later (legitimate) patterns.
      //
      // The new contract is stronger: compileSafeRegex rejects the
      // evil pattern synchronously (zero CPU) and the loop continues
      // with the legitimate pattern that follows. Pin both halves.
      const input = 'a'.repeat(22) + '!trigger-the-second-one';
      const settings = {
        ...mockSettings,
        customPatterns: [
          { pattern: '(a+)+$', severity: 'medium' },
          { pattern: 'trigger-the-second-one', severity: 'critical' },
        ],
      };
      const ctx = { ...mockContext, data: input };

      const start = Date.now();
      const result = await plugin.scanRequest(ctx, settings);
      const elapsed = Date.now() - start;

      // Finishes fast — the evil pattern never reaches the engine.
      expect(elapsed).toBeLessThan(200);

      // And the legitimate second pattern still fires, so the
      // critical threat is detected and the scan is blocked.
      expect(result.success).toBe(false);
      const threats = (result.error?.details as any)?.threats || [];
      expect(
        threats.some(
          (t: any) => t.type === 'suspicious_pattern' && t.severity === 'critical',
        ),
      ).toBe(true);
    });

    it('drops whitelist entries that are themselves catastrophic-backtracking shapes', async () => {
      // Whitelist patterns are compiled and then matched against every
      // candidate threat value — a pathological whitelist is just as
      // dangerous as a pathological scan pattern. compileSafeRegex
      // refuses them, so a poisoned whitelist becomes a no-op (the
      // scanner continues to flag real threats as before) rather than
      // hanging the request.
      const settings = {
        ...mockSettings,
        whitelistPatterns: ['(a+)+$', 'legitimate-allowlist-entry'],
      };
      // A classic SQL-injection payload that the built-in patterns
      // will pick up as high severity — the evil whitelist entry
      // must NOT suppress it (nor hang us).
      const ctx = { ...mockContext, data: "' OR 1=1 --" };

      const start = Date.now();
      const result = await plugin.scanRequest(ctx, settings);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(200);
      // Built-in SQL-injection pattern still fires — the poisoned
      // whitelist is a no-op, not a wildcard bypass.
      expect(result.success).toBe(false);
    });
  });
});
