import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';

import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool, ToolStatus } from '../../entities/tool.entity';
import { User } from '../../entities/user.entity';

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

export interface BulkAssociateToolsDto {
  toolIds: string[];
  isActive?: boolean;
  permissions?: any;
}

@Injectable()
export class GatewayToolQueriesHelper {
  private readonly logger = new Logger(GatewayToolQueriesHelper.name);

  constructor(
    @InjectRepository(GatewayTool)
    private gatewayToolRepository: Repository<GatewayTool>,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRedis() private readonly redis: Redis.Redis,
  ) {}

  async getGatewayTools(filters: GatewayToolSearchFilters): Promise<{
    gatewayTools: GatewayTool[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
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

    if (filters.isActive !== undefined) {
      queryBuilder.andWhere('gatewayTool.isActive = :isActive', { isActive: filters.isActive });
    }

    if (filters.toolIds?.length > 0) {
      queryBuilder.andWhere('gatewayTool.toolId IN (:...toolIds)', { toolIds: filters.toolIds });
    }

    if (filters.search) {
      queryBuilder.andWhere(
        '(tool.name ILIKE :search OR tool.description ILIKE :search)',
        { search: `%${filters.search}%` },
      );
    }

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

    const total = await queryBuilder.getCount();

    const gatewayTools = await queryBuilder.skip(skip).take(limit).getMany();

    const totalPages = Math.ceil(total / limit);

    return { gatewayTools, total, page, limit, totalPages };
  }

  async getGatewayTool(gatewayToolId: string, organizationId: string): Promise<GatewayTool> {
    const gatewayTool = await this.gatewayToolRepository.findOne({
      where: { id: gatewayToolId },
      relations: { gateway: true, tool: true },
    });

    if (!gatewayTool || gatewayTool.gateway.organizationId !== organizationId) {
      throw new NotFoundException('Gateway tool association not found');
    }

    return gatewayTool;
  }

  async getAvailableTools(gatewayId: string, organizationId: string): Promise<Tool[]> {
    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId, organizationId },
    });

    if (!gateway) {
      throw new NotFoundException('Gateway not found');
    }

    const associatedTools = await this.gatewayToolRepository.find({
      where: { gatewayId },
      select: { toolId: true },
    });

    const associatedToolIds = associatedTools.map(at => at.toolId);

    const queryBuilder = this.toolRepository
      .createQueryBuilder('tool')
      .where('tool.status = :status', { status: ToolStatus.ACTIVE });

    if (associatedToolIds.length > 0) {
      queryBuilder.andWhere('tool.id NOT IN (:...associatedIds)', { associatedIds: associatedToolIds });
    }

    return queryBuilder.orderBy('tool.name', 'ASC').getMany();
  }

  async bulkAssociateTools(
    gatewayId: string,
    bulkAssociateDto: BulkAssociateToolsDto,
    organizationId: string,
    userId: string,
    invalidateCache: (gatewayId: string) => Promise<void>,
  ): Promise<{ associated: GatewayTool[]; skipped: Array<{ toolId: string; reason: string }> }> {
    try {
      const gateway = await this.gatewayRepository.findOne({
        where: { id: gatewayId, organizationId },
      });

      if (!gateway) {
        throw new NotFoundException('Gateway not found');
      }

      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: { organizationMemberships: true },
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateway_tools')) {
        throw new ForbiddenException('User does not have permission to manage gateway tools');
      }

      const tools = await this.toolRepository.find({
        where: { id: In(bulkAssociateDto.toolIds), status: ToolStatus.ACTIVE },
      });

      const existingAssociations = await this.gatewayToolRepository.find({
        where: { gatewayId, toolId: In(bulkAssociateDto.toolIds) },
      });

      const existingToolIds = new Set(existingAssociations.map(a => a.toolId));

      const associated: GatewayTool[] = [];
      const skipped: Array<{ toolId: string; reason: string }> = [];

      for (const toolId of bulkAssociateDto.toolIds) {
        if (existingToolIds.has(toolId)) {
          skipped.push({ toolId, reason: 'Already associated with gateway' });
          continue;
        }

        const tool = tools.find(t => t.id === toolId);
        if (!tool) {
          skipped.push({ toolId, reason: 'Tool not found or not active' });
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
          skipped.push({ toolId, reason: `Failed to associate: ${error.message}` });
        }
      }

      this.logger.log(
        `Bulk association completed for gateway '${gateway.name}': ` +
        `${associated.length} associated, ${skipped.length} skipped`,
      );

      if (associated.length > 0) {
        await invalidateCache(gatewayId);
      }

      return { associated, skipped };
    } catch (error) {
      this.logger.error(`Failed to bulk associate tools: ${error.message}`);
      throw error;
    }
  }
}
