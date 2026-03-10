import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Gateway } from './gateway.entity';
import { Tool } from './tool.entity';

@Entity('gateway_tools')
@Index(['gatewayId', 'toolId'], { unique: true })
@Index(['toolId', 'isActive'])
@Index(['gatewayId', 'isActive'])
@Index(['gatewayId', 'usageCount'])
export class GatewayTool {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  gatewayId: string;

  @Column()
  toolId: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'json', nullable: true })
  overrides: {
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

  @Column({ type: 'json', nullable: true })
  permissions: {
    allowedUsers?: string[];
    allowedRoles?: string[];
    allowedOrganizations?: string[];
    requiredScopes?: string[];
  };

  @Column({ type: 'json', nullable: true })
  transformations: {
    inputMapping?: Record<string, string>;
    outputMapping?: Record<string, string>;
    headerMapping?: Record<string, string>;
  };

  @Column({ default: 0 })
  usageCount: number;

  @Column({ nullable: true })
  lastUsedAt: Date;

  @Column({ type: 'json', nullable: true })
  securityPolicy: {
    allowedDomains?: string[]; // Restrict tool to only call these domains
    blockedDomains?: string[]; // Block tool from calling these domains
    maxResponseSizeBytes?: number; // Per-tool response size limit
    allowedHttpMethods?: string[]; // Restrict HTTP methods (GET, POST, etc.)
    requireHttps?: boolean; // Force HTTPS only
  } | null;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  associatedAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Gateway, gateway => gateway.tools, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'gatewayId' })
  gateway: Gateway;

  @ManyToOne(() => Tool, tool => tool.gatewayAssociations, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'toolId' })
  tool: Tool;

  // Methods
  getEffectiveName(): string {
    return this.overrides?.name || this.tool?.name || 'unknown';
  }

  getEffectiveDescription(): string {
    return this.overrides?.description || this.tool?.description || '';
  }

  getEffectiveParameters(): Record<string, any> {
    if (this.overrides?.parameters) {
      // Merge tool parameters with overrides
      return {
        ...this.tool?.parameters,
        ...this.overrides.parameters,
      };
    }
    return this.tool?.parameters || {};
  }

  hasPermission(userId: string, userRoles: string[], userOrg: string, scopes: string[]): boolean {
    if (!this.permissions) return true;

    // Check user permission
    if (this.permissions.allowedUsers?.length > 0) {
      if (!this.permissions.allowedUsers.includes(userId)) {
        return false;
      }
    }

    // Check role permission
    if (this.permissions.allowedRoles?.length > 0) {
      const hasRole = userRoles.some(role => this.permissions.allowedRoles.includes(role));
      if (!hasRole) return false;
    }

    // Check organization permission
    if (this.permissions.allowedOrganizations?.length > 0) {
      if (!this.permissions.allowedOrganizations.includes(userOrg)) {
        return false;
      }
    }

    // Check scope permission
    if (this.permissions.requiredScopes?.length > 0) {
      const hasScope = this.permissions.requiredScopes.some(scope => scopes.includes(scope));
      if (!hasScope) return false;
    }

    return true;
  }

  transformInput(input: Record<string, any>): Record<string, any> {
    if (!this.transformations?.inputMapping) return input;

    const transformed = { ...input };
    
    for (const [sourceKey, targetKey] of Object.entries(this.transformations.inputMapping)) {
      if (sourceKey in transformed) {
        transformed[targetKey] = transformed[sourceKey];
        if (sourceKey !== targetKey) {
          delete transformed[sourceKey];
        }
      }
    }

    return transformed;
  }

  transformOutput(output: any): any {
    if (!this.transformations?.outputMapping) return output;

    if (typeof output === 'object' && output !== null) {
      const transformed = { ...output };
      
      for (const [sourceKey, targetKey] of Object.entries(this.transformations.outputMapping)) {
        if (sourceKey in transformed) {
          transformed[targetKey] = transformed[sourceKey];
          if (sourceKey !== targetKey) {
            delete transformed[sourceKey];
          }
        }
      }

      return transformed;
    }

    return output;
  }

  getEffectiveTimeout(): number {
    return this.overrides?.timeout || this.tool?.configuration?.timeout || 30000;
  }

  getEffectiveRetries(): number {
    return this.overrides?.retries || this.tool?.configuration?.retries || 3;
  }

  incrementUsage() {
    this.usageCount++;
    this.lastUsedAt = new Date();
  }

  canExecute(): boolean {
    return this.isActive && this.tool?.canExecute();
  }

  getCacheConfig(): { enabled: boolean; ttl: number } {
    const toolCache = this.tool?.configuration?.cache;
    const overrideCache = this.overrides?.cache;

    return {
      enabled: overrideCache?.enabled ?? toolCache?.enabled ?? false,
      ttl: overrideCache?.ttl ?? toolCache?.ttl ?? 300, // 5 minutes default
    };
  }
}