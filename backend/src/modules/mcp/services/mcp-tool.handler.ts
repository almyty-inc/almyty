import { Injectable, Logger, Inject, forwardRef, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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
import { normalizeOutputSchema } from '../core/json-schema-2020';
import { mcpProtocolSettings } from '../core/mcp-settings';
import { outputSchemaViolation } from '../core/output-schema-check';
import { toolAnnotations, toolIcons, toolTitle } from '../core/tool-presentation';
import { mcpParamHeaderMismatch } from '../core/mcp-param-headers';
import { McpCallContext, McpPolymorphicResult } from '../core/mcp-protocol-core';
import { ApprovalsService } from '../../approvals/approvals.service';
import { HeldCallApprovals, heldCallInputRequired, heldCallRetry } from './mcp-held-call';
import { ToolDiscoveryService } from '../../tool-discovery/tool-discovery.service';
import { allPagesOfTools } from '../../tools/tool-pages';
import { CodeModeService } from '../../code-mode/code-mode.service';
import { GATEWAY_META_NAMES, GatewayExposure, effectiveExposure, gatewayMetaTools } from '../../code-mode/code-exposure';
import { CALL_TOOL, GET_TOOL, RUN_CODE, SEARCH_TOOLS } from '../../tool-discovery/meta-tools';

/** Errors this handler raised for an unknown tool: rethrown as protocol errors, never folded into isError. */
const UNKNOWN_TOOL_ERRORS = new WeakSet<object>();

@Injectable()
export class McpToolHandler {
  private readonly logger = new Logger(McpToolHandler.name);
  private fallbackDiscovery?: ToolDiscoveryService;

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
    // ApprovalsService, reached lazily: the approvals module imports the
    // agents module, which imports this one. Absent in unit tests, and then
    // a held call keeps its legacy answer.
    @Optional() private readonly moduleRef?: ModuleRef,
    // search_tools / get_tool ranking and descriptions (tool-discovery).
    @Optional() private readonly discovery?: ToolDiscoveryService,
  ) {}

  private approvalsService(): HeldCallApprovals | null {
    try {
      return (this.moduleRef?.get(ApprovalsService, { strict: false }) as HeldCallApprovals) ?? null;
    } catch {
      return null;
    }
  }

  // run_code on gateways (code-mode/), reached lazily like ApprovalsService.
  private codeModeService(): CodeModeService | null {
    try {
      return (this.moduleRef?.get(CodeModeService, { strict: false }) as CodeModeService) ?? null;
    } catch {
      return null;
    }
  }

  /** What a gateway serves (code-mode/code-exposure.ts), and the gateway. Unreadable means `tools`. */
  async exposureOf(gatewayId: string, organizationId: string): Promise<{ exposure: GatewayExposure; gateway: Gateway | null }> {
    let gateway: Gateway | null = null;
    try {
      gateway = await this.gatewayToolRepository.manager
        .getRepository(Gateway)
        .findOne({ where: { id: gatewayId, organizationId }, relations: { authConfigs: true } });
    } catch {
      gateway = null;
    }
    return { exposure: gateway ? effectiveExposure(gateway) : 'tools', gateway };
  }

  /**
   * search_tools, get_tool, call_tool and run_code on a gateway in `code`
   * or `both` exposure, over exactly the set tools/call resolves against
   * (discoveryScope). A wrong argument is a tool error the model can
   * correct, not a protocol error.
   */
  async callGatewayMetaTool(
    params: McpCallToolRequest,
    organizationId: string,
    userId: string | undefined,
    gateway: Gateway,
    ctx?: McpCallContext,
  ): Promise<McpCallToolResult | McpPolymorphicResult> {
    const args: Record<string, any> = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const caller = userId ? { id: userId } : undefined;
    const answer = (value: unknown, isError = false): McpCallToolResult => ({
      content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      ...(isPlainObject(value) ? { structuredContent: value as Record<string, unknown> } : {}),
      isError,
    });
    try {
      switch (params.name) {
        case SEARCH_TOOLS: {
          if (typeof args.query !== 'string' || !args.query.trim()) return answer('search_tools needs a query.', true);
          const found = await this.handleToolsSearch({ query: args.query, limit: Number.isInteger(args.limit) ? args.limit : 10 }, organizationId, gateway.id, caller);
          return answer({ tools: found.tools.map((t: any) => ({ name: t.name, summary: t.description, sideEffect: t.sideEffect, score: t.score })) });
        }
        case GET_TOOL: {
          if (typeof args.name !== 'string' || !args.name.trim()) return answer('get_tool needs a name.', true);
          const tool = await this.handleToolGet({ name: args.name }, organizationId, userId, gateway.id);
          const detail = args.detail === 'name' || args.detail === 'description' ? args.detail : 'full';
          if (detail === 'name') return answer({ name: tool.name, sideEffect: tool.sideEffect });
          if (detail === 'description') return answer({ name: tool.name, description: tool.description, sideEffect: tool.sideEffect });
          const { usage: _usage, metadata: _metadata, status: _status, version: _version, ...full } = tool;
          return answer(full);
        }
        case CALL_TOOL: {
          if (typeof args.name !== 'string' || !args.name.trim() || GATEWAY_META_NAMES.has(args.name)) {
            return answer('call_tool needs the name of one of this gateway\'s tools.', true);
          }
          const inner = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {};
          return this.handleToolCall({ name: args.name, arguments: inner } as McpCallToolRequest, organizationId, userId, gateway.id, undefined, ctx);
        }
        case RUN_CODE: {
          const codeMode = this.codeModeService();
          if (!codeMode) return answer('Scripts are not available on this server.', true);
          const scope = await this.discoveryScope(organizationId, gateway.id, caller);
          const ran = await codeMode.runOnGateway({ gateway, userId: userId ?? null, scope, params: args });
          return answer(ran.forModel, ran.isError);
        }
      }
    } catch (error: any) {
      if (UNKNOWN_TOOL_ERRORS.has(error)) return answer(`No tool named "${String(args.name)}" here. Use search_tools to find one.`, true);
      return answer(`${params.name} failed: ${error?.message ?? error}`, true);
    }
    return answer(`Unknown tool ${params.name}`, true);
  }

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
    // A gateway's exposure decides what it lists, and is part of the key, so
    // a change to it is not served from the old listing.
    const exposure: GatewayExposure = gatewayId ? (await this.exposureOf(gatewayId, organizationId)).exposure : 'tools';
    const cacheKey = gatewayId
      ? `mcp:tools:${organizationId}:${gatewayId}:${exposure}:cursor:${cursor}`
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
      // What the gateway serves -- the same set tools/call resolves against,
      // in a stable order (name, then id) -- with what a listing renders.
      tools = await servableToolsOnGateway(this.gatewayToolRepository, gatewayId, {
        operation: true,
        outputSchema: true,
        api: true,
      });
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
      tools = await this.withPresentation(result.tools);
      prePaged = true;
      totalCount = typeof result.total === 'number' ? result.total : cursor + tools.length;
    }

    // Title, annotations, outputSchema and icons ride along; the core drops
    // whichever the negotiated protocol version does not define.
    let mcpTools: McpTool[] = tools.map((tool) => this.toMcpTool(tool));

    // `code` exposure lists exactly the meta-tools; `both` lists them after
    // the gateway's own tools (decision 3).
    if (exposure !== 'tools') {
      const meta = gatewayMetaTools(exposure).map((d) => ({ name: d.name, description: d.description, inputSchema: d.parameters }) as McpTool);
      mcpTools = exposure === 'code' ? meta : [...mcpTools.filter((t) => !GATEWAY_META_NAMES.has(t.name)), ...meta];
    }

    // Cursor-based pagination
    const paged = prePaged ? mcpTools : mcpTools.slice(cursor, cursor + pageSize);
    const total = prePaged ? (totalCount as number) : mcpTools.length;
    const nextCursor = cursor + paged.length < total ? String(cursor + paged.length) : undefined;

    const result: any = { tools: paged };
    if (nextCursor) {
      result.nextCursor = nextCursor;
    }

    // TTL from MCP_TOOLS_LIST_CACHE_SECONDS; 0 turns the cache off.
    const ttl = mcpProtocolSettings().toolsListCacheSeconds;
    if (ttl > 0) {
      try {
        await this.redis.setex(cacheKey, ttl, JSON.stringify(result));
      } catch {
        // Non-critical
      }
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

  /**
   * The tools search_tools and get_tool may name: exactly the set tools/list
   * serves. Through a gateway, its servable set (servableToolsOnGateway, the
   * function tools/list and tools/call read); without one, the caller's view
   * of the organization (the same listScope filter tools/list applies),
   * every page of it. `tool-discovery-scope.guard.spec.ts` holds this.
   */
  async discoveryScope(organizationId: string, gatewayId?: string, caller?: { id: string }): Promise<Tool[]> {
    if (gatewayId) {
      return servableToolsOnGateway(this.gatewayToolRepository, gatewayId, { operation: true, outputSchema: true, api: true, categories: true });
    }
    return allPagesOfTools(this.toolsService, { organizationId, status: ToolStatus.ACTIVE, ...this.listScope(gatewayId, caller) });
  }

  private get toolDiscovery(): ToolDiscoveryService {
    // Without the module (positional unit-test harnesses), keyword ranking alone.
    this.fallbackDiscovery ??= this.discovery ?? new ToolDiscoveryService();
    return this.fallbackDiscovery;
  }

  /**
   * tools/search: the search_tools ranking (keywords and embeddings, over the
   * tools/list set), in the shape this method has always answered with,
   * plus each hit's side-effect class and score.
   */
  async handleToolsSearch(
    params: any,
    organizationId: string,
    gatewayId?: string,
    caller?: { id: string },
  ): Promise<any> {
    const query = params?.query as string;
    const limit = Math.min(Math.max(Number(params?.limit) || 20, 1), 100);
    const page = Math.max(Number(params?.page) || 1, 1);

    if (!query) {
      throw this.createError(JsonRpcErrorCode.INVALID_PARAMS, 'Missing required parameter: query');
    }

    const scope = await this.discoveryScope(organizationId, gatewayId, caller);
    const nameOf = (t: Tool) => this.sanitizeToolName(t.name);
    const { results, total } = await this.toolDiscovery.search(scope, query, { organizationId, limit: page * limit, nameOf, uncapped: true });
    const byName = new Map(scope.map((t) => [nameOf(t), t]));
    const pageHits = results.slice((page - 1) * limit, page * limit);

    return {
      tools: pageHits.map((hit) => {
        const tool = byName.get(hit.name)!;
        return {
          name: hit.name,
          description: tool.description,
          inputSchema: tool.parameters || { type: 'object', properties: {} },
          type: tool.type,
          sideEffect: tool.sideEffect,
          score: hit.score,
          usageCount: tool.usageCount || 0,
          successRate: tool.successRate || 0,
        };
      }),
      total,
      page,
      hasMore: page * limit < total,
    };
  }

  /**
   * tools/get: one tool from the tools/list set, with get_tool's full detail
   * (side-effect class, code name and signature) next to the fields this
   * method has always answered with. A tool outside the set is unknown
   * (-32602), like on tools/call.
   */
  async handleToolGet(params: any, organizationId: string, userId?: string, gatewayId?: string): Promise<any> {
    const toolName = params?.name as string;

    if (!toolName) {
      throw this.createError(JsonRpcErrorCode.INVALID_PARAMS, 'Missing required parameter: name');
    }

    const scope = await this.discoveryScope(organizationId, gatewayId, userId ? { id: userId } : undefined);
    const nameOf = (t: Tool) => this.sanitizeToolName(t.name);
    const found = this.toolDiscovery.resolve(scope, toolName, nameOf);
    if (!found) throw this.unknownTool(toolName);
    // The off-gateway listing does not join output schemas; the one tool described does.
    const tool = found.outputSchema !== undefined
      ? found
      : Object.assign(found, { outputSchema: (await this.toolRepository.findOne({ where: { id: found.id }, relations: { outputSchema: true } }))?.outputSchema ?? null });
    const full = this.toolDiscovery.describe(scope, tool, 'full', nameOf);

    return {
      name: nameOf(tool),
      description: tool.description,
      inputSchema: tool.parameters || { type: 'object', properties: {} },
      ...(full.outputSchema ? { outputSchema: full.outputSchema } : {}),
      type: tool.type,
      version: tool.version,
      status: tool.status,
      sideEffect: tool.sideEffect,
      openWorld: tool.openWorld,
      code: full.code,
      signature: full.signature,
      example: full.example,
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
    /** Modern requests only: the Mcp-Param-* headers it carried, lower-cased names. */
    paramHeaders?: Record<string, string>,
    /** The request's protocol context: a 2026 client may be asked to approve a held call. */
    ctx?: McpCallContext,
  ): Promise<McpCallToolResult | McpPolymorphicResult> {
    if (!params.name) {
      throw this.createError(JsonRpcErrorCode.INVALID_PARAMS, 'Tool name is required');
    }

    // A gateway in `code` or `both` exposure answers the meta-tools itself
    // (code-mode/code-exposure.ts); in `tools` exposure these names are
    // ordinary tool names, resolved below like any other.
    if (gatewayId && GATEWAY_META_NAMES.has(params.name)) {
      const { exposure, gateway } = await this.exposureOf(gatewayId, organizationId);
      if (gateway && exposure !== 'tools' && (params.name !== CALL_TOOL || exposure === 'both')) {
        return this.callGatewayMetaTool(params, organizationId, userId, gateway, ctx);
      }
    }

    // Through a gateway, only what that gateway lists (the same set tools/list
    // reads); without one, the caller's own view of the organization.
    const found = gatewayId
      ? await this.resolveGatewayTool(params.name, gatewayId)
      : await this.resolveOrgTool(params.name, organizationId, userId);
    // Another member's private tool is not callable here, and does not
    // exist as far as this caller is told.
    if (!found || isOthersPrivate(found, userId)) {
      throw this.unknownTool(params.name);
    }
    const tool = gatewayId ? found : await this.withOutputSchema(found);

    // 2026-07-28: a parameter the tool's schema mirrors into an
    // Mcp-Param-* header must agree with that header (-32020, HTTP 400).
    if (paramHeaders) {
      const mismatch = mcpParamHeaderMismatch(tool.parameters, params.arguments ?? {}, paramHeaders);
      if (mismatch) {
        const error = this.createError(JsonRpcErrorCode.HEADER_MISMATCH, `Header mismatch: ${mismatch}`);
        UNKNOWN_TOOL_ERRORS.add(error);
        throw error;
      }
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
        throw this.unknownTool(params.name);
      }
      principal = gatewayPrincipal(gateway, userId ?? null);
    }

    // A 2026 retry of a held call: the person's decision travels in
    // inputResponses, the approval in the sealed requestState. A protocol
    // error (a tampered or foreign state) is thrown before anything runs.
    const approvals = this.approvalsService();
    let args: Record<string, any> = params.arguments || {};
    let waitForHeld = false;
    if ((params as any).requestState !== undefined) {
      const retry = await heldCallRetry(params, ctx, userId, organizationId, approvals);
      if ('again' in retry) return retry.again;
      args = { ...args, _approvalId: retry.approvalId };
      waitForHeld = retry.decided;
    }

    try {
      const execute = () => this.toolExecutorService.executeTool(
        tool.id,
        args,
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
      let result = await execute();
      // Just approved: the held call runs once, on the approval event. Wait
      // a little for its result rather than send the person away.
      if (waitForHeld) {
        const deadline = Date.now() + mcpProtocolSettings().heldCallWaitMs;
        while (result.approvalStatus === 'pending' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          result = await execute();
        }
      }
      // A tool outside the call's scope is the same "not found" as a tool
      // that does not exist.
      if (result.notFound) {
        throw this.unknownTool(params.name);
      }

      // Held for a person who is the caller, on a client that can ask them:
      // ask (input_required) instead of sending them to Approvals.
      const ask = await heldCallInputRequired(result, params, ctx, userId, organizationId, approvals);
      if (ask) return ask;

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

      if (!result.success) {
        // Invalid arguments land here too: the executor refuses them and the
        // model gets the reason as a tool error it can correct, not as a
        // protocol error (2025-11-25 tools, "Error Handling", SEP-1303).
        return { content: [{ type: 'text', text: textContent }], isError: true };
      }

      // structuredContent next to the text block: newer clients read the
      // object, older ones the serialized text (the core drops the field
      // for versions before 2025-06-18).
      const structured = isPlainObject(result.data) ? (result.data as Record<string, unknown>) : undefined;
      const declared = this.declaredOutputSchema(tool);
      if (declared) {
        // A tool that declares an output schema MUST return structured
        // content that conforms to it, and a client SDK refuses a result
        // that does not. Say so as a tool error carrying the data, rather
        // than hand the client a result it will throw on.
        const problem = structured === undefined
          ? 'the tool returned no JSON object'
          : outputSchemaViolation(declared, structured);
        if (problem) {
          this.logger.warn(`Tool ${tool.name} result does not match its output schema: ${problem}`);
          return {
            content: [{
              type: 'text',
              text: `The tool's response did not match its declared output schema (${problem}). Response:\n${textContent}`,
            }],
            isError: true,
          };
        }
      }

      return {
        content: [{ type: 'text', text: textContent }],
        ...(structured !== undefined ? { structuredContent: structured } : {}),
        isError: false,
      };
    } catch (error) {
      if (UNKNOWN_TOOL_ERRORS.has(error)) throw error;
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
    sanitized = sanitized.replace(/^[-_]+|(?<![-_])[-_]+$/g, '');

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
    // Every page: a first page alone (20 tools) hid the rest from prompts.
    return allPagesOfTools(this.toolsService, { organizationId, status: ToolStatus.ACTIVE, ...this.listScope(gatewayId, caller) });
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
    const servable = await servableToolsOnGateway(this.gatewayToolRepository, gatewayId, { outputSchema: true });
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

  /**
   * An unknown tool is a protocol error, -32602 Invalid params, as in the
   * 2025-11-25 tools page's own example. It used to be a custom -32002,
   * a code the 2026-07-28 revision reserves.
   */
  private unknownTool(name: string): any {
    const error = this.createError(JsonRpcErrorCode.INVALID_PARAMS, `Tool not found: ${name}`);
    UNKNOWN_TOOL_ERRORS.add(error);
    return error;
  }

  /**
   * The output schema a tool declares in tools/list, normalised to
   * 2020-12, or null. Only object schemas qualify: `structuredContent` is
   * an object before 2026-07-28. Sources, in order: the generated
   * response schema (`tool.outputSchema`), an LLM tool's JSON output
   * schema, a remote MCP tool's own declaration.
   */
  declaredOutputSchema(tool: Tool): Record<string, any> | null {
    if (!mcpProtocolSettings().emitOutputSchema) return null;
    const llm = tool.llmConfig?.outputMode === 'json' ? tool.llmConfig.outputSchema : undefined;
    const raw =
      tool.outputSchema?.schema ?? llm ?? (tool.configuration?.mcp as any)?.outputSchema ?? null;
    return raw ? normalizeOutputSchema(raw) : null;
  }

  /** The tool's tools/list entry, before the core shapes it for a version. */
  toMcpTool(tool: Tool): McpTool {
    const outputSchema = this.declaredOutputSchema(tool);
    const icons = toolIcons(tool);
    return {
      name: this.sanitizeToolName(tool.name),
      title: toolTitle(tool),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.parameters || { type: 'object', properties: {} },
      ...(outputSchema ? { outputSchema } : {}),
      annotations: toolAnnotations(tool),
      ...(icons.length ? { icons } : {}),
    };
  }

  /**
   * Load what a listing renders (operation, output schema, API) onto tools
   * that came back without it. One query for the page, never per tool;
   * the tools keep their order.
   */
  private async withPresentation(tools: Tool[]): Promise<Tool[]> {
    const ids = tools.map((t) => t.id).filter(Boolean);
    if (!ids.length) return tools;
    let loaded: Tool[] | undefined;
    try {
      loaded = await this.toolRepository.find({
        where: { id: In(ids) },
        relations: { operation: true, outputSchema: true, api: true },
      });
    } catch (error: any) {
      this.logger.warn(`Could not load tool presentation details: ${error?.message}`);
    }
    if (!Array.isArray(loaded) || !loaded.length) return tools;
    const byId = new Map(loaded.map((t) => [t.id, t]));
    return tools.map((t) => {
      const full = byId.get(t.id);
      return full ? Object.assign(Object.create(Object.getPrototypeOf(t)), t, {
        operation: t.operation ?? full.operation,
        outputSchema: t.outputSchema ?? full.outputSchema,
        api: t.api ?? full.api,
      }) : t;
    });
  }

  /** A gateway-less tool loaded without its output schema relation gets it here. */
  private async withOutputSchema(tool: Tool): Promise<Tool> {
    if (tool.outputSchema || !tool.outputSchemaId) return tool;
    try {
      const full = await this.toolRepository.findOne({ where: { id: tool.id }, relations: { outputSchema: true } });
      return full?.outputSchema ? Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, { outputSchema: full.outputSchema }) : tool;
    } catch {
      return tool;
    }
  }

  private createError(code: JsonRpcErrorCode, message: string): any {
    const error = new Error() as any;
    error.code = code;
    error.message = message;
    return error;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
