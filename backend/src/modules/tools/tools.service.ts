import { Inject, forwardRef } from '@nestjs/common';
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
import { ToolsOperationHelper } from './tools-operation.helper';
import { ToolsStatsHelper } from './tools-stats.helper';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
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
    @Inject(forwardRef(() => ToolsOperationHelper))
    @Inject(forwardRef(() => ToolsOperationHelper))
    private readonly operationHelper: ToolsOperationHelper,
    private readonly statsHelper: ToolsStatsHelper,
    private readonly accessPolicy: AccessPolicyService,
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

      // Validate team scoping before persisting.
      await this.accessPolicy.assertCanScopeToTeam(
        userId,
        organizationId,
        (createToolDto as any).visibility,
        (createToolDto as any).teamId,
      );

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

      // Authorization: tool creator can always edit; otherwise org admin/owner or team lead
      if (tool.createdBy !== userId) {
        const decision = await this.accessPolicy.canAccess({ id: userId }, tool, 'manage');
        if (!decision.allowed) {
          throw new ForbiddenException(decision.reason);
        }
      }

      // Re-validate team scoping if it's being changed.
      const updateAnyEarly = updateToolDto as any;
      if (updateAnyEarly.visibility !== undefined || updateAnyEarly.teamId !== undefined) {
        const nextVis = updateAnyEarly.visibility ?? tool.visibility;
        const nextTeamId = updateAnyEarly.teamId !== undefined ? updateAnyEarly.teamId : tool.teamId;
        await this.accessPolicy.assertCanScopeToTeam(userId, organizationId, nextVis, nextTeamId);
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

      // Protocol configs. These were missing from the update path, so a
      // PUT that changed e.g. httpConfig returned 200 but silently kept
      // the old target URL.
      if (updateToolDto.httpConfig !== undefined) {
        tool.httpConfig = updateToolDto.httpConfig;
      }

      if (updateToolDto.llmConfig !== undefined) {
        tool.llmConfig = updateToolDto.llmConfig;
      }

      if (updateToolDto.graphqlConfig !== undefined) {
        tool.graphqlConfig = updateToolDto.graphqlConfig;
      }

      if (updateToolDto.soapConfig !== undefined) {
        tool.soapConfig = updateToolDto.soapConfig;
      }

      if (updateToolDto.grpcConfig !== undefined) {
        tool.grpcConfig = updateToolDto.grpcConfig;
      }

      if (updateToolDto.examples !== undefined) {
        tool.examples = updateToolDto.examples;
      }

      if (updateToolDto.authConfig !== undefined) {
        tool.authConfig = updateToolDto.authConfig;
      }

      // Team-scoping fields (visibility + teamId) from the dashboard
      // VisibilityField. Drop a stray teamId if visibility flips back
      // to 'org' so we don't leave a dangling team reference.
      if (updateToolDto.visibility !== undefined) {
        tool.visibility = updateToolDto.visibility;
        tool.teamId = updateToolDto.visibility === 'team' ? (updateToolDto.teamId ?? null) : null;
      } else if (updateToolDto.teamId !== undefined && tool.visibility === 'team') {
        tool.teamId = updateToolDto.teamId;
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
      .leftJoinAndSelect('gatewayAssociation.gateway', 'gateway');
    if (filters.bypassTeamFilter) {
      // System context — gateway-tool resolution already gates access
      // by gateway membership, so the team-scope filter would
      // double-filter and hide legitimately-shared tools.
      queryBuilder.where('tool.organizationId = :_orgId', { _orgId: filters.organizationId });
    } else if (filters.caller) {
      await this.accessPolicy.applyListFilter(queryBuilder, filters.caller, filters.organizationId, 'tool');
    } else {
      throw new Error('getTools requires either caller or bypassTeamFilter');
    }

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

    // Authorization: org owner/admin always, team-scoped requires team lead
    const decision = await this.accessPolicy.canAccess({ id: userId }, tool, 'manage');
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason);
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

    // Authorization: org owner/admin always, team-scoped requires team lead
    const decision2 = await this.accessPolicy.canAccess({ id: userId }, tool, 'manage');
    if (!decision2.allowed) {
      throw new ForbiddenException(decision2.reason);
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

    // Authorization: tool creator can always delete; otherwise org admin/owner or team lead
    if (tool.createdBy !== userId) {
      const decision3 = await this.accessPolicy.canAccess({ id: userId }, tool, 'manage');
      if (!decision3.allowed) {
        throw new ForbiddenException(decision3.reason);
      }
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



  async createToolVersion(
    tool: Tool,
    changelog: string,
    userId: string,
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

  async findByName(name: string, organizationId: string): Promise<Tool | null> {
    return this.toolRepository.findOne({ where: { name, organizationId } });
  }

  // ── Delegations to ToolsStatsHelper ──
  async getToolUsageStats(toolId: string, organizationId: string, timeframe: 'hour' | 'day' | 'week' | 'month' = 'day') {
    const tool = await this.getTool(toolId, organizationId, false);
    return this.statsHelper.getToolUsageStats(tool, organizationId, timeframe);
  }
  getOrganizationToolStats(...args: Parameters<ToolsStatsHelper['getOrganizationToolStats']>) {
    return this.statsHelper.getOrganizationToolStats(...args);
  }

  // ── Delegations to ToolsOperationHelper ──
  createFromOperation(...args: Parameters<ToolsOperationHelper['createFromOperation']>) { return this.operationHelper.createFromOperation(...args); }
  updateFromOperation(...args: Parameters<ToolsOperationHelper['updateFromOperation']>) { return this.operationHelper.updateFromOperation(...args); }
  generateToolParametersFromOperation(...args: Parameters<ToolsOperationHelper['generateToolParametersFromOperation']>) { return this.operationHelper.generateToolParametersFromOperation(...args); }
  resolveSchemaRef(...args: Parameters<ToolsOperationHelper['resolveSchemaRef']>) { return this.operationHelper.resolveSchemaRef(...args); }
  mapOperationToToolType(...args: Parameters<ToolsOperationHelper['mapOperationToToolType']>) { return this.operationHelper.mapOperationToToolType(...args); }
}