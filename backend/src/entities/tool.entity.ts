import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  ManyToMany,
  JoinColumn,
  JoinTable,
  Index,
} from 'typeorm';
import { Operation } from './operation.entity';
import { JsonSchema } from './json-schema.entity';
import { ToolVersion } from './tool-version.entity';
import { ToolCategory } from './tool-category.entity';
import { GatewayTool } from './gateway-tool.entity';
import { Organization } from './organization.entity';

export enum ToolType {
  FUNCTION = 'function',
  ACTION = 'action',
  QUERY = 'query',
  MUTATION = 'mutation',
  API = 'api',
}

export enum ToolExecutionMethod {
  HTTP = 'http',
  GRAPHQL = 'graphql',
  SOAP = 'soap',
  GRPC = 'grpc',
  CUSTOM = 'custom',
}

export enum ToolStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  DEPRECATED = 'deprecated',
  INACTIVE = 'inactive',
  DELETED = 'deleted',
}

@Entity('tools')
@Index(['name', 'operationId'])
@Index(['organizationId', 'name'])
@Index(['organizationId', 'status'])
@Index(['organizationId', 'createdAt'])
export class Tool {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({
    type: 'varchar',
    default: ToolType.FUNCTION,
  })
  type: ToolType;

  @Column({ type: 'text', nullable: true })
  code: string | null; // Custom JavaScript/TypeScript code for custom tools

  @Column({
    type: 'varchar',
    nullable: true,
  })
  executionMethod: ToolExecutionMethod | null; // How this tool executes (http, graphql, soap, grpc, custom)

  @Column({ type: 'json', nullable: true })
  authConfig: {
    type?: 'none' | 'basic' | 'bearer' | 'oauth2' | 'apiKey';
    config?: Record<string, any>;
  } | null; // Authentication configuration for manual tools

  @Column({
    type: 'varchar',
    default: ToolStatus.DRAFT,
  })
  status: ToolStatus;

  @Column({ default: '1.0.0' })
  version: string;

  @Column({ nullable: true })
  operationId: string | null;

  @Column()
  organizationId: string;

  @Column({ nullable: true })
  inputSchemaId: string;

  @Column({ nullable: true })
  outputSchemaId: string;

  @Column({ type: 'json', nullable: true })
  parameters: Record<string, any>; // JSON Schema parameters

  @Column({ type: 'json', nullable: true })
  examples: Array<{
    name: string;
    description?: string;
    input: Record<string, any>;
    expectedOutput?: any;
  }>;

  @Column({ type: 'json', nullable: true })
  configuration: {
    timeout?: number;
    retries?: number;
    rateLimit?: {
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
    cache?: {
      enabled: boolean;
      ttl?: number;
    };
  };

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ default: 0 })
  usageCount: number;

  @Column({ nullable: true })
  lastUsedAt: Date;

  @Column({ default: 0 })
  successRate: number; // Percentage 0-100

  @Column({ default: 0 })
  averageResponseTime: number; // In milliseconds

  @Column({ nullable: true })
  createdBy: string;

  @Column({ nullable: true })
  updatedBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Operation, operation => operation.tools, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'operationId' })
  operation: Operation | null;

  @ManyToOne(() => Organization, organization => organization.tools, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @ManyToOne(() => JsonSchema, jsonSchema => jsonSchema.toolsUsingAsInput, {
    nullable: true,
  })
  @JoinColumn({ name: 'inputSchemaId' })
  inputSchema: JsonSchema;

  @ManyToOne(() => JsonSchema, jsonSchema => jsonSchema.toolsUsingAsOutput, {
    nullable: true,
  })
  @JoinColumn({ name: 'outputSchemaId' })
  outputSchema: JsonSchema;

  @OneToMany(() => ToolVersion, toolVersion => toolVersion.tool, {
    cascade: true,
  })
  versions: ToolVersion[];

  @ManyToMany(() => ToolCategory, category => category.tools)
  @JoinTable({
    name: 'tool_categories_mapping',
    joinColumn: { name: 'toolId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'categoryId', referencedColumnName: 'id' },
  })
  categories: ToolCategory[];

  @OneToMany(() => GatewayTool, gatewayTool => gatewayTool.tool)
  gatewayAssociations: GatewayTool[];

  // Methods
  isActive(): boolean {
    return this.status === ToolStatus.ACTIVE;
  }

  canExecute(): boolean {
    return this.isActive() && this.operation && !this.operation.deprecated;
  }

  validateInput(input: Record<string, any>): { isValid: boolean; errors: string[] } {
    if (this.inputSchema) {
      return this.inputSchema.validate(input);
    }

    // Fallback to basic parameter validation
    const errors: string[] = [];
    
    if (this.parameters?.required && Array.isArray(this.parameters.required)) {
      for (const field of this.parameters.required) {
        if (!(field in input)) {
          errors.push(`Missing required parameter: ${field}`);
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  getRequiredParameters(): string[] {
    if (this.inputSchema) {
      return this.inputSchema.getRequiredFields();
    }
    return this.parameters?.required || [];
  }

  getOptionalParameters(): string[] {
    if (this.inputSchema) {
      return this.inputSchema.getOptionalFields();
    }
    
    if (!this.parameters?.properties) return [];
    
    const allParams = Object.keys(this.parameters.properties);
    const required = this.getRequiredParameters();
    return allParams.filter(param => !required.includes(param));
  }

  incrementUsage() {
    this.usageCount += 1;
    this.lastUsedAt = new Date();
  }

  updateMetrics(responseTime: number, success: boolean) {
    // Update average response time
    if (this.usageCount > 0) {
      this.averageResponseTime = 
        (this.averageResponseTime * (this.usageCount - 1) + responseTime) / this.usageCount;
    } else {
      this.averageResponseTime = responseTime;
    }

    // Update success rate (simplified calculation)
    if (success) {
      this.successRate = Math.min(100, this.successRate + (100 - this.successRate) * 0.1);
    } else {
      this.successRate = Math.max(0, this.successRate * 0.9);
    }
  }

  getPerformanceRating(): 'excellent' | 'good' | 'fair' | 'poor' {
    const score = (this.successRate * 0.7) + ((5000 - Math.min(this.averageResponseTime, 5000)) / 5000 * 100 * 0.3);
    
    if (score >= 90) return 'excellent';
    if (score >= 75) return 'good';
    if (score >= 60) return 'fair';
    return 'poor';
  }

  toOpenAPITool(): Record<string, any> {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description || '',
        parameters: this.parameters || {
          type: 'object',
          properties: {},
        },
      },
    };
  }

  toAnthropicTool(): Record<string, any> {
    return {
      name: this.name,
      description: this.description || '',
      input_schema: this.parameters || {
        type: 'object',
        properties: {},
      },
    };
  }
}