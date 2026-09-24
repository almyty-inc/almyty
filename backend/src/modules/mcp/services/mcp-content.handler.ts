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
import { isOthersPrivate } from '../../../common/authorization/private-visibility';
import { Resource } from '../../../entities/resource.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { Gateway } from '../../../entities/gateway.entity';
import { gatewayServableTo } from '../../gateways/private-gateway';
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

  async handleResourcesList(
    params: any,
    organizationId: string,
    gatewayId?: string,
    caller?: { id: string },
  ): Promise<any> {
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

    // Resources of another member's private API are not listed (with no
    // known caller, no private API's resources are).
    resources = resources.filter((r) => !r.api || !isOthersPrivate(r.api, caller?.id ?? null));

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
    caller?: { id: string },
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

    // A resource of another member's private API (any private API when
    // the caller is unknown) reads like one that does not exist.
    if (!resource || (resource.api && isOthersPrivate(resource.api, caller?.id ?? null))) {
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

  async handlePromptsList(
    params: any,
    organizationId: string,
    gatewayId?: string,
    caller?: { id: string },
  ): Promise<any> {
    // Both branches go through getToolsForScope so the gateway-less path is
    // team-scoped to the caller. The old else-branch read the tool table
    // directly on organizationId alone, which is the same unscoped org-wide
    // read the bypass produced.
    const tools: Tool[] = await this.toolHandler.getToolsForScope(organizationId, gatewayId, caller);

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

  /**
   * prompts/get answers from the same tool set prompts/list offered: the
   * gateway's servable tools, or the caller's visible tools (their own
   * private ones included, nobody else's, and only their teams' tools).
   * A prompt for any other tool reads like one that does not exist, and
   * with neither a caller nor a gateway there is no tool set at all.
   */
  async handlePromptGet(
    params: McpGetPromptRequest,
    organizationId: string,
    gatewayId?: string,
    caller?: { id: string },
  ): Promise<McpGetPromptResult> {
    const isToolPrompt = params.name === 'list-available-tools' || params.name.startsWith('use-');
    if (!isToolPrompt) {
      throw this.createError(JsonRpcErrorCode.RESOURCE_NOT_FOUND, `Prompt '${params.name}' not found`);
    }
    const tools: Tool[] = await this.toolHandler.getToolsForScope(organizationId, gatewayId, caller);

    if (params.name === 'list-available-tools') {
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

    const toolName = params.name.slice('use-'.length);
    // prompts/list names a prompt after the sanitized tool name; accept
    // that and the raw name, but only among the tools in scope.
    const tool = tools.find((t) => this.toolHandler.sanitizeToolName(t.name) === toolName)
      ?? tools.find((t) => t.name === toolName);

    if (!tool) {
      throw this.createError(JsonRpcErrorCode.RESOURCE_NOT_FOUND, `Tool '${toolName}' not found`);
    }

    const schema = tool.parameters as any;
    const props = schema?.properties || {};
    const argsList = Object.entries(props).map(([name]: [string, any]) => {
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

  async handleSkillsList(
    params: any,
    organizationId: string,
    gatewayId?: string,
    caller?: { id: string },
  ): Promise<any> {
    if (gatewayId) {
      const skill = await this.skillGeneratorService.generateGatewaySkills(gatewayId, organizationId);
      return { skills: [skill] };
    }

    const tools = await this.toolHandler.getToolsForScope(organizationId, undefined, caller);

    const skills = await batchAsync(tools.slice(0, params?.limit || 50), 5, async (tool) => {
      try {
        return await this.skillGeneratorService.generateToolSkill(tool.id, organizationId);
      } catch {
        return null;
      }
    });

    // Skills promoted from another member's private agent are theirs alone;
    // with no known caller no private-derived skill is listed.
    const promoted = await this.promotedSkillsService.listForServing(organizationId, caller?.id ?? null);
    return { skills: [...skills.filter(Boolean), ...promoted] };
  }

  async handleSkillGet(
    params: any,
    organizationId: string,
    caller?: { id: string },
    servingGatewayId?: string,
  ): Promise<any> {
    const { toolId, gatewayId, promotedSkillId } = params || {};

    if (promotedSkillId) {
      // Another member's private-derived skill (and, with no known caller,
      // any private-derived skill) throws the same not-found as a missing one.
      const skill = await this.promotedSkillsService.get(promotedSkillId, organizationId, caller?.id ?? null);
      return { name: skill.slug, content: skill.content };
    }

    if (gatewayId) {
      // `gatewayId` here is any gateway of the org, named in the request,
      // not the one being served. Another user's private gateway answers
      // like one that does not exist.
      if (gatewayId !== servingGatewayId) {
        const target = await this.gatewayToolRepository.manager?.findOne(Gateway, {
          where: { id: gatewayId, organizationId },
          select: { id: true, visibility: true, ownerUserId: true },
        });
        if (target && !gatewayServableTo(target, caller?.id)) {
          throw this.createError(JsonRpcErrorCode.RESOURCE_NOT_FOUND, `Gateway not found: ${gatewayId}`);
        }
      }
      return this.skillGeneratorService.generateGatewaySkills(gatewayId, organizationId);
    }

    if (toolId) {
      return this.skillGeneratorService.generateToolSkill(toolId, organizationId, caller ?? null);
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
