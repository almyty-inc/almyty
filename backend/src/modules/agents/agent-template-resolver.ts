import { Injectable, Logger } from '@nestjs/common';

export interface ExecutionContext {
  input: Record<string, any>;
  nodes: Record<string, { output: any }>;
  variables?: Record<string, any>;
}

/** Maximum allowed length for a single template expression (inside {{ }}). */
const MAX_EXPRESSION_LENGTH = 500;

/** Maximum allowed total length for a template string. */
const MAX_TEMPLATE_LENGTH = 10000;

/**
 * Blocklist of property names / keywords that must never appear in an expression.
 * Guards against prototype-pollution and sandbox-escape attempts.
 */
const EXPRESSION_BLOCKLIST = [
  '__proto__',
  'constructor',
  'prototype',
  'process',
  'require',
  'import',
  'global',
  'window',
  'Function',
  'eval',
];

/**
 * Blocklisted segment matcher. Previously this was a bare
 * `EXPRESSION_BLOCKLIST.join('|')` without word boundaries, so ANY
 * path whose segment happened to contain a blocked word as a substring
 * got rejected. Real false-positive examples from production configs:
 *
 *   nodes.processor.output   → blocked (because 'process' is a
 *                              substring of 'processor')
 *   input.importItems        → blocked (contains 'import')
 *   variables.globalConfig   → blocked (contains 'global')
 *   input.constructorName    → blocked (contains 'constructor')
 *
 * The blocklist is there to stop someone sneaking sandbox-escape
 * expressions through — but only for whole dot-separated segments
 * (e.g. `{{constructor.name}}`), not for any identifier that happens
 * to share letters with one. Check each segment individually.
 */
const BLOCKED_SEGMENTS = new Set(EXPRESSION_BLOCKLIST);

function containsBlockedSegment(expression: string): boolean {
  for (const segment of expression.split('.')) {
    if (BLOCKED_SEGMENTS.has(segment)) return true;
  }
  return false;
}

/** Allowed expression pattern: only alphanumeric, underscores, hyphens, and dots. */
const SAFE_PATH_REGEX = /^[a-zA-Z0-9_\-]+(\.[a-zA-Z0-9_\-]+)*$/;

@Injectable()
export class AgentTemplateResolver {
  private readonly logger = new Logger(AgentTemplateResolver.name);

  /**
   * Resolves all {{...}} template expressions in the given string.
   * Supports:
   *   {{input.field}}         — access execution input
   *   {{nodes.nodeId.output}} — access a previous node's output
   *   {{variables.key}}       — access agent-level variables
   *
   * Uses safe dot-notation property access (NO eval).
   */
  resolve(template: string, context: ExecutionContext): string {
    if (!template || typeof template !== 'string') {
      return template;
    }

    // Enforce max template length
    if (template.length > MAX_TEMPLATE_LENGTH) {
      throw new Error(
        `Template length (${template.length}) exceeds maximum allowed (${MAX_TEMPLATE_LENGTH})`,
      );
    }

    return template.replace(/\{\{([^}]+)\}\}/g, (match, path: string) => {
      const trimmedPath = path.trim();

      // Validate expression before resolving
      this.validateExpression(trimmedPath);

      const resolved = this.resolveProperty(trimmedPath, context);

      if (resolved === undefined || resolved === null) {
        this.logger.warn(`Template expression '${trimmedPath}' resolved to ${resolved}`);
        return '';
      }

      // If the resolved value is an object, JSON-stringify it
      if (typeof resolved === 'object') {
        return JSON.stringify(resolved);
      }

      return String(resolved);
    });
  }

  /**
   * Resolves a value from context using dot-notation.
   * For example: "input.name" or "nodes.llm1.output.content"
   */
  resolveValue(path: string, context: ExecutionContext): any {
    const trimmedPath = path.trim();
    this.validateExpression(trimmedPath);
    return this.resolveProperty(trimmedPath, context);
  }

  /**
   * Validate that a template expression is safe to resolve.
   * Throws if the expression is too long, contains blocked keywords,
   * or uses anything other than dot-notation property access.
   */
  private validateExpression(expression: string): void {
    // Length check
    if (expression.length > MAX_EXPRESSION_LENGTH) {
      throw new Error(
        `Template expression length (${expression.length}) exceeds maximum allowed (${MAX_EXPRESSION_LENGTH})`,
      );
    }

    // Whitelist check FIRST: only dot-notation property access. We
    // need this in place before we try to split the expression on
    // dots for the blocklist check, otherwise garbage like
    // `constructor()` could slip past the segment matcher.
    if (!SAFE_PATH_REGEX.test(expression)) {
      throw new Error(
        `Template expression contains invalid characters: '${expression}'`,
      );
    }

    // Blocklist check: reject if ANY whole dot-separated segment
    // matches a blocked keyword. See containsBlockedSegment for the
    // rationale — previously this was a naive substring match that
    // false-positived on legitimate identifiers like `processor`
    // or `importItems`.
    if (containsBlockedSegment(expression)) {
      throw new Error(
        `Template expression contains a blocked keyword: '${expression}'`,
      );
    }
  }

  private resolveProperty(path: string, context: ExecutionContext): any {
    const parts = path.split('.');
    let current: any = context;

    for (const part of parts) {
      if (current === undefined || current === null) {
        return undefined;
      }

      if (typeof current !== 'object') {
        return undefined;
      }

      // Only access own properties — never walk the prototype chain
      if (!Object.prototype.hasOwnProperty.call(current, part)) {
        return undefined;
      }

      current = current[part];
    }

    return current;
  }
}
