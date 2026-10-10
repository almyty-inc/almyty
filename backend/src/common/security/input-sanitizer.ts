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

const LINE_BREAK = /[\n\r\u2028\u2029]/;
const SHELL_META = /[;&|`$]/;
const SHELL_COMMAND = /(?:rm|curl|wget|nc|ncat|bash|sh|python|perl|ruby|php)\b/i;

/**
 * The patterns below that span "X, then Y later on the line" used to be
 * written `/X.*Y/`, which the engine retries from every X: 100 KB of `;`,
 * `{{` or `${` in one tool argument (an LLM or an MCP client chooses
 * those) held the event loop for three to six seconds. Each is now
 * answered from the first X on each line, with the same result: a later
 * X on the same line can only see less of it.
 */

/** `/[;&|`$].*(?:rm|curl|...|php)\b/i` */
function hasShellCommand(value: string): boolean {
  for (const line of value.split(LINE_BREAK)) {
    const meta = line.search(SHELL_META);
    if (meta !== -1 && SHELL_COMMAND.test(line.slice(meta + 1))) return true;
  }
  return false;
}

/** `/<open>.*<close>/`: `open`, then `close` after it on the same line. */
function hasOnOneLine(value: string, open: string, close: string): boolean {
  for (const line of value.split(LINE_BREAK)) {
    const start = line.indexOf(open);
    if (start !== -1 && line.indexOf(close, start + open.length) !== -1) return true;
  }
  return false;
}

/**
 * `/<!DOCTYPE[^>]*SYSTEM/i`. Every `<!DOCTYPE` before the same `>` sees
 * a suffix of the first one's declaration, so one look per declaration.
 */
function hasDoctypeSystem(value: string): boolean {
  const lower = value.toLowerCase();
  let at = 0;
  for (;;) {
    const start = lower.indexOf('<!doctype', at);
    if (start === -1) return false;
    const gt = lower.indexOf('>', start + 9);
    if (lower.slice(start + 9, gt === -1 ? lower.length : gt).includes('system')) return true;
    if (gt === -1) return false;
    at = gt + 1;
  }
}

const matches = (pattern: RegExp) => (value: string) => pattern.test(value);

// Patterns that suggest injection attempts. `command` marks the checks a
// tool's executable inputs skip (tools/tool-executable-inputs.ts): a shell
// tool's command is supposed to contain shell syntax.
const INJECTION_PATTERNS: Array<{ name: string; test: (value: string) => boolean; severity: 'block' | 'warn'; command?: true }> = [
  // Command injection
  { name: 'shell-command', test: hasShellCommand, severity: 'block', command: true },
  { name: 'backtick-exec', test: matches(/`[^`]+`/), severity: 'warn', command: true },

  // XML entity injection (XXE)
  { name: 'xxe-entity', test: matches(/<!ENTITY\s/i), severity: 'block' },
  { name: 'xxe-system', test: hasDoctypeSystem, severity: 'block' },

  // Path traversal
  { name: 'path-traversal', test: matches(/\.\.[/\\]/), severity: 'warn' },

  // SSRF via parameter values
  { name: 'ssrf-localhost', test: matches(/(?:^|\s)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(?::\d+)?(?:\s|$|\/)/i), severity: 'warn' },
  { name: 'ssrf-metadata', test: matches(/169\.254\.169\.254/i), severity: 'block' },

  // Template injection
  { name: 'template-injection', test: (value) => hasOnOneLine(value, '{{', '}}'), severity: 'warn' },
  { name: 'ssti', test: (value) => hasOnOneLine(value, '${', '}'), severity: 'warn' },
];

/**
 * Sanitize tool parameters before execution.
 * Returns warnings for suspicious patterns and blocks critical ones.
 *
 * `executableInputs` names the top-level parameters that are the command
 * the tool runs (tools/tool-executable-inputs.ts); the command-injection
 * checks skip them and every other check still applies.
 */
export function sanitizeToolParameters(
  parameters: Record<string, any>,
  options?: { strict?: boolean; executableInputs?: string[] },
): SanitizationResult {
  const warnings: string[] = [];
  const sanitized = deepClone(parameters);
  let safe = true;
  const executable = new Set((options?.executableInputs ?? []).map((key) => `params.${key}`));

  function scanValue(value: any, path: string): any {
    if (typeof value === 'string') {
      for (const { name, test, severity, command } of INJECTION_PATTERNS) {
        if (command && executable.has(path)) continue;
        if (test(value)) {
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
