import { Injectable, Logger } from '@nestjs/common';

export interface ExecutionContext {
  input: Record<string, any>;
  nodes: Record<string, { output: any }>;
  variables?: Record<string, any>;
}

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

    return template.replace(/\{\{([^}]+)\}\}/g, (match, path: string) => {
      const trimmedPath = path.trim();
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
    return this.resolveProperty(path.trim(), context);
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

      current = current[part];
    }

    return current;
  }
}
