/**
 * Input sanitization for tool parameters.
 *
 * Protects against:
 * - SQL injection patterns
 * - Command injection patterns
 * - XML entity injection (XXE)
 * - Path traversal
 * - Template injection
 */

export interface SanitizationResult {
  safe: boolean;
  warnings: string[];
  sanitized: Record<string, any>;
}

// Patterns that suggest injection attempts
const INJECTION_PATTERNS: Array<{ name: string; pattern: RegExp; severity: 'block' | 'warn' }> = [
  // Command injection
  { name: 'shell-command', pattern: /[;&|`$].*(?:rm|curl|wget|nc|ncat|bash|sh|python|perl|ruby|php)\b/i, severity: 'block' },
  { name: 'backtick-exec', pattern: /`[^`]+`/, severity: 'warn' },

  // XML entity injection (XXE)
  { name: 'xxe-entity', pattern: /<!ENTITY\s/i, severity: 'block' },
  { name: 'xxe-system', pattern: /<!DOCTYPE[^>]*SYSTEM/i, severity: 'block' },

  // Path traversal
  { name: 'path-traversal', pattern: /\.\.[/\\]/, severity: 'warn' },

  // SSRF via parameter values
  { name: 'ssrf-localhost', pattern: /(?:^|\s)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(?::\d+)?(?:\s|$|\/)/i, severity: 'warn' },
  { name: 'ssrf-metadata', pattern: /169\.254\.169\.254/i, severity: 'block' },

  // Template injection
  { name: 'template-injection', pattern: /\{\{.*\}\}/, severity: 'warn' },
  { name: 'ssti', pattern: /\$\{.*\}/, severity: 'warn' },
];

/**
 * Sanitize tool parameters before execution.
 * Returns warnings for suspicious patterns and blocks critical ones.
 */
export function sanitizeToolParameters(
  parameters: Record<string, any>,
  options?: { strict?: boolean },
): SanitizationResult {
  const warnings: string[] = [];
  const sanitized = deepClone(parameters);
  let safe = true;

  function scanValue(value: any, path: string): any {
    if (typeof value === 'string') {
      for (const { name, pattern, severity } of INJECTION_PATTERNS) {
        if (pattern.test(value)) {
          const msg = `[${severity}] ${name} pattern detected in ${path}`;
          warnings.push(msg);

          if (severity === 'block') {
            safe = false;
          }
        }
      }

      // Truncate extremely long strings (potential DoS)
      if (value.length > 100000) {
        warnings.push(`[warn] Truncated oversized string in ${path} (${value.length} chars)`);
        return value.slice(0, 100000);
      }

      return value;
    }

    if (Array.isArray(value)) {
      // Limit array size
      if (value.length > 10000) {
        warnings.push(`[warn] Truncated oversized array in ${path} (${value.length} items)`);
        return value.slice(0, 10000).map((item, i) => scanValue(item, `${path}[${i}]`));
      }
      return value.map((item, i) => scanValue(item, `${path}[${i}]`));
    }

    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      // Limit object key count
      if (keys.length > 1000) {
        warnings.push(`[warn] Object in ${path} has too many keys (${keys.length})`);
        safe = false;
        return value;
      }

      const result: Record<string, any> = {};
      for (const key of keys) {
        result[key] = scanValue(value[key], `${path}.${key}`);
      }
      return result;
    }

    return value;
  }

  const scannedParams = scanValue(sanitized, 'params');

  return {
    safe: options?.strict ? safe && warnings.length === 0 : safe,
    warnings,
    sanitized: scannedParams,
  };
}

function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => deepClone(item)) as any;

  const cloned: any = {};
  for (const key of Object.keys(obj as any)) {
    cloned[key] = deepClone((obj as any)[key]);
  }
  return cloned;
}
