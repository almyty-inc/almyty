import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { UserOrganization } from './user-organization.entity';
import { ApiKey } from './api-key.entity';

@Entity('users')
@Index(['email'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  /**
   * Canonical form of `email` used to dedupe abuse aliases at registration:
   * gmail dots stripped, `+tag` sub-addressing removed, domain aliases
   * folded (googlemail.com -> gmail.com). Two addresses that reach the same
   * real inbox collapse to one value here, so a bot can't farm many accounts
   * from a single mailbox. See email-normalization.ts. Unique-indexed.
   * Nullable only so the backfill migration can populate legacy rows.
   */
  @Column({ nullable: true })
  @Index({ unique: true })
  normalizedEmail: string | null;

  @Column()
  @Exclude()
  passwordHash: string;

  @Column()
  firstName: string;

  @Column()
  lastName: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: false })
  isVerified: boolean;

  /**
   * When the user verified their email address (non-blocking flow —
   * login works unverified; some features like referral rewards are
   * gated on this). NULL = unverified. Set together with the legacy
   * `isVerified` boolean.
   */
  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  /**
   * Bumped to invalidate all previously issued access/refresh tokens for
   * this user (password change, password reset). JWTs carry the value
   * they were minted with; the JWT strategy and refresh path reject any
   * token whose `tv` claim doesn't match. A missing claim is treated as 0
   * so tokens issued before this column existed stay valid until the
   * first bump.
   */
  @Column({ default: 0 })
  tokenVersion: number;

  @Column({ nullable: true })
  verificationToken: string;

  @Column({ nullable: true })
  resetPasswordToken: string;

  @Column({ nullable: true })
  resetPasswordExpires: Date;

  @Column({ nullable: true })
  lastLoginAt: Date;

  @Column({ type: 'json', nullable: true })
  preferences: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => UserOrganization, userOrg => userOrg.user)
  organizationMemberships: UserOrganization[];

  @OneToMany(() => ApiKey, apiKey => apiKey.user)
  apiKeys: ApiKey[];

  // Virtual properties
  get fullName(): string {
    return `${this.firstName} ${this.lastName}`;
  }

  // Methods
  hasPermissionInOrganization(organizationId: string, permission: string): boolean {
    const membership = this.organizationMemberships?.find(
      m => m.organizationId === organizationId
    );
    
    if (!membership) return false;
    
    // Check role-based permissions (simplified)
    const rolePermissions = {
      owner: ['read', 'write', 'delete', 'admin', 'create_gateways', 'edit_gateways', 'delete_gateways', 'manage_gateways', 'create_tools', 'edit_tools', 'delete_tools', 'manage_tools', 'use_tools', 'manage_llm_providers', 'manage_gateway_tools', 'edit_agents', 'delete_agents'],
      admin: ['read', 'write', 'delete', 'create_gateways', 'edit_gateways', 'delete_gateways', 'manage_gateways', 'create_tools', 'edit_tools', 'delete_tools', 'manage_tools', 'use_tools', 'manage_llm_providers', 'manage_gateway_tools', 'edit_agents', 'delete_agents'],
      member: ['read', 'write', 'use_tools'],
      viewer: ['read'],
    };
    
    return rolePermissions[membership.role]?.includes(permission) || false;
  }
}