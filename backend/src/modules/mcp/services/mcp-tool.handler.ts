import { Injectable, Logger, Inject, forwardRef, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';

import {
  JsonRpcErrorCode,
  McpTool,
  McpCallToolRequest,
  McpCallToolResult,
} from '../types/mcp.types';

import { Tool, ToolStatus } from '../../../entities/tool.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { ToolCategory } from '../../../entities/tool-category.entity';
import { ToolsService } from '../../tools/tools.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { isOthersPrivate, servableOnGateway, withoutOthersPrivate } from '../../../common/authorization/private-visibility';
import { Gateway } from '../../../entities/gateway.entity';
import { MetricsRecorderService } from '../../../common/metrics/metrics-recorder.service';
import { MetricType, MetricStatus } from '../../../entities/usage-metric.entity';

@Injectable()
export class McpToolHandler {
  private readonly logger = new Logger(McpToolHandler.name);

  constructor(
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(GatewayTool)
    private gatewayToolRepository: Repository<GatewayTool>,
    @InjectRepository(ToolCategory)
    private toolCategoryRepository: Repository<ToolCategory>,
    @Inject(forwardRef(() => ToolsService))
    private toolsService: ToolsService,
    @Inject(forwardRef(() => ToolExecutorService))
    private toolExecutorService: ToolExecutorService,
    @InjectRedis() private readonly redis: Redis.Redis,
    @Optional() private readonly metrics?: MetricsRecorderService,
  ) {}

  // Resolve how a tool listing should be scoped.
  //
  // `bypassTeamFilter: true` skips AccessPolicyService.applyListFilter and
  // filters on organization alone. That is only defensible where something
  // else already gates access -- on the gateway path, gateway membership
  // does. The gateway-less path (McpController, and every transport) has no
  // gateway, so the bypass there handed the caller every tool in the org,
  // including team-scoped tools they hold no membership for. Use the real
  // caller when there is one, and refuse rather than fall back to the
  // unscoped read when there is neither a gateway nor a caller.
  private listScope(
    gatewayId?: string,
    caller?: { id: string },
  ): { bypassTeamFilter: true; caller?: { id: string } } | { caller: { id: string } } {
    if (gatewayId) {
      // The caller still rides along so getTools can include the caller's
      // own private tools and exclude everyone else's.
      return caller?.id ? { bypassTeamFilter: true, caller } : { bypassTeamFilter: true };
    }
    if (caller?.id) {
      return { caller };
    }
    throw this.createError(
      JsonRpcErrorCode.INVALID_REQUEST,
      'Tool listing requires an authenticated caller or a gateway scope',
    );
  }

  /** MCP tools/list page size. Also the DB page size on the org-wide path. */
  private static readonly TOOLS_PAGE_SIZE = 100;

  /**
   * Parse the `cursor` of a tools/list request into a row offset.
   *
   * Every cursor this server mints is a multiple of the page size, so
   * anything else is a cursor it did not issue. The MCP spec's answer to an
   * unrecognised cursor is -32602 Invalid params, which is also what keeps
   * the offset exactly expressible as a database page.
   */
  private parseListCursor(raw: unknown): number {
    if (raw === undefined || raw === null || raw === '') {
      return 0;
    }
    const cursor = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    if (
      !Number.isInteger(cursor) ||
      cursor < 0 ||
      cursor % McpToolHandler.TOOLS_PAGE_SIZE !== 0
    ) {
      throw this.createError(JsonRpcErrorCode.INVALID_PARAMS, `Invalid cursor: ${raw}`);
    }
    return cursor;
  }

  async handleToolsList(
    params: any,
    organizationId: string,
    gatewayId?: string,
    caller?: { id: string },
  ): Promise<any> {
    const pageSize = McpToolHandler.TOOLS_PAGE_SIZE;
    const cursor = this.parseListCursor(params?.cursor);

    // The cache key carries the caller on the gateway-less path: the listing
    // is now team-scoped per caller, so a single org-wide key would serve one
    // member's scoped list to another. It also carries the cursor, because
    // the cached VALUE is one page — without it a `cursor=100` request was
    // served page 0 from cache.
    const cacheKey = gatewayId
      ? `mcp:tools:${organizationId}:${gatewayId}:cursor:${cursor}`
      : `mcp:tools:${organizationId}:user:${caller?.id ?? 'none'}:cursor:${cursor}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Cache miss or Redis error — continue to query
    }

    let tools: any[];
    // Whether `tools` is already just this page (DB-side) or the whole set
    // that still has to be sliced here.
    let prePaged = false;
    let totalCount: number | undefined;

    if (gatewayId) {
      const gatewayTools = await this.gatewayToolRepository.find({
        where: { gatewayId, isActive: true },
        relations: { tool: true },
      });
      // A private tool is served through a gateway only when the gateway is
      // private to the tool's own owner.
      tools = await this.servableThroughGateway(gatewayTools.map((gt: any) => gt.tool).filter(Boolean), gatewayId);
      this.logger.log(`[GATEWAY-SCOPE] Returning ${tools.length} tools for gateway ${gatewayId}`);
    } else {
      // Page at the database, and ask for the page actually being served.
      // This used to call getTools() with no `limit`, taking its default of
      // 20, and then slice that to a page size of 100 — so an org with more
      // than 20 tools was silently truncated, and because the slice could
      // never exceed the page size the `nextCursor` branch never fired and
      // the client had no way to reach the rest.
      const result = await this.toolsService.getTools({
        organizationId,
        page: Math.floor(cursor / pageSize) + 1,
        limit: pageSize,
        ...this.listScope(gatewayId, caller),
      });
      tools = result.tools;
      prePaged = true;
      totalCount = typeof result.total === 'number' ? result.total : cursor + tools.length;
    }

    const mcpTools: McpTool[] = tools.map(tool => ({
      name: this.sanitizeToolName(tool.name),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.parameters || {
        type: 'object',
        properties: {},
      },
    }));

    // Cursor-based pagination
    const paged = prePaged ? mcpTools : mcpTools.slice(cursor, cursor + pageSize);
    const total = prePaged ? (totalCount as number) : mcpTools.length;
    const nextCursor = cursor + paged.length < total ? String(cursor + paged.length) : undefined;

    const result: any = { tools: paged };
    if (nextCursor) {
      result.nextCursor = nextCursor;
    }

    try {
      await this.redis.setex(cacheKey, 60, JSON.stringify(result));
    } catch {
      // Non-critical
    }

    return result;
  }

  async handleToolsDiscover(
    params: any,
    organizationId: string,
    gatewayId?: string,
    caller?: { id: string },
  ): Promise<any> {
    const category = params?.category as string | undefined;
    const depth = (params?.depth as string) || 'categories';

    const tools = await this.getToolsForScope(organizationId, gatewayId, caller);

    const categories = await this.toolCategoryRepository.find({
      where: { organizationId, isActive: true },
      relations: { tools: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });

    if (depth === 'categories') {
      const categoryList = categories.map(cat => ({
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        description: cat.description,
        icon: cat.icon,
        toolCount: withoutOthersPrivate(cat.tools ?? [], caller?.id).filter(t => t.status === ToolStatus.ACTIVE).length,
      }));

      const categorizedToolIds = new Set(categories.flatMap(c => c.tools?.map(t => t.id) || []));
      const uncategorizedCount = tools.filter(t => !categorizedToolIds.has(t.id)).length;

      return {
        categories: categoryList,
        uncategorizedCount,
        totalTools: tools.length,
      };
    }

    let filteredTools = tools;
    if (category) {
      const cat = categories.find(c => c.slug === category || c.id === category);
      if (cat) {
        const catToolIds = new Set(cat.tools?.map(t => t.id) || []);
        filteredTools = tools.filter(t => catToolIds.has(t.id));
      } else if (category === 'uncategorized') {
        const categorizedToolIds = new Set(categories.flatMap(c => c.tools?.map(t => t.id) || []));
        filteredTools = tools.filter(t => !categorizedToolIds.has(t.id));
      }
    }

    return {
      tools: filteredTools.map(tool => ({
        name: this.sanitizeToolName(tool.name),
        description: tool.description,
        type: tool.type,
        category: tool.categories?.[0]?.name || null,
        usageCount: tool.usageCount || 0,
        successRate: tool.successRate || 0,
        averageResponseTime: tool.averageResponseTime || 0,
      })),
      totalTools: filteredTools.length,
    };
  }

  async handleToolsSearch(
    params: any,
    organizationId: string,
    gatewayId?: string,
    caller?: { id: string },
  ): Promise<any> {
    const query = params?.query as string;
    const limit = Math.min(params?.limit || 20, 100);
    const page = params?.page || 1;

    if (!query) {
      throw this.createError(JsonRpcErrorCode.INVALID_PARAMS, 'Missing required parameter: query');
    }

    const result = await this.toolsService.getTools({
      organizationId,
      search: query,
      status: ToolStatus.ACTIVE,
      page,
      limit,
      ...this.listScope(gatewayId, caller),
    });

    let tools = gatewayId
      ? await this.servableThroughGateway(result.tools, gatewayId)
      : withoutOthersPrivate(result.tools, caller?.id);
    if (gatewayId) {
      const gatewayTools = await this.gatewayToolRepository.find({
        where: { gatewayId, isActive: true },
      });
      const gatewayToolIds = new Set(gatewayTools.map(gt => gt.toolId));
      tools = tools.filter(t => gatewayToolIds.has(t.id));
    }

    return {
      tools: tools.map(tool => ({
        name: this.sanitizeToolName(tool.name),
        description: tool.description,
        inputSchema: tool.parameters || { type: 'object', properties: {} },
        type: tool.type,
        usageCount: tool.usageCount || 0,
        successRate: tool.successRate || 0,
      })),
      total: result.total,
      page,
      hasMore: page * limit < result.total,
    };
  }

  async handleToolGet(params: any, organizationId: string, userId?: string): Promise<any> {
    const toolName = params?.name as string;

    if (!toolName) {
      throw this.createError(JsonRpcErrorCode.INVALID_PARAMS, 'Missing required parameter: name');
    }

    const allTools = await this.toolRepository.find({
      where: { status: ToolStatus.ACTIVE, organizationId },
      relations: { categories: true, operation: true },
    });

    // Another member's private tool is "not found".
    const tool = withoutOthersPrivate(allTools, userId).find(t => this.sanitizeToolName(t.name) === toolName);

    if (!tool) {
      throw this.createError(JsonRpcErrorCode.INTERNAL_ERROR, `Tool not found: ${toolName}`);
    }

    return {
      name: this.sanitizeToolName(tool.name),
      description: tool.description,
      inputSchema: tool.parameters || { type: 'object', properties: {} },
      type: tool.type,
      version: tool.version,
      status: tool.status,
      categories: tool.categories?.map(c => ({ name: c.name, slug: c.slug })) || [],
      metadata: {
        operationMethod: tool.operation?.method,
        operationEndpoint: tool.operation?.endpoint,
        createdAt: tool.createdAt,
        updatedAt: tool.updatedAt,
        lastUsedAt: tool.lastUsedAt,
      },
      usage: {
        totalExecutions: tool.usageCount || 0,
        successRate: tool.successRate || 0,
        averageResponseTime: tool.averageResponseTime || 0,
      },
    };
  }

  async handleToolCall(
    params: McpCallToolRequest,
    organizationId: string,
    userId?: string,
    gatewayId?: string,
  ): Promise<McpCallToolResult> {
    if (!params.name) {
      throw this.createError(JsonRpcErrorCode.INVALID_PARAMS, 'Tool name is required');
    }

    let tool = await this.toolsService.findByName(params.name, organizationId);
    // Another member's private tool is not callable here, and does not
    // exist as far as this caller is told.
    if (tool && isOthersPrivate(tool, userId)) {
      throw this.createError(JsonRpcErrorCode.TOOL_NOT_FOUND, `Tool not found: ${params.name}`);
    }
    // Through a gateway, a private tool is callable only when the gateway is
    // private to the tool's own owner.
    if (tool && gatewayId && (await this.servableThroughGateway([tool], gatewayId)).length === 0) {
      throw this.createError(JsonRpcErrorCode.TOOL_NOT_FOUND, `Tool not found: ${params.name}`);
    }

    if (!tool) {
      const allTools = await this.toolsService.getTools({ organizationId, ...this.listScope(undefined, userId ? { id: userId } : undefined) });
      tool = allTools.tools.find(t => this.sanitizeToolName(t.name) === params.name);

      if (!tool) {
        throw this.createError(JsonRpcErrorCode.TOOL_NOT_FOUND, `Tool not found: ${params.name}`);
      }
    }

    try {
      const result = await this.toolExecutorService.executeTool(
        tool.id,
        params.arguments || {},
        {
          userId: userId || null,
          organizationId,
          // The gateway this call arrived through. The executor uses it to
          // load `gateway_tools.securityPolicy` for this tool and enforce it
          // on the outbound request; without it the policy is invisible here.
          gatewayId: gatewayId ?? null,
        },
      );

      this.metrics?.record(MetricType.MCP_TOOL_CALL, {
        organizationId,
        userId: userId || null,
        toolId: tool.id,
        status: result.success ? MetricStatus.SUCCESS : MetricStatus.ERROR,
      });

      const textContent = !result.success && result.error
        ? result.error
        : typeof result.data === 'string'
          ? result.data
          : JSON.stringify(result.data ?? {}, null, 2);

      return {
        content: [{ type: 'text', text: textContent }],
        isError: !result.success,
      };
    } catch (error) {
      this.metrics?.record(MetricType.MCP_TOOL_CALL, {
        organizationId,
        userId: userId || null,
        toolId: tool.id,
        status: MetricStatus.ERROR,
      });
      return {
        content: [{ type: 'text', text: `Tool execution failed: ${error.message}` }],
        isError: true,
      };
    }
  }

  async handleCompletionComplete(
    params: any,
    organizationId: string,
    gatewayId?: string,
  ): Promise<{ completion: { values: string[]; hasMore?: boolean; total?: number } }> {
    const ref = params?.ref;
    const argument = params?.argument;

    if (!ref || !argument) {
      return { completion: { values: [] } };
    }

    const prefix = (argument.value || '').toLowerCase();

    if (ref.type === 'ref/prompt' || ref.type === 'ref/resource') {
      const tools = await this.getToolsForGateway(organizationId, gatewayId);
      const matches = tools
        .map((t) => t.name)
        .filter((name) => name.toLowerCase().startsWith(prefix))
        .slice(0, 20);

      return {
        completion: {
          values: matches,
          hasMore: false,
          total: matches.length,
        },
      };
    }

    return { completion: { values: [] } };
  }

  sanitizeToolName(name: string): string {
    if (!name) return 'unnamed_tool';

    let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    sanitized = sanitized.replace(/[-_]{2,}/g, '_');
    sanitized = sanitized.replace(/^[-_]+|[-_]+$/g, '');

    if (/^[0-9]/.test(sanitized)) {
      sanitized = `tool_${sanitized}`;
    }

    if (!sanitized) {
      sanitized = 'unnamed_tool';
    }

    if (sanitized.length > 64) {
      sanitized = sanitized.substring(0, 64);
    }

    return sanitized;
  }

  async getToolsForScope(
    organizationId: string,
    gatewayId?: string,
    caller?: { id: string },
  ): Promise<Tool[]> {
    if (gatewayId) {
      const gatewayTools = await this.gatewayToolRepository.find({
        where: { gatewayId, isActive: true },
        relations: { tool: { categories: true } },
      });
      // Gateway membership gates org/team tools; a private tool is served
      // only through a gateway private to the tool's own owner.
      return this.servableThroughGateway(gatewayTools.map((gt: any) => gt.tool).filter(Boolean), gatewayId);
    }
    const result = await this.toolsService.getTools({ organizationId, status: ToolStatus.ACTIVE, ...this.listScope(gatewayId, caller) });
    return result.tools;
  }

  private async getToolsForGateway(organizationId: string, gatewayId?: string, userId?: string): Promise<Tool[]> {
    if (gatewayId) {
      const gatewayTools = await this.gatewayToolRepository.find({
        where: { gatewayId },
        relations: { tool: true },
      });
      return this.servableThroughGateway(
        gatewayTools.map((gt) => gt.tool).filter((t) => t && t.status === ToolStatus.ACTIVE),
        gatewayId,
      );
    }
    const tools = await this.toolRepository.find({
      where: { organization: { id: organizationId }, status: ToolStatus.ACTIVE },
    });
    return withoutOthersPrivate(tools, userId);
  }

  /**
   * The tools a gateway may serve. A gateway is reached by whoever holds
   * its endpoint or key, so a private tool passes only when the gateway is
   * itself private to the tool's own owner (the same rule the UTCP manual
   * and the skill/CLI/SDK bundles apply). The gateway row is read only when
   * there is a private tool to decide about.
   */
  private async servableThroughGateway<T extends Tool>(tools: T[], gatewayId: string): Promise<T[]> {
    if (!tools.some((t) => t.visibility === 'private')) return tools;
    const gateway = await this.gatewayToolRepository.manager.getRepository(Gateway).findOne({
      where: { id: gatewayId },
      select: { id: true, visibility: true, ownerUserId: true },
    });
    return servableOnGateway(tools, gateway);
  }
  private createError(code: JsonRpcErrorCode, message: string): any {
    const error = new Error() as any;
    error.code = code;
    error.message = message;
    return error;
  }
}
