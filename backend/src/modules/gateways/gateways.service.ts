import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindManyOptions, Like } from 'typeorm';

import { Gateway, GatewayType, GatewayStatus } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { GatewayAuth, GatewayAuthType } from '../../entities/gateway-auth.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';

export interface CreateGatewayDto {
  name: string;
  description?: string;
  type: GatewayType;
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
  type?: GatewayType;
  status?: GatewayStatus;
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

      // Validate endpoint uniqueness within organization
      const existingGateway = await this.gatewayRepository.findOne({
        where: { endpoint: createGatewayDto.endpoint, organizationId },
      });

      if (existingGateway) {
        throw new BadRequestException('Endpoint already exists in your organization');
      }

      // Validate configuration based on gateway type
      this.validateGatewayConfiguration(createGatewayDto.type, createGatewayDto.configuration);

      // Create the gateway
      const gateway = this.gatewayRepository.create({
        ...createGatewayDto,
        organizationId,
        status: GatewayStatus.ACTIVE,
      });

      const savedGateway = await this.gatewayRepository.save(gateway);

      this.logger.log(`[CREATE_GATEWAY] Gateway saved to DB: id=${savedGateway.id}, name='${savedGateway.name}', org=${savedGateway.organizationId}`);

      // Create default authentication if not provided
      await this.createDefaultAuth(savedGateway);

      this.logger.log(`[CREATE_GATEWAY] Gateway '${savedGateway.name}' created successfully in organization ${organizationId}`);

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

      // Check permissions
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'edit_gateways')) {
        throw new ForbiddenException('User does not have permission to edit gateways');
      }

      // Update fields
      Object.assign(gateway, updateGatewayDto);

      // Validate configuration if updated
      if (updateGatewayDto.configuration) {
        this.validateGatewayConfiguration(gateway.type, gateway.configuration);
      }

      const updatedGateway = await this.gatewayRepository.save(gateway);

      this.logger.log(`Gateway '${updatedGateway.name}' updated`);

      return updatedGateway;

    } catch (error) {
      this.logger.error(`Failed to update gateway: ${error.message}`);
      throw error;
    }
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

    if (filters.type) {
      queryBuilder.andWhere('gateway.type = :type', { type: filters.type });
    }

    if (filters.status) {
      queryBuilder.andWhere('gateway.status = :status', { status: filters.status });
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

    // Check permissions
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['organizationMemberships'],
    });

    if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateways')) {
      throw new ForbiddenException('User does not have permission to manage gateways');
    }

    if (gateway.status === GatewayStatus.ACTIVE) {
      return gateway;
    }

    gateway.status = GatewayStatus.ACTIVE;
    const updatedGateway = await this.gatewayRepository.save(gateway);

    this.logger.log(`Gateway '${gateway.name}' activated`);

    return updatedGateway;
  }

  async deactivateGateway(
    gatewayId: string,
    organizationId: string,
    userId: string
  ): Promise<Gateway> {
    const gateway = await this.getGateway(gatewayId, organizationId, false);

    // Check permissions
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['organizationMemberships'],
    });

    if (!user?.hasPermissionInOrganization(organizationId, 'manage_gateways')) {
      throw new ForbiddenException('User does not have permission to manage gateways');
    }

    if (gateway.status === GatewayStatus.INACTIVE) {
      return gateway;
    }

    gateway.status = GatewayStatus.INACTIVE;
    const updatedGateway = await this.gatewayRepository.save(gateway);

    this.logger.log(`Gateway '${gateway.name}' deactivated`);

    return updatedGateway;
  }

  async deleteGateway(
    gatewayId: string,
    organizationId: string,
    userId: string
  ): Promise<void> {
    const gateway = await this.getGateway(gatewayId, organizationId, false);

    // Check permissions
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['organizationMemberships'],
    });

    if (!user?.hasPermissionInOrganization(organizationId, 'delete_gateways')) {
      throw new ForbiddenException('User does not have permission to delete gateways');
    }

    await this.gatewayRepository.remove(gateway);

    this.logger.log(`Gateway '${gateway.name}' deleted`);
  }

  async getGatewayStats(
    gatewayId: string,
    organizationId: string,
    timeframe: 'hour' | 'day' | 'week' | 'month' = 'day'
  ): Promise<GatewayStats> {
    const gateway = await this.getGateway(gatewayId, organizationId, true);

    const timeframeDurations = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
    };

    const since = new Date(Date.now() - timeframeDurations[timeframe]);

    // Get usage metrics
    const metrics = await this.usageMetricRepository.find({
      where: {
        gatewayId: gateway.id,
        createdAt: { $gte: since } as any,
      },
    });

    const requestMetrics = metrics.filter(m => m.type === 'request_count');
    const responseTimeMetrics = metrics.filter(m => m.type === 'response_time');
    
    const totalRequests = requestMetrics.reduce((sum, m) => sum + m.value, 0);
    const successfulRequests = requestMetrics.filter(m => m.status === 'success').reduce((sum, m) => sum + m.value, 0);
    const failedRequests = totalRequests - successfulRequests;
    const averageResponseTime = responseTimeMetrics.length > 0
      ? responseTimeMetrics.reduce((sum, m) => sum + m.value, 0) / responseTimeMetrics.length
      : 0;
    const successRate = totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0;
    const activeTools = gateway.getActiveTools().length;
    const uniqueUsers = new Set(metrics.map(m => m.userId).filter(Boolean)).size;

    // Calculate trend data
    const requestTrend = this.calculateRequestTrend(metrics, timeframe);

    return {
      totalRequests,
      successfulRequests,
      failedRequests,
      averageResponseTime: Math.round(averageResponseTime),
      successRate: Math.round(successRate * 100) / 100,
      activeTools,
      uniqueUsers,
      requestTrend,
    };
  }

  async getOrganizationGatewayStats(organizationId: string): Promise<{
    totalGateways: number;
    activeGateways: number;
    inactiveGateways: number;
    totalRequests: number;
    averageResponseTime: number;
    successRate: number;
    topGateways: Array<{
      gateway: Gateway;
      requestCount: number;
    }>;
  }> {
    // Get gateway counts
    const gatewayCounts = await this.gatewayRepository
      .createQueryBuilder('gateway')
      .select('gateway.status')
      .addSelect('COUNT(*)', 'count')
      .where('gateway.organizationId = :organizationId', { organizationId })
      .groupBy('gateway.status')
      .getRawMany();

    const statusCounts: Record<string, number> = gatewayCounts.reduce((acc, row) => {
      acc[row.gateway_status] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);

    const totalGateways = Object.values(statusCounts).reduce((sum: number, count) => sum + (count as number), 0);

    // Get all gateways for organization
    const gateways = await this.gatewayRepository.find({
      where: { organizationId },
    });

    const totalRequests = gateways.reduce((sum, g) => sum + g.totalRequests, 0);
    const successfulRequests = gateways.reduce((sum, g) => sum + g.successfulRequests, 0);
    const successRate = totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0;

    // Get usage metrics for average response time
    const metrics = await this.usageMetricRepository.find({
      where: { organizationId },
    });

    const responseTimeMetrics = metrics.filter(m => m.type === 'response_time');
    const averageResponseTime = responseTimeMetrics.length > 0
      ? responseTimeMetrics.reduce((sum, m) => sum + m.value, 0) / responseTimeMetrics.length
      : 0;

    // Get top gateways by request count
    const topGateways = gateways
      .sort((a, b) => b.totalRequests - a.totalRequests)
      .slice(0, 10)
      .map(gateway => ({
        gateway,
        requestCount: gateway.totalRequests,
      }));

    return {
      totalGateways,
      activeGateways: statusCounts[GatewayStatus.ACTIVE] || 0,
      inactiveGateways: statusCounts[GatewayStatus.INACTIVE] || 0,
      totalRequests,
      averageResponseTime: Math.round(averageResponseTime),
      successRate: Math.round(successRate * 100) / 100,
      topGateways,
    };
  }

  async performHealthCheck(gatewayId: string, organizationId: string): Promise<{
    isHealthy: boolean;
    responseTime?: number;
    error?: string;
    details?: Record<string, any>;
  }> {
    const gateway = await this.getGateway(gatewayId, organizationId, false);

    if (!gateway.healthCheck?.enabled) {
      return { isHealthy: true };
    }

    const startTime = Date.now();

    try {
      // Perform health check based on gateway type
      const healthResult = await this.performTypeSpecificHealthCheck(gateway);
      const responseTime = Date.now() - startTime;

      // Update gateway health status
      gateway.updateHealthStatus(healthResult.isHealthy);
      await this.gatewayRepository.save(gateway);

      return {
        ...healthResult,
        responseTime,
      };

    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      gateway.updateHealthStatus(false);
      await this.gatewayRepository.save(gateway);

      return {
        isHealthy: false,
        responseTime,
        error: error.message,
      };
    }
  }

  private validateGatewayConfiguration(type: GatewayType, configuration: Record<string, any>): void {
    switch (type) {
      case GatewayType.MCP:
        if (!configuration.transport) {
          throw new BadRequestException('MCP gateway requires transport configuration');
        }
        if (!['http', 'sse', 'websocket'].includes(configuration.transport)) {
          throw new BadRequestException('Invalid MCP transport type');
        }
        break;

      case GatewayType.A2A:
        if (!configuration.agentCapabilities) {
          throw new BadRequestException('A2A gateway requires agentCapabilities configuration');
        }
        break;

      case GatewayType.UTCP:
        if (!configuration.protocol) {
          throw new BadRequestException('UTCP gateway requires protocol configuration');
        }
        if (!['http', 'tcp'].includes(configuration.protocol)) {
          throw new BadRequestException('Invalid UTCP protocol type');
        }
        break;

      // SCOPED_TOOL was removed - scoping is now handled via selective tool assignment
    }
  }

  private async createDefaultAuth(gateway: Gateway): Promise<void> {
    const defaultAuth = this.gatewayAuthRepository.create({
      gatewayId: gateway.id,
      type: GatewayAuthType.API_KEY,
      isRequired: true,
      isActive: true,
      configuration: {
        keyHeader: 'x-api-key',
        keyQuery: 'api_key',
        defaultScopes: ['gateway:use'],
      },
      validationRules: {
        minKeyLength: 32,
        maxKeyLength: 128,
        keyFormat: '^[a-zA-Z0-9_-]+$',
      },
      errorResponses: {
        unauthorized: {
          code: 401,
          message: 'API key is required',
        },
        invalid: {
          code: 401,
          message: 'Invalid API key',
        },
      },
    });

    await this.gatewayAuthRepository.save(defaultAuth);
  }

  private async performTypeSpecificHealthCheck(gateway: Gateway): Promise<{
    isHealthy: boolean;
    details?: Record<string, any>;
  }> {
    // Basic health check - can be extended for specific gateway types
    const activeTools = gateway.getActiveTools();
    const hasActiveTools = activeTools.length > 0;

    return {
      isHealthy: hasActiveTools && gateway.canAcceptRequests(),
      details: {
        activeToolsCount: activeTools.length,
        status: gateway.status,
        canAcceptRequests: gateway.canAcceptRequests(),
      },
    };
  }

  private calculateRequestTrend(
    metrics: UsageMetric[],
    timeframe: 'hour' | 'day' | 'week' | 'month'
  ): Array<{ date: string; requests: number; success: number; failed: number }> {
    const intervals = {
      hour: 24,  // Last 24 hours
      day: 30,   // Last 30 days
      week: 12,  // Last 12 weeks
      month: 12, // Last 12 months
    };

    const interval = intervals[timeframe];
    const trend: Array<{ date: string; requests: number; success: number; failed: number }> = [];

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

      const periodMetrics = metrics.filter(m => {
        const metricDate = new Date(m.createdAt);
        switch (timeframe) {
          case 'hour':
            return metricDate.getHours() === date.getHours() &&
                   metricDate.toDateString() === date.toDateString();
          case 'day':
            return metricDate.toDateString() === date.toDateString();
          case 'week':
            return this.getWeekNumber(metricDate) === this.getWeekNumber(date) &&
                   metricDate.getFullYear() === date.getFullYear();
          case 'month':
            return metricDate.getMonth() === date.getMonth() &&
                   metricDate.getFullYear() === date.getFullYear();
          default:
            return false;
        }
      });

      const requestMetrics = periodMetrics.filter(m => m.type === 'request_count');
      const requests = requestMetrics.reduce((sum, m) => sum + m.value, 0);
      const success = requestMetrics.filter(m => m.status === 'success').reduce((sum, m) => sum + m.value, 0);
      const failed = requests - success;

      trend.push({
        date: dateKey,
        requests,
        success,
        failed,
      });
    }

    return trend;
  }

  private getWeekNumber(date: Date): number {
    const oneJan = new Date(date.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((date.getTime() - oneJan.getTime()) / (24 * 60 * 60 * 1000));
    return Math.ceil((date.getDay() + 1 + numberOfDays) / 7);
  }
}