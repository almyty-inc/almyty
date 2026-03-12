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
   */
  async generateToolSkill(toolId: string): Promise<SkillOutput> {
    const tool = await this.toolRepository.findOne({
      where: { id: toolId },
      relations: ['categories', 'operation'],
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
   */
  async generateGatewaySkills(gatewayId: string): Promise<SkillOutput> {
    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId },
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
   */
  async generateIndividualSkills(gatewayId: string): Promise<IndividualSkill[]> {
    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId },
    });

    if (!gateway) {
      throw new NotFoundException(`Gateway not found: ${gatewayId}`);
    }

    const tools = await this.getGatewayTools(gatewayId);

    return tools.map(tool => ({
      name: this.slugify(tool.name),
      fileName: `apifai-${this.slugify(tool.name)}`,
      content: this.renderToolSkillMd(tool),
    }));
  }

  private async getGatewayTools(gatewayId: string): Promise<Tool[]> {
    const gatewayTools = await this.gatewayToolRepository.find({
      where: { gatewayId, isActive: true },
      relations: ['tool', 'tool.categories', 'tool.operation'],
    });

    return gatewayTools.map(gt => gt.tool).filter(Boolean);
  }

  /**
   * Render a SKILL.md following the Agent Skills open standard.
   * https://agentskills.io / https://code.claude.com/docs/en/skills
   */
  private renderToolSkillMd(tool: Tool): string {
    const params = tool.parameters as any;
    const properties = params?.properties || {};
    const required = params?.required || [];
    const method = tool.operation?.method || '';
    const endpoint = tool.operation?.endpoint || '';

    const lines: string[] = [];

    // YAML frontmatter (Agent Skills standard)
    lines.push('---');
    lines.push(`name: ${this.slugify(tool.name)}`);
    lines.push(`description: ${this.escapeYaml(this.buildDescription(tool))}`);
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

    // Tool call instructions
    lines.push('## Tool call');
    lines.push('');
    lines.push(`Call \`apifai_execute\` with:`);
    lines.push(`- \`tool_name\`: \`"${tool.name}"\``);

    if (Object.keys(properties).length > 0) {
      lines.push(`- \`parameters\`:`);
      for (const [name, schema] of Object.entries(properties)) {
        const paramSchema = schema as any;
        const isRequired = required.includes(name);
        const typeStr = paramSchema.type || 'string';
        const desc = paramSchema.description || '';
        const reqLabel = isRequired ? ', **required**' : '';
        lines.push(`  - \`${name}\` (${typeStr}${reqLabel}): ${desc}`);
      }
    }
    lines.push('');

    // Example
    lines.push('## Example');
    lines.push('');
    lines.push(this.generateExample(tool, properties, required));
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
    lines.push(`description: ${this.escapeYaml(`API skills for ${gateway.name}. ${tools.length} tools available.`)}`);
    lines.push('---');
    lines.push('');

    // Overview
    lines.push(`# ${gateway.name}`);
    lines.push('');
    lines.push(`This gateway provides ${tools.length} tools. Use \`apifai_execute\` to call any tool, or \`apifai_search\` to find tools by keyword.`);
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

      lines.push(`Call \`apifai_execute\` with \`tool_name: "${tool.name}"\``);
      lines.push('');

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
      `description: ${this.escapeYaml(`API skills for ${gateway.name}`)}`,
      '---',
      '',
      `# ${gateway.name}`,
      '',
      'No tools are currently assigned to this gateway.',
      '',
    ].join('\n');
  }

  private buildDescription(tool: Tool): string {
    const base = tool.description || `Use the ${tool.name} tool`;
    // Keep it concise — description is used by agents to decide when to load the skill
    if (base.length > 200) {
      return base.substring(0, 197) + '...';
    }
    return base;
  }

  private generateWhenToUse(tool: Tool): string {
    const type = tool.type;
    const name = tool.name;
    const desc = tool.description || '';

    const lines: string[] = [];

    switch (type) {
      case ToolType.QUERY:
        lines.push(`- User wants to retrieve or look up data`);
        break;
      case ToolType.MUTATION:
        lines.push(`- User wants to create, update, or modify data`);
        break;
      case ToolType.ACTION:
        lines.push(`- User wants to perform an action or trigger a workflow`);
        break;
      default:
        lines.push(`- User needs to interact with this API endpoint`);
    }

    // Add context from the description
    if (desc) {
      lines.push(`- Request relates to: ${desc.substring(0, 100)}`);
    }

    return lines.join('\n');
  }

  private generateExample(tool: Tool, properties: Record<string, any>, required: string[]): string {
    const exampleParams: Record<string, any> = {};
    for (const [name, schema] of Object.entries(properties)) {
      const paramSchema = schema as any;
      if (required.includes(name) || Object.keys(properties).length <= 3) {
        exampleParams[name] = this.getExampleValue(name, paramSchema);
      }
    }

    const paramsStr = JSON.stringify(exampleParams, null, 2);
    return `\`\`\`\napifai_execute({\n  tool_name: "${tool.name}",\n  parameters: ${paramsStr}\n})\n\`\`\``;
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
