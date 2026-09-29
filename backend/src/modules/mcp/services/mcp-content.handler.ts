import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { In, Repository } from 'typeorm';

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
import { AccessPolicyService, type ResourceLike } from '../../../common/authorization/access-policy.service';
import { Resource } from '../../../entities/resource.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { Gateway } from '../../../entities/gateway.entity';
import { findServableGatewayTool, servableToolsOnGateway } from '../../gateways/gateway-servable';
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
    private accessPolicy: AccessPolicyService,
  ) {}

  async handleResourcesList(
    params: any,
    organizationId: string,
    gatewayId?: string,
    caller?: { id: string },
  ): Promise<any> {
    let resources: Resource[];

    if (gatewayId) {
      // The resources of the APIs whose tools this gateway serves -- the
      // same set resources/read resolves against.
      const apiIds = [...(await this.apiIdsServedOnGateway(gatewayId))];
      resources = apiIds.length === 0
        ? []
        : await this.resourceRepository.find({
            where: { apiId: In(apiIds), api: { organizationId } },
            relations: { api: true },
          });
    } else {
      // Off a gateway the caller sees the resources of the APIs they can
      // see, by the rule tools/list applies.
      const all = await this.resourceRepository.find({
        where: { api: { organizationId } },
        relations: { api: true },
      });
      resources = await this.visibleResourcesOffGateway(organizationId, caller, all);
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

  /**
   * resources/read answers from the set resources/list offered. Through a
   * gateway that is the resources of the APIs whose tools the gateway
   * serves; off a gateway, the resources of the APIs the caller can see.
   * A resource outside it -- another member's private API's, a team API's
   * outside the team, a malformed id -- reads exactly like one that does
   * not exist.
   */
  async handleResourceRead(
    params: McpReadResourceRequest,
    organizationId: string,
    caller?: { id: string },
    gatewayId?: string,
  ): Promise<McpReadResourceResult> {
    const match = params.uri.match(/almyty:\/\/resources\/(.+)/);
    if (!match) {
      throw this.createError(JsonRpcErrorCode.RESOURCE_NOT_FOUND, 'Invalid resource URI format');
    }

    const resourceId = match[1];
    const resource = isUUID(resourceId)
      ? await this.resourceRepository.findOne({
          where: { id: resourceId, api: { organizationId } },
          relations: { api: true },
        })
      : null;

    // Through a gateway: the resources of the APIs it serves tools of. Off
    // a gateway: the resources of the APIs the caller can see. Another
    // member's private API's resource (any private API's when the caller
    // is unknown) is outside both.
    const published = !!resource
      && !(resource.api && isOthersPrivate(resource.api, caller?.id ?? null))
      && (gatewayId
        ? (await this.apiIdsServedOnGateway(gatewayId)).has(resource.apiId)
        : (await this.visibleResourcesOffGateway(organizationId, caller, [resource])).length > 0);
    if (!resource || !published) {
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

  /**
   * The APIs a gateway publishes resources for: those of the tools it
   * serves, by the shared rule in gateway-servable.ts (active row, active
   * tool, scope fits the gateway). resources/list and resources/read both
   * read this, so what is listed and what is readable cannot drift apart.
   */
  private async apiIdsServedOnGateway(gatewayId: string): Promise<Set<string>> {
    const tools = await servableToolsOnGateway(this.gatewayToolRepository, gatewayId);
    return new Set(tools.map((t) => t.apiId).filter((id): id is string => !!id));
  }

  /** The resources whose API the caller may see off a gateway. A resource with no API has no scope and is left out. */
  private async visibleResourcesOffGateway(
    organizationId: string,
    caller: { id: string } | undefined,
    resources: Resource[],
  ): Promise<Resource[]> {
    const apis = resources.map((r) => r.api).filter((api): api is NonNullable<Resource['api']> => !!api);
    const visible = new Set((await this.visibleOffGateway(organizationId, caller, apis)).map((api) => api.id));
    return resources.filter((r) => !!r.api && visible.has(r.api.id));
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

  /**
   * skills/list. Through a gateway: the bundle of what that gateway serves
   * (the servable rule, gateway-servable.ts). Off a gateway: a skill per
   * tool the caller's tools/list shows, plus the promoted skills they may see.
   */
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

  /**
   * skills/get answers from the set skills/list offered.
   *
   * Through a gateway (`servingGatewayId`) that is the gateway itself: a
   * `toolId` resolves only among the tools it serves, and a `gatewayId`
   * only when it names the gateway being served. Off a gateway, a tool or
   * gateway resolves only when the caller could see it (org-wide, their
   * teams', their own private ones), and a tool only while active, as
   * tools/list shows it. Everything else -- another gateway's tool or
   * bundle, a team's row outside the team, a malformed id -- is the same
   * not-found a missing row gets.
   */
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
      const notFound = this.createError(JsonRpcErrorCode.RESOURCE_NOT_FOUND, `Gateway not found: ${gatewayId}`);
      if (servingGatewayId) {
        // A gateway publishes its own bundle, never another gateway's.
        if (gatewayId !== servingGatewayId) throw notFound;
      } else {
        const target = typeof gatewayId === 'string' && isUUID(gatewayId)
          ? await this.gatewayToolRepository.manager.getRepository(Gateway).findOne({
              where: { id: gatewayId, organizationId },
              select: { id: true, organizationId: true, visibility: true, teamId: true, ownerUserId: true },
            })
          : null;
        if (!target || (await this.visibleOffGateway(organizationId, caller, [target])).length === 0) {
          throw notFound;
        }
      }
      return this.skillGeneratorService.generateGatewaySkills(gatewayId, organizationId);
    }

    if (toolId) {
      const notFound = this.createError(JsonRpcErrorCode.RESOURCE_NOT_FOUND, `Tool not found: ${toolId}`);
      if (typeof toolId !== 'string' || !isUUID(toolId)) throw notFound;
      if (servingGatewayId) {
        if (!(await findServableGatewayTool(this.gatewayToolRepository, servingGatewayId, toolId))) throw notFound;
      } else {
        const tool = await this.toolRepository.findOne({ where: { id: toolId, organizationId, status: ToolStatus.ACTIVE } });
        if (!tool || (await this.visibleOffGateway(organizationId, caller, [tool])).length === 0) throw notFound;
      }
      return this.skillGeneratorService.generateToolSkill(toolId, organizationId, caller ?? null);
    }

    throw this.createError(JsonRpcErrorCode.INVALID_PARAMS, 'toolId, gatewayId, or promotedSkillId is required');
  }

  /**
   * Off a gateway, the rows the caller may see -- the rule tools/list
   * applies (AccessPolicyService): org-wide rows, their teams' rows, their
   * own private rows; an org admin every non-private row. With no known
   * caller, org-wide rows only.
   */
  private async visibleOffGateway<T extends ResourceLike>(
    organizationId: string,
    caller: { id: string } | undefined,
    rows: T[],
  ): Promise<T[]> {
    if (caller?.id) return this.accessPolicy.filterVisible(caller, organizationId, rows);
    return rows.filter((row) => row.organizationId === organizationId && (row.visibility ?? 'org') === 'org');
  }

  private createError(code: JsonRpcErrorCode, message: string): any {
    const error = new Error() as any;
    error.code = code;
    error.message = message;
    return error;
  }
}
