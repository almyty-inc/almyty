import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { VersionedEntity } from 'typeorm-versions';
import { Organization } from './organization.entity';
import { GatewayTool } from './gateway-tool.entity';
import { GatewayAuth } from './gateway-auth.entity';
import { LlmSession } from './llm-session.entity';
import { UsageMetric } from './usage-metric.entity';

export enum GatewayType {
  MCP = 'mcp',
  A2A = 'a2a',
  UTCP = 'utcp',
  SKILLS = 'skills',
}

export enum GatewayStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  MAINTENANCE = 'maintenance',
  ERROR = 'error',
}

export interface RateLimitConfig {
  enabled: boolean;
  requestsPerMinute?: number;
  requestsPerHour?: number;
  requestsPerDay?: number;
  burstLimit?: number;
  windowSize?: number;
}

@Entity('gateways')
@VersionedEntity()
@Index(['organizationId', 'name'])
@Index(['organizationId', 'endpoint'], { unique: true })
export class Gateway {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({
    type: 'varchar',
  })
  type: GatewayType;

  @Column({
    type: 'varchar',
    default: GatewayStatus.ACTIVE,
  })
  status: GatewayStatus;

  @Column()
  organizationId: string;

  @Column()
  endpoint: string; // e.g., /gateways/my-mcp-gateway

  @Column({ type: 'json' })
  configuration: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  rateLimitConfig: RateLimitConfig;

  @Column({ type: 'json', nullable: true })
  corsConfig: {
    origins: string[];
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
  };

  @Column({ type: 'json', nullable: true })
  webhooks: {
    enabled: boolean;
    endpoints: Array<{
      url: string;
      events: string[];
      secret?: string;
    }>;
  };

  @Column({ default: 30000 })
  requestTimeout: number;

  @Column({ default: 3 })
  maxRetries: number;

  @Column({ type: 'json', nullable: true })
  customHeaders: Record<string, string>;

  @Column({ type: 'json', nullable: true })
  healthCheck: {
    enabled: boolean;
    endpoint?: string;
    interval?: number;
    timeout?: number;
  };

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ default: 0 })
  totalRequests: number;

  @Column({ default: 0 })
  successfulRequests: number;

  @Column({ nullable: true })
  lastRequestAt: Date;

  @Column({ nullable: true })
  lastHealthCheckAt: Date;

  @Column({ default: true })
  isHealthy: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, org => org.gateways, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @OneToMany(() => GatewayTool, gatewayTool => gatewayTool.gateway, {
    cascade: true,
  })
  tools: GatewayTool[];

  @OneToMany(() => GatewayAuth, gatewayAuth => gatewayAuth.gateway, {
    cascade: true,
  })
  authConfigs: GatewayAuth[];

  @OneToMany(() => LlmSession, session => session.gateway)
  llmSessions: LlmSession[];

  @OneToMany(() => UsageMetric, usageMetric => usageMetric.gateway)
  usageMetrics: UsageMetric[];

  // Methods
  isActive(): boolean {
    return this.status === GatewayStatus.ACTIVE;
  }

  canAcceptRequests(): boolean {
    return this.isActive() && this.isHealthy;
  }

  getSuccessRate(): number {
    if (this.totalRequests === 0) return 0;
    return (this.successfulRequests / this.totalRequests) * 100;
  }

  incrementRequest(success: boolean = true) {
    this.totalRequests++;
    if (success) {
      this.successfulRequests++;
    }
    this.lastRequestAt = new Date();
  }

  updateHealthStatus(isHealthy: boolean) {
    this.isHealthy = isHealthy;
    this.lastHealthCheckAt = new Date();
    
    if (!isHealthy && this.status === GatewayStatus.ACTIVE) {
      this.status = GatewayStatus.ERROR;
    } else if (isHealthy && this.status === GatewayStatus.ERROR) {
      this.status = GatewayStatus.ACTIVE;
    }
  }

  getActiveTools(): GatewayTool[] {
    return this.tools?.filter(tool => tool.isActive) || [];
  }

  isScoped(): boolean {
    // A gateway is considered "scoped" if it has fewer tools than all available tools in the organization
    // This is a conceptual indicator - the actual scoping is done by selective tool assignment
    return (this.tools?.length || 0) > 0; // Any specific tool assignment indicates intentional scoping
  }

  hasRateLimit(): boolean {
    return this.rateLimitConfig?.enabled || false;
  }

  getEndpointUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/$/, '')}${this.endpoint}`;
  }

  supportsProtocol(protocol: string): boolean {
    switch (this.type) {
      case GatewayType.MCP:
        return ['http', 'sse', 'websocket'].includes(protocol);
      case GatewayType.A2A:
        return ['http', 'grpc'].includes(protocol);
      case GatewayType.UTCP:
        return ['http', 'tcp'].includes(protocol);
      case GatewayType.SKILLS:
        return ['cli', 'file'].includes(protocol);
      default:
        return false;
    }
  }

  getConfigForType(): Record<string, any> {
    const baseConfig = {
      name: this.name,
      type: this.type,
      endpoint: this.endpoint,
      timeout: this.requestTimeout,
      retries: this.maxRetries,
      toolCount: this.tools?.length || 0,
    };

    switch (this.type) {
      case GatewayType.MCP:
        return {
          ...baseConfig,
          transport: this.configuration.transport || 'http',
          version: this.configuration.version || '1.0',
        };

      case GatewayType.A2A:
        return {
          ...baseConfig,
          agentCapabilities: this.configuration.agentCapabilities || [],
          conversationMemory: this.configuration.conversationMemory || false,
        };

      case GatewayType.UTCP:
        return {
          ...baseConfig,
          protocol: this.configuration.protocol || 'http',
          encoding: this.configuration.encoding || 'json',
        };

      case GatewayType.SKILLS:
        return {
          ...baseConfig,
          format: 'skill-md',
          installCommand: `npx @almyty/skills install --gateway ${this.id}`,
        };

      default:
        return baseConfig;
    }
  }
}