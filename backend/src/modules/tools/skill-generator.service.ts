import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Tool, ToolType, ToolExecutionMethod } from '../../entities/tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';

export interface SkillOutput {
  name: string;
  content: string;
  toolCount: number;
}

export interface IndividualSkill {
  name: string;
  fileName: string;
  content: string;
}

@Injectable()
export class SkillGeneratorService {
  private readonly logger = new Logger(SkillGeneratorService.name);

  constructor(
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(GatewayTool)
    private gatewayToolRepository: Repository<GatewayTool>,
  ) {}

  /**
   * Generate a SKILL.md file for a single tool (Agent Skills standard).
   *
   * @param organizationId Required. Without this any authenticated user
   *   could request another org's tool skill just by guessing a UUID.
   */
  async generateToolSkill(toolId: string, organizationId: string): Promise<SkillOutput> {
    if (!organizationId) {
      throw new NotFoundException(`Tool not found: ${toolId}`);
    }
    const tool = await this.toolRepository.findOne({
      where: { id: toolId, organizationId },
      relations: ['categories', 'operation', 'operation.api'],
    });

    if (!tool) {
      throw new NotFoundException(`Tool not found: ${toolId}`);
    }

    const content = this.renderToolSkillMd(tool);
    return {
      name: this.slugify(tool.name),
      content,
      toolCount: 1,
    };
  }

  /**
   * Generate a combined skill bundle for a gateway (single markdown file).
   *
   * @param organizationId Required (see generateToolSkill).
   */
  async generateGatewaySkills(gatewayId: string, organizationId: string): Promise<SkillOutput> {
    if (!organizationId) {
      throw new NotFoundException(`Gateway not found: ${gatewayId}`);
    }
    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId, organizationId },
    });

    if (!gateway) {
      throw new NotFoundException(`Gateway not found: ${gatewayId}`);
    }

    const tools = await this.getGatewayTools(gatewayId);

    if (tools.length === 0) {
      return {
        name: this.slugify(gateway.name),
        content: this.renderEmptyGatewaySkill(gateway),
        toolCount: 0,
      };
    }

    const content = this.renderGatewaySkill(gateway, tools);
    return {
      name: this.slugify(gateway.name),
      content,
      toolCount: tools.length,
    };
  }

  /**
   * Generate individual SKILL.md files per tool for a gateway.
   * Used by the skills CLI to install into agent directories.
   *
   * Per Agent Skills spec: frontmatter `name` must match parent directory name.
   * Directory = `almyty-{slug}`, so name = `almyty-{slug}`.
   */
  async generateIndividualSkills(
    gatewayId: string,
    organizationId: string,
    context?: { orgSlug?: string; gatewaySlug?: string },
  ): Promise<IndividualSkill[]> {
    if (!organizationId) {
      throw new NotFoundException(`Gateway not found: ${gatewayId}`);
    }
    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId, organizationId },
    });

    if (!gateway) {
      throw new NotFoundException(`Gateway not found: ${gatewayId}`);
    }

    const tools = await this.getGatewayTools(gatewayId);

    return tools.map(tool => {
      const slug = this.slugify(tool.name);
      const fileName = `almyty-${slug}`;
      return {
        name: slug,
        fileName,
        // Use fileName as skillName so frontmatter name matches directory
        content: this.renderToolSkillMd(tool, fileName, context),
      };
    });
  }

  private async getGatewayTools(gatewayId: string): Promise<Tool[]> {
    const gatewayTools = await this.gatewayToolRepository.find({
      where: { gatewayId, isActive: true },
      relations: ['tool', 'tool.categories', 'tool.operation', 'tool.operation.api'],
    });

    return gatewayTools.map(gt => gt.tool).filter(Boolean);
  }

  /**
   * Render a SKILL.md following the Agent Skills open standard.
   * https://agentskills.io/specification
   *
   * @param tool The tool to render
   * @param skillName Optional override for the frontmatter `name` field.
   *   When provided (e.g. `almyty-find-pet-by-id`), ensures name matches
   *   the parent directory per the Agent Skills spec.
   */
  private renderToolSkillMd(tool: Tool, skillName?: string, context?: { orgSlug?: string; gatewaySlug?: string }): string {
    const params = tool.parameters as any;
    const properties = params?.properties || {};
    const required = params?.required || [];
    const method = tool.operation?.method || '';
    const endpoint = tool.operation?.endpoint || '';
    const baseUrl = tool.operation?.api?.baseUrl?.replace(/\/$/, '') || '';
    const isApiTool = !!tool.operation && !!method && !!endpoint;

    const lines: string[] = [];

    // YAML frontmatter (Agent Skills standard)
    lines.push('---');
    lines.push(`name: ${skillName || this.slugify(tool.name)}`);
    lines.push(`description: ${this.escapeYaml(this.buildDescription(tool))}`);
    lines.push('metadata:');
    lines.push('  author: almyty');
    lines.push('  generated: "true"');
    if (tool.version) {
      lines.push(`  version: "${tool.version}"`);
    }
    lines.push('---');
    lines.push('');

    // Title
    lines.push(`# ${tool.name}`);
    lines.push('');

    // Description
    if (tool.description) {
      lines.push(tool.description);
      lines.push('');
    }

    // When to use
    lines.push('## When to use');
    lines.push('');
    lines.push(this.generateWhenToUse(tool));
    lines.push('');

    // API endpoint (for API tools with operation data)
    if (isApiTool) {
      const fullUrl = baseUrl
        ? `${baseUrl}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`
        : endpoint;
      lines.push('## HTTP endpoint');
      lines.push('');
      lines.push('```');
      lines.push(`${method} ${fullUrl}`);
      lines.push('```');
      lines.push('');
    }

    // Parameters
    if (Object.keys(properties).length > 0) {
      lines.push('## Parameters');
      lines.push('');
      for (const [pName, schema] of Object.entries(properties)) {
        const paramSchema = schema as any;
        const isRequired = required.includes(pName);
        const typeStr = paramSchema.type || 'string';
        const desc = paramSchema.description || '';
        const reqLabel = isRequired ? ', **required**' : '';
        lines.push(`- \`${pName}\` (${typeStr}${reqLabel}): ${desc}`);
      }
      lines.push('');
    }

    // Example
    lines.push('## Example');
    lines.push('');
    if (isApiTool) {
      lines.push(this.generateCurlExample(tool, properties, required));
    } else {
      lines.push(this.generateJsonExample(tool, properties, required));
    }
    lines.push('');

    // Invocation section (only if context with slugs is provided)
    if (context?.orgSlug && context?.gatewaySlug) {
      const skillSlug = this.slugify(tool.name);
      const requiredFlags = required.map(p => `--${p} <${p}>`).join(' ');
      lines.push('## Invocation');
      lines.push('');
      lines.push('Run this tool directly:');
      lines.push('```bash');
      lines.push(`npx @almyty/skills run @${context.orgSlug}/${context.gatewaySlug}/${skillSlug}${requiredFlags ? ' ' + requiredFlags : ''}`);
      lines.push('```');
      lines.push('');
    }

    // Skip generic error handling section — adds no value

    return lines.join('\n');
  }

  /**
   * Render a gateway skill bundle (overview + per-tool sections).
   */
  private renderGatewaySkill(gateway: any, tools: Tool[]): string {
    const lines: string[] = [];

    // YAML frontmatter
    lines.push('---');
    lines.push(`name: ${this.slugify(gateway.name)}`);
    lines.push(`description: ${this.escapeYaml(`API tools for ${gateway.name}. ${tools.length} tools available. Use when interacting with the ${gateway.name} API.`)}`);
    lines.push('metadata:');
    lines.push('  author: almyty');
    lines.push('  generated: "true"');
    lines.push('---');
    lines.push('');

    // Overview
    lines.push(`# ${gateway.name}`);
    lines.push('');
    lines.push(`This gateway provides ${tools.length} API tools.`);
    lines.push('');

    // Tool index
    lines.push('## Available tools');
    lines.push('');
    for (const tool of tools) {
      lines.push(`- **${tool.name}**: ${tool.description || 'No description'}`);
    }
    lines.push('');

    // Per-tool sections
    for (const tool of tools) {
      const params = tool.parameters as any;
      const properties = params?.properties || {};
      const required = params?.required || [];
      const method = tool.operation?.method || '';
      const endpoint = tool.operation?.endpoint || '';
      const baseUrl = tool.operation?.api?.baseUrl?.replace(/\/$/, '') || '';
      const isApiTool = !!tool.operation && !!method && !!endpoint;

      lines.push('---');
      lines.push('');
      lines.push(`### ${tool.name}`);
      lines.push('');
      if (tool.description) {
        lines.push(tool.description);
        lines.push('');
      }

      if (isApiTool) {
        const fullUrl = baseUrl
          ? `${baseUrl}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`
          : endpoint;
        lines.push('```');
        lines.push(`${method} ${fullUrl}`);
        lines.push('```');
        lines.push('');
      }

      if (Object.keys(properties).length > 0) {
        lines.push('**Parameters:**');
        lines.push('');
        for (const [name, schema] of Object.entries(properties)) {
          const paramSchema = schema as any;
          const isRequired = required.includes(name);
          lines.push(`- \`${name}\` (${paramSchema.type || 'string'}${isRequired ? ', required' : ''}): ${paramSchema.description || ''}`);
        }
        lines.push('');
      }

      if (isApiTool) {
        lines.push(this.generateCurlExample(tool, properties, required));
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private renderEmptyGatewaySkill(gateway: any): string {
    return [
      '---',
      `name: ${this.slugify(gateway.name)}`,
      `description: ${this.escapeYaml(`API tools for ${gateway.name}. Use when interacting with the ${gateway.name} API.`)}`,
      'metadata:',
      '  author: almyty',
      '  generated: "true"',
      '---',
      '',
      `# ${gateway.name}`,
      '',
      'No tools are currently assigned to this gateway.',
      '',
    ].join('\n');
  }

  private buildDescription(tool: Tool): string {
    const desc = tool.description || tool.name;
    if (desc.length > 300) return desc.substring(0, 297) + '...';
    return desc;
  }

  private generateWhenToUse(tool: Tool): string {
    const desc = tool.description || '';
    const method = tool.operation?.method?.toUpperCase() || '';
    const endpoint = tool.operation?.endpoint || '';

    const lines: string[] = [];
    if (desc) lines.push(`- ${desc}`);
    if (method && endpoint) lines.push(`- ${method} requests to ${endpoint}`);

    return lines.length > 0 ? lines.join('\n') : '- Use this tool when relevant to the user\'s request';
  }

  /**
   * Generate a curl example for API tools.
   */
  private generateCurlExample(tool: Tool, properties: Record<string, any>, required: string[]): string {
    const method = tool.operation?.method || 'GET';
    const endpoint = tool.operation?.endpoint || '';
    const baseUrl = tool.operation?.api?.baseUrl?.replace(/\/$/, '') || '';
    let fullUrl = baseUrl
      ? `${baseUrl}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`
      : endpoint;

    const bodyParams: Record<string, any> = {};
    const queryParams: string[] = [];

    for (const [name, schema] of Object.entries(properties)) {
      const paramSchema = schema as any;
      const value = this.getExampleValue(name, paramSchema);

      if (fullUrl.includes(`{${name}}`)) {
        // Path parameter — substitute into URL
        fullUrl = fullUrl.replace(`{${name}}`, String(value));
      } else if (['GET', 'DELETE', 'HEAD'].includes(method)) {
        // Query parameter for GET-like methods
        if (required.includes(name) || Object.keys(properties).length <= 3) {
          queryParams.push(`${name}=${encodeURIComponent(String(value))}`);
        }
      } else {
        // Body parameter for POST/PUT/PATCH
        if (required.includes(name) || Object.keys(properties).length <= 3) {
          bodyParams[name] = value;
        }
      }
    }

    if (queryParams.length > 0) {
      fullUrl += `?${queryParams.join('&')}`;
    }

    const lines: string[] = [];
    lines.push('```bash');

    const hasBody = Object.keys(bodyParams).length > 0;
    if (method === 'GET' && !hasBody) {
      lines.push(`curl "${fullUrl}"`);
    } else {
      const parts: string[] = [`curl -X ${method} "${fullUrl}"`];
      if (hasBody) {
        parts.push(`  -H "Content-Type: application/json"`);
        parts.push(`  -d '${JSON.stringify(bodyParams)}'`);
      }
      lines.push(parts.join(' \\\n'));
    }

    lines.push('```');
    return lines.join('\n');
  }

  /**
   * Generate a JSON parameters example for non-API tools.
   */
  private generateJsonExample(tool: Tool, properties: Record<string, any>, required: string[]): string {
    const exampleParams: Record<string, any> = {};
    for (const [name, schema] of Object.entries(properties)) {
      const paramSchema = schema as any;
      if (required.includes(name) || Object.keys(properties).length <= 3) {
        exampleParams[name] = this.getExampleValue(name, paramSchema);
      }
    }

    if (Object.keys(exampleParams).length === 0) {
      return 'No parameters required.';
    }

    return `\`\`\`json\n${JSON.stringify(exampleParams, null, 2)}\n\`\`\``;
  }

  private getExampleValue(name: string, schema: any): any {
    if (schema.enum && schema.enum.length > 0) return schema.enum[0];
    if (schema.default !== undefined) return schema.default;

    const type = schema.type || 'string';
    const nameLower = name.toLowerCase();

    switch (type) {
      case 'integer':
      case 'number':
        if (nameLower.includes('id')) return 1;
        if (nameLower.includes('limit')) return 10;
        if (nameLower.includes('page')) return 1;
        return 0;
      case 'boolean':
        return true;
      case 'array':
        return [];
      case 'object':
        return {};
      default:
        if (nameLower.includes('name')) return 'example';
        if (nameLower.includes('email')) return 'user@example.com';
        if (nameLower.includes('status')) return 'active';
        return 'string';
    }
  }

  private generateErrorHandling(_tool: Tool): string {
    const lines: string[] = [];
    lines.push('- **400 Bad Request**: Check that all required parameters are provided and valid');
    lines.push('- **401 Unauthorized**: Authentication credentials may be missing or expired');
    lines.push('- **404 Not Found**: The requested resource may not exist');
    lines.push('- **500 Internal Server Error**: Server-side issue, retry after a brief wait');
    return lines.join('\n');
  }

  private slugify(name: string): string {
    if (!name) return 'unnamed';
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'unnamed';
  }

  private escapeYaml(str: string): string {
    if (str.includes(':') || str.includes('#') || str.includes("'") || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return str;
  }
}
