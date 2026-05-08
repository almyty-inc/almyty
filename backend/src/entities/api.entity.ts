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
import { ApiSchema } from './api-schema.entity';
import { Operation } from './operation.entity';
import { Resource } from './resource.entity';
import { Credential } from './credential.entity';

export enum ApiType {
  OPENAPI = 'openapi',
  GRAPHQL = 'graphql',
  SOAP = 'soap',
  GRPC = 'grpc',
  HTTP = 'http',
  SDK = 'sdk',
  OTHER = 'other',
}

export enum ApiStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  DEPRECATED = 'deprecated',
  INACTIVE = 'inactive',
}

@Entity('apis')
@VersionedEntity()
@Index(['organizationId', 'name'])
export class Api {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column()
  baseUrl: string;

  @Column({ default: '1.0.0' })
  version: string;

  @Column({
    type: 'varchar',
    default: ApiType.OTHER,
  })
  type: ApiType;

  @Column({
    type: 'varchar',
    default: ApiStatus.DRAFT,
  })
  status: ApiStatus;

  @Column()
  organizationId: string;

  /**
   * Team-scoping. visibility='org' (default) is org-wide; 'team'
   * requires teamId. Constraint enforced at DB level via
   * 1745340000000-TeamScopingPerEntity. Listing filters use
   * AccessPolicyService.applyListFilter.
   */
  @Column({ type: 'varchar', length: 8, default: 'org' })
  visibility: 'org' | 'team';

  @Column({ type: 'uuid', nullable: true })
  teamId: string | null;

  @Column({ type: 'json', nullable: true })
  headers: Record<string, string>; // Default headers for all requests

  @Column({ type: 'json', nullable: true })
  authentication: {
    type: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';
    config: Record<string, any>;
  };

  @Column({ type: 'json', nullable: true })
  rateLimits: {
    requestsPerSecond?: number;
    requestsPerMinute?: number;
    requestsPerHour?: number;
  };

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ default: 30000 })
  timeoutMs: number;

  @Column({ default: 3 })
  retryAttempts: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, org => org.apis, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @OneToMany(() => ApiSchema, schema => schema.api, {
    cascade: true,
  })
  schemas: ApiSchema[];

  @OneToMany(() => Operation, operation => operation.api, {
    cascade: true,
  })
  operations: Operation[];

  @OneToMany(() => Resource, resource => resource.api, {
    cascade: true,
  })
  resources: Resource[];

  @OneToMany(() => Credential, credential => credential.api, {
    cascade: true,
  })
  credentials: Credential[];

  @Column({ type: 'jsonb', nullable: true })
  dependencies: Record<string, string> | null;

  @Column({ type: 'jsonb', nullable: true })
  npmRegistry: any | null;

  @Column({ type: 'jsonb', nullable: true })
  sdkMaps: Record<string, any> | null;

  // Methods
  getLatestSchema(): ApiSchema | undefined {
    return this.schemas?.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];
  }

  getActiveOperations(): Operation[] {
    return this.operations?.filter(op => op.isActive) || [];
  }

  isConfigured(): boolean {
    return this.status === ApiStatus.ACTIVE && this.schemas?.length > 0;
  }

  supportsAuthentication(): boolean {
    return this.authentication?.type !== 'none';
  }
}