import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';

/**
 * Read-only / counter helpers extracted from GatewayToolService:
 * the per-gateway tool stats rollup and the per-tool usage bump.
 * Both are pure DB calls — no auth, no UTCP cache invalidation —
 * so they sit in their own helper to keep the main service focused
 * on association lifecycle.
 */
@Injectable()
export class GatewayToolStatsHelper {
  private readonly logger = new Logger(GatewayToolStatsHelper.name);

  constructor(
    @InjectRepository(GatewayTool)
    private readonly gatewayToolRepository: Repository<GatewayTool>,
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
  ) {}

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
      relations: { tool: true },
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
}
