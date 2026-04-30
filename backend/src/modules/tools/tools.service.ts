import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindManyOptions, Like, In, MoreThanOrEqual } from 'typeorm';

import { Tool, ToolStatus, ToolType, ToolExecutionMethod } from '../../entities/tool.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Api } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';

import { CreateToolDto, UpdateToolDto, ToolSearchFilters, ToolUsageStats } from './dto/tools.dto';
export type { CreateToolDto, UpdateToolDto, ToolSearchFilters, ToolUsageStats };

@Injectable()
export class ToolsService {
  private readonly logger = new Logger(ToolsService.name);

  constructor(
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(ToolVersion)
    private toolVersionRepository: Repository<ToolVersion>,
    @InjectRepository(ToolCategory)
    private toolCategoryRepository: Repository<ToolCategory>,
    @InjectRepository(ToolExecution)
    private toolExecutionRepository: Repository<ToolExecution>,
    @InjectRepository(Api)
    private apiRepository: Repository<Api>,
    @InjectRepository(Operation)
    private operationRepository: Repository<Operation>,
    @InjectRepository(ApiSchema)
    private apiSchemaRepository: Repository<ApiSchema>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async createTool(
    createToolDto: CreateToolDto,
    organizationId: string,
    userId: string
  ): Promise<Tool> {
    try {
      // Verify organization and user permissions
      const organization = await this.organizationRepository.findOne({
        where: { id: organizationId },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'create_tools')) {
        throw new ForbiddenException('User does not have permission to create tools');
      }

      // Check organization limits
      if (!organization.canAddMoreTools()) {
        throw new BadRequestException('Organization has reached tool limit');
      }

      // Validate categories if provided
      let categories: ToolCategory[] = [];
      if (createToolDto.categoryIds?.length > 0) {
        categories = await this.toolCategoryRepository.find({
          where: {
            id: In(createToolDto.categoryIds),
            organizationId,
          },
        });

        if (categories.length !== createToolDto.categoryIds.length) {
          throw new BadRequestException('Some categories were not found');
        }
      }

      // Validate operation if provided
      let operation: Operation | null = null;
      if (createToolDto.operationId) {
        operation = await this.operationRepository.findOne({
          where: { id: createToolDto.operationId },
          relations: ['api'],
        });

        if (!operation || operation.api.organizationId !== organizationId) {
          throw new BadRequestException('Operation not found or not accessible');
        }
      }

      // Validate apiId if provided
      if (createToolDto.apiId) {
        const api = await this.apiRepository.findOne({
          where: { id: createToolDto.apiId, organizationId },
        });
        if (!api) {
          throw new BadRequestException('API not found or not accessible in this organization');
        }
      }

      // Create the tool
      // Custom tools (with code or httpConfig) are ACTIVE by default, auto-generated are DRAFT
      const isCustomTool = (!!createToolDto.code || !!createToolDto.httpConfig) && !createToolDto.operationId;
      const isHttpTool = !!createToolDto.httpConfig;
      const tool = this.toolRepository.create({
        ...createToolDto,
        organizationId,
        createdBy: userId,
        status: isCustomTool ? ToolStatus.ACTIVE : ToolStatus.DRAFT,
        version: '1.0.0',
        categories,
        operationId: operation?.id || null,
        ...(isHttpTool ? {
          executionMethod: ToolExecutionMethod.HTTP,
          httpConfig: createToolDto.httpConfig,
          code: null,
        } : {}),
        ...(createToolDto.apiId ? { apiId: createToolDto.apiId } : {}),
        metadata: {
          ...createToolDto.metadata,
          isCustomTool,
        },
      });

      const savedTool = await this.toolRepository.save(tool);

      // Create initial version
      await this.createToolVersion(savedTool, 'Initial tool creation', userId);

      this.logger.log(`Tool '${savedTool.name}' created by user ${userId} in organization ${organizationId}`);

      // Audit log (fire-and-forget)
      this.auditLogService.logCreate(organizationId, userId, AuditResource.TOOL, savedTool.id, savedTool.name);

      return savedTool;

    } catch (error) {
      this.logger.error(`Failed to create tool: ${error.message}`);
      throw error;
    }
  }

  async updateTool(
    toolId: string,
    updateToolDto: UpdateToolDto,
    organizationId: string,
    userId: string
  ): Promise<Tool> {
    try {
      const tool = await this.toolRepository.findOne({
        where: { id: toolId, organizationId },
        relations: ['categories'],
      });

      if (!tool) {
        throw new NotFoundException('Tool not found');
      }

      // Check permissions
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'edit_tools') && tool.createdBy !== userId) {
        throw new ForbiddenException('User does not have permission to edit this tool');
      }

      // Capture old values for change tracking (before mutation)
      const oldValues = { name: tool.name, description: tool.description, parameters: tool.parameters, code: tool.code, configuration: tool.configuration, metadata: tool.metadata };

      // Handle categories update
      if (updateToolDto.categoryIds !== undefined) {
        if (updateToolDto.categoryIds.length > 0) {
          const categories = await this.toolCategoryRepository.find({
            where: {
              id: In(updateToolDto.categoryIds),
              organizationId,
            },
          });

          if (categories.length !== updateToolDto.categoryIds.length) {
            throw new BadRequestException('Some categories were not found');
          }

          tool.categories = categories;
        } else {
          tool.categories = [];
        }
      }

      // Update other fields
      if (updateToolDto.name !== undefined) {
        tool.name = updateToolDto.name;
      }

      if (updateToolDto.description !== undefined) {
        tool.description = updateToolDto.description;
      }

      if (updateToolDto.parameters !== undefined) {
        tool.parameters = updateToolDto.parameters;
      }

      if (updateToolDto.code !== undefined) {
        tool.code = updateToolDto.code;
      }

      if (updateToolDto.configuration !== undefined) {
        tool.configuration = { ...tool.configuration, ...updateToolDto.configuration };
      }

      if (updateToolDto.metadata !== undefined) {
        tool.metadata = { ...tool.metadata, ...updateToolDto.metadata };
      }

      if (updateToolDto.sdkConfig !== undefined) {
        tool.sdkConfig = updateToolDto.sdkConfig;
      }

      if (updateToolDto.dependencies !== undefined) {
        tool.dependencies = updateToolDto.dependencies;
      }

      // Increment version
      const versionParts = tool.version.split('.').map(Number);
      versionParts[2]++; // Increment patch version
      tool.version = versionParts.join('.');

      tool.updatedBy = userId;

      const updatedTool = await this.toolRepository.save(tool);

      // Create new version
      await this.createToolVersion(updatedTool, 'Tool updated', userId);

      this.logger.log(`Tool '${updatedTool.name}' updated by user ${userId}`);

      // Audit log (fire-and-forget)
      const changes = this.auditLogService.computeChanges(oldValues, updateToolDto, ['name', 'description', 'parameters', 'code', 'configuration', 'metadata']);
      this.auditLogService.logUpdate(organizationId, userId, AuditResource.TOOL, updatedTool.id, updatedTool.name, changes);

      return updatedTool;

    } catch (error) {
      this.logger.error(`Failed to update tool: ${error.message}`);
      throw error;
    }
  }

  async getTool(
    toolId: string,
    organizationId: string,
    includeRelations = true
  ): Promise<Tool> {
    const relations = includeRelations ? [
      'categories',
      'operation',
      'operation.api',
      'inputSchema',
      'outputSchema',
      'versions',
      'gatewayAssociations',
      'gatewayAssociations.gateway',
    ] : [];

    const tool = await this.toolRepository.findOne({
      where: { id: toolId, organizationId },
      relations,
    });

    if (!tool) {
      throw new NotFoundException('Tool not found');
    }

    return tool;
  }

  async getTools(filters: ToolSearchFilters): Promise<{
    tools: Tool[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;

    const queryBuilder = this.toolRepository
      .createQueryBuilder('tool')
      .leftJoinAndSelect('tool.categories', 'category')
      .leftJoinAndSelect('tool.operation', 'operation')
      .leftJoinAndSelect('operation.api', 'api')
      .leftJoinAndSelect('tool.gatewayAssociations', 'gatewayAssociation')
      .leftJoinAndSelect('gatewayAssociation.gateway', 'gateway')
      .where('tool.organizationId = :organizationId', { organizationId: filters.organizationId });

    // Apply filters
    if (filters.search) {
      queryBuilder.andWhere(
        '(tool.name ILIKE :search OR tool.description ILIKE :search)',
        { search: `%${filters.search}%` }
      );
    }

    if (filters.type) {
      queryBuilder.andWhere('tool.type = :type', { type: filters.type });
    }

    if (filters.status) {
      queryBuilder.andWhere('tool.status = :status', { status: filters.status });
    }

    if (filters.categoryIds?.length > 0) {
      queryBuilder.andWhere('category.id IN (:...categoryIds)', {
        categoryIds: filters.categoryIds,
      });
    }

    if (filters.apiId) {
      queryBuilder.andWhere('api.id = :apiId', { apiId: filters.apiId });
    }

    if (filters.tags?.length > 0) {
      queryBuilder.andWhere('tool.tags && :tags', { tags: filters.tags });
    }

    // Apply sorting
    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder || 'DESC';

    if (sortBy === 'usage') {
      // Sort by usage count - would need a subquery for execution count
      queryBuilder
        .leftJoin('tool.executions', 'execution')
        .addSelect('COUNT(execution.id)', 'usageCount')
        .groupBy('tool.id')
        .addGroupBy('category.id')
        .addGroupBy('operation.id')
        .addGroupBy('api.id')
        .orderBy('usageCount', sortOrder);
    } else {
      queryBuilder.orderBy(`tool.${sortBy}`, sortOrder);
    }

    // Get total count
    const totalQuery = queryBuilder.clone();
    const total = await totalQuery.getCount();

    // Apply pagination
    const tools = await queryBuilder
      .skip(skip)
      .take(limit)
      .getMany();

    const totalPages = Math.ceil(total / limit);

    return {
      tools,
      total,
      page,
      limit,
      totalPages,
    };
  }

  async activateTool(
    toolId: string,
    organizationId: string,
    userId: string
  ): Promise<Tool> {
    const tool = await this.getTool(toolId, organizationId, false);

    // Check permissions
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['organizationMemberships'],
    });

    if (!user?.hasPermissionInOrganization(organizationId, 'manage_tools')) {
      throw new ForbiddenException('User does not have permission to manage tools');
    }

    if (tool.status === ToolStatus.ACTIVE) {
      return tool;
    }

    tool.status = ToolStatus.ACTIVE;
    tool.updatedBy = userId;

    const updatedTool = await this.toolRepository.save(tool);

    await this.createToolVersion(updatedTool, 'Tool activated', userId);

    this.logger.log(`Tool '${tool.name}' activated by user ${userId}`);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, userId, action: AuditAction.TOOL_ACTIVATE, resourceType: AuditResource.TOOL, resourceId: tool.id, resourceName: tool.name });

    return updatedTool;
  }

  async deactivateTool(
    toolId: string,
    organizationId: string,
    userId: string
  ): Promise<Tool> {
    const tool = await this.getTool(toolId, organizationId, false);

    // Check permissions
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['organizationMemberships'],
    });

    if (!user?.hasPermissionInOrganization(organizationId, 'manage_tools')) {
      throw new ForbiddenException('User does not have permission to manage tools');
    }

    if (tool.status === ToolStatus.INACTIVE) {
      return tool;
    }

    tool.status = ToolStatus.INACTIVE;
    tool.updatedBy = userId;

    const updatedTool = await this.toolRepository.save(tool);

    await this.createToolVersion(updatedTool, 'Tool deactivated', userId);

    this.logger.log(`Tool '${tool.name}' deactivated by user ${userId}`);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, userId, action: AuditAction.TOOL_DEACTIVATE, resourceType: AuditResource.TOOL, resourceId: tool.id, resourceName: tool.name });

    return updatedTool;
  }

  async deleteTool(
    toolId: string,
    organizationId: string,
    userId: string
  ): Promise<void> {
    const tool = await this.getTool(toolId, organizationId, false);

    // Check permissions
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['organizationMemberships'],
    });

    if (!user?.hasPermissionInOrganization(organizationId, 'delete_tools') && tool.createdBy !== userId) {
      throw new ForbiddenException('User does not have permission to delete this tool');
    }

    // Soft delete by setting status to deleted
    tool.status = ToolStatus.DELETED;
    tool.updatedBy = userId;

    await this.toolRepository.save(tool);

    this.logger.log(`Tool '${tool.name}' deleted by user ${userId}`);

    // Audit log (fire-and-forget)
    this.auditLogService.logDelete(organizationId, userId, AuditResource.TOOL, tool.id, tool.name);
  }

  async getToolVersions(
    toolId: string,
    organizationId: string
  ): Promise<ToolVersion[]> {
    const tool = await this.getTool(toolId, organizationId, false);
    
    return this.toolVersionRepository.find({
      where: { toolId: tool.id },
      order: { createdAt: 'DESC' },
      relations: ['createdByUser'],
    });
  }

  async getToolUsageStats(
    toolId: string,
    organizationId: string,
    timeframe: 'hour' | 'day' | 'week' | 'month' = 'day'
  ): Promise<ToolUsageStats> {
    const tool = await this.getTool(toolId, organizationId, false);

    const timeframeDurations = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
    };

    const since = new Date(Date.now() - timeframeDurations[timeframe]);

    // Get executions. Previously this used the MongoDB-style
    // `{ $gte: since }` operator, which TypeORM doesn't recognise —
    // the whole where clause was an object-literal comparison that
    // matched zero rows, so `getToolUsageStats` silently returned
    // all-zeros for every tool in every timeframe.
    const executions = await this.toolExecutionRepository.find({
      where: {
        toolId: tool.id,
        organizationId,
        createdAt: MoreThanOrEqual(since),
      },
      relations: ['user'],
    });

    const total = executions.length;
    const successful = executions.filter(e => e.success).length;
    const failed = total - successful;
    const avgTime = total > 0 ? executions.reduce((sum, e) => sum + e.executionTime, 0) / total : 0;
    const cached = executions.filter(e => e.cached).length;
    const cacheHitRate = total > 0 ? (cached / total) * 100 : 0;
    const rateLimited = executions.filter(e => e.metadata?.rateLimited).length;
    const uniqueUsers = new Set(executions.map(e => e.userId)).size;

    // Calculate trend data
    const trendData = this.calculateExecutionTrend(executions, timeframe);

    return {
      totalExecutions: total,
      successfulExecutions: successful,
      failedExecutions: failed,
      averageExecutionTime: Math.round(avgTime),
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      rateLimitedExecutions: rateLimited,
      uniqueUsers,
      executionTrend: trendData,
    };
  }

  async getOrganizationToolStats(organizationId: string): Promise<{
    totalTools: number;
    activeTools: number;
    draftTools: number;
    inactiveTools: number;
    totalExecutions: number;
    averageExecutionTime: number;
    topUsedTools: Array<{
      tool: Tool;
      executionCount: number;
    }>;
  }> {
    // Get tool counts
    const toolCounts = await this.toolRepository
      .createQueryBuilder('tool')
      .select('tool.status')
      .addSelect('COUNT(*)', 'count')
      .where('tool.organizationId = :organizationId', { organizationId })
      .groupBy('tool.status')
      .getRawMany();

    const statusCounts: Record<string, number> = toolCounts.reduce((acc, row) => {
      acc[row.tool_status] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);

    const totalTools = Object.values(statusCounts).reduce((sum: number, count: number) => sum + count, 0);

    // Get execution stats
    const executions = await this.toolExecutionRepository.find({
      where: { organizationId },
      relations: ['tool'],
    });

    const totalExecutions = executions.length;
    const averageExecutionTime = totalExecutions > 0
      ? Math.round(executions.reduce((sum, e) => sum + e.executionTime, 0) / totalExecutions)
      : 0;

    // Get top used tools
    const toolUsage = executions.reduce((acc, execution) => {
      const toolId = execution.toolId;
      acc[toolId] = (acc[toolId] || 0) + 1;
      return acc;
    }, {});

    const topToolIds = Object.entries(toolUsage)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, 10)
      .map(([toolId]) => toolId);

    const topTools = await this.toolRepository.find({
      where: { id: In(topToolIds) },
    });

    const topUsedTools = topTools.map(tool => ({
      tool,
      executionCount: toolUsage[tool.id] || 0,
    }));

    return {
      totalTools,
      activeTools: statusCounts[ToolStatus.ACTIVE] || 0,
      draftTools: statusCounts[ToolStatus.DRAFT] || 0,
      inactiveTools: statusCounts[ToolStatus.INACTIVE] || 0,
      totalExecutions,
      averageExecutionTime,
      topUsedTools,
    };
  }

  private async createToolVersion(
    tool: Tool,
    changelog: string,
    userId: string
  ): Promise<ToolVersion> {
    const version = this.toolVersionRepository.create({
      toolId: tool.id,
      version: tool.version,
      definition: {
        name: tool.name,
        description: tool.description,
        type: tool.type,
        parameters: tool.parameters,
        configuration: tool.configuration,
        metadata: tool.metadata,
      },
      changelog,
      createdBy: userId,
    });

    return this.toolVersionRepository.save(version);
  }

  private calculateExecutionTrend(
    executions: ToolExecution[],
    timeframe: 'hour' | 'day' | 'week' | 'month'
  ): Array<{ date: string; executions: number; success: number; failed: number }> {
    const intervals = {
      hour: 24, // Last 24 hours
      day: 30,  // Last 30 days
      week: 12, // Last 12 weeks
      month: 12, // Last 12 months
    };

    const interval = intervals[timeframe];
    const trend: Array<{ date: string; executions: number; success: number; failed: number }> = [];

    for (let i = interval - 1; i >= 0; i--) {
      let date: Date;
      let dateKey: string;

      switch (timeframe) {
        case 'hour':
          date = new Date(Date.now() - i * 60 * 60 * 1000);
          dateKey = date.toISOString().slice(0, 13) + ':00:00Z';
          break;
        case 'day':
          date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
          dateKey = date.toISOString().slice(0, 10);
          break;
        case 'week':
          date = new Date(Date.now() - i * 7 * 24 * 60 * 60 * 1000);
          dateKey = `${date.getFullYear()}-W${this.getWeekNumber(date)}`;
          break;
        case 'month':
          date = new Date(Date.now() - i * 30 * 24 * 60 * 60 * 1000);
          dateKey = date.toISOString().slice(0, 7);
          break;
      }

      const periodExecutions = executions.filter(e => {
        const executionDate = new Date(e.createdAt);
        switch (timeframe) {
          case 'hour':
            return executionDate.getHours() === date.getHours() &&
                   executionDate.toDateString() === date.toDateString();
          case 'day':
            return executionDate.toDateString() === date.toDateString();
          case 'week':
            return this.getWeekNumber(executionDate) === this.getWeekNumber(date) &&
                   executionDate.getFullYear() === date.getFullYear();
          case 'month':
            return executionDate.getMonth() === date.getMonth() &&
                   executionDate.getFullYear() === date.getFullYear();
          default:
            return false;
        }
      });

      const total = periodExecutions.length;
      const successful = periodExecutions.filter(e => e.success).length;
      const failed = total - successful;

      trend.push({
        date: dateKey,
        executions: total,
        success: successful,
        failed,
      });
    }

    return trend;
  }

  async findByName(name: string, organizationId: string): Promise<Tool | null> {
    return this.toolRepository.findOne({
      where: {
        name,
        organizationId,
      },
    });
  }

  async createFromOperation(
    operation: Operation,
    options: {
      name: string;
      description: string;
      organizationId: string;
    }
  ): Promise<Tool> {
    // Load the operation with its API
    const operationWithApi = await this.operationRepository.findOne({
      where: { id: operation.id },
      relations: ['api'],
    });

    if (!operationWithApi) {
      throw new NotFoundException('Operation not found');
    }

    // Generate tool parameters from operation parameters
    const toolParameters = await this.generateToolParametersFromOperation(operationWithApi);

    // Generate tool configuration
    const toolConfiguration = {
      timeout: operationWithApi.timeoutMs || operationWithApi.api?.timeoutMs || 30000,
      retries: operationWithApi.api?.retryAttempts || 3,
      cache: {
        enabled: operationWithApi.type === 'query', // Cache read operations by default
        ttl: 300, // 5 minutes
      },
      rateLimit: operationWithApi.rateLimit || operationWithApi.api?.rateLimits,
    };

    // Create the tool
    const tool = this.toolRepository.create({
      name: options.name,
      description: options.description,
      type: this.mapOperationToToolType(operationWithApi),
      parameters: toolParameters,
      configuration: toolConfiguration,
      organizationId: options.organizationId,
      operationId: operation.id,
      status: ToolStatus.ACTIVE,
      version: '1.0.0',
      createdBy: 'system', // Auto-generated
      metadata: {
        autoGenerated: true,
        sourceOperation: {
          id: operationWithApi.id,
          name: operationWithApi.name,
          method: operationWithApi.method,
          endpoint: operationWithApi.endpoint,
        },
        sourceApi: {
          id: operationWithApi.api.id,
          name: operationWithApi.api.name,
          type: operationWithApi.api.type,
          baseUrl: operationWithApi.api.baseUrl,
        },
      },
    });

    const savedTool = await this.toolRepository.save(tool);

    // Create initial version
    await this.createToolVersion(savedTool, 'Auto-generated from API operation', 'system');

    this.logger.log(`Auto-generated tool '${savedTool.name}' from operation '${operationWithApi.name}'`);

    return savedTool;
  }

  async updateFromOperation(
    toolId: string,
    operation: Operation,
    options: {
      name: string;
      description: string;
      organizationId: string;
    }
  ): Promise<Tool> {
    // Load the existing tool
    const tool = await this.toolRepository.findOne({
      where: { id: toolId },
    });

    if (!tool) {
      throw new NotFoundException('Tool not found');
    }

    // Load the operation with its API
    const operationWithApi = await this.operationRepository.findOne({
      where: { id: operation.id },
      relations: ['api'],
    });

    if (!operationWithApi) {
      throw new NotFoundException('Operation not found');
    }

    // Regenerate tool parameters from operation
    const toolParameters = await this.generateToolParametersFromOperation(operationWithApi);

    // Update tool fields
    tool.description = options.description;
    tool.parameters = toolParameters;
    tool.metadata = {
      ...tool.metadata,
      autoGenerated: true,
      sourceOperation: {
        id: operationWithApi.id,
        name: operationWithApi.name,
        method: operationWithApi.method,
        endpoint: operationWithApi.endpoint,
      },
      sourceApi: {
        id: operationWithApi.api.id,
        name: operationWithApi.api.name,
        type: operationWithApi.api.type,
        baseUrl: operationWithApi.api.baseUrl,
      },
    };

    const updatedTool = await this.toolRepository.save(tool);

    this.logger.log(`Updated tool '${updatedTool.name}' from operation '${operationWithApi.name}'`);

    return updatedTool;
  }

  private async generateToolParametersFromOperation(operation: Operation): Promise<Record<string, any>> {
    const parameters: Record<string, any> = {
      type: 'object',
      properties: {},
      required: [],
    };

    // Add path parameters
    if (operation.parameters?.path) {
      Object.entries(operation.parameters.path).forEach(([name, param]: [string, any]) => {
        parameters.properties[name] = {
          type: param.type || 'string',
          description: param.description || `Path parameter: ${name}`,
          ...(param.enum && { enum: param.enum }),
          ...(param.example && { example: param.example }),
        };
        if (param.required) {
          parameters.required.push(name);
        }
      });
    }

    // Add query parameters
    if (operation.parameters?.query) {
      Object.entries(operation.parameters.query).forEach(([name, param]: [string, any]) => {
        parameters.properties[name] = {
          type: param.type || 'string',
          description: param.description || `Query parameter: ${name}`,
          ...(param.enum && { enum: param.enum }),
          ...(param.example && { example: param.example }),
        };
        if (param.required) {
          parameters.required.push(name);
        }
      });
    }

    // GraphQL operations have a different body shape: instead of a
    // single `schema`, the parser emits `body.query` (the GraphQL
    // query string) and `body.variables` (an object whose
    // `properties` map describes each variable). Lift those
    // variables to top-level so the generated SKILL.md surfaces
    // them as proper parameters.
    if (
      operation.parameters?.body?.variables?.properties &&
      typeof operation.parameters.body.variables.properties === 'object'
    ) {
      const vars = operation.parameters.body.variables;
      Object.entries(vars.properties as Record<string, any>).forEach(([name, prop]) => {
        parameters.properties[name] = prop;
      });
      if (Array.isArray(vars.required)) {
        parameters.required.push(...vars.required);
      }
    }

    // Add body parameters
    if (operation.parameters?.body) {
      this.logger.log(`[PARAMS] Body found for ${operation.name}: ${JSON.stringify(operation.parameters.body)}`);

      // Check if body has a schema with $ref
      if (operation.parameters.body.schema) {
        const bodySchema = operation.parameters.body.schema;
        this.logger.log(`[PARAMS] Body schema: ${JSON.stringify(bodySchema)}`);

        // If it's a $ref, resolve it
        if (bodySchema.$ref) {
          this.logger.log(`[PARAMS] Resolving $ref: ${bodySchema.$ref} for API ${operation.apiId}`);
          const resolvedSchema = await this.resolveSchemaRef(bodySchema.$ref, operation.apiId);
          this.logger.log(`[PARAMS] Resolved schema: ${JSON.stringify(resolvedSchema)}`);

          if (resolvedSchema && resolvedSchema.properties) {
            // Flatten the resolved schema properties into tool parameters
            Object.entries(resolvedSchema.properties).forEach(([name, prop]: [string, any]) => {
              parameters.properties[name] = prop;
            });
            if (resolvedSchema.required) {
              parameters.required.push(...resolvedSchema.required);
            }
            this.logger.log(`[PARAMS] Added ${Object.keys(parameters.properties).length} properties from resolved schema`);
          }
        }
        // If schema has properties directly
        else if (bodySchema.properties) {
          Object.entries(bodySchema.properties).forEach(([name, prop]: [string, any]) => {
            parameters.properties[name] = prop;
          });
          if (bodySchema.required) {
            parameters.required.push(...bodySchema.required);
          }
        }
      }
    }

    return parameters;
  }

  private async resolveSchemaRef(ref: string, apiId: string): Promise<any> {
    try {
      // Get the API's schema
      const apiSchema = await this.apiSchemaRepository.findOne({
        where: { apiId },
        order: { createdAt: 'DESC' },
      });

      if (!apiSchema || !apiSchema.rawSchema) {
        this.logger.warn(`No schema found for API ${apiId} to resolve $ref: ${ref}`);
        return null;
      }

      // Parse the rawSchema if it's a string
      let schemaObj: any;
      if (typeof apiSchema.rawSchema === 'string') {
        try {
          schemaObj = JSON.parse(apiSchema.rawSchema);
        } catch (error) {
          this.logger.error(`Failed to parse rawSchema: ${error.message}`);
          return null;
        }
      } else {
        schemaObj = apiSchema.rawSchema;
      }

      // Parse the $ref (e.g., "#/definitions/Order" -> ["definitions", "Order"])
      const refPath = ref.replace(/^#\//, '').split('/');

      // Navigate through the schema to find the definition
      let resolvedSchema: any = schemaObj;
      for (const key of refPath) {
        if (resolvedSchema && typeof resolvedSchema === 'object' && key in resolvedSchema) {
          resolvedSchema = resolvedSchema[key];
        } else {
          this.logger.warn(`Failed to resolve $ref ${ref}: path ${key} not found`);
          return null;
        }
      }

      return resolvedSchema || null;
    } catch (error) {
      this.logger.error(`Error resolving $ref ${ref}: ${error.message}`);
      return null;
    }
  }

  private mapOperationToToolType(operation: Operation): ToolType {
    switch (operation.method) {
      case 'GET':
        return ToolType.API;
      case 'POST':
      case 'PUT':
      case 'PATCH':
        return ToolType.API;
      case 'DELETE':
        return ToolType.API;
      default:
        return ToolType.API;
    }
  }

  private getWeekNumber(date: Date): number {
    const oneJan = new Date(date.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((date.getTime() - oneJan.getTime()) / (24 * 60 * 60 * 1000));
    return Math.ceil((date.getDay() + 1 + numberOfDays) / 7);
  }
}