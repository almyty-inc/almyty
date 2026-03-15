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

  @Column({ default: true })
  isActive: boolean;

  @Column({ nullable: true })
  expiresAt: Date;

  @Column({ nullable: true })
  lastUsedAt: Date;

  @Column({ type: 'json', nullable: true })
  scopes: string[]; // Array of permissions/scopes

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

  hasScope(scope: string): boolean {
    return this.scopes?.includes(scope) || false;
  }

  canMakeRequest(): boolean {
    return this.isActive && !this.isExpired();
  }

  updateLastUsed() {
    this.lastUsedAt = new Date();
  }
}