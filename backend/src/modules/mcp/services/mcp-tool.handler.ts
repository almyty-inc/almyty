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
import { isOthersPrivate, withoutOthersPrivate } from '../../../common/authorization/private-visibility';
import { servableToolsOnGateway } from '../../gateways/gateway-servable';
import {
  ExecutionPrincipal,
  gatewayPrincipal,
  userPrincipal,
} from '../../../common/authorization/execution-access.service';
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
      // What the gateway serves -- the same set tools/call resolves against.
      tools = await servableToolsOnGateway(this.gatewayToolRepository, gatewayId);
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

    const allCategories = await this.toolCategoryRepository.find({
      where: { organizationId, isActive: true },
      relations: { tools: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });

    // Through a gateway, count only what it serves -- the tools/list set.
    // A count taken over the org would disclose the existence and number of
    // tools the gateway never published, so a category holding none of the
    // gateway's tools is not shown at all (and reads like an unknown one).
    const servedIds = gatewayId ? new Set(tools.map((t) => t.id)) : null;
    const categories = servedIds
      ? allCategories.filter((cat) => (cat.tools ?? []).some((t) => servedIds.has(t.id)))
      : allCategories;

    if (depth === 'categories') {
      const categoryList = categories.map(cat => ({
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        description: cat.description,
        icon: cat.icon,
        toolCount: servedIds
          ? (cat.tools ?? []).filter((t) => servedIds.has(t.id)).length
          : withoutOthersPrivate(cat.tools ?? [], caller?.id).filter(t => t.status === ToolStatus.ACTIVE).length,
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

    let tools: Tool[];
    let total: number;
    if (gatewayId) {
      // Search inside what the gateway serves, never around it: match, count
      // and page over the servable set (the tools/list set). Searching the
      // org and filtering the page afterwards leaked the org-wide `total`
      // and `hasMore`, and dropped servable hits that fell on another page.
      const needle = query.toLowerCase();
      const matches = withoutOthersPrivate(
        await servableToolsOnGateway(this.gatewayToolRepository, gatewayId),
        caller?.id,
      )
        .filter((t) => t.name?.toLowerCase().includes(needle) || t.description?.toLowerCase().includes(needle))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      tools = matches.slice((page - 1) * limit, page * limit);
      total = matches.length;
    } else {
      const result = await this.toolsService.getTools({
        organizationId,
        search: query,
        status: ToolStatus.ACTIVE,
        page,
        limit,
        ...this.listScope(gatewayId, caller),
      });
      tools = withoutOthersPrivate(result.tools, caller?.id);
      total = result.total;
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
      total,
      page,
      hasMore: page * limit < total,
    };
  }

  async handleToolGet(params: any, organizationId: string, userId?: string, gatewayId?: string): Promise<any> {
    const toolName = params?.name as string;

    if (!toolName) {
      throw this.createError(JsonRpcErrorCode.INVALID_PARAMS, 'Missing required parameter: name');
    }

    // Through a gateway, only the tools that gateway serves: describing an
    // org tool the gateway never published would be a listing by other means.
    const allTools = gatewayId
      ? await servableToolsOnGateway(this.gatewayToolRepository, gatewayId, { categories: true, operation: true })
      : await this.toolRepository.find({
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

    // Through a gateway, only what that gateway lists (the same set tools/list
    // reads); without one, the caller's own view of the organization.
    const tool = gatewayId
      ? await this.resolveGatewayTool(params.name, gatewayId)
      : await this.resolveOrgTool(params.name, organizationId, userId);
    // Another member's private tool is not callable here, and does not
    // exist as far as this caller is told.
    if (!tool || isOthersPrivate(tool, userId)) {
      throw this.createError(JsonRpcErrorCode.TOOL_NOT_FOUND, `Tool not found: ${params.name}`);
    }

    // Whose scope the call runs in. Through a gateway it is the gateway's --
    // a gateway serves only what its own visibility covers, re-checked on
    // every call -- and on the gateway-less path it is the caller's own.
    let principal: ExecutionPrincipal = userPrincipal(userId ?? null);
    if (gatewayId) {
      const gateway = await this.gatewayToolRepository.manager.getRepository(Gateway).findOne({
        where: { id: gatewayId, organizationId },
        select: { id: true, organizationId: true, visibility: true, teamId: true, ownerUserId: true, isSystem: true },
      });
      if (!gateway) {
        throw this.createError(JsonRpcErrorCode.TOOL_NOT_FOUND, `Tool not found: ${params.name}`);
      }
      principal = gatewayPrincipal(gateway, userId ?? null);
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
          principal,
        },
      );
      // A tool outside the call's scope is the same "not found" as a tool
      // that does not exist.
      if (result.notFound) {
        throw this.createError(JsonRpcErrorCode.TOOL_NOT_FOUND, `Tool not found: ${params.name}`);
      }

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
      if (error?.code === JsonRpcErrorCode.TOOL_NOT_FOUND) throw error;
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
      // The gateway's own set: what tools/list shows and tools/call runs.
      return servableToolsOnGateway(this.gatewayToolRepository, gatewayId, { categories: true });
    }
    const result = await this.toolsService.getTools({ organizationId, status: ToolStatus.ACTIVE, ...this.listScope(gatewayId, caller) });
    return result.tools;
  }

  private async getToolsForGateway(organizationId: string, gatewayId?: string, userId?: string): Promise<Tool[]> {
    if (gatewayId) {
      return servableToolsOnGateway(this.gatewayToolRepository, gatewayId);
    }
    const tools = await this.toolRepository.find({
      where: { organization: { id: organizationId }, status: ToolStatus.ACTIVE },
    });
    return withoutOthersPrivate(tools, userId);
  }

  /**
   * The tool a gateway call names, from the set the gateway lists.
   *
   * tools/list and tools/call both read `servableToolsOnGateway`, so a name
   * the listing does not carry resolves to nothing here -- the same
   * not-found a tool that does not exist gets. This used to look the name
   * up across the whole organization, which let a gateway run any org tool
   * it never published.
   */
  private async resolveGatewayTool(name: string, gatewayId: string): Promise<Tool | null> {
    const servable = await servableToolsOnGateway(this.gatewayToolRepository, gatewayId);
    return (
      servable.find((t) => t.name === name) ??
      servable.find((t) => this.sanitizeToolName(t.name) === name) ??
      null
    );
  }

  /** The tool a gateway-less call names: the caller's own view of the org. */
  private async resolveOrgTool(name: string, organizationId: string, userId?: string): Promise<Tool | null> {
    const byName = await this.toolsService.findByName(name, organizationId);
    if (byName) return byName;
    const allTools = await this.toolsService.getTools({ organizationId, ...this.listScope(undefined, userId ? { id: userId } : undefined) });
    return allTools.tools.find((t) => this.sanitizeToolName(t.name) === name) ?? null;
  }

  private createError(code: JsonRpcErrorCode, message: string): any {
    const error = new Error() as any;
    error.code = code;
    error.message = message;
    return error;
  }
}
