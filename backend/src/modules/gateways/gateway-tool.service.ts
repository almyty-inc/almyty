import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool, ToolStatus } from '../../entities/tool.entity';
import { User } from '../../entities/user.entity';

export interface CreateGatewayToolDto {
  toolId: string;
  isActive?: boolean;
  overrides?: {
    name?: string;
    description?: string;
    parameters?: Record<string, any>;
    rateLimit?: {
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
    timeout?: number;
    retries?: number;
    cache?: {
      enabled: boolean;
      ttl?: number;
    };
  };
  permissions?: {
    allowedUsers?: string[];
    allowedRoles?: string[];
    allowedOrganizations?: string[];
    requiredScopes?: string[];
  };
  transformations?: {
    inputMapping?: Record<string, string>;
    outputMapping?: Record<string, string>;
    headerMapping?: Record<string, string>;
  };
  metadata?: Record<string, any>;
}

export interface UpdateGatewayToolDto {
  isActive?: boolean;
  overrides?: {
    name?: string;
    description?: string;
    parameters?: Record<string, any>;
    rateLimit?: {
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
    timeout?: number;
    retries?: number;
    cache?: {
      enabled: boolean;
      ttl?: number;
    };
  };
  permissions?: {
    allowedUsers?: string[];
    allowedRoles?: string[];
    allowedOrganizations?: string[];
    requiredScopes?: string[];
  };
  transformations?: {
    inputMapping?: Record<string, string>;
    outputMapping?: Record<string, string>;
    headerMapping?: Record<string, string>;
  };
  metadata?: Record<string, any>;
  securityPolicy?: {
    allowedDomains?: string[];
    blockedDomains?: string[];
    maxResponseSizeBytes?: number;
    allowedHttpMethods?: string[];
    requireHttps?: boolean;
  } | null;
}

export interface BulkAssociateToolsDto {
  toolIds: string[];
  isActive?: boolean;
  permissions?: {
    allowedUsers?: string[];
    allowedRoles?: string[];
    allowedOrganizations?: string[];
    requiredScopes?: string[];
  };
}

export interface GatewayToolSearchFilters {
  gatewayId: string;
  isActive?: boolean;
  toolIds?: string[];
  search?: string;
  organizationId: string;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'associatedAt' | 'lastUsedAt' | 'usageCount';
  sortOrder?: 'ASC' | 'DESC';
}

@Injectable()
export class GatewayToolService {
  private readonly logger = new Logger(GatewayToolService.name);

  constructor(
    @InjectRepository(GatewayTool)
    private gatewayToolRepository: Repository<GatewayTool>,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async associateTool(
    gatewayId: string,
    createGatewayToolDto: CreateGatewayToolDto,
    organizationId: string,
    userId: string
  ): Promise<GatewayTool> {
    try {
      // Verify gateway exists and belongs to organization
      const gateway = await this.gatewayRepository.findOne({
        where: { id: gatewayId, organizationId },
      });

      if (!gateway) {
        throw new NotFoundException('Gateway not found');
      }

      // Verify tool exists
      const tool = await this.toolRepository.findOne({
        where: { id: createGatewayToolDto.toolId },
      });

      if (!tool) {
        throw new NotFoundException('Tool not found');
      }

      if (tool.status !== ToolStatus.ACTIVE) {
        throw new BadRequestException('Can only associate active tools');
      }

      // Check if association already exists
      const existingAssociation = await this.gatewayToolRepository.findOne({
        where: { gatewayId, toolId: createGatewayToolDto.toolId },
      });

      if (existingAssociation) {
        throw new BadRequestException('Tool is already associated with this gateway');
      }

      // Check user permissions
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateway_tools')) {
        throw new ForbiddenException('User does not have permission to manage gateway tools');
      }

      // Create the association
      const gatewayTool = this.gatewayToolRepository.create({
        gatewayId,
        ...createGatewayToolDto,
        isActive: createGatewayToolDto.isActive !== false, // Default to true
      });

      const savedAssociation = await this.gatewayToolRepository.save(gatewayTool);

      this.logger.log(`Tool '${tool.name}' associated with gateway '${gateway.name}'`);

      return savedAssociation;

    } catch (error) {
      this.logger.error(`Failed to associate tool with gateway: ${error.message}`);
      throw error;
    }
  }

  async updateGatewayTool(
    gatewayToolId: string,
    updateGatewayToolDto: UpdateGatewayToolDto,
    organizationId: string,
    userId: string
  ): Promise<GatewayTool> {
    try {
      const gatewayTool = await this.gatewayToolRepository.findOne({
        where: { id: gatewayToolId },
        relations: ['gateway', 'tool'],
      });

      if (!gatewayTool || gatewayTool.gateway.organizationId !== organizationId) {
        throw new NotFoundException('Gateway tool association not found');
      }

      // Check user permissions
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateway_tools')) {
        throw new ForbiddenException('User does not have permission to manage gateway tools');
      }

      // Update the association
      Object.assign(gatewayTool, updateGatewayToolDto);

      const updatedAssociation = await this.gatewayToolRepository.save(gatewayTool);

      this.logger.log(`Gateway tool association ${gatewayToolId} updated`);

      return updatedAssociation;

    } catch (error) {
      this.logger.error(`Failed to update gateway tool: ${error.message}`);
      throw error;
    }
  }

  async dissociateTool(
    gatewayToolId: string,
    organizationId: string,
    userId: string
  ): Promise<void> {
    try {
      const gatewayTool = await this.gatewayToolRepository.findOne({
        where: { id: gatewayToolId },
        relations: ['gateway', 'tool'],
      });

      if (!gatewayTool || gatewayTool.gateway.organizationId !== organizationId) {
        throw new NotFoundException('Gateway tool association not found');
      }

      // Check user permissions
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateway_tools')) {
        throw new ForbiddenException('User does not have permission to manage gateway tools');
      }

      await this.gatewayToolRepository.remove(gatewayTool);

      this.logger.log(`Tool '${gatewayTool.tool.name}' dissociated from gateway '${gatewayTool.gateway.name}'`);

    } catch (error) {
      this.logger.error(`Failed to dissociate tool from gateway: ${error.message}`);
      throw error;
    }
  }

  async bulkAssociateTools(
    gatewayId: string,
    bulkAssociateDto: BulkAssociateToolsDto,
    organizationId: string,
    userId: string
  ): Promise<{ associated: GatewayTool[]; skipped: Array<{ toolId: string; reason: string }> }> {
    try {
      // Verify gateway exists and belongs to organization
      const gateway = await this.gatewayRepository.findOne({
        where: { id: gatewayId, organizationId },
      });

      if (!gateway) {
        throw new NotFoundException('Gateway not found');
      }

      // Check user permissions
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateway_tools')) {
        throw new ForbiddenException('User does not have permission to manage gateway tools');
      }

      // Get all tools to associate
      const tools = await this.toolRepository.find({
        where: {
          id: In(bulkAssociateDto.toolIds),
          status: ToolStatus.ACTIVE,
        },
      });

      // Get existing associations
      const existingAssociations = await this.gatewayToolRepository.find({
        where: {
          gatewayId,
          toolId: In(bulkAssociateDto.toolIds),
        },
      });

      const existingToolIds = new Set(existingAssociations.map(a => a.toolId));
      
      const associated: GatewayTool[] = [];
      const skipped: Array<{ toolId: string; reason: string }> = [];

      for (const toolId of bulkAssociateDto.toolIds) {
        if (existingToolIds.has(toolId)) {
          skipped.push({
            toolId,
            reason: 'Already associated with gateway',
          });
          continue;
        }

        const tool = tools.find(t => t.id === toolId);
        if (!tool) {
          skipped.push({
            toolId,
            reason: 'Tool not found or not active',
          });
          continue;
        }

        try {
          const gatewayTool = this.gatewayToolRepository.create({
            gatewayId,
            toolId,
            isActive: bulkAssociateDto.isActive !== false,
            permissions: bulkAssociateDto.permissions,
          });

          const savedAssociation = await this.gatewayToolRepository.save(gatewayTool);
          associated.push(savedAssociation);
        } catch (error) {
          skipped.push({
            toolId,
            reason: `Failed to associate: ${error.message}`,
          });
        }
      }

      this.logger.log(
        `Bulk association completed for gateway '${gateway.name}': ` +
        `${associated.length} associated, ${skipped.length} skipped`
      );

      return { associated, skipped };

    } catch (error) {
      this.logger.error(`Failed to bulk associate tools: ${error.message}`);
      throw error;
    }
  }

  async getGatewayTools(filters: GatewayToolSearchFilters): Promise<{
    gatewayTools: GatewayTool[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    // Verify gateway exists and belongs to organization
    const gateway = await this.gatewayRepository.findOne({
      where: { id: filters.gatewayId, organizationId: filters.organizationId },
    });

    if (!gateway) {
      throw new NotFoundException('Gateway not found');
    }

    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;

    const queryBuilder = this.gatewayToolRepository
      .createQueryBuilder('gatewayTool')
      .leftJoinAndSelect('gatewayTool.tool', 'tool')
      .leftJoinAndSelect('gatewayTool.gateway', 'gateway')
      .where('gatewayTool.gatewayId = :gatewayId', { gatewayId: filters.gatewayId });

    // Apply filters
    if (filters.isActive !== undefined) {
      queryBuilder.andWhere('gatewayTool.isActive = :isActive', { isActive: filters.isActive });
    }

    if (filters.toolIds?.length > 0) {
      queryBuilder.andWhere('gatewayTool.toolId IN (:...toolIds)', { toolIds: filters.toolIds });
    }

    if (filters.search) {
      queryBuilder.andWhere(
        '(tool.name ILIKE :search OR tool.description ILIKE :search)',
        { search: `%${filters.search}%` }
      );
    }

    // Apply sorting
    const sortBy = filters.sortBy || 'associatedAt';
    const sortOrder = filters.sortOrder || 'DESC';
    
    let orderColumn: string;
    switch (sortBy) {
      case 'name':
        orderColumn = 'tool.name';
        break;
      default:
        orderColumn = `gatewayTool.${sortBy}`;
    }
    
    queryBuilder.orderBy(orderColumn, sortOrder);

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const gatewayTools = await queryBuilder
      .skip(skip)
      .take(limit)
      .getMany();

    const totalPages = Math.ceil(total / limit);

    return {
      gatewayTools,
      total,
      page,
      limit,
      totalPages,
    };
  }

  async getGatewayTool(
    gatewayToolId: string,
    organizationId: string
  ): Promise<GatewayTool> {
    const gatewayTool = await this.gatewayToolRepository.findOne({
      where: { id: gatewayToolId },
      relations: ['gateway', 'tool'],
    });

    if (!gatewayTool || gatewayTool.gateway.organizationId !== organizationId) {
      throw new NotFoundException('Gateway tool association not found');
    }

    return gatewayTool;
  }

  async getAvailableTools(
    gatewayId: string,
    organizationId: string
  ): Promise<Tool[]> {
    // Verify gateway exists and belongs to organization
    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId, organizationId },
    });

    if (!gateway) {
      throw new NotFoundException('Gateway not found');
    }

    // Get already associated tool IDs
    const associatedTools = await this.gatewayToolRepository.find({
      where: { gatewayId },
      select: ['toolId'],
    });

    const associatedToolIds = associatedTools.map(at => at.toolId);

    // Get tools not yet associated with this gateway
    const queryBuilder = this.toolRepository
      .createQueryBuilder('tool')
      .where('tool.status = :status', { status: ToolStatus.ACTIVE });

    if (associatedToolIds.length > 0) {
      queryBuilder.andWhere('tool.id NOT IN (:...associatedIds)', { associatedIds: associatedToolIds });
    }

    return queryBuilder.orderBy('tool.name', 'ASC').getMany();
  }

  async activateGatewayTool(
    gatewayToolId: string,
    organizationId: string,
    userId: string
  ): Promise<GatewayTool> {
    const gatewayTool = await this.getGatewayTool(gatewayToolId, organizationId);

    // Check permissions
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['organizationMemberships'],
    });

    if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateway_tools')) {
      throw new ForbiddenException('User does not have permission to manage gateway tools');
    }

    if (gatewayTool.isActive) {
      return gatewayTool;
    }

    gatewayTool.isActive = true;
    const updatedGatewayTool = await this.gatewayToolRepository.save(gatewayTool);

    this.logger.log(`Gateway tool ${gatewayToolId} activated`);

    return updatedGatewayTool;
  }

  async deactivateGatewayTool(
    gatewayToolId: string,
    organizationId: string,
    userId: string
  ): Promise<GatewayTool> {
    const gatewayTool = await this.getGatewayTool(gatewayToolId, organizationId);

    // Check permissions
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['organizationMemberships'],
    });

    if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateway_tools')) {
      throw new ForbiddenException('User does not have permission to manage gateway tools');
    }

    if (!gatewayTool.isActive) {
      return gatewayTool;
    }

    gatewayTool.isActive = false;
    const updatedGatewayTool = await this.gatewayToolRepository.save(gatewayTool);

    this.logger.log(`Gateway tool ${gatewayToolId} deactivated`);

    return updatedGatewayTool;
  }

  async getGatewayToolStats(gatewayId: string, organizationId: string): Promise<{
    totalTools: number;
    activeTools: number;
    inactiveTools: number;
    totalUsage: number;
    mostUsedTools: Array<{
      gatewayTool: GatewayTool;
      usageCount: number;
    }>;
    recentlyUsedTools: Array<{
      gatewayTool: GatewayTool;
      lastUsedAt: Date;
    }>;
  }> {
    // Verify gateway exists
    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId, organizationId },
    });

    if (!gateway) {
      throw new NotFoundException('Gateway not found');
    }

    // Get all gateway tools
    const gatewayTools = await this.gatewayToolRepository.find({
      where: { gatewayId },
      relations: ['tool'],
    });

    const totalTools = gatewayTools.length;
    const activeTools = gatewayTools.filter(gt => gt.isActive).length;
    const inactiveTools = totalTools - activeTools;
    const totalUsage = gatewayTools.reduce((sum, gt) => sum + gt.usageCount, 0);

    // Most used tools
    const mostUsedTools = gatewayTools
      .filter(gt => gt.usageCount > 0)
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 10)
      .map(gatewayTool => ({
        gatewayTool,
        usageCount: gatewayTool.usageCount,
      }));

    // Recently used tools
    const recentlyUsedTools = gatewayTools
      .filter(gt => gt.lastUsedAt)
      .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime())
      .slice(0, 10)
      .map(gatewayTool => ({
        gatewayTool,
        lastUsedAt: gatewayTool.lastUsedAt,
      }));

    return {
      totalTools,
      activeTools,
      inactiveTools,
      totalUsage,
      mostUsedTools,
      recentlyUsedTools,
    };
  }

  async incrementUsage(gatewayToolId: string): Promise<void> {
    try {
      await this.gatewayToolRepository.increment(
        { id: gatewayToolId },
        'usageCount',
        1
      );

      await this.gatewayToolRepository.update(
        { id: gatewayToolId },
        { lastUsedAt: new Date() }
      );
    } catch (error) {
      this.logger.warn(`Failed to increment usage for gateway tool ${gatewayToolId}: ${error.message}`);
    }
  }

  async copyToolsFromGateway(
    sourceGatewayId: string,
    targetGatewayId: string,
    organizationId: string,
    userId: string,
    overrideExisting = false
  ): Promise<{ copied: GatewayTool[]; skipped: Array<{ toolId: string; reason: string }> }> {
    try {
      // Verify both gateways exist and belong to organization
      const [sourceGateway, targetGateway] = await Promise.all([
        this.gatewayRepository.findOne({ where: { id: sourceGatewayId, organizationId } }),
        this.gatewayRepository.findOne({ where: { id: targetGatewayId, organizationId } }),
      ]);

      if (!sourceGateway) {
        throw new NotFoundException('Source gateway not found');
      }

      if (!targetGateway) {
        throw new NotFoundException('Target gateway not found');
      }

      // Check permissions
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateway_tools')) {
        throw new ForbiddenException('User does not have permission to manage gateway tools');
      }

      // Get tools from source gateway
      const sourceTools = await this.gatewayToolRepository.find({
        where: { gatewayId: sourceGatewayId },
        relations: ['tool'],
      });

      // Get existing tools in target gateway
      const existingTargetTools = await this.gatewayToolRepository.find({
        where: { gatewayId: targetGatewayId },
        select: ['toolId'],
      });

      const existingToolIds = new Set(existingTargetTools.map(t => t.toolId));

      const copied: GatewayTool[] = [];
      const skipped: Array<{ toolId: string; reason: string }> = [];

      for (const sourceTool of sourceTools) {
        if (existingToolIds.has(sourceTool.toolId) && !overrideExisting) {
          skipped.push({
            toolId: sourceTool.toolId,
            reason: 'Tool already exists in target gateway',
          });
          continue;
        }

        try {
          // Remove existing if overriding
          if (existingToolIds.has(sourceTool.toolId) && overrideExisting) {
            await this.gatewayToolRepository.delete({
              gatewayId: targetGatewayId,
              toolId: sourceTool.toolId,
            });
          }

          const newGatewayTool = this.gatewayToolRepository.create({
            gatewayId: targetGatewayId,
            toolId: sourceTool.toolId,
            isActive: sourceTool.isActive,
            overrides: sourceTool.overrides,
            permissions: sourceTool.permissions,
            transformations: sourceTool.transformations,
            metadata: sourceTool.metadata,
          });

          const savedGatewayTool = await this.gatewayToolRepository.save(newGatewayTool);
          copied.push(savedGatewayTool);

        } catch (error) {
          skipped.push({
            toolId: sourceTool.toolId,
            reason: `Failed to copy: ${error.message}`,
          });
        }
      }

      this.logger.log(
        `Copied tools from gateway '${sourceGateway.name}' to '${targetGateway.name}': ` +
        `${copied.length} copied, ${skipped.length} skipped`
      );

      return { copied, skipped };

    } catch (error) {
      this.logger.error(`Failed to copy tools between gateways: ${error.message}`);
      throw error;
    }
  }

  async removeTool(
    gatewayId: string,
    toolId: string,
    organizationId: string,
  ): Promise<void> {
    try {
      // Verify gateway belongs to organization
      const gateway = await this.gatewayRepository.findOne({
        where: { id: gatewayId, organizationId },
      });

      if (!gateway) {
        throw new NotFoundException('Gateway not found');
      }

      // Find and delete the gateway-tool association
      const gatewayTool = await this.gatewayToolRepository.findOne({
        where: { gatewayId, toolId },
      });

      if (!gatewayTool) {
        throw new NotFoundException('Tool not assigned to this gateway');
      }

      await this.gatewayToolRepository.remove(gatewayTool);

      this.logger.log(`Removed tool ${toolId} from gateway ${gatewayId}`);
    } catch (error) {
      this.logger.error(`Failed to remove tool: ${error.message}`);
      throw error;
    }
  }

  async removeAllTools(
    gatewayId: string,
    organizationId: string,
  ): Promise<void> {
    try {
      // Verify gateway belongs to organization
      const gateway = await this.gatewayRepository.findOne({
        where: { id: gatewayId, organizationId },
      });

      if (!gateway) {
        throw new NotFoundException('Gateway not found');
      }

      // Delete all gateway-tool associations for this gateway
      await this.gatewayToolRepository.delete({ gatewayId });

      this.logger.log(`Removed all tools from gateway ${gatewayId}`);
    } catch (error) {
      this.logger.error(`Failed to remove all tools: ${error.message}`);
      throw error;
    }
  }
}