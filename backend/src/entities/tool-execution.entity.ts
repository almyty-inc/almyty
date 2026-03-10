import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

import { Tool } from './tool.entity';
import { User } from './user.entity';
import { Organization } from './organization.entity';

@Entity('tool_executions')
@Index(['toolId', 'organizationId', 'createdAt'])
@Index(['userId', 'createdAt'])
@Index(['success', 'createdAt'])
export class ToolExecution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  toolId: string;

  @Column('uuid', { nullable: true })
  @Index()
  userId: string | null;

  @Column('uuid')
  @Index()
  organizationId: string;

  @Column('uuid', { nullable: true })
  @Index()
  gatewayId: string | null;

  @Column('json')
  parameters: Record<string, any>;

  @Column('json', { nullable: true })
  result?: any;

  @Column('boolean')
  @Index()
  success: boolean;

  @Column('text', { nullable: true })
  error?: string;

  @Column('integer', { default: 0 })
  executionTime: number; // in milliseconds

  @Column('boolean', { default: false })
  cached: boolean;

  @Column('integer', { default: 0 })
  retryCount: number;

  @Column('json', { nullable: true })
  metadata?: {
    httpStatus?: number;
    requestId?: string;
    rateLimited?: boolean;
    apiCallId?: string;
    userAgent?: string;
    clientIp?: string;
    // Security audit fields
    securityWarnings?: string[]; // Input sanitization warnings
    ssrfBlocked?: boolean; // Whether SSRF protection was triggered
    integrityVerified?: boolean; // Whether tool hash was verified
    [key: string]: any;
  };

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Relations
  @ManyToOne(() => Tool, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'toolId' })
  tool: Tool;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'userId' })
  user: User | null;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  // Helper methods
  getDurationInSeconds(): number {
    return Math.round(this.executionTime / 1000);
  }

  isSuccessful(): boolean {
    return this.success;
  }

  isCached(): boolean {
    return this.cached;
  }

  wasRateLimited(): boolean {
    return this.metadata?.rateLimited === true;
  }

  getHttpStatus(): number | undefined {
    return this.metadata?.httpStatus;
  }

  getRequestId(): string | undefined {
    return this.metadata?.requestId;
  }

  getErrorMessage(): string | undefined {
    return this.error;
  }

  // Static query helpers
  static getSuccessfulExecutionsQuery() {
    return { success: true };
  }

  static getFailedExecutionsQuery() {
    return { success: false };
  }

  static getCachedExecutionsQuery() {
    return { cached: true };
  }

  static getRateLimitedExecutionsQuery() {
    return { 'metadata.rateLimited': true };
  }

  static getExecutionsInTimeframeQuery(since: Date, until?: Date) {
    const query: any = {
      createdAt: { $gte: since },
    };

    if (until) {
      query.createdAt.$lte = until;
    }

    return query;
  }

  static getExecutionsByToolQuery(toolId: string) {
    return { toolId };
  }

  static getExecutionsByUserQuery(userId: string) {
    return { userId };
  }

  static getExecutionsByOrganizationQuery(organizationId: string) {
    return { organizationId };
  }

  // Analytics helpers
  toAnalyticsData() {
    return {
      id: this.id,
      toolId: this.toolId,
      userId: this.userId,
      organizationId: this.organizationId,
      success: this.success,
      executionTime: this.executionTime,
      cached: this.cached,
      retryCount: this.retryCount,
      httpStatus: this.getHttpStatus(),
      rateLimited: this.wasRateLimited(),
      timestamp: this.createdAt,
      error: this.error,
      requestId: this.getRequestId(),
    };
  }

  toMetricsData() {
    return {
      tool_id: this.toolId,
      user_id: this.userId,
      organization_id: this.organizationId,
      success: this.success ? 1 : 0,
      execution_time_ms: this.executionTime,
      cached: this.cached ? 1 : 0,
      retry_count: this.retryCount,
      http_status: this.getHttpStatus() || 0,
      rate_limited: this.wasRateLimited() ? 1 : 0,
      timestamp: this.createdAt.getTime(),
    };
  }
}