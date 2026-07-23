import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  JsonRpcErrorCode,
  McpResource,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpPrompt,
  McpGetPromptRequest,
  McpGetPromptResult,
  McpTextContent,
} from '../types/mcp.types';

import { Tool, ToolStatus } from '../../../entities/tool.entity';
import { Resource } from '../../../entities/resource.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { SkillGeneratorService } from '../../tools/skill-generator.service';
import { PromotedSkillsService } from '../../promoted-skills/promoted-skills.service';
import { McpToolHandler } from './mcp-tool.handler';
import { batchAsync } from '../../../common/utils/batch-async';

@Injectable()
export class McpContentHandler {
  private readonly logger = new Logger(McpContentHandler.name);

  constructor(
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(Resource)
    private resourceRepository: Repository<Resource>,
    @InjectRepository(GatewayTool)
    private gatewayToolRepository: Repository<GatewayTool>,
    private skillGeneratorService: SkillGeneratorService,
    private toolHandler: McpToolHandler,
    private promotedSkillsService: PromotedSkillsService,
  ) {}

  async handleResourcesList(params: any, organizationId: string, gatewayId?: string): Promise<any> {
    let resources: Resource[];

    if (gatewayId) {
      // Scope to APIs that have tools assigned to this gateway
      const gatewayTools = await this.gatewayToolRepository.find({
        where: { gatewayId, isActive: true },
        relations: { tool: true },
      });
      const apiIds = [...new Set(gatewayTools.map(gt => gt.tool?.apiId).filter(Boolean))];
      if (apiIds.length === 0) {
        resources = [];
      } else {
        const allResources = await this.resourceRepository.find({
          where: { api: { organizationId } },
          relations: { api: true },
        });
        resources = allResources.filter(r => apiIds.includes(r.api?.id));
      }
    } else {
      resources = await this.resourceRepository.find({
        where: { api: { organizationId } },
        relations: { api: true },
      });
    }

    const mcpResources: McpResource[] = resources.map(resource => ({
      uri: `almyty://resources/${resource.id}`,
      name: resource.name,
      ...(resource.description ? { description: resource.description } : {}),
      mimeType: 'application/json',
    }));

    const cursor = params?.cursor ? parseInt(params.cursor, 10) : 0;
    const pageSize = 100;
    const paged = mcpResources.slice(cursor, cursor + pageSize);
    const result: any = { resources: paged };
    if (cursor + pageSize < mcpResources.length) {
      result.nextCursor = String(cursor + pageSize);
    }

    return result;
  }

  async handleResourceTemplatesList(): Promise<{ resourceTemplates: any[] }> {
    return { resourceTemplates: [] };
  }

  async handleResourceRead(
    params: McpReadResourceRequest,
    organizationId: string,
  ): Promise<McpReadResourceResult> {
    const match = params.uri.match(/almyty:\/\/resources\/(.+)/);
    if (!match) {
      throw this.createError(JsonRpcErrorCode.RESOURCE_NOT_FOUND, 'Invalid resource URI format');
    }

    const resourceId = match[1];
    const resource = await this.resourceRepository.findOne({
      where: { id: resourceId, api: { organizationId } },
      relations: { api: true },
    });

    if (!resource) {
      throw this.createError(JsonRpcErrorCode.RESOURCE_NOT_FOUND, 'Resource not found');
    }

    return {
      contents: [
        {
          uri: params.uri,
          mimeType: 'application/json',
          text: JSON.stringify(resource.schema || resource.properties, null, 2),
        },
      ],
    };
  }

  async handlePromptsList(params: any, organizationId: string, gatewayId?: string): Promise<any> {
    let tools: Tool[];

    if (gatewayId) {
      tools = await this.toolHandler.getToolsForScope(organizationId, gatewayId);
    } else {
      tools = await this.toolRepository.find({
        where: { organization: { id: organizationId }, status: ToolStatus.ACTIVE },
      });
    }

    const prompts: McpPrompt[] = [];

    for (const tool of tools) {
      const schema = tool.parameters as any;
      const props = schema?.properties || {};
      const requiredSet = new Set<string>(schema?.required || []);

      prompts.push({
        name: `use-${this.toolHandler.sanitizeToolName(tool.name)}`,
        description: `Execute the ${tool.name} tool${tool.description ? ': ' + tool.description : ''}`,
        arguments: Object.entries(props).map(([name, prop]: [string, any]) => ({
          name,
          description: prop.description || `Parameter: ${name}`,
          required: requiredSet.has(name),
        })),
      });
    }

    prompts.push({
      name: 'list-available-tools',
      description: 'List all available tools and their capabilities',
      arguments: [],
    });

    const cursor = params?.cursor ? parseInt(params.cursor, 10) : 0;
    const pageSize = 100;
    const paged = prompts.slice(cursor, cursor + pageSize);
    const result: any = { prompts: paged };
    if (cursor + pageSize < prompts.length) {
      result.nextCursor = String(cursor + pageSize);
    }

    return result;
  }

  async handlePromptGet(
    params: McpGetPromptRequest,
    organizationId: string,
  ): Promise<McpGetPromptResult> {
    if (params.name === 'list-available-tools') {
      const tools = await this.toolRepository.find({
        where: { organization: { id: organizationId }, status: ToolStatus.ACTIVE },
      });

      const toolList = tools.map((t) => `- **${t.name}**: ${t.description || 'No description'}`).join('\n');

      return {
        description: 'List of all available tools',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Here are the available tools in this organization:\n\n${toolList}\n\nWhich tool would you like to use?`,
            } as McpTextContent,
          },
        ],
      };
    }

    if (params.name.startsWith('use-')) {
      const toolName = params.name.replace('use-', '');
      const tool = await this.toolRepository.findOne({
        where: { name: toolName, organization: { id: organizationId } },
      });

      if (!tool) {
        throw this.createError(JsonRpcErrorCode.RESOURCE_NOT_FOUND, `Tool '${toolName}' not found`);
      }

      const schema = tool.parameters as any;
      const props = schema?.properties || {};
      const argsList = Object.entries(props).map(([name, prop]: [string, any]) => {
        const value = params.arguments?.[name] || `<${name}>`;
        return `- ${name}: ${value}`;
      }).join('\n');

      return {
        description: `Execute ${tool.name}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please execute the **${tool.name}** tool${tool.description ? ' (' + tool.description + ')' : ''} with the following parameters:\n\n${argsList}`,
            } as McpTextContent,
          },
        ],
      };
    }

    throw this.createError(JsonRpcErrorCode.RESOURCE_NOT_FOUND, `Prompt '${params.name}' not found`);
  }

  async handleSkillsList(params: any, organizationId: string, gatewayId?: string): Promise<any> {
    if (gatewayId) {
      const skill = await this.skillGeneratorService.generateGatewaySkills(gatewayId, organizationId);
      return { skills: [skill] };
    }

    const tools = await this.toolHandler.getToolsForScope(organizationId);

    const skills = await batchAsync(tools.slice(0, params?.limit || 50), 5, async (tool) => {
      try {
        return await this.skillGeneratorService.generateToolSkill(tool.id, organizationId);
      } catch {
        return null;
      }
    });

    const promoted = await this.promotedSkillsService.listForServing(organizationId);
    return { skills: [...skills.filter(Boolean), ...promoted] };
  }

  async handleSkillGet(params: any, organizationId: string): Promise<any> {
    const { toolId, gatewayId, promotedSkillId } = params || {};

    if (promotedSkillId) {
      const skill = await this.promotedSkillsService.get(promotedSkillId, organizationId);
      return { name: skill.slug, content: skill.content };
    }

    if (gatewayId) {
      return this.skillGeneratorService.generateGatewaySkills(gatewayId, organizationId);
    }

    if (toolId) {
      return this.skillGeneratorService.generateToolSkill(toolId, organizationId);
    }

    throw this.createError(JsonRpcErrorCode.INVALID_PARAMS, 'toolId, gatewayId, or promotedSkillId is required');
  }

  private createError(code: JsonRpcErrorCode, message: string): any {
    const error = new Error() as any;
    error.code = code;
    error.message = message;
    return error;
  }
}
