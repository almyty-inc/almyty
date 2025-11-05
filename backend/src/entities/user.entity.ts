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
      owner: ['read', 'write', 'delete', 'admin', 'create_gateways', 'edit_gateways', 'delete_gateways', 'manage_gateways', 'create_tools', 'edit_tools', 'delete_tools', 'manage_tools', 'use_tools', 'manage_llm_providers', 'manage_gateway_tools'],
      admin: ['read', 'write', 'delete', 'create_gateways', 'edit_gateways', 'delete_gateways', 'manage_gateways', 'create_tools', 'edit_tools', 'delete_tools', 'manage_tools', 'use_tools', 'manage_llm_providers', 'manage_gateway_tools'],
      member: ['read', 'write', 'use_tools'],
      viewer: ['read'],
    };
    
    return rolePermissions[membership.role]?.includes(permission) || false;
  }
}