import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

import {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcErrorCode,
  McpInitializeRequest,
  McpInitializeResult,
  McpCapabilities,
  McpSession,
  McpTool,
  McpToolsListResult,
  McpCallToolRequest,
  McpCallToolResult,
  McpResource,
  McpResourcesListResult,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpPrompt,
  McpPromptsListResult,
  McpGetPromptRequest,
  McpGetPromptResult,
  McpContent,
  McpTextContent,
} from './types/mcp.types';

import { Tool, ToolStatus } from '../../entities/tool.entity';
import { Resource } from '../../entities/resource.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolsService } from '../tools/tools.service';
import { ToolExecutorService, ToolExecutionResult } from '../tools/tool-executor.service';
import { SkillGeneratorService } from '../tools/skill-generator.service';
import { batchAsync } from '../../common/utils/batch-async';

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly sessions = new Map<string, McpSession>();
  private readonly serverInfo = {
    name: 'almyty',
    version: '1.0.0',
  };

  constructor(
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(Resource)
    private resourceRepository: Repository<Resource>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(GatewayTool)
    private gatewayToolRepository: Repository<GatewayTool>,
    @InjectRepository(ToolCategory)
    private toolCategoryRepository: Repository<ToolCategory>,
    private toolsService: ToolsService,
    private toolExecutorService: ToolExecutorService,
    private skillGeneratorService: SkillGeneratorService,
    @InjectRedis() private readonly redis: Redis.Redis,
  ) {}

  // Core JSON-RPC Handler
  async handleJsonRpc(requestBody: any, organizationId: string, userId?: string, gatewayId?: string): Promise<JsonRpcResponse> {
    try {
      const request = this.validateJsonRpcRequest(requestBody);
      
      this.logger.debug(`Handling MCP method: ${request.method} for org: ${organizationId}`);
      
      let result: any;
      
      switch (request.method) {
        case 'initialize':
          result = await this.handleInitialize(request.params as McpInitializeRequest, organizationId, userId);
          break;
          
        case 'ping':
          result = await this.handlePing();
          break;
          
        case 'tools/list':
          result = await this.handleToolsList(request.params, organizationId, gatewayId);
          break;

        case 'tools/discover':
          result = await this.handleToolsDiscover(request.params, organizationId, gatewayId);
          break;

        case 'tools/search':
          result = await this.handleToolsSearch(request.params, organizationId, gatewayId);
          break;

        case 'tools/get':
          result = await this.handleToolGet(request.params, organizationId);
          break;

        case 'tools/call':
          result = await this.handleToolCall(request.params as McpCallToolRequest, organizationId, userId);
          break;
          
        case 'resources/list':
          result = await this.handleResourcesList(request.params, organizationId);
          break;
          
        case 'resources/read':
          result = await this.handleResourceRead(request.params as McpReadResourceRequest, organizationId);
          break;
          
        case 'prompts/list':
          result = await this.handlePromptsList(request.params, organizationId);
          break;
          
        case 'prompts/get':
          result = await this.handlePromptGet(request.params as McpGetPromptRequest, organizationId);
          break;

        case 'skills/list':
          result = await this.handleSkillsList(request.params, organizationId, gatewayId);
          break;

        case 'skills/get':
          result = await this.handleSkillGet(request.params, organizationId);
          break;

        case 'resources/templates/list':
          result = await this.handleResourceTemplatesList(organizationId);
          break;

        case 'resources/subscribe':
          result = {};
          break;

        case 'resources/unsubscribe':
          result = {};
          break;

        case 'logging/setLevel':
          result = {};
          break;

        case 'completion/complete':
          result = await this.handleCompletionComplete(request.params, organizationId, gatewayId);
          break;

        // Client→server notifications (fire-and-forget, no response per JSON-RPC 2.0)
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/progress':
        case 'notifications/roots/list_changed':
          return null;

        default:
          throw this.createJsonRpcError(
            JsonRpcErrorCode.METHOD_NOT_FOUND,
            `Method not found: ${request.method}`,
            request.id
          );
      }
      
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };

      // Update gateway request metrics. Scope to the caller's org so
      // an attacker in org A can't use a leaked gatewayId from org B to
      // pollute another org's request counters.
      if (gatewayId) {
        await this.bumpGatewayMetrics(gatewayId, organizationId, true);
      }

      return response;

    } catch (error) {
      // Update gateway metrics for failed requests (same org scoping).
      if (gatewayId) {
        await this.bumpGatewayMetrics(gatewayId, organizationId, false);
      }

      if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
        return {
          jsonrpc: '2.0',
          id: requestBody?.id || null,
          error,
        };
      }

      // Log the full error server-side but don't echo stack traces /
      // internal details to the caller — JSON-RPC error.data was
      // leaking things like "Cannot read properties of undefined
      // (reading 'apiKey')" which reveal schema internals.
      this.logger.error(`MCP JSON-RPC error: ${error.message}`, error.stack);
      return {
        jsonrpc: '2.0',
        id: requestBody?.id || null,
        error: {
          code: JsonRpcErrorCode.INTERNAL_ERROR,
          message: 'Internal server error',
        },
      };
    }
  }

  /**
   * Atomically bump the gateway's request counters. Previously this
   * was a read-modify-write (`findOne` + `entity.incrementRequest()`
   * + `save`), which races under concurrent load — two overlapping
   * callers both read `totalRequests=N`, both increment to N+1,
   * both save, and one increment is lost. A SQL UPDATE with
   * server-side arithmetic is safe under any amount of concurrency.
   *
   * Scoped to organizationId so a leaked gatewayId from another org
   * can't be used to pollute a different tenant's counters.
   */
  private async bumpGatewayMetrics(
    gatewayId: string,
    organizationId: string,
    success: boolean,
  ): Promise<void> {
    try {
      await this.gatewayRepository
        .createQueryBuilder()
        .update(Gateway)
        .set({
          totalRequests: () => '"totalRequests" + 1',
          successfulRequests: success
            ? () => '"successfulRequests" + 1'
            : () => '"successfulRequests"',
          lastRequestAt: new Date(),
        })
        .where('id = :gatewayId', { gatewayId })
        .andWhere('organizationId = :organizationId', { organizationId })
        .execute();
    } catch (metricsError: any) {
      // Metrics updates are best-effort; a DB hiccup here shouldn't
      // take down the actual JSON-RPC response we're building.
      this.logger.error(`Failed to update gateway metrics: ${metricsError.message}`);
    }
  }

  // MCP Protocol Handlers
  private async handleInitialize(
    params: McpInitializeRequest,
    organizationId: string,
    userId?: string,
  ): Promise<McpInitializeResult> {
    // Validate protocol version (minimum 2024-11-05, support up to 2025-03-26)
    const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26'];
    if (!params.protocolVersion || params.protocolVersion < '2024-11-05') {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_PARAMS,
        `Unsupported protocol version: ${params.protocolVersion}. Supported: ${SUPPORTED_VERSIONS.join(', ')}`,
      );
    }

    // Create session
    const sessionId = uuidv4();
    const session: McpSession = {
      id: sessionId,
      clientInfo: params.clientInfo,
      capabilities: params.capabilities,
      transport: 'http',
      isInitialized: true,
      createdAt: new Date(),
      lastActivity: new Date(),
      organizationId,
      userId,
    };

    this.sessions.set(sessionId, session);

    this.logger.log(`MCP session initialized: ${sessionId} for org: ${organizationId}`);

    // Return server capabilities
    const serverCapabilities: McpCapabilities = {
      tools: {
        listChanged: false,
      },
      resources: {
        subscribe: false,
        listChanged: false,
      },
      prompts: {
        listChanged: false,
      },
      completions: {},
      logging: {},
      experimental: {
        almyty: {
          universalApiTranslation: true,
          multiProtocolSupport: ['mcp', 'utcp', 'a2a'],
          apiFormats: ['openapi', 'graphql', 'soap', 'protobuf'],
          progressiveDiscovery: {
            methods: ['tools/discover', 'tools/search', 'tools/get'],
            description: 'Use tools/discover for categories, tools/search for filtered results, tools/get for full schema',
          },
          skills: {
            methods: ['skills/list', 'skills/get'],
            description: 'Generate procedural skill files (YAML frontmatter + markdown) for tools and gateways',
          },
        },
      },
    };

    // Negotiate protocol version — use the highest we both support
    const negotiatedVersion = params.protocolVersion >= '2025-03-26'
      ? '2025-03-26'
      : '2024-11-05';

    return {
      protocolVersion: negotiatedVersion,
      capabilities: serverCapabilities,
      serverInfo: this.serverInfo,
    };
  }

  private async handlePing(): Promise<{}> {
    return {};
  }

  private async handleToolsList(params: any, organizationId: string, gatewayId?: string): Promise<McpToolsListResult> {
    // Check Redis cache first (60s TTL)
    const cacheKey = `mcp:tools:${organizationId}:${gatewayId || 'all'}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {
      // Cache miss or Redis error — continue to query
    }

    let tools: any[];

    if (gatewayId) {
      // Get tools assigned to this specific gateway
      const gatewayTools = await this.gatewayToolRepository.find({
        where: { gatewayId, isActive: true },
        relations: ['tool'],
      });
      tools = gatewayTools.map((gt: any) => gt.tool).filter(Boolean);
      this.logger.log(`[GATEWAY-SCOPE] Returning ${tools.length} tools for gateway ${gatewayId}`);
    } else {
      // Get all tools for organization
      const result = await this.toolsService.getTools({ organizationId });
      tools = result.tools;
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
    const cursor = params?.cursor ? parseInt(params.cursor, 10) : 0;
    const pageSize = 100;
    const paged = mcpTools.slice(cursor, cursor + pageSize);
    const nextCursor = cursor + pageSize < mcpTools.length ? String(cursor + pageSize) : undefined;

    const result: any = { tools: paged };
    if (nextCursor) {
      result.nextCursor = nextCursor;
    }

    // Cache for 60 seconds
    try {
      await this.redis.setex(cacheKey, 60, JSON.stringify(result));
    } catch (e) {
      // Non-critical — log and continue
    }

    return result;
  }

  // ==================== Progressive Tool Discovery ====================

  /**
   * tools/discover - Returns tool categories and summaries without full schemas.
   * Tier 1: Categories with tool counts (minimal tokens)
   * Tier 2: Tool summaries (name + description, no schemas)
   */
  private async handleToolsDiscover(params: any, organizationId: string, gatewayId?: string): Promise<any> {
    const category = params?.category as string | undefined;
    const depth = (params?.depth as string) || 'categories';

    // Get all active tools for this org/gateway
    const tools = await this.getToolsForScope(organizationId, gatewayId);

    // Get categories for this organization
    const categories = await this.toolCategoryRepository.find({
      where: { organizationId, isActive: true },
      relations: ['tools'],
      order: { sortOrder: 'ASC', name: 'ASC' },
    });

    if (depth === 'categories') {
      // Tier 1: Just categories with counts
      const categoryList = categories.map(cat => ({
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        description: cat.description,
        icon: cat.icon,
        toolCount: cat.tools?.filter(t => t.status === ToolStatus.ACTIVE).length || 0,
      }));

      // Count uncategorized tools
      const categorizedToolIds = new Set(categories.flatMap(c => c.tools?.map(t => t.id) || []));
      const uncategorizedCount = tools.filter(t => !categorizedToolIds.has(t.id)).length;

      return {
        categories: categoryList,
        uncategorizedCount,
        totalTools: tools.length,
      };
    }

    // Tier 2: Tool summaries (optionally filtered by category)
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
   * tools/search - Search tools by query string with optional filters.
   * Returns summaries + schemas for matched tools.
   */
  private async handleToolsSearch(params: any, organizationId: string, gatewayId?: string): Promise<any> {
    const query = params?.query as string;
    const limit = Math.min(params?.limit || 20, 100);
    const page = params?.page || 1;

    if (!query) {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_PARAMS,
        'Missing required parameter: query',
      );
    }

    // Use existing search infrastructure
    const result = await this.toolsService.getTools({
      organizationId,
      search: query,
      status: ToolStatus.ACTIVE,
      page,
      limit,
    });

    // If gateway-scoped, filter to only gateway tools
    let tools = result.tools;
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

  /**
   * tools/get - Get full tool details including schema, stats, and metadata.
   * Use this to load the complete schema for a specific tool before calling it.
   */
  private async handleToolGet(params: any, organizationId: string): Promise<any> {
    const toolName = params?.name as string;

    if (!toolName) {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_PARAMS,
        'Missing required parameter: name',
      );
    }

    // Find tool by sanitized name match. CRITICAL: scope to the caller's
    // organization. Previously this fetched ALL active tools across ALL
    // orgs and matched by sanitized name — an MCP client in org A could
    // request a tool from org B by name and receive its full schema,
    // metadata, and stats.
    const allTools = await this.toolRepository.find({
      where: { status: ToolStatus.ACTIVE, organizationId },
      relations: ['categories', 'operation'],
    });

    const tool = allTools.find(t => this.sanitizeToolName(t.name) === toolName);

    if (!tool) {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INTERNAL_ERROR,
        `Tool not found: ${toolName}`,
      );
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

  /**
   * Helper: Get active tools for an org or gateway scope.
   */
  private async getToolsForScope(organizationId: string, gatewayId?: string): Promise<Tool[]> {
    if (gatewayId) {
      const gatewayTools = await this.gatewayToolRepository.find({
        where: { gatewayId, isActive: true },
        relations: ['tool', 'tool.categories'],
      });
      return gatewayTools.map((gt: any) => gt.tool).filter(Boolean);
    }
    const result = await this.toolsService.getTools({ organizationId, status: ToolStatus.ACTIVE });
    return result.tools;
  }

  // ==================== End Progressive Tool Discovery ====================

  /**
   * Sanitize tool name to match MCP client pattern: ^[a-zA-Z0-9_-]{1,64}$
   */
  private sanitizeToolName(name: string): string {
    if (!name) return 'unnamed_tool';

    // Replace any character that's not alphanumeric, underscore, or hyphen with underscore
    let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Replace multiple consecutive underscores/hyphens with a single one
    sanitized = sanitized.replace(/[-_]{2,}/g, '_');

    // Remove leading/trailing underscores or hyphens
    sanitized = sanitized.replace(/^[-_]+|[-_]+$/g, '');

    // Ensure it doesn't start with a number
    if (/^[0-9]/.test(sanitized)) {
      sanitized = `tool_${sanitized}`;
    }

    // Ensure it's not empty after sanitization
    if (!sanitized) {
      sanitized = 'unnamed_tool';
    }

    // Truncate to 64 characters if necessary
    if (sanitized.length > 64) {
      sanitized = sanitized.substring(0, 64);
    }

    return sanitized;
  }

  private async handleToolCall(
    params: McpCallToolRequest,
    organizationId: string,
    userId?: string,
  ): Promise<McpCallToolResult> {
    if (!params.name) {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_PARAMS,
        'Tool name is required',
      );
    }

    // Find the tool - first try exact match, then try to find by sanitized name
    let tool = await this.toolsService.findByName(params.name, organizationId);

    if (!tool) {
      // If not found, the client might have sent a sanitized name
      // Get all tools and find one whose sanitized name matches
      const allTools = await this.toolsService.getTools({ organizationId });
      tool = allTools.tools.find(t => this.sanitizeToolName(t.name) === params.name);

      if (!tool) {
        throw this.createJsonRpcError(
          JsonRpcErrorCode.TOOL_NOT_FOUND,
          `Tool not found: ${params.name}`,
        );
      }
    }

    try {
      // Execute the tool using our existing tool execution service
      // Note: userId can be null for MCP sessions without user auth
      const result = await this.toolExecutorService.executeTool(
        tool.id,
        params.arguments || {},
        {
          userId: userId || null,
          organizationId,
        }
      );

      // Convert result to MCP content format
      // MCP spec requires content array with type and text fields
      const textContent = !result.success && result.error
        ? result.error
        : typeof result.data === 'string'
          ? result.data
          : JSON.stringify(result.data ?? {}, null, 2);

      return {
        content: [
          {
            type: 'text',
            text: textContent,
          },
        ],
        isError: !result.success,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Tool execution failed: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleResourcesList(params: any, organizationId: string): Promise<McpResourcesListResult> {
    // Get resources from APIs in this organization
    const resources = await this.resourceRepository.find({
      where: {
        api: {
          organizationId,
        },
      },
      relations: ['api'],
    });

    const mcpResources: McpResource[] = resources.map(resource => ({
      uri: `almyty://resources/${resource.id}`,
      name: resource.name,
      ...(resource.description ? { description: resource.description } : {}),
      mimeType: 'application/json',
    }));

    // Cursor-based pagination
    const cursor = params?.cursor ? parseInt(params.cursor, 10) : 0;
    const pageSize = 100;
    const paged = mcpResources.slice(cursor, cursor + pageSize);
    const result: any = { resources: paged };
    if (cursor + pageSize < mcpResources.length) {
      result.nextCursor = String(cursor + pageSize);
    }

    return result;
  }

  private async handleResourceTemplatesList(organizationId: string): Promise<{ resourceTemplates: any[] }> {
    return { resourceTemplates: [] };
  }

  private async handleResourceRead(
    params: McpReadResourceRequest,
    organizationId: string,
  ): Promise<McpReadResourceResult> {
    // Extract resource ID from URI
    const match = params.uri.match(/almyty:\/\/resources\/(.+)/);
    if (!match) {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.RESOURCE_NOT_FOUND,
        'Invalid resource URI format',
      );
    }

    const resourceId = match[1];
    const resource = await this.resourceRepository.findOne({
      where: {
        id: resourceId,
        api: {
          organizationId,
        },
      },
      relations: ['api'],
    });

    if (!resource) {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.RESOURCE_NOT_FOUND,
        'Resource not found',
      );
    }

    const content: McpContent[] = [
      {
        type: 'text',
        text: JSON.stringify(resource.schema || resource.properties, null, 2),
      } as McpTextContent,
    ];

    return {
      contents: content,
    };
  }

  private async handlePromptsList(params: any, organizationId: string): Promise<McpPromptsListResult> {
    // Generate prompts from available tools in the organization
    const tools = await this.toolRepository.find({
      where: { organization: { id: organizationId }, status: ToolStatus.ACTIVE },
    });

    const prompts: McpPrompt[] = [];

    // Create a prompt for each tool that has parameters
    for (const tool of tools) {
      const schema = tool.parameters as any;
      const props = schema?.properties || {};
      const requiredSet = new Set<string>(schema?.required || []);

      prompts.push({
        name: `use-${this.sanitizeToolName(tool.name)}`,
        description: `Execute the ${tool.name} tool${tool.description ? ': ' + tool.description : ''}`,
        arguments: Object.entries(props).map(([name, prop]: [string, any]) => ({
          name,
          description: prop.description || `Parameter: ${name}`,
          required: requiredSet.has(name),
        })),
      });
    }

    // Add a discovery prompt
    prompts.push({
      name: 'list-available-tools',
      description: 'List all available tools and their capabilities',
      arguments: [],
    });

    // Cursor-based pagination
    const cursor = params?.cursor ? parseInt(params.cursor, 10) : 0;
    const pageSize = 100;
    const paged = prompts.slice(cursor, cursor + pageSize);
    const result: any = { prompts: paged };
    if (cursor + pageSize < prompts.length) {
      result.nextCursor = String(cursor + pageSize);
    }

    return result;
  }

  private async handlePromptGet(
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

    // Handle use-{toolName} prompts
    if (params.name.startsWith('use-')) {
      const toolName = params.name.replace('use-', '');
      const tool = await this.toolRepository.findOne({
        where: { name: toolName, organization: { id: organizationId } },
      });

      if (!tool) {
        throw this.createJsonRpcError(
          JsonRpcErrorCode.RESOURCE_NOT_FOUND,
          `Tool '${toolName}' not found`,
        );
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

    throw this.createJsonRpcError(
      JsonRpcErrorCode.RESOURCE_NOT_FOUND,
      `Prompt '${params.name}' not found`,
    );
  }

  // Utility Methods
  private validateJsonRpcRequest(body: any): JsonRpcRequest {
    if (!body || typeof body !== 'object') {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_REQUEST,
        'Invalid request body',
      );
    }

    if (body.jsonrpc !== '2.0') {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_REQUEST,
        'Invalid JSON-RPC version',
      );
    }

    if (!body.method || typeof body.method !== 'string') {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_REQUEST,
        'Missing or invalid method',
      );
    }

    // JSON-RPC 2.0 notifications have no id and expect no response.
    // Only require id for non-notification methods.
    const isNotification = body.method.startsWith('notifications/');
    if (!isNotification && body.id === undefined) {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_REQUEST,
        'Missing request ID',
      );
    }

    return body as JsonRpcRequest;
  }

  private createJsonRpcError(code: JsonRpcErrorCode, message: string, id?: string | number): JsonRpcError {
    const error = new Error() as any;
    error.code = code;
    error.message = message;
    error.id = id;
    return error;
  }

  // Session Management
  async getSession(sessionId: string): Promise<McpSession | null> {
    return this.sessions.get(sessionId) || null;
  }

  async removeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.logger.log(`MCP session removed: ${sessionId}`);
  }

  async getActiveSessions(organizationId: string): Promise<McpSession[]> {
    return Array.from(this.sessions.values()).filter(
      session => session.organizationId === organizationId
    );
  }

  // Notification Broadcasting  
  async broadcastNotification(
    organizationId: string,
    method: string,
    params?: any,
  ): Promise<void> {
    const sessions = await this.getActiveSessions(organizationId);
    
    for (const session of sessions) {
      // In a real implementation, we'd send this to the client via their transport
      this.logger.debug(`Broadcasting notification ${method} to session ${session.id}`);
    }
  }

  // Convert our tools to MCP format
  async getToolsAsMcp(organizationId: string): Promise<McpTool[]> {
    const { tools } = await this.toolsService.getTools({ organizationId });
    
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description || `AI tool generated from ${tool.metadata?.sourceApi?.name || 'API'}`,
      inputSchema: tool.parameters || {
        type: 'object',
        properties: {},
        description: tool.description,
      },
    }));
  }

  // Skills handlers

  private async handleSkillsList(params: any, organizationId: string, gatewayId?: string): Promise<any> {
    // If gatewayId is provided, generate a gateway skill bundle
    if (gatewayId) {
      const skill = await this.skillGeneratorService.generateGatewaySkills(gatewayId, organizationId);
      return {
        skills: [skill],
      };
    }

    // Otherwise, list skills for all active tools in the org
    const tools = await this.getToolsForScope(organizationId);

    const skills = await batchAsync(tools.slice(0, params?.limit || 50), 5, async (tool) => {
      try {
        return await this.skillGeneratorService.generateToolSkill(tool.id, organizationId);
      } catch {
        return null;
      }
    });

    return {
      skills: skills.filter(Boolean),
    };
  }

  private async handleSkillGet(params: any, organizationId: string): Promise<any> {
    const { toolId, gatewayId } = params || {};

    if (gatewayId) {
      return this.skillGeneratorService.generateGatewaySkills(gatewayId, organizationId);
    }

    if (toolId) {
      return this.skillGeneratorService.generateToolSkill(toolId, organizationId);
    }

    throw this.createJsonRpcError(
      JsonRpcErrorCode.INVALID_PARAMS,
      'Either toolId or gatewayId is required',
    );
  }

  /**
   * completion/complete — return completions for prompt argument values
   * or resource URI templates. Provides tool/resource name completions.
   */
  private async handleCompletionComplete(
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

    // Complete tool names for prompts/get arguments
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

  private async getToolsForGateway(organizationId: string, gatewayId?: string): Promise<Tool[]> {
    if (gatewayId) {
      const gatewayTools = await this.gatewayToolRepository.find({
        where: { gatewayId },
        relations: ['tool'],
      });
      return gatewayTools
        .map((gt) => gt.tool)
        .filter((t) => t && t.status === ToolStatus.ACTIVE);
    }
    return this.toolRepository.find({
      where: { organization: { id: organizationId }, status: ToolStatus.ACTIVE },
    });
  }

  // Health check
  async healthCheck(): Promise<{
    status: string;
    activeSessions: number;
    serverInfo: any;
  }> {
    return {
      status: 'healthy',
      activeSessions: this.sessions.size,
      serverInfo: this.serverInfo,
    };
  }
}