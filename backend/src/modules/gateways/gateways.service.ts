import { Inject, forwardRef } from '@nestjs/common';
import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindManyOptions, Like, MoreThanOrEqual } from 'typeorm';

import { Gateway, GatewayKind, GatewayType, GatewayStatus } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { GatewayAuth, GatewayAuthType } from '../../entities/gateway-auth.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';

import { GatewaysStatsHelper } from './gateways-stats.helper';
import { GatewayInitHelper } from './gateway-init.helper';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
export interface CreateGatewayDto {
  name: string;
  description?: string;
  type: GatewayType;
  agentId?: string;
  endpoint: string;
  configuration: Record<string, any>;
  rateLimitConfig?: {
    enabled: boolean;
    requestsPerMinute?: number;
    requestsPerHour?: number;
    requestsPerDay?: number;
    burstLimit?: number;
    windowSize?: number;
  };
  corsConfig?: {
    origins: string[];
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
  };
  webhooks?: {
    enabled: boolean;
    endpoints: Array<{
      url: string;
      events: string[];
      secret?: string;
    }>;
  };
  requestTimeout?: number;
  maxRetries?: number;
  customHeaders?: Record<string, string>;
  healthCheck?: {
    enabled: boolean;
    endpoint?: string;
    interval?: number;
    timeout?: number;
  };
  metadata?: Record<string, any>;
}

export interface UpdateGatewayDto {
  name?: string;
  description?: string;
  configuration?: Record<string, any>;
  rateLimitConfig?: {
    enabled: boolean;
    requestsPerMinute?: number;
    requestsPerHour?: number;
    requestsPerDay?: number;
    burstLimit?: number;
    windowSize?: number;
  };
  corsConfig?: {
    origins: string[];
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
  };
  webhooks?: {
    enabled: boolean;
    endpoints: Array<{
      url: string;
      events: string[];
      secret?: string;
    }>;
  };
  requestTimeout?: number;
  maxRetries?: number;
  customHeaders?: Record<string, string>;
  healthCheck?: {
    enabled: boolean;
    endpoint?: string;
    interval?: number;
    timeout?: number;
  };
  metadata?: Record<string, any>;
}

export interface GatewaySearchFilters {
  search?: string;
  kind?: GatewayKind;
  type?: GatewayType;
  status?: GatewayStatus;
  agentId?: string;
  organizationId: string;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'totalRequests';
  sortOrder?: 'ASC' | 'DESC';
}

export interface GatewayStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  successRate: number;
  activeTools: number;
  uniqueUsers: number;
  requestTrend: Array<{
    date: string;
    requests: number;
    success: number;
    failed: number;
  }>;
}

@Injectable()
export class GatewaysService {
  private readonly logger = new Logger(GatewaysService.name);

  constructor(
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(GatewayTool)
    private gatewayToolRepository: Repository<GatewayTool>,
    @InjectRepository(GatewayAuth)
    private gatewayAuthRepository: Repository<GatewayAuth>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRepository(UsageMetric)
    private usageMetricRepository: Repository<UsageMetric>,
    private readonly auditLogService: AuditLogService,
    @Inject(forwardRef(() => GatewaysStatsHelper))
    private readonly statsHelper: GatewaysStatsHelper,
    private readonly init: GatewayInitHelper,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  async createGateway(
    createGatewayDto: CreateGatewayDto,
    organizationId: string,
    userId: string
  ): Promise<Gateway> {
    try {
      this.logger.log(`[CREATE_GATEWAY] Creating gateway '${createGatewayDto.name}' for org=${organizationId}, user=${userId}`);

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

      if (!user?.hasPermissionInOrganization(organizationId, 'create_gateways')) {
        throw new ForbiddenException('User does not have permission to create gateways');
      }

      // Check organization limits
      if (!organization.canAddMoreGateways()) {
        throw new BadRequestException('Organization has reached gateway limit');
      }

      // Ensure endpoint starts with /
      const endpoint = createGatewayDto.endpoint.startsWith('/')
        ? createGatewayDto.endpoint
        : '/' + createGatewayDto.endpoint;

      // Validate endpoint uniqueness within organization
      const existingGateway = await this.gatewayRepository.findOne({
        where: { endpoint, organizationId },
      });

      if (existingGateway) {
        throw new BadRequestException('Endpoint already exists in your organization');
      }

      // Infer kind from type if not provided
      const kind = Gateway.kindForType(createGatewayDto.type);

      // Validate kind/type exclusivity
      if (kind === GatewayKind.AGENT && !createGatewayDto.agentId) {
        throw new BadRequestException('Agent-kind gateways require an agentId');
      }
      if (kind === GatewayKind.TOOL && createGatewayDto.agentId) {
        throw new BadRequestException('Tool-kind gateways cannot have an agentId');
      }

      // Validate configuration based on gateway type
      this.init.validateGatewayConfiguration(createGatewayDto.type, createGatewayDto.configuration);

      // Create the gateway
      const gateway = this.gatewayRepository.create({
        ...createGatewayDto,
        kind,
        endpoint,
        organizationId,
        status: GatewayStatus.ACTIVE,
      });

      const savedGateway = await this.gatewayRepository.save(gateway);

      this.logger.log(`[CREATE_GATEWAY] Gateway saved to DB: id=${savedGateway.id}, name='${savedGateway.name}', org=${savedGateway.organizationId}`);

      // Create default authentication if not provided
      await this.init.createDefaultAuth(savedGateway);

      this.logger.log(`[CREATE_GATEWAY] Gateway '${savedGateway.name}' created successfully in organization ${organizationId}`);

      // Audit log (fire-and-forget)
      this.auditLogService.logCreate(organizationId, userId, AuditResource.GATEWAY, savedGateway.id, savedGateway.name);

      return savedGateway;

    } catch (error) {
      this.logger.error(`Failed to create gateway: ${error.message}`);
      throw error;
    }
  }

  async updateGateway(
    gatewayId: string,
    updateGatewayDto: UpdateGatewayDto,
    organizationId: string,
    userId: string
  ): Promise<Gateway> {
    try {
      const gateway = await this.gatewayRepository.findOne({
        where: { id: gatewayId, organizationId },
      });

      if (!gateway) {
        throw new NotFoundException('Gateway not found');
      }

      // Authorization: org owner/admin always, team-scoped requires team lead
      const decision = await this.accessPolicy.canAccess({ id: userId }, gateway, 'manage');
      if (!decision.allowed) {
        throw new ForbiddenException(decision.reason);
      }

      // Capture old values for change tracking (before mutation)
      const oldValues = { name: gateway.name, description: gateway.description, configuration: gateway.configuration, rateLimitConfig: gateway.rateLimitConfig, metadata: gateway.metadata };

      // Update fields
      Object.assign(gateway, updateGatewayDto);
      // Sanitize team-scoping after the spread so flipping back to
      // visibility='org' clears the dangling teamId.
      const updateAny = updateGatewayDto as any;
      if (updateAny.visibility === 'org') {
        gateway.teamId = null;
      } else if (updateAny.visibility === 'team' && updateAny.teamId !== undefined) {
        gateway.teamId = updateAny.teamId;
      }

      // Validate configuration if updated
      if (updateGatewayDto.configuration) {
        this.init.validateGatewayConfiguration(gateway.type, gateway.configuration);
      }

      const updatedGateway = await this.gatewayRepository.save(gateway);

      this.logger.log(`Gateway '${updatedGateway.name}' updated`);

      // Audit log (fire-and-forget)
      const changes = this.auditLogService.computeChanges(oldValues, updateGatewayDto, ['name', 'description', 'configuration', 'rateLimitConfig', 'metadata']);
      this.auditLogService.logUpdate(organizationId, userId, AuditResource.GATEWAY, updatedGateway.id, updatedGateway.name, changes);

      return updatedGateway;

    } catch (error) {
      this.logger.error(`Failed to update gateway: ${error.message}`);
      throw error;
    }
  }

  /**
   * Resolve a gateway by @orgSlug/gateway-name-slug.
   * Used by the CLI to avoid exposing UUIDs.
   */
  async resolveGateway(orgSlug: string, gatewayNameSlug: string): Promise<Gateway> {
    const organization = await this.organizationRepository.findOne({
      where: { slug: orgSlug },
    });
    if (!organization) {
      throw new NotFoundException(`Organization not found: ${orgSlug}`);
    }

    // Try matching by endpoint (which is already a slug like /httpbin-skills-gateway)
    let gateway = await this.gatewayRepository.findOne({
      where: { organizationId: organization.id, endpoint: `/${gatewayNameSlug}` },
      relations: ['tools', 'tools.tool', 'authConfigs'],
    });

    // Fallback: match by slugified name
    if (!gateway) {
      const gateways = await this.gatewayRepository.find({
        where: { organizationId: organization.id },
        relations: ['tools', 'tools.tool', 'authConfigs'],
      });
      gateway = gateways.find(g =>
        g.name.toLowerCase().replace(/\s+/g, '-') === gatewayNameSlug
      ) || null;
    }

    if (!gateway) {
      throw new NotFoundException(`Gateway not found: @${orgSlug}/${gatewayNameSlug}`);
    }

    return gateway;
  }

  async getGateway(
    gatewayId: string,
    organizationId: string,
    includeRelations = true
  ): Promise<Gateway> {
    const relations = includeRelations ? [
      'tools',
      'tools.tool',
      'authConfigs',
    ] : [];

    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId, organizationId },
      relations,
    });

    if (!gateway) {
      throw new NotFoundException('Gateway not found');
    }

    return gateway;
  }

  async getGateways(filters: GatewaySearchFilters): Promise<{
    gateways: Gateway[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    this.logger.log(`[GET_GATEWAYS] Fetching gateways for org=${filters.organizationId}`);

    // Self-heal: ensure the org has its system gateway. createOrganization()
    // calls ensureSystemGateway() inline, but auth.register() doesn't go
    // through that path — so freshly-signed-up orgs would render the
    // Gateways page as empty even though every org is supposed to ship
    // with the platform-management gateway used by MCP OAuth. The
    // ensureSystemGateway helper is idempotent (early-return on
    // existing isSystem=true row), so it costs one indexed lookup once
    // the gateway exists. Failure is logged-and-swallowed because we
    // don't want a transient gateway-create error to break listing.
    try {
      await this.init.ensureSystemGateway(filters.organizationId);
    } catch (err) {
      this.logger.warn(
        `[GET_GATEWAYS] ensureSystemGateway failed for org=${filters.organizationId}: ${err.message}`,
      );
    }

    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;

    const queryBuilder = this.gatewayRepository
      .createQueryBuilder('gateway')
      .leftJoinAndSelect('gateway.tools', 'gatewayTool')
      .leftJoinAndSelect('gatewayTool.tool', 'tool')
      .leftJoinAndSelect('gateway.authConfigs', 'authConfig')
      .where('gateway.organizationId = :organizationId', { organizationId: filters.organizationId });

    // Apply filters
    if (filters.search) {
      queryBuilder.andWhere(
        '(gateway.name ILIKE :search OR gateway.description ILIKE :search)',
        { search: `%${filters.search}%` }
      );
    }

    if (filters.kind) {
      const toolTypes = [GatewayType.MCP, GatewayType.UTCP, GatewayType.SKILLS];
      if (filters.kind === GatewayKind.TOOL) {
        queryBuilder.andWhere('gateway.type IN (:...toolTypes)', { toolTypes });
      } else {
        queryBuilder.andWhere('gateway.type NOT IN (:...toolTypes)', { toolTypes });
      }
    }

    if (filters.type) {
      queryBuilder.andWhere('gateway.type = :type', { type: filters.type });
    }

    if (filters.status) {
      queryBuilder.andWhere('gateway.status = :status', { status: filters.status });
    }

    if (filters.agentId) {
      queryBuilder.andWhere('gateway.agentId = :agentId', { agentId: filters.agentId });
    }

    // Apply sorting
    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder || 'DESC';
    queryBuilder.orderBy(`gateway.${sortBy}`, sortOrder);

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const gateways = await queryBuilder
      .skip(skip)
      .take(limit)
      .getMany();

    const totalPages = Math.ceil(total / limit);

    this.logger.log(`[GET_GATEWAYS] Found ${total} gateways for org=${filters.organizationId}`);

    return {
      gateways,
      total,
      page,
      limit,
      totalPages,
    };
  }

  async activateGateway(
    gatewayId: string,
    organizationId: string,
    userId: string
  ): Promise<Gateway> {
    const gateway = await this.getGateway(gatewayId, organizationId, false);

    // Authorization: org owner/admin always, team-scoped requires team lead
    const decision = await this.accessPolicy.canAccess({ id: userId }, gateway, 'manage');
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason);
    }

    if (gateway.status === GatewayStatus.ACTIVE) {
      return gateway;
    }

    gateway.status = GatewayStatus.ACTIVE;
    const updatedGateway = await this.gatewayRepository.save(gateway);

    this.logger.log(`Gateway '${gateway.name}' activated`);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, userId, action: AuditAction.GATEWAY_ACTIVATE, resourceType: AuditResource.GATEWAY, resourceId: gateway.id, resourceName: gateway.name });

    return updatedGateway;
  }

  async deactivateGateway(
    gatewayId: string,
    organizationId: string,
    userId: string
  ): Promise<Gateway> {
    const gateway = await this.getGateway(gatewayId, organizationId, false);

    // Authorization: org owner/admin always, team-scoped requires team lead
    const decision2 = await this.accessPolicy.canAccess({ id: userId }, gateway, 'manage');
    if (!decision2.allowed) {
      throw new ForbiddenException(decision2.reason);
    }

    if (gateway.status === GatewayStatus.INACTIVE) {
      return gateway;
    }

    gateway.status = GatewayStatus.INACTIVE;
    const updatedGateway = await this.gatewayRepository.save(gateway);

    this.logger.log(`Gateway '${gateway.name}' deactivated`);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, userId, action: AuditAction.GATEWAY_DEACTIVATE, resourceType: AuditResource.GATEWAY, resourceId: gateway.id, resourceName: gateway.name });

    return updatedGateway;
  }

  async incrementRequestCount(gatewayId: string, success: boolean): Promise<void> {
    await this.gatewayRepository
      .createQueryBuilder()
      .update(Gateway)
      .set({
        totalRequests: () => '"totalRequests" + 1',
        successfulRequests: success ? () => '"successfulRequests" + 1' : () => '"successfulRequests"',
        lastRequestAt: new Date(),
      })
      .where('id = :id', { id: gatewayId })
      .execute();
  }

  async deleteGateway(
    gatewayId: string,
    organizationId: string,
    userId: string
  ): Promise<void> {
    const gateway = await this.getGateway(gatewayId, organizationId, false);

    if (gateway.isSystem) {
      throw new BadRequestException('System gateways cannot be deleted');
    }

    // Authorization: org owner/admin always, team-scoped requires team lead
    const decision3 = await this.accessPolicy.canAccess({ id: userId }, gateway, 'manage');
    if (!decision3.allowed) {
      throw new ForbiddenException(decision3.reason);
    }

    await this.gatewayRepository.remove(gateway);

    this.logger.log(`Gateway '${gateway.name}' deleted`);

    // Audit log (fire-and-forget)
    this.auditLogService.logDelete(organizationId, userId, AuditResource.GATEWAY, gatewayId, gateway.name);
  }

  /**
   * Ensure the system gateway exists for an organization. Upserts the
   * gateway row and its OAuth auth config. Called during org creation
   * and (via the migration) for all existing orgs.
   */

  private getWeekNumber(date: Date): number {
    const oneJan = new Date(date.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((date.getTime() - oneJan.getTime()) / (24 * 60 * 60 * 1000));
    return Math.ceil((date.getDay() + 1 + numberOfDays) / 7);
  }

  // ── Delegations to GatewayInitHelper ──
  ensureSystemGateway(...args: Parameters<GatewayInitHelper['ensureSystemGateway']>) {
    return this.init.ensureSystemGateway(...args);
  }

  // ── Delegations to GatewaysStatsHelper ──
  getGatewayStats(...args: Parameters<GatewaysStatsHelper['getGatewayStats']>) { return this.statsHelper.getGatewayStats(...args); }
  getOrganizationGatewayStats(...args: Parameters<GatewaysStatsHelper['getOrganizationGatewayStats']>) { return this.statsHelper.getOrganizationGatewayStats(...args); }
  performHealthCheck(...args: Parameters<GatewaysStatsHelper['performHealthCheck']>) { return this.statsHelper.performHealthCheck(...args); }
  searchSkillsAcrossGateways(...args: Parameters<GatewaysStatsHelper['searchSkillsAcrossGateways']>) { return this.statsHelper.searchSkillsAcrossGateways(...args); }
  getAllUserGateways(...args: Parameters<GatewaysStatsHelper['getAllUserGateways']>) { return this.statsHelper.getAllUserGateways(...args); }
  calculateRequestTrend(...args: Parameters<GatewaysStatsHelper['calculateRequestTrend']>) { return this.statsHelper.calculateRequestTrend(...args); }
}