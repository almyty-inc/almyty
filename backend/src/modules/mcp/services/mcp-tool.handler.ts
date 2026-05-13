import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';

import {
  JsonRpcErrorCode,
  McpTool,
  McpToolsListResult,
  McpCallToolRequest,
  McpCallToolResult,
} from '../types/mcp.types';

import { Tool, ToolStatus } from '../../../entities/tool.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { ToolCategory } from '../../../entities/tool-category.entity';
import { ToolsService } from '../../tools/tools.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';

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
  ) {}

  async handleToolsList(params: any, organizationId: string, gatewayId?: string): Promise<any> {
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
      const gatewayTools = await this.gatewayToolRepository.find({
        where: { gatewayId, isActive: true },
        relations: ['tool'],
      });
      tools = gatewayTools.map((gt: any) => gt.tool).filter(Boolean);
      this.logger.log(`[GATEWAY-SCOPE] Returning ${tools.length} tools for gateway ${gatewayId}`);
    } else {
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

    try {
      await this.redis.setex(cacheKey, 60, JSON.stringify(result));
    } catch (e) {
      // Non-critical
    }

    return result;
  }

  async handleToolsDiscover(params: any, organizationId: string, gatewayId?: string): Promise<any> {
    const category = params?.category as string | undefined;
    const depth = (params?.depth as string) || 'categories';

    const tools = await this.getToolsForScope(organizationId, gatewayId);

    const categories = await this.toolCategoryRepository.find({
      where: { organizationId, isActive: true },
      relations: ['tools'],
      order: { sortOrder: 'ASC', name: 'ASC' },
    });

    if (depth === 'categories') {
      const categoryList = categories.map(cat => ({
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        description: cat.description,
        icon: cat.icon,
        toolCount: cat.tools?.filter(t => t.status === ToolStatus.ACTIVE).length || 0,
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

  async handleToolsSearch(params: any, organizationId: string, gatewayId?: string): Promise<any> {
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
    });

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

  async handleToolGet(params: any, organizationId: string): Promise<any> {
    const toolName = params?.name as string;

    if (!toolName) {
      throw this.createError(JsonRpcErrorCode.INVALID_PARAMS, 'Missing required parameter: name');
    }

    const allTools = await this.toolRepository.find({
      where: { status: ToolStatus.ACTIVE, organizationId },
      relations: ['categories', 'operation'],
    });

    const tool = allTools.find(t => this.sanitizeToolName(t.name) === toolName);

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
  ): Promise<McpCallToolResult> {
    if (!params.name) {
      throw this.createError(JsonRpcErrorCode.INVALID_PARAMS, 'Tool name is required');
    }

    let tool = await this.toolsService.findByName(params.name, organizationId);

    if (!tool) {
      const allTools = await this.toolsService.getTools({ organizationId });
      tool = allTools.tools.find(t => this.sanitizeToolName(t.name) === params.name);

      if (!tool) {
        throw this.createError(JsonRpcErrorCode.TOOL_NOT_FOUND, `Tool not found: ${params.name}`);
      }
    }

    try {
      const result = await this.toolExecutorService.executeTool(
        tool.id,
        params.arguments || {},
        { userId: userId || null, organizationId },
      );

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

  async getToolsForScope(organizationId: string, gatewayId?: string): Promise<Tool[]> {
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

  private createError(code: JsonRpcErrorCode, message: string): any {
    const error = new Error() as any;
    error.code = code;
    error.message = message;
    return error;
  }
}
