import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Tool, ToolType } from '../../entities/tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';

export interface SkillOutput {
  name: string;
  content: string;
  toolCount: number;
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
   * Generate a skill file for a single tool.
   */
  async generateToolSkill(toolId: string): Promise<SkillOutput> {
    const tool = await this.toolRepository.findOne({
      where: { id: toolId },
      relations: ['categories', 'operation'],
    });

    if (!tool) {
      throw new NotFoundException(`Tool not found: ${toolId}`);
    }

    const content = this.renderToolSkill(tool);
    return {
      name: this.slugify(tool.name),
      content,
      toolCount: 1,
    };
  }

  /**
   * Generate a skill bundle for all tools in a gateway.
   */
  async generateGatewaySkills(gatewayId: string): Promise<SkillOutput> {
    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId },
    });

    if (!gateway) {
      throw new NotFoundException(`Gateway not found: ${gatewayId}`);
    }

    const gatewayTools = await this.gatewayToolRepository.find({
      where: { gatewayId, isActive: true },
      relations: ['tool', 'tool.categories', 'tool.operation'],
    });

    const tools = gatewayTools.map(gt => gt.tool).filter(Boolean);

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
   * Render a single tool skill as markdown with YAML frontmatter.
   */
  private renderToolSkill(tool: Tool): string {
    const params = tool.parameters as any;
    const properties = params?.properties || {};
    const required = params?.required || [];
    const categories = tool.categories?.map(c => c.name) || [];
    const method = tool.operation?.method || 'GET';
    const endpoint = tool.operation?.endpoint || '';

    const lines: string[] = [];

    // YAML frontmatter
    lines.push('---');
    lines.push(`name: ${this.slugify(tool.name)}`);
    lines.push(`description: ${this.escapeYaml(tool.description || '')}`);
    lines.push(`tools: [${this.slugify(tool.name)}]`);
    lines.push(`type: ${tool.type || 'api'}`);
    if (categories.length > 0) {
      lines.push(`categories: [${categories.join(', ')}]`);
    }
    if (method && endpoint) {
      lines.push(`method: ${method}`);
      lines.push(`endpoint: ${endpoint}`);
    }
    lines.push('---');
    lines.push('');

    // Title
    lines.push(`# ${tool.name}`);
    lines.push('');

    // Description
    if (tool.description) {
      lines.push('## Description');
      lines.push('');
      lines.push(tool.description);
      lines.push('');
    }

    // When to use
    lines.push('## When to use');
    lines.push('');
    lines.push(this.generateWhenToUse(tool));
    lines.push('');

    // Parameters
    if (Object.keys(properties).length > 0) {
      lines.push('## Parameters');
      lines.push('');
      for (const [name, schema] of Object.entries(properties)) {
        const paramSchema = schema as any;
        const isRequired = required.includes(name);
        const typeStr = paramSchema.type || 'string';
        const desc = paramSchema.description || '';
        const reqLabel = isRequired ? '**required**' : 'optional';
        lines.push(`- \`${name}\` (${typeStr}, ${reqLabel}): ${desc}`);
      }
      lines.push('');
    }

    // Steps
    lines.push('## Steps');
    lines.push('');
    lines.push(this.generateSteps(tool, properties, required));
    lines.push('');

    // Error handling
    lines.push('## Error handling');
    lines.push('');
    lines.push(this.generateErrorHandling(tool));
    lines.push('');

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
    lines.push(`description: Skills for ${gateway.name} gateway`);
    lines.push(`tools: [${tools.map(t => this.slugify(t.name)).join(', ')}]`);
    lines.push(`gateway: ${gateway.id}`);
    lines.push(`toolCount: ${tools.length}`);
    lines.push('---');
    lines.push('');

    // Overview
    lines.push(`# ${gateway.name}`);
    lines.push('');
    lines.push(`This gateway provides ${tools.length} tools.`);
    lines.push('');

    // Tool index
    lines.push('## Available tools');
    lines.push('');
    for (const tool of tools) {
      const type = tool.type || 'api';
      lines.push(`- **${tool.name}** (${type}): ${tool.description || 'No description'}`);
    }
    lines.push('');

    // Per-tool sections
    for (const tool of tools) {
      lines.push('---');
      lines.push('');
      lines.push(`### ${tool.name}`);
      lines.push('');
      if (tool.description) {
        lines.push(tool.description);
        lines.push('');
      }

      const params = tool.parameters as any;
      const properties = params?.properties || {};
      const required = params?.required || [];

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
    }

    return lines.join('\n');
  }

  private renderEmptyGatewaySkill(gateway: any): string {
    return [
      '---',
      `name: ${this.slugify(gateway.name)}`,
      `description: Skills for ${gateway.name} gateway`,
      'tools: []',
      `gateway: ${gateway.id}`,
      'toolCount: 0',
      '---',
      '',
      `# ${gateway.name}`,
      '',
      'No tools are currently assigned to this gateway.',
      '',
    ].join('\n');
  }

  private generateWhenToUse(tool: Tool): string {
    const type = tool.type;
    const name = tool.name;

    switch (type) {
      case ToolType.QUERY:
        return `Use this when the user wants to retrieve or look up data using ${name}.`;
      case ToolType.MUTATION:
        return `Use this when the user wants to create, update, or modify data using ${name}.`;
      case ToolType.ACTION:
        return `Use this when the user wants to perform an action using ${name}.`;
      default:
        return `Use this when the user needs to interact with the ${name} API endpoint.`;
    }
  }

  private generateSteps(tool: Tool, properties: Record<string, any>, required: string[]): string {
    const steps: string[] = [];
    let stepNum = 1;

    if (required.length > 0) {
      steps.push(`${stepNum}. Collect required parameters: ${required.map(r => `\`${r}\``).join(', ')}`);
      stepNum++;
    }

    const optional = Object.keys(properties).filter(k => !required.includes(k));
    if (optional.length > 0) {
      steps.push(`${stepNum}. Optionally collect: ${optional.map(o => `\`${o}\``).join(', ')}`);
      stepNum++;
    }

    steps.push(`${stepNum}. Call \`${this.slugify(tool.name)}\` with the collected parameters`);
    stepNum++;

    steps.push(`${stepNum}. Return the result to the user`);

    return steps.join('\n');
  }

  private generateErrorHandling(tool: Tool): string {
    const lines: string[] = [];
    lines.push('- **400 Bad Request**: Check that all required parameters are provided and valid');
    lines.push('- **401 Unauthorized**: Authentication credentials may be missing or expired');
    lines.push('- **404 Not Found**: The requested resource may not exist');
    lines.push('- **429 Too Many Requests**: Rate limit exceeded, wait before retrying');
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
    if (str.includes(':') || str.includes('#') || str.includes("'") || str.includes('"')) {
      return `"${str.replace(/"/g, '\\"')}"`;
    }
    return str;
  }
}
