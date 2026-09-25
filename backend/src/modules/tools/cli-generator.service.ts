import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Tool } from '../../entities/tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { servableToolsOnGateway } from '../gateways/gateway-servable';
import {
  bashComment,
  bashSingleQuote,
  cliFlagName,
  jsComment,
  jsStringLiteral,
  sanitizeSchemaText,
  singleLine,
} from '../../common/security/untrusted-text';

export interface CliOutput {
  name: string;
  content: string;
  format: 'bash' | 'node';
  toolCount: number;
}

@Injectable()
export class CliGeneratorService {
  private readonly logger = new Logger(CliGeneratorService.name);

  constructor(
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(GatewayTool)
    private gatewayToolRepository: Repository<GatewayTool>,
  ) {}

  /**
   * Generate a CLI script for a single tool.
   *
   * @param organizationId Required. Previously this lookup had no org
   *   filter, letting any authenticated user download any org's tool
   *   scripts by UUID.
   */
  async generateToolCli(
    toolId: string,
    format: 'bash' | 'node' = 'bash',
    organizationId?: string,
  ): Promise<CliOutput> {
    if (!organizationId) {
      throw new NotFoundException(`Tool not found: ${toolId}`);
    }
    const tool = await this.toolRepository.findOne({
      where: { id: toolId, organizationId },
      relations: { operation: true },
    });

    if (!tool) {
      throw new NotFoundException(`Tool not found: ${toolId}`);
    }

    const content = format === 'bash'
      ? this.renderBashScript(tool)
      : this.renderNodeScript(tool);

    return {
      name: this.slugify(tool.name),
      content,
      format,
      toolCount: 1,
    };
  }

  /**
   * Generate a CLI bundle for all tools in a gateway.
   *
   * @param organizationId Required (see generateToolCli).
   */
  async generateGatewayCliBunde(
    gatewayId: string,
    format: 'bash' | 'node' = 'bash',
    organizationId?: string,
  ): Promise<CliOutput> {
    if (!organizationId) {
      throw new NotFoundException(`Gateway not found: ${gatewayId}`);
    }
    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId, organizationId },
    });

    if (!gateway) {
      throw new NotFoundException(`Gateway not found: ${gatewayId}`);
    }

    // What the gateway serves: attached, enabled, the tool active, and in
    // the gateway's scope -- the same set its MCP/UTCP listing is built from.
    const tools = await servableToolsOnGateway(this.gatewayToolRepository, gatewayId, { operation: true });

    const content = format === 'bash'
      ? this.renderBashBundle(gateway, tools)
      : this.renderNodeBundle(gateway, tools);

    return {
      name: this.slugify(gateway.name),
      content,
      format,
      toolCount: tools.length,
    };
  }

  // --- Bash generators ---
  //
  // Everything that comes from the tool record (name, description,
  // parameter names and descriptions) is schema text an API author chose.
  // It reaches the script only through `untrusted-text` escapers: comments
  // are single-lined, echoed text is single-quoted, flags and variable
  // names are reduced to a safe charset. Nothing schema-derived is ever
  // placed inside double quotes, where `$(...)` would run.

  /** Map each schema parameter to a safe flag and shell variable. */
  private cliParams(tool: Tool): { name: string; flag: string; varName: string; schema: any; required: boolean }[] {
    const params = tool.parameters as any;
    const properties = params?.properties || {};
    const required: string[] = Array.isArray(params?.required) ? params.required : [];
    const seen = new Set<string>();
    return Object.entries(properties).map(([name, schema], index) => {
      let flag = cliFlagName(name) || `param-${index + 1}`;
      if (flag === 'help' || seen.has(flag)) flag = `${flag}-${index + 1}`;
      seen.add(flag);
      return {
        name,
        flag,
        // Prefixed so a parameter called `path` or `token` can't clobber
        // PATH or the script's own TOKEN.
        varName: `ARG_${flag.replace(/[^a-z0-9]/g, '_').toUpperCase()}`,
        schema: (schema || {}) as any,
        required: required.includes(name),
      };
    });
  }

  /** Bash helper that JSON-encodes its argument (runtime values are data too). */
  private bashJsonStringFunction(): string[] {
    return [
      'json_str() {',
      '  local s="$1"',
      '  s="${s//\\\\/\\\\\\\\}"',
      '  s="${s//\\"/\\\\\\"}"',
      "  s=\"${s//$'\\n'/\\\\n}\"",
      "  s=\"${s//$'\\r'/\\\\r}\"",
      "  s=\"${s//$'\\t'/\\\\t}\"",
      '  printf \'"%s"\' "$s"',
      '}',
    ];
  }

  private renderBashScript(tool: Tool): string {
    const params = this.cliParams(tool);

    const lines: string[] = [];
    lines.push('#!/usr/bin/env bash');
    lines.push(bashComment(`CLI wrapper for: ${tool.name}`));
    lines.push(bashComment(tool.description || 'No description'));
    lines.push(`# Generated by almyty`);
    lines.push('');
    lines.push('set -euo pipefail');
    lines.push('');

    // Configuration
    lines.push('# Configuration');
    lines.push('BASE_URL="${ALMYTY_BASE_URL:-http://localhost:4000}"');
    lines.push('TOKEN="${ALMYTY_TOKEN:-}"');
    lines.push('');
    lines.push(...this.bashJsonStringFunction());
    lines.push('');

    // Usage function
    lines.push('usage() {');
    lines.push(`  echo "Usage: $0 [options]"`);
    lines.push('  echo ""');
    lines.push('  echo "Options:"');
    for (const p of params) {
      const text = `  --${p.flag} <${singleLine(p.schema.type || 'string', 32)}>  ${singleLine(p.schema.description || p.name)}${p.required ? ' (required)' : ''}`;
      lines.push(`  echo ${bashSingleQuote(text)}`);
    }
    lines.push('  echo "  --help                Show this help"');
    lines.push('  exit 1');
    lines.push('}');
    lines.push('');

    // Parse arguments
    lines.push('# Parse arguments');
    for (const p of params) {
      lines.push(`${p.varName}=""`);
      lines.push(`${p.varName}_SET=""`);
    }
    lines.push('');
    lines.push('while [[ $# -gt 0 ]]; do');
    lines.push('  case "$1" in');
    for (const p of params) {
      lines.push(`    --${p.flag}) ${p.varName}="$2"; ${p.varName}_SET=1; shift 2 ;;`);
    }
    lines.push('    --help) usage ;;');
    lines.push('    *) echo "Unknown option: $1"; usage ;;');
    lines.push('  esac');
    lines.push('done');
    lines.push('');

    // Validate required
    const required = params.filter((p) => p.required);
    if (required.length > 0) {
      lines.push('# Validate required parameters');
      for (const p of required) {
        lines.push(`if [[ -z "$${p.varName}_SET" ]]; then echo "Error: --${p.flag} is required"; usage; fi`);
      }
      lines.push('');
    }

    // Build JSON body. Keys are JSON-encoded at generation time and
    // single-quoted; values are JSON-encoded at run time by json_str.
    lines.push('# Build request');
    lines.push('JSON_BODY=""');
    for (const p of params) {
      const key = bashSingleQuote(`${JSON.stringify(sanitizeSchemaText(p.name, 256))}:`);
      lines.push(
        `if [[ -n "$${p.varName}_SET" ]]; then JSON_BODY+="\${JSON_BODY:+,}"${key}"$(json_str "$${p.varName}")"; fi`,
      );
    }
    lines.push('JSON_BODY="{${JSON_BODY}}"');
    lines.push('');

    // Execute via almyty UTCP endpoint
    lines.push('# Execute tool via almyty');
    lines.push(`curl -s -X POST \\`);
    lines.push(`  "\${BASE_URL}/utcp/tools/${this.slugify(tool.name)}/execute" \\`);
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push('  -H "Authorization: Bearer ${TOKEN}" \\');
    lines.push('  -d "$JSON_BODY" | python3 -m json.tool 2>/dev/null || cat');
    lines.push('');

    return lines.join('\n');
  }

  private renderBashBundle(gateway: any, tools: Tool[]): string {
    const lines: string[] = [];
    lines.push('#!/usr/bin/env bash');
    lines.push(bashComment(`CLI bundle for gateway: ${gateway.name}`));
    lines.push(`# ${tools.length} tools available`);
    lines.push(`# Generated by almyty`);
    lines.push('');
    lines.push('set -euo pipefail');
    lines.push('');
    lines.push('BASE_URL="${ALMYTY_BASE_URL:-http://localhost:4000}"');
    lines.push('TOKEN="${ALMYTY_TOKEN:-}"');
    lines.push('');
    lines.push(...this.bashJsonStringFunction());
    lines.push('');

    // List available commands
    lines.push('usage() {');
    lines.push(`  echo ${bashSingleQuote(`${singleLine(gateway.name)} CLI`)}`);
    lines.push('  echo ""');
    lines.push('  echo "Commands:"');
    for (const tool of tools) {
      lines.push(`  echo ${bashSingleQuote(`  ${this.slugify(tool.name)}  ${singleLine(tool.description || 'No description')}`)}`);
    }
    lines.push('  echo ""');
    lines.push('  echo "Usage: $0 <command> [--param value ...]"');
    lines.push('  exit 1');
    lines.push('}');
    lines.push('');

    lines.push('if [[ $# -lt 1 ]]; then usage; fi');
    lines.push('');
    lines.push('COMMAND="$1"; shift');
    lines.push('');

    // Build JSON from remaining args
    lines.push('# Build JSON body from --key value pairs');
    lines.push('JSON_BODY=""');
    lines.push('while [[ $# -gt 0 ]]; do');
    lines.push('  KEY="${1#--}"');
    lines.push('  VALUE="${2:-}"');
    lines.push('  JSON_BODY+="${JSON_BODY:+,}$(json_str "$KEY"):$(json_str "$VALUE")"');
    lines.push('  shift 2 || shift');
    lines.push('done');
    lines.push('JSON_BODY="{${JSON_BODY}}"');
    lines.push('');

    // Execute
    lines.push('curl -s -X POST \\');
    lines.push('  "${BASE_URL}/utcp/tools/${COMMAND}/execute" \\');
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push('  -H "Authorization: Bearer ${TOKEN}" \\');
    lines.push('  -d "$JSON_BODY" | python3 -m json.tool 2>/dev/null || cat');
    lines.push('');

    return lines.join('\n');
  }

  // --- Node.js generators ---
  //
  // Schema text becomes JS only as JSON string literals or single-line
  // comments; object keys are accessed with JSON-encoded names.

  private renderNodeScript(tool: Tool): string {
    const params = this.cliParams(tool);

    const lines: string[] = [];
    lines.push('#!/usr/bin/env node');
    lines.push(jsComment(`CLI wrapper for: ${tool.name}`));
    lines.push(jsComment(tool.description || 'No description'));
    lines.push('// Generated by almyty');
    lines.push('');
    lines.push("const BASE_URL = process.env.ALMYTY_BASE_URL || 'http://localhost:4000';");
    lines.push("const TOKEN = process.env.ALMYTY_TOKEN || '';");
    lines.push('');

    // Parse args
    lines.push('function parseArgs(args) {');
    lines.push('  const parsed = {};');
    lines.push('  for (let i = 0; i < args.length; i++) {');
    lines.push("    if (args[i].startsWith('--')) {");
    lines.push('      const key = args[i].slice(2);');
    lines.push('      parsed[key] = args[i + 1] || true;');
    lines.push('      i++;');
    lines.push('    }');
    lines.push('  }');
    lines.push('  return parsed;');
    lines.push('}');
    lines.push('');

    lines.push('async function main() {');
    lines.push('  const args = parseArgs(process.argv.slice(2));');
    lines.push('');

    // Help
    lines.push("  if (args.help) {");
    lines.push(`    console.log(${jsStringLiteral(`Usage: ${this.slugify(tool.name)} [options]`)});`);
    lines.push("    console.log('');");
    lines.push("    console.log('Options:');");
    for (const p of params) {
      const text = `  --${p.flag} <${singleLine(p.schema.type || 'string', 32)}>  ${singleLine(p.schema.description || p.name)}${p.required ? ' (required)' : ''}`;
      lines.push(`    console.log(${jsStringLiteral(text)});`);
    }
    lines.push("    process.exit(0);");
    lines.push('  }');
    lines.push('');

    // Validate required
    const required = params.filter((p) => p.required);
    if (required.length > 0) {
      for (const p of required) {
        lines.push(`  if (!args[${jsStringLiteral(p.flag)}]) { console.error(${jsStringLiteral(`Error: --${p.flag} is required`)}); process.exit(1); }`);
      }
      lines.push('');
    }

    // Build params object
    lines.push('  const params = {};');
    for (const p of params) {
      const flag = jsStringLiteral(p.flag);
      lines.push(`  if (args[${flag}] !== undefined) params[${jsStringLiteral(p.name, 256)}] = args[${flag}];`);
    }
    lines.push('');

    // Execute
    lines.push(`  const response = await fetch(\`\${BASE_URL}/utcp/tools/${this.slugify(tool.name)}/execute\`, {`);
    lines.push("    method: 'POST',");
    lines.push("    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },");
    lines.push('    body: JSON.stringify(params),');
    lines.push('  });');
    lines.push('');
    lines.push('  const result = await response.json();');
    lines.push('  console.log(JSON.stringify(result, null, 2));');
    lines.push('}');
    lines.push('');
    lines.push('main().catch(err => { console.error(err.message); process.exit(1); });');
    lines.push('');

    return lines.join('\n');
  }

  private renderNodeBundle(gateway: any, tools: Tool[]): string {
    const lines: string[] = [];
    lines.push('#!/usr/bin/env node');
    lines.push(jsComment(`CLI bundle for gateway: ${gateway.name}`));
    lines.push(`// ${tools.length} tools available`);
    lines.push('// Generated by almyty');
    lines.push('');
    lines.push("const BASE_URL = process.env.ALMYTY_BASE_URL || 'http://localhost:4000';");
    lines.push("const TOKEN = process.env.ALMYTY_TOKEN || '';");
    lines.push('');

    lines.push('const COMMANDS = {');
    for (const tool of tools) {
      lines.push(`  ${jsStringLiteral(this.slugify(tool.name))}: ${jsStringLiteral(singleLine(tool.description || 'No description'))},`);
    }
    lines.push('};');
    lines.push('');

    lines.push('function parseArgs(args) {');
    lines.push('  const parsed = {};');
    lines.push('  for (let i = 0; i < args.length; i++) {');
    lines.push("    if (args[i].startsWith('--')) {");
    lines.push('      parsed[args[i].slice(2)] = args[i + 1] || true;');
    lines.push('      i++;');
    lines.push('    }');
    lines.push('  }');
    lines.push('  return parsed;');
    lines.push('}');
    lines.push('');

    lines.push('async function main() {');
    lines.push('  const command = process.argv[2];');
    lines.push('  const args = parseArgs(process.argv.slice(3));');
    lines.push('');
    lines.push("  if (!command || command === '--help') {");
    lines.push(`    console.log(${jsStringLiteral(`${singleLine(gateway.name)} CLI`)});`);
    lines.push("    console.log('');");
    lines.push("    console.log('Commands:');");
    lines.push("    for (const [name, desc] of Object.entries(COMMANDS)) {");
    lines.push("      console.log(`  ${name}  ${desc}`);");
    lines.push('    }');
    lines.push("    process.exit(0);");
    lines.push('  }');
    lines.push('');
    lines.push('  if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {');
    lines.push("    console.error(`Unknown command: ${command}`);");
    lines.push("    process.exit(1);");
    lines.push('  }');
    lines.push('');
    lines.push('  const response = await fetch(`${BASE_URL}/utcp/tools/${command}/execute`, {');
    lines.push("    method: 'POST',");
    lines.push("    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },");
    lines.push('    body: JSON.stringify(args),');
    lines.push('  });');
    lines.push('');
    lines.push('  const result = await response.json();');
    lines.push('  console.log(JSON.stringify(result, null, 2));');
    lines.push('}');
    lines.push('');
    lines.push('main().catch(err => { console.error(err.message); process.exit(1); });');
    lines.push('');

    return lines.join('\n');
  }

  // --- Helpers ---

  private slugify(name: string): string {
    if (!name) return 'unnamed';
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'unnamed';
  }
}