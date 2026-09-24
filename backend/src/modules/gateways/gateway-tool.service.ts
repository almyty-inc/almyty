import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';

import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool, ToolStatus } from '../../entities/tool.entity';
import { User } from '../../entities/user.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { GatewayToolTransferHelper } from './gateway-tool-transfer.helper';
import { GatewayToolStatsHelper } from './gateway-tool-stats.helper';
import { GatewayToolQueriesHelper } from './gateway-tool-queries.helper';
import { assertToolAttachable, gatewayServableTo } from './private-gateway';
import { ExecutionAccessService } from '../../common/authorization/execution-access.service';

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

// The only fields a PATCH may write. `id`, `gatewayId` and `toolId` are
// identity, `usageCount`/`lastUsedAt`/`associatedAt` are bookkeeping, and none
// of them belong in an update body -- see IDENTITY_GATEWAY_TOOL_FIELDS below.
export const UPDATABLE_GATEWAY_TOOL_FIELDS = [
  'isActive',
  'overrides',
  'permissions',
  'transformations',
  'metadata',
  'securityPolicy',
] as const;

// Repointing an association at another gateway or another tool is not an
// update: it either grafts a foreign org's tool into the caller's gateway
// listing, or pushes the caller's own row onto another org's gateway, which
// injects attacker-chosen tool names and descriptions into that tenant's
// agents and MCP clients. The correct operation is dissociate plus associate,
// and both of those re-check the organization.
export const IDENTITY_GATEWAY_TOOL_FIELDS = ['id', 'gatewayId', 'toolId', 'gateway', 'tool'] as const;

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
    private readonly auditLogService: AuditLogService,
    @InjectRedis() private readonly redis: Redis.Redis,
    private readonly transfer: GatewayToolTransferHelper,
    private readonly stats: GatewayToolStatsHelper,
    private readonly queries: GatewayToolQueriesHelper,
    // The publish-time half of the gateway rule for team tools. @Optional()
    // only to keep the positional spec harnesses' order; attaching a team
    // tool refuses without it.
    @Optional() private readonly executionAccess?: ExecutionAccessService,
  ) {}

  /**
   * Drop the cached UTCP manual for a gateway. UtcpService caches
   * the gateway-scoped manual at `utcp:manual:gw:<id>` for 5 minutes;
   * any tool assignment / dissociation / activation change has to
   * bust that key or the manual will lie about the gateway's tools
   * for up to 5 min after the change.
   *
   * Best-effort — Redis being temporarily unreachable is non-fatal
   * (the cached entry will TTL out).
   */
  private async invalidateUtcpManualCache(gatewayId: string): Promise<void> {
    try {
      await this.redis.del(`utcp:manual:gw:${gatewayId}`);
    } catch (err: any) {
      this.logger.warn(`Failed to invalidate UTCP manual cache for gw=${gatewayId}: ${err.message}`);
    }
  }

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

      if (!gateway || !gatewayServableTo(gateway, userId)) {
        throw new NotFoundException('Gateway not found');
      }

      // Verify the tool exists AND belongs to this organization. The
      // gateway above is org-scoped and the permission check below is
      // too; the tool was not, so an org-A admin holding an org-B tool
      // uuid could write a gateway_tools row across tenants — and
      // `gateway_tools` has no organization column, so nothing at the
      // storage layer rejected it either. The gateway then served org
      // B's tool name, description and parameter schema to org A's
      // clients. Execution itself fails closed in ToolExecutorService,
      // but the metadata had already leaked.
      const tool = await this.toolRepository.findOne({
        where: { id: createGatewayToolDto.toolId, organizationId },
      });

      if (!tool) {
        throw new NotFoundException('Tool not found');
      }
      assertToolAttachable(gateway, tool, userId);
      // A team tool also needs the person attaching it to be able to run it
      // (a member of its team, or an org owner/admin) -- a membership
      // lookup the pure check above cannot make. Same shared rule the call
      // path applies. Fails closed when the check is not wired.
      if (tool.visibility === 'team') {
        if (!this.executionAccess) throw new ForbiddenException('Gateway publishing check is not configured');
        await this.executionAccess.assertGatewayMayServe(gateway, tool, userId, 'Tool');
      }

      // Name the actual problem. 'Can only associate active tools' did not
      // say which state the tool was in, that every tool generated from a
      // schema starts as a draft, or where the fix lives -- so the one
      // refusal a new user is guaranteed to hit read as a bug in the
      // gateway rather than a step they had not taken yet.
      if (tool.status !== ToolStatus.ACTIVE) {
        throw new BadRequestException(
          `Tool '${tool.name}' is ${tool.status}, and a gateway only serves active tools. ` +
            'Tools generated from a schema start as drafts: open Tools, select them and ' +
            'use "Activate selected", then assign them here.',
        );
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
        relations: { organizationMemberships: true },
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
      await this.invalidateUtcpManualCache(gatewayId);

      // Audit log (fire-and-forget)
      this.auditLogService.log({ organizationId, userId, action: AuditAction.TOOL_ASSIGN, resourceType: AuditResource.GATEWAY, resourceId: gatewayId, resourceName: gateway.name, details: { toolId: tool.id, toolName: tool.name } });

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
        relations: { gateway: true, tool: true },
      });

      if (!gatewayTool || gatewayTool.gateway.organizationId !== organizationId) {
        throw new NotFoundException('Gateway tool association not found');
      }

      // Check user permissions
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: { organizationMemberships: true },
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateway_tools')) {
        throw new ForbiddenException('User does not have permission to manage gateway tools');
      }

      // Refuse, rather than silently drop, an attempt to move this row to a
      // different gateway or a different tool.
      for (const field of IDENTITY_GATEWAY_TOOL_FIELDS) {
        if (
          Object.prototype.hasOwnProperty.call(updateGatewayToolDto, field) &&
          (updateGatewayToolDto as any)[field] !== (gatewayTool as any)[field]
        ) {
          throw new ForbiddenException(
            `Gateway tool association field '${field}' cannot be updated; dissociate and re-associate instead`,
          );
        }
      }

      // Assign only whitelisted fields. A blanket Object.assign would write any
      // column the caller names, including the identity columns above.
      for (const field of UPDATABLE_GATEWAY_TOOL_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(updateGatewayToolDto, field)) {
          (gatewayTool as any)[field] = (updateGatewayToolDto as any)[field];
        }
      }

      // Re-assert the org binding after assignment, so nothing that runs above
      // can leave a row pointing at a gateway outside the caller's org.
      if (gatewayTool.gateway.organizationId !== organizationId) {
        throw new ForbiddenException('Gateway tool association is not owned by this organization');
      }

      const updatedAssociation = await this.gatewayToolRepository.save(gatewayTool);

      this.logger.log(`Gateway tool association ${gatewayToolId} updated`);
      await this.invalidateUtcpManualCache(gatewayTool.gatewayId);

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
        relations: { gateway: true, tool: true },
      });

      if (!gatewayTool || gatewayTool.gateway.organizationId !== organizationId) {
        throw new NotFoundException('Gateway tool association not found');
      }

      // Check user permissions
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: { organizationMemberships: true },
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateway_tools')) {
        throw new ForbiddenException('User does not have permission to manage gateway tools');
      }

      await this.gatewayToolRepository.remove(gatewayTool);

      this.logger.log(`Tool '${gatewayTool.tool.name}' dissociated from gateway '${gatewayTool.gateway.name}'`);
      await this.invalidateUtcpManualCache(gatewayTool.gatewayId);

      // Audit log (fire-and-forget)
      this.auditLogService.log({ organizationId, userId, action: AuditAction.TOOL_REMOVE, resourceType: AuditResource.GATEWAY, resourceId: gatewayTool.gateway.id, resourceName: gatewayTool.gateway.name, details: { toolId: gatewayTool.tool.id, toolName: gatewayTool.tool.name } });

    } catch (error) {
      this.logger.error(`Failed to dissociate tool from gateway: ${error.message}`);
      throw error;
    }
  }

  async bulkAssociateTools(
    gatewayId: string,
    bulkAssociateDto: BulkAssociateToolsDto,
    organizationId: string,
    userId: string,
  ): Promise<{ associated: GatewayTool[]; skipped: Array<{ toolId: string; reason: string }> }> {
    return this.queries.bulkAssociateTools(gatewayId, bulkAssociateDto, organizationId, userId, (id) => this.invalidateUtcpManualCache(id));
  }

  getGatewayTools(...args: Parameters<GatewayToolQueriesHelper['getGatewayTools']>) {
    return this.queries.getGatewayTools(...args);
  }

  getGatewayTool(...args: Parameters<GatewayToolQueriesHelper['getGatewayTool']>) {
    return this.queries.getGatewayTool(...args);
  }

  getAvailableTools(...args: Parameters<GatewayToolQueriesHelper['getAvailableTools']>) {
    return this.queries.getAvailableTools(...args);
  }

  async activateGatewayTool(gatewayToolId: string, organizationId: string, userId: string): Promise<GatewayTool> {
    return this.setGatewayToolActive(gatewayToolId, organizationId, userId, true);
  }

  async deactivateGatewayTool(gatewayToolId: string, organizationId: string, userId: string): Promise<GatewayTool> {
    return this.setGatewayToolActive(gatewayToolId, organizationId, userId, false);
  }

  private async setGatewayToolActive(
    gatewayToolId: string,
    organizationId: string,
    userId: string,
    isActive: boolean,
  ): Promise<GatewayTool> {
    const gatewayTool = await this.getGatewayTool(gatewayToolId, organizationId);

    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: { organizationMemberships: true },
    });

    if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateway_tools')) {
      throw new ForbiddenException('User does not have permission to manage gateway tools');
    }

    if (gatewayTool.isActive === isActive) {
      return gatewayTool;
    }

    gatewayTool.isActive = isActive;
    const updatedGatewayTool = await this.gatewayToolRepository.save(gatewayTool);

    this.logger.log(`Gateway tool ${gatewayToolId} ${isActive ? 'activated' : 'deactivated'}`);
    await this.invalidateUtcpManualCache(gatewayTool.gatewayId);

    return updatedGatewayTool;
  }

  // ── Delegations to GatewayToolStatsHelper ──
  getGatewayToolStats(...args: Parameters<GatewayToolStatsHelper['getGatewayToolStats']>) {
    return this.stats.getGatewayToolStats(...args);
  }
  incrementUsage(...args: Parameters<GatewayToolStatsHelper['incrementUsage']>) {
    return this.stats.incrementUsage(...args);
  }

  copyToolsFromGateway(...args: Parameters<GatewayToolTransferHelper['copyToolsFromGateway']>) {
    return this.transfer.copyToolsFromGateway(...args);
  }

  removeTool(...args: Parameters<GatewayToolTransferHelper['removeTool']>) {
    return this.transfer.removeTool(...args);
  }

  removeAllTools(...args: Parameters<GatewayToolTransferHelper['removeAllTools']>) {
    return this.transfer.removeAllTools(...args);
  }
}
