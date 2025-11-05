import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity';
import { Organization } from './organization.entity';

export enum OrganizationRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MEMBER = 'member',
  VIEWER = 'viewer',
}

@Entity('user_organizations')
@Index(['userId', 'organizationId'], { unique: true })
export class UserOrganization {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column()
  organizationId: string;

  @Column({
    type: 'varchar',
    default: 'member',
  })
  role: OrganizationRole;

  @Column({ default: true })
  isActive: boolean;

  @Column({ nullable: true })
  invitedBy: string;

  @Column({ nullable: true })
  inviteToken: string;

  @Column({ nullable: true })
  inviteExpiresAt: Date;

  @Column({ default: false })
  inviteAccepted: boolean;

  @Column({ type: 'json', nullable: true })
  permissions: string[]; // Additional specific permissions

  @CreateDateColumn()
  joinedAt: Date;

  @ManyToOne(() => User, user => user.organizationMemberships, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'userId' })
  user: User;

  @ManyToOne(() => Organization, org => org.members, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  // Methods
  hasPermission(permission: string): boolean {
    // Role-based permissions
    const rolePermissions = {
      [OrganizationRole.OWNER]: ['read', 'write', 'delete', 'admin', 'billing', 'invite'],
      [OrganizationRole.ADMIN]: ['read', 'write', 'delete', 'invite'],
      [OrganizationRole.MEMBER]: ['read', 'write'],
      [OrganizationRole.VIEWER]: ['read'],
    };

    const hasRolePermission = rolePermissions[this.role]?.includes(permission) || false;
    const hasSpecificPermission = this.permissions?.includes(permission) || false;

    return hasRolePermission || hasSpecificPermission;
  }

  canManageUsers(): boolean {
    return [OrganizationRole.OWNER, OrganizationRole.ADMIN].includes(this.role);
  }

  canManageBilling(): boolean {
    return this.role === OrganizationRole.OWNER;
  }
}