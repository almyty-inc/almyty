import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  BeforeInsert,
} from 'typeorm';
import { User } from './user.entity';
import { Organization } from './organization.entity';
import { Gateway } from './gateway.entity';
import * as crypto from 'crypto';

@Entity('api_keys')
@Index(['keyHash'], { unique: true })
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ unique: true })
  keyHash: string;

  @Column()
  keyPrefix: string; // First 8 characters for identification

  @Column()
  userId: string;

  @Column({ nullable: true })
  organizationId: string;

  @Column({ nullable: true })
  gatewayId: string;

  @Column({ nullable: true })
  agentId: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ nullable: true })
  expiresAt: Date;

  @Column({ nullable: true })
  lastUsedAt: Date;

  /**
   * Scopes, and who actually enforces them.
   *
   * GATEWAY keys (gatewayId set, minted by gateway-auth.controller):
   * enforced. GatewayAuthValidators hands these to the gateway protocol
   * service, which threads them into ToolExecutionOptions.scopes, which
   * is checked against gateway_tools.permissions.requiredScopes before
   * dispatch.
   *
   * PLATFORM keys (gatewayId null, minted by AuthService.createApiKey):
   * NOT enforced, and not accepted either. A platform key authenticates
   * through ApiKeyStrategy -- one half of JwtAuthGuard -- and acts as its
   * user with that user's full role on every route the guard protects.
   * Nothing on that path reads this column, so a ['read'] key answered
   * DELETE. createApiKey now rejects scopes, and ApiKeyStrategy refuses
   * a platform key that carries any.
   */
  @Column({ type: 'json', nullable: true })
  scopes: string[];

  /**
   * NOT IMPLEMENTED. No code reads this column: not ApiKeyStrategy, not
   * any guard or interceptor, not GatewayRateLimitService. It was
   * accepted by CreateApiKeyDto and stored, and then ignored on every
   * request. createApiKey now rejects it rather than pretending.
   *
   * Rate limiting that works is per gateway: Gateway.rateLimitConfig,
   * enforced by GatewayRateLimitService. Per-key limits are a product
   * decision, not a missing line of plumbing -- they need a counter
   * keyed by ApiKey.id on the platform request path, which does not
   * exist.
   */
  @Column({ type: 'json', nullable: true })
  rateLimits: {
    requestsPerMinute?: number;
    requestsPerHour?: number;
    requestsPerDay?: number;
  };

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => User, user => user.apiKeys, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'userId' })
  user: User;

  @ManyToOne(() => Organization, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @ManyToOne(() => Gateway, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'gatewayId' })
  gateway: Gateway;

  @BeforeInsert()
  generateKeyHash() {
    if (!this.keyHash) {
      // This would be set from the service when creating the key
      const key = this.generateApiKey();
      this.keyHash = this.hashKey(key);
      this.keyPrefix = key.substring(0, 8);
    }
  }

  private generateApiKey(): string {
    return `llm_${crypto.randomBytes(32).toString('hex')}`;
  }

  private hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  // Methods
  isExpired(): boolean {
    return this.expiresAt ? new Date() > this.expiresAt : false;
  }

  canMakeRequest(): boolean {
    return this.isActive && !this.isExpired();
  }

  updateLastUsed() {
    this.lastUsedAt = new Date();
  }
}