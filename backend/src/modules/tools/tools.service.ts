import { Inject, forwardRef } from '@nestjs/common';
import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';

import { Tool, ToolStatus, ToolExecutionMethod } from '../../entities/tool.entity';
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
import {
  assertAttachable,
  isOthersPrivate,
  nameTaken,
  resolveVisibilityWrite,
} from '../../common/authorization/private-visibility';
import { assertManageable, assertReadable } from '../../common/authorization/read-rule';
import { assertNoSharedDependents } from '../../common/authorization/private-dependents';
import { isUniqueViolation } from '../../common/utils/unique-violation';
import { precheckToolQuota, withToolQuota } from './tool-quota';
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
        relations: { organizationMemberships: true },
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'create_tools')) {
        throw new ForbiddenException('User does not have permission to create tools');
      }

      // Fail fast before the validation below; the enforcing check runs
      // with the insert (withToolQuota).
      await precheckToolQuota(this.toolRepository.manager, organizationId);

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

      // Validate team scoping before persisting.
      await this.accessPolicy.assertCanScopeToTeam(
        userId,
        organizationId,
        (createToolDto as any).visibility,
        (createToolDto as any).teamId,
      );
      // The creator owns the tool; 'private' means private to them.
      const scope = resolveVisibilityWrite({
        requestedVisibility: createToolDto.visibility,
        requestedTeamId: createToolDto.teamId,
        current: { ownerId: userId },
        callerId: userId,
        noun: 'tool',
      });

      // Validate operation if provided
      let operation: Operation | null = null;
      if (createToolDto.operationId) {
        operation = await this.operationRepository.findOne({
          where: { id: createToolDto.operationId },
          relations: { api: true },
        });

        if (!operation || operation.api.organizationId !== organizationId || isOthersPrivate(operation.api, userId)) {
          throw new BadRequestException('Operation not found or not accessible');
        }
        assertAttachable({ visibility: scope.visibility, ownerId: userId, noun: 'tool' }, [operation.api], 'API');
      }

      // Validate apiId if provided
      if (createToolDto.apiId) {
        const api = await this.apiRepository.findOne({
          where: { id: createToolDto.apiId, organizationId },
        });
        if (!api || isOthersPrivate(api, userId)) {
          throw new BadRequestException('API not found or not accessible in this organization');
        }
        assertAttachable({ visibility: scope.visibility, ownerId: userId, noun: 'tool' }, [api], 'API');
      }

      // Create the tool
      // Custom tools (with code or httpConfig) are ACTIVE by default, auto-generated are DRAFT
      const isCustomTool = (!!createToolDto.code || !!createToolDto.httpConfig) && !createToolDto.operationId;
      const isHttpTool = !!createToolDto.httpConfig;
      const tool = this.toolRepository.create({
        ...createToolDto,
        organizationId,
        createdBy: userId,
        visibility: scope.visibility,
        teamId: scope.teamId,
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

      // Check organization limits and insert under the organization's
      // tool-quota lock: a real COUNT, serialised against concurrent
      // creates, not the unloaded relation canAddMoreTools() used to read.
      const savedTool = await withToolQuota(
        this.toolRepository.manager,
        organizationId,
        1,
        (tx) => tx.getRepository(Tool).save(tool),
      );

      // Create initial version
      await this.createToolVersion(savedTool, 'Initial tool creation', userId);

      this.logger.log(`Tool '${savedTool.name}' created by user ${userId} in organization ${organizationId}`);

      // Audit log (fire-and-forget)
      this.auditLogService.logCreate(organizationId, userId, AuditResource.TOOL, savedTool.id, savedTool.name);

      return savedTool;

    } catch (error) {
      // `tools_org_name_uq` keeps one live tool per (org, name) so
      // that name-based resolution in the gateways and the skill
      // renderer has a single answer. Report the collision instead
      // of letting the driver error out as a 500.
      if (isUniqueViolation(error)) {
        throw nameTaken('tool', createToolDto.name);
      }
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
      // Cannot read it (missing, another member's private tool, a team's
      // the caller is not on): 404. Can read it but not manage it: 403.
      // The creator always may.
      const tool = await assertManageable(
        this.accessPolicy,
        userId,
        await this.toolRepository.findOne({ where: { id: toolId, organizationId }, relations: { categories: true } }),
        'Tool',
        { ownerManages: true },
      );

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
      // to 'org' so we don't leave a dangling team reference. Only the
      // tool's owner may make it private.
      if (updateToolDto.visibility !== undefined || updateToolDto.teamId !== undefined) {
        const scope = resolveVisibilityWrite({
          requestedVisibility: updateToolDto.visibility,
          requestedTeamId: updateToolDto.visibility === undefined && tool.visibility !== 'team'
            ? undefined
            : updateToolDto.teamId,
          current: { visibility: tool.visibility, teamId: tool.teamId, ownerId: tool.createdBy ?? null },
          callerId: userId,
          noun: 'tool',
        });
        if (tool.apiId && scope.visibility !== 'private') {
          const api = await this.apiRepository.findOne({ where: { id: tool.apiId, organizationId } });
          if (api) assertAttachable({ visibility: scope.visibility, ownerId: scope.ownerId, noun: 'tool' }, [api], 'API');
        }
        // Going private would detach it from shared agents and gateways
        // that use it (they would fail at run time). Refuse and say which.
        if (scope.visibility === 'private' && tool.visibility !== 'private') {
          await assertNoSharedDependents(
            this.toolRepository.manager,
            this.accessPolicy,
            { noun: 'tool', organizationId, targets: [{ kind: 'tool', id: tool.id }] },
            userId,
          );
        }
        tool.visibility = scope.visibility;
        tool.teamId = scope.teamId;
        if (scope.ownerId) tool.createdBy = scope.ownerId;
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
      // A rename onto a taken name trips `tools_org_name_uq`; answer it as
      // create does rather than as a 500 carrying the driver's text.
      if (isUniqueViolation(error)) {
        throw nameTaken('tool', updateToolDto.name ?? '');
      }
      this.logger.error(`Failed to update tool: ${error.message}`);
      throw error;
    }
  }

  async getTool(
    toolId: string,
    organizationId: string,
    includeRelations = true,
    caller?: { id: string },
  ): Promise<Tool> {
    const relations = includeRelations ? {
      categories: true,
      operation: { api: true },
      inputSchema: true,
      outputSchema: true,
      versions: true,
      gatewayAssociations: { gateway: true },
    } : {};

    const tool = await this.toolRepository.findOne({
      where: { id: toolId, organizationId },
      relations,
    });

    if (!tool) {
      throw new NotFoundException('Tool not found');
    }

    // With a caller, a tool they may not read (another member's private
    // one, a team's they are not on) is "not found" -- a 403 would confirm
    // it exists.
    if (caller) await assertReadable(this.accessPolicy, caller, tool, 'Tool');
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
      // The tool's own API. Joining only through the operation left a tool
      // with an apiId but no operation nameless, and the list printed
      // "Unknown API" beside an API that exists.
      .leftJoinAndSelect('tool.api', 'toolApi')
      .leftJoinAndSelect('tool.gatewayAssociations', 'gatewayAssociation')
      .leftJoinAndSelect('gatewayAssociation.gateway', 'gateway');
    if (filters.bypassTeamFilter) {
      // System context — gateway-tool resolution already gates access
      // by gateway membership, so the team-scope filter would
      // double-filter and hide legitimately-shared tools.
      queryBuilder.where('tool.organizationId = :_orgId', { _orgId: filters.organizationId });
      // Gateway membership does not reach a private tool: it stays its
      // owner's (filters.caller, when the gateway call has one) alone.
      queryBuilder.andWhere(`(tool.visibility IS DISTINCT FROM 'private' OR tool."createdBy" = :_privateMe)`, {
        _privateMe: filters.caller?.id ?? null,
      });
    } else if (filters.caller) {
      await this.accessPolicy.applyListFilter(queryBuilder, filters.caller, filters.organizationId, 'tool', { ownerColumn: 'createdBy' });
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

    // Cannot read it: 404. Can read it but not manage it: 403.
    await assertManageable(this.accessPolicy, userId, tool, 'Tool');

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

    // Cannot read it: 404. Can read it but not manage it: 403.
    await assertManageable(this.accessPolicy, userId, tool, 'Tool');

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

    // Cannot read it: the not-found a missing tool gets. Can read it but
    // not manage it: 403. The creator always may.
    await assertManageable(this.accessPolicy, userId, tool, 'Tool', { ownerManages: true });

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
    });
  }



  async createToolVersion(
    tool: Tool,
    changelog: string,
    userId: string | null,
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

  /**
   * The live tool with this name, if any. Deleting a tool is a soft
   * delete: the row stays for history, but its name is free (the partial
   * `tools_org_name_uq` index skips it), so nothing may treat it as the
   * tool of that name. Answering with it made a re-import "update" the
   * dead row, which stayed deleted while reported as generated.
   */
  async findByName(name: string, organizationId: string): Promise<Tool | null> {
    return this.toolRepository.findOne({ where: { name, organizationId, status: Not(ToolStatus.DELETED) } });
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
  buildFromOperation(...args: Parameters<ToolsOperationHelper['buildFromOperation']>) { return this.operationHelper.buildFromOperation(...args); }
  prepareUpdateFromOperation(...args: Parameters<ToolsOperationHelper['prepareUpdateFromOperation']>) { return this.operationHelper.prepareUpdateFromOperation(...args); }
  generateToolParametersFromOperation(...args: Parameters<ToolsOperationHelper['generateToolParametersFromOperation']>) { return this.operationHelper.generateToolParametersFromOperation(...args); }
  resolveSchemaRef(...args: Parameters<ToolsOperationHelper['resolveSchemaRef']>) { return this.operationHelper.resolveSchemaRef(...args); }
  mapOperationToToolType(...args: Parameters<ToolsOperationHelper['mapOperationToToolType']>) { return this.operationHelper.mapOperationToToolType(...args); }
}