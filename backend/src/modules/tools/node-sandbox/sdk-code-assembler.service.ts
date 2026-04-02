import { Injectable, Logger } from '@nestjs/common';
import { SdkConfig, SdkValue } from './types';

/**
 * Assembles executable JavaScript code from an SdkConfig definition.
 * The generated code is intended to run inside the Node sandbox worker,
 * where `parameters` and `credentials` are available as global objects.
 */
@Injectable()
export class SdkCodeAssemblerService {
  private readonly logger = new Logger(SdkCodeAssemblerService.name);

  /**
   * Generate executable code from an SDK configuration.
   *
   * @param config - The SDK configuration describing imports, construction, and method calls
   * @returns JavaScript code string suitable for sandbox execution
   */
  assemble(config: SdkConfig): string {
    const lines: string[] = [];

    // 1. Imports (require statements)
    lines.push(...this.renderImports(config));

    // 2. Client construction (if any)
    if (config.construct) {
      const args = config.construct.args
        .map((a) => this.renderValue(a))
        .join(', ');
      lines.push(
        `const client = new ${config.construct.className}(${args});`,
      );
      lines.push('');
    }

    // 3. Method call
    lines.push(...this.renderCall(config));

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Import rendering
  // ---------------------------------------------------------------------------

  private renderImports(config: SdkConfig): string[] {
    const lines: string[] = [];

    // Group imports: default vs named
    const defaultImports = config.imports.filter((i) => i.isDefault);
    const namedImports = config.imports.filter((i) => !i.isDefault);

    for (const imp of defaultImports) {
      lines.push(
        `const ${imp.name} = require('${config.packageName}');`,
      );
    }

    if (namedImports.length > 0) {
      const names = namedImports.map((i) => i.name).join(', ');
      lines.push(
        `const { ${names} } = require('${config.packageName}');`,
      );
    }

    if (lines.length > 0) {
      lines.push('');
    }

    return lines;
  }

  // ---------------------------------------------------------------------------
  // Call rendering
  // ---------------------------------------------------------------------------

  private renderCall(config: SdkConfig): string[] {
    const lines: string[] = [];
    const args = config.call.args.map((a) => this.renderValue(a)).join(', ');

    // Determine the call target
    let target: string;
    if (config.construct) {
      target = `client.${config.call.methodPath}`;
    } else {
      // Standalone function call (no client construction)
      target = config.call.methodPath;
    }

    lines.push(`const result = await ${target}(${args});`);
    lines.push('return result;');

    return lines;
  }

  // ---------------------------------------------------------------------------
  // Value rendering
  // ---------------------------------------------------------------------------

  /**
   * Recursively render an SdkValue to a JavaScript expression string.
   */
  renderValue(value: SdkValue): string {
    switch (value.type) {
      case 'literal':
        return this.renderLiteral(value.value);

      case 'parameter':
        return `parameters[${JSON.stringify(value.key)}]`;

      case 'credential':
        return `credentials[${JSON.stringify(value.key)}]`;

      case 'object':
        return this.renderObject(value.properties);

      case 'array':
        return this.renderArray(value.items);

      case 'class_instance': {
        const args = value.args.map((a) => this.renderValue(a)).join(', ');
        return `new ${value.className}(${args})`;
      }

      default:
        return 'undefined';
    }
  }

  private renderLiteral(value: string | number | boolean | null): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    return 'undefined';
  }

  private renderObject(properties: Record<string, SdkValue>): string {
    const entries = Object.entries(properties);
    if (entries.length === 0) return '{}';

    const parts = entries.map(
      ([key, val]) => `${this.renderPropertyKey(key)}: ${this.renderValue(val)}`,
    );

    // Single-line for small objects, multi-line for larger ones
    if (parts.length <= 2 && parts.every((p) => p.length < 40)) {
      return `{ ${parts.join(', ')} }`;
    }

    return `{\n  ${parts.join(',\n  ')}\n}`;
  }

  private renderArray(items: SdkValue[]): string {
    if (items.length === 0) return '[]';
    const parts = items.map((item) => this.renderValue(item));
    return `[${parts.join(', ')}]`;
  }

  /**
   * Render an object property key. If the key is a valid JS identifier,
   * use it bare; otherwise wrap in quotes.
   */
  private renderPropertyKey(key: string): string {
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) {
      return key;
    }
    return JSON.stringify(key);
  }
}
