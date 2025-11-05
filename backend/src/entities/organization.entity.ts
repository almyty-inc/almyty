import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { UserOrganization } from './user-organization.entity';
import { Team } from './team.entity';
import { Api } from './api.entity';
import { Tool } from './tool.entity';
import { Gateway } from './gateway.entity';
import { LlmProvider } from './llm-provider.entity';
import { LlmSession } from './llm-session.entity';
import { UsageMetric } from './usage-metric.entity';

export interface OrganizationSettings {
  maxApis?: number;
  maxTools?: number;
  maxGateways?: number;
  allowedApiTypes?: string[];
  defaultRateLimit?: {
    ttl: number;
    limit: number;
  };
  webhooks?: {
    enabled: boolean;
    endpoints: string[];
  };
}

@Entity('organizations')
@Index(['name'], { unique: true })
@Index(['slug'], { unique: true })
export class Organization {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

  @Column({ unique: true })
  slug: string;

  @Column({ nullable: true })
  description: string;

  @Column({ nullable: true })
  website: string;

  @Column({ nullable: true })
  logo: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'json', nullable: true })
  settings: OrganizationSettings;

  @Column({ type: 'json', nullable: true })
  billingInfo: Record<string, any>;

  @Column({ default: 'free' })
  plan: string; // free, pro, enterprise

  @Column({ nullable: true })
  planExpiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => UserOrganization, userOrg => userOrg.organization)
  members: UserOrganization[];

  @OneToMany(() => Team, team => team.organization)
  teams: Team[];

  @OneToMany(() => Api, api => api.organization)
  apis: Api[];

  @OneToMany(() => Tool, tool => tool.organization)
  tools: Tool[];

  @OneToMany(() => Gateway, gateway => gateway.organization)
  gateways: Gateway[];

  @OneToMany(() => LlmProvider, provider => provider.organization)
  llmProviders: LlmProvider[];

  @OneToMany(() => LlmSession, session => session.organization)
  llmSessions: LlmSession[];

  @OneToMany(() => UsageMetric, metric => metric.organization)
  usageMetrics: UsageMetric[];

  @BeforeInsert()
  @BeforeUpdate()
  generateSlug() {
    if (!this.slug && this.name) {
      const baseSlug = this.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      // Add timestamp and random string to ensure uniqueness
      const randomString = Math.random().toString(36).substring(2, 8);
      this.slug = `${baseSlug}-${Date.now()}-${randomString}`;
    }
  }

  // Methods
  getOwners(): UserOrganization[] {
    return this.members?.filter(m => m.role === 'owner') || [];
  }

  getAdmins(): UserOrganization[] {
    return this.members?.filter(m => ['owner', 'admin'].includes(m.role)) || [];
  }

  canAddMoreApis(): boolean {
    const maxApis = this.settings?.maxApis;
    if (!maxApis) return true;
    return (this.apis?.length || 0) < maxApis;
  }

  canAddMoreGateways(): boolean {
    const maxGateways = this.settings?.maxGateways;
    if (!maxGateways) return true;
    return (this.gateways?.length || 0) < maxGateways;
  }

  canAddMoreTools(): boolean {
    const maxTools = this.settings?.maxTools;
    if (!maxTools) return true;
    return (this.tools?.length || 0) < maxTools;
  }
}