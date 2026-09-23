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
import { decideToolCaller } from '../common/security/gateway-tool-permissions';

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

  /**
   * Per-gateway renaming of a tool's payloads.
   *
   * `inputMapping` and `outputMapping` are applied by
   * ToolExecutorService (input before validation and the cache key,
   * output on a successful result), and only on calls that arrive with a
   * gatewayId -- the mapping belongs to one tool on one gateway.
   *
   * `headerMapping` is NOT IMPLEMENTED: nothing reads it, including
   * transformInput/transformOutput below. It is accepted by the DTO and
   * stored, and it changes no outbound request. Unlike the other two it
   * has no rename semantics to borrow -- outbound headers are assembled
   * per executor under the security policy's allowed-host and HTTPS
   * checks, so honouring it would change what leaves the process, which
   * is a product decision rather than missing plumbing.
   */
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

  /**
   * Delegates to common/security/gateway-tool-permissions.ts, which is
   * where the executor reads it from: the decision has to work on whatever
   * the repository returned, and a method only exists on a hydrated entity.
   * Keeping the logic in one place is what stops this method drifting back
   * into being the only copy -- which is how it ended up with no callers.
   */
  hasPermission(userId: string, userRoles: string[], userOrg: string, scopes: string[]): boolean {
    return decideToolCaller(this.permissions, {
      userId,
      roles: userRoles,
      organizationId: userOrg,
      scopes,
    }).allowed;
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