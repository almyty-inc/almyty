import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Gateway } from './gateway.entity';
import { Tool } from './tool.entity';
import { User } from './user.entity';
import { Organization } from './organization.entity';
import { LlmProvider } from './llm-provider.entity';

export enum MetricType {
  REQUEST_COUNT = 'request_count',
  RESPONSE_TIME = 'response_time',
  ERROR_RATE = 'error_rate',
  THROUGHPUT = 'throughput',
  CACHE_HIT_RATE = 'cache_hit_rate',
  BANDWIDTH_USAGE = 'bandwidth_usage',
  CONCURRENT_USERS = 'concurrent_users',
  API_CALLS = 'api_calls',
  TOOL_EXECUTIONS = 'tool_executions',
  // Security plugin counters (emitted by PluginManager.executeHook)
  SECURITY_THREAT_BLOCKED = 'security_threat_blocked',
  PII_FILTERED = 'pii_filtered',
  // Per-protocol semantic counters (emitted by the protocol controllers).
  // The agentId of A2A events is carried in `dimensions.agentId` so the
  // monitoring loop can count distinct active agents over the window.
  MCP_SESSION = 'mcp_session',
  MCP_TOOL_CALL = 'mcp_tool_call',
  UTCP_MANUAL = 'utcp_manual',
  UTCP_DIRECT_CALL = 'utcp_direct_call',
  A2A_MESSAGE = 'a2a_message',
  A2A_WORKFLOW = 'a2a_workflow',
}

export enum MetricStatus {
  SUCCESS = 'success',
  ERROR = 'error',
  TIMEOUT = 'timeout',
  RATE_LIMITED = 'rate_limited',
  UNAUTHORIZED = 'unauthorized',
}

@Entity('usage_metrics')
@Index(['timestamp', 'type'])
@Index(['gatewayId', 'timestamp'])
@Index(['organizationId', 'timestamp'])
export class UsageMetric {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'varchar',
  })
  type: MetricType;

  @Column({ type: 'decimal', precision: 15, scale: 4 })
  value: number;

  @Column({
    type: 'varchar',
    default: MetricStatus.SUCCESS,
  })
  status: MetricStatus;

  @Column({ nullable: true })
  gatewayId: string;

  @Column({ nullable: true })
  toolId: string;

  @Column({ nullable: true })
  userId: string;

  @Column({ nullable: true })
  organizationId: string;

  @Column({ nullable: true })
  llmProviderId: string;

  @Column({ type: 'json', nullable: true })
  dimensions: Record<string, any>; // Additional metric dimensions

  @Column({ type: 'json', nullable: true })
  metadata: {
    requestId?: string;
    userAgent?: string;
    ipAddress?: string;
    endpoint?: string;
    method?: string;
    protocol?: string;
    statusCode?: number;
    errorMessage?: string;
    responseSize?: number;
    requestSize?: number;
  };

  @Column({ type: 'timestamp' })
  timestamp: Date;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => Gateway, gateway => gateway.usageMetrics, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'gatewayId' })
  gateway: Gateway;

  @ManyToOne(() => Tool, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'toolId' })
  tool: Tool;

  @ManyToOne(() => User, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'userId' })
  user: User;

  @ManyToOne(() => Organization, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @ManyToOne(() => LlmProvider, provider => provider.usageMetrics, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'llmProviderId' })
  llmProvider: LlmProvider;

  // Methods
  isError(): boolean {
    return [
      MetricStatus.ERROR,
      MetricStatus.TIMEOUT,
      MetricStatus.RATE_LIMITED,
      MetricStatus.UNAUTHORIZED,
    ].includes(this.status);
  }

  getResponseTimeCategory(): 'fast' | 'medium' | 'slow' | 'very_slow' {
    if (this.type !== MetricType.RESPONSE_TIME) return 'fast';
    
    const responseTime = this.value;
    if (responseTime < 200) return 'fast';
    if (responseTime < 1000) return 'medium';
    if (responseTime < 5000) return 'slow';
    return 'very_slow';
  }

  getDimensionValue(key: string): any {
    return this.dimensions?.[key];
  }

  static createRequestMetric(data: {
    gatewayId?: string;
    toolId?: string;
    userId?: string;
    organizationId?: string;
    status: MetricStatus;
    metadata?: Record<string, any>;
  }): UsageMetric {
    const metric = new UsageMetric();
    metric.type = MetricType.REQUEST_COUNT;
    metric.value = 1;
    metric.status = data.status;
    metric.gatewayId = data.gatewayId;
    metric.toolId = data.toolId;
    metric.userId = data.userId;
    metric.organizationId = data.organizationId;
    metric.metadata = data.metadata;
    metric.timestamp = new Date();
    return metric;
  }

  static createResponseTimeMetric(data: {
    gatewayId?: string;
    toolId?: string;
    userId?: string;
    organizationId?: string;
    responseTime: number;
    status: MetricStatus;
    metadata?: Record<string, any>;
  }): UsageMetric {
    const metric = new UsageMetric();
    metric.type = MetricType.RESPONSE_TIME;
    metric.value = data.responseTime;
    metric.status = data.status;
    metric.gatewayId = data.gatewayId;
    metric.toolId = data.toolId;
    metric.userId = data.userId;
    metric.organizationId = data.organizationId;
    metric.metadata = data.metadata;
    metric.timestamp = new Date();
    return metric;
  }

  static createThroughputMetric(data: {
    gatewayId?: string;
    organizationId?: string;
    requestCount: number;
    timeWindowSeconds: number;
  }): UsageMetric {
    const metric = new UsageMetric();
    metric.type = MetricType.THROUGHPUT;
    metric.value = data.requestCount / data.timeWindowSeconds;
    metric.status = MetricStatus.SUCCESS;
    metric.gatewayId = data.gatewayId;
    metric.organizationId = data.organizationId;
    metric.dimensions = {
      requestCount: data.requestCount,
      timeWindowSeconds: data.timeWindowSeconds,
    };
    metric.timestamp = new Date();
    return metric;
  }
}