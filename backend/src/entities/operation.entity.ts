import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Api } from './api.entity';
import { Resource } from './resource.entity';
import { Tool } from './tool.entity';

export enum HttpMethod {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT',
  PATCH = 'PATCH',
  DELETE = 'DELETE',
  OPTIONS = 'OPTIONS',
  HEAD = 'HEAD',
}

export enum OperationType {
  QUERY = 'query',
  MUTATION = 'mutation',
  SUBSCRIPTION = 'subscription',
  RPC = 'rpc',
}

@Entity('operations')
export class Operation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  operationId: string; // From OpenAPI or other schemas

  @Column({ nullable: true })
  description: string;

  @Column()
  apiId: string;

  @Column({ nullable: true })
  resourceId: string;

  @Column({
    type: 'varchar',
    nullable: true,
  })
  method: HttpMethod;

  @Column()
  endpoint: string;

  @Column({
    type: 'varchar',
    default: OperationType.QUERY,
  })
  type: OperationType;

  @Column({ type: 'json', nullable: true })
  parameters: {
    path?: Record<string, any>;
    query?: Record<string, any>;
    header?: Record<string, any>;
    body?: Record<string, any>;
  };

  @Column({ type: 'json', nullable: true })
  responses: Record<string, {
    description: string;
    schema?: Record<string, any>;
    examples?: any[];
  }>;

  @Column({ type: 'json', nullable: true })
  security: Array<Record<string, string[]>>;

  @Column({ type: 'json', nullable: true })
  tags: string[];

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: false })
  deprecated: boolean;

  @Column({ nullable: true })
  deprecationMessage: string;

  @Column({ type: 'json', nullable: true })
  rateLimit: {
    requestsPerMinute?: number;
    requestsPerHour?: number;
  };

  @Column({ default: 30000 })
  timeoutMs: number;

  @Column({ type: 'json', nullable: true })
  retryConfig: {
    attempts: number;
    delay: number;
    backoff?: 'fixed' | 'exponential';
  };

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Api, api => api.operations, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'apiId' })
  api: Api;

  @ManyToOne(() => Resource, resource => resource.operations, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'resourceId' })
  resource: Resource;

  @OneToMany(() => Tool, tool => tool.operation, {
    cascade: true,
  })
  tools: Tool[];

  // Methods
  getFullEndpoint(): string {
    if (!this.api?.baseUrl) return this.endpoint;
    
    const baseUrl = this.api.baseUrl.replace(/\/$/, '');
    const endpoint = this.endpoint.startsWith('/') ? this.endpoint : `/${this.endpoint}`;
    
    return `${baseUrl}${endpoint}`;
  }

  requiresAuthentication(): boolean {
    return this.security && this.security.length > 0;
  }

  hasParameters(): boolean {
    return !!(
      this.parameters?.path ||
      this.parameters?.query ||
      this.parameters?.header ||
      this.parameters?.body
    );
  }

  getSuccessResponse(): any {
    // Get 2xx response
    const successCode = Object.keys(this.responses || {}).find(code => 
      code.startsWith('2')
    );
    return successCode ? this.responses[successCode] : null;
  }

  isReadOperation(): boolean {
    return this.method === HttpMethod.GET || this.type === OperationType.QUERY;
  }

  isWriteOperation(): boolean {
    return [HttpMethod.POST, HttpMethod.PUT, HttpMethod.PATCH, HttpMethod.DELETE].includes(this.method) ||
           this.type === OperationType.MUTATION;
  }
}