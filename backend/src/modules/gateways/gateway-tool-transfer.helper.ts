import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';

import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { User } from '../../entities/user.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

/**
 * Copy / remove operations for gateway-tool associations.
 * Split out of GatewayToolService to keep the main service focused
 * on per-association CRUD.
 *
 * Each public method invalidates the gateway-scoped UTCP manual
 * cache (`utcp:manual:gw:<id>`) so a stale snapshot can't keep
 * advertising tools that no longer belong to the gateway.
 */
@Injectable()
export class GatewayToolTransferHelper {
  private readonly logger = new Logger(GatewayToolTransferHelper.name);

  constructor(
    @InjectRepository(GatewayTool)
    private readonly gatewayToolRepository: Repository<GatewayTool>,
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly auditLogService: AuditLogService,
    @InjectRedis() private readonly redis: Redis.Redis,
  ) {}

  async copyToolsFromGateway(
    sourceGatewayId: string,
    targetGatewayId: string,
    organizationId: string,
    userId: string,
    overrideExisting = false,
  ): Promise<{ copied: GatewayTool[]; skipped: Array<{ toolId: string; reason: string }> }> {
    try {
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

      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateway_tools')) {
        throw new ForbiddenException('User does not have permission to manage gateway tools');
      }

      const sourceTools = await this.gatewayToolRepository.find({
        where: { gatewayId: sourceGatewayId },
        relations: ['tool'],
      });

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
          `${copied.length} copied, ${skipped.length} skipped`,
      );

      if (copied.length > 0) {
        await this.invalidateUtcpManualCache(targetGatewayId);
      }

      return { copied, skipped };
    } catch (error) {
      this.logger.error(`Failed to copy tools between gateways: ${error.message}`);
      throw error;
    }
  }

  async removeTool(gatewayId: string, toolId: string, organizationId: string): Promise<void> {
    try {
      const gateway = await this.gatewayRepository.findOne({
        where: { id: gatewayId, organizationId },
      });

      if (!gateway) {
        throw new NotFoundException('Gateway not found');
      }

      const gatewayTool = await this.gatewayToolRepository.findOne({
        where: { gatewayId, toolId },
      });

      if (!gatewayTool) {
        throw new NotFoundException('Tool not assigned to this gateway');
      }

      await this.gatewayToolRepository.remove(gatewayTool);

      this.logger.log(`Removed tool ${toolId} from gateway ${gatewayId}`);
      await this.invalidateUtcpManualCache(gatewayId);

      this.auditLogService.log({
        organizationId,
        userId: undefined,
        action: AuditAction.TOOL_REMOVE,
        resourceType: AuditResource.GATEWAY,
        resourceId: gatewayId,
        resourceName: gateway.name,
        details: { toolId },
      });
    } catch (error) {
      this.logger.error(`Failed to remove tool: ${error.message}`);
      throw error;
    }
  }

  async removeAllTools(gatewayId: string, organizationId: string): Promise<void> {
    try {
      const gateway = await this.gatewayRepository.findOne({
        where: { id: gatewayId, organizationId },
      });

      if (!gateway) {
        throw new NotFoundException('Gateway not found');
      }

      await this.gatewayToolRepository.delete({ gatewayId });

      this.logger.log(`Removed all tools from gateway ${gatewayId}`);
      await this.invalidateUtcpManualCache(gatewayId);
    } catch (error) {
      this.logger.error(`Failed to remove all tools: ${error.message}`);
      throw error;
    }
  }

  private async invalidateUtcpManualCache(gatewayId: string): Promise<void> {
    try {
      await this.redis.del(`utcp:manual:gw:${gatewayId}`);
    } catch (err: any) {
      this.logger.warn(`Failed to invalidate UTCP manual cache for gw=${gatewayId}: ${err.message}`);
    }
  }
}
